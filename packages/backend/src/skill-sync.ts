import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  SkillSyncOperation,
  SkillSyncResolution,
  SkillSyncPolicy,
  SkillSyncPreview,
  SkillSyncReport,
  SkillSyncRun,
  SkillSyncState,
  SkillSynchronizationState,
} from "@agentkib/runtime-protocol";
import { SkillManager, type SkillSyncLocation } from "./skill-manager";
import { skillPackage, skillPreviewFile } from "./skill-package";
import {
  SkillStateStore,
  readSkillJson,
  writeSkillJson,
  withSkillLocks,
  withSkillTargetLocks,
} from "./skill-state";
import { currentTask } from "./task-executor";
import { assertSkillSyncJournal } from "./skill-sync-journal";

export interface SyncLibrary {
  id: string;
  display_name: string;
  hash: string;
  observed_hash: string | null;
  lock_fingerprint: string;
  source: unknown;
  upstream_base_hash?: string | null;
  path: string;
  valid: boolean;
  instance_id?: string;
  diagnostics?: string[];
}
export interface SkillSyncLibraryHooks {
  list(): Promise<SyncLibrary[]>;
  get(id: string): Promise<SyncLibrary | null>;
  accept(input: {
    id: string;
    snapshotPath: string;
    expectedHash: string;
    expectedLock: string;
    operationId: string;
    originDeploymentId?: string;
    originKind?: "deployment" | "local-import" | "library-edit";
  }): Promise<SyncLibrary>;
  fork(input: {
    snapshotPath: string;
    displayName: string;
    operationId: string;
    localSource?: string;
  }): Promise<SyncLibrary>;
  check(id: string): Promise<{ available: boolean; error?: string }>;
  operationStatus?(operationId: string): Promise<{ library_id: string; committed: boolean } | null>;
  transactions?(): Promise<
    Array<{
      operation_id: string;
      library_id: string;
      operation: string;
      status: string;
      started_at: string;
      error?: string;
    }>
  >;
  update(id: string, operationId: string, beforeCommit?: () => Promise<void>): Promise<SyncLibrary>;
  recover(operationId?: string): Promise<unknown>;
}
type SyncPlan = {
  token: string;
  operation: SkillSyncOperation;
  resolution?: SkillSyncResolution;
  location: SkillSyncLocation;
  library: SyncLibrary | null;
  library_id: string | null;
  before_hash: string | null;
  candidate_hash: string | null;
  target_snapshot: string | null;
  library_snapshot: string | null;
  base_snapshot: string | null;
  base_hash: string | null;
  policy_revision: number;
  expires: number;
  conflicts: string[];
};
type SyncJournal = {
  schema_version: 1;
  kind: "skill-sync";
  operation_id: string;
  plan: SyncPlan;
  phase: "prepared" | "library-committed" | "location-committed";
  library_id: string | null;
  started_at: string;
  trigger: SkillSyncRun["trigger"];
};
type RunStore = {
  schema_version: 1;
  last_due_at: string | null;
  runs: SkillSyncRun[];
  libraries?: Record<
    string,
    { next_at: string; failures: number; owner_key?: string; source_key?: string }
  >;
  blocked_targets?: Record<string, string>;
  target_retry?: Record<string, { fingerprint: string; next_at: string; failures: number }>;
};
const operations: SkillSyncOperation[] = [
  "adopt",
  "pull",
  "push",
  "fork",
  "detach",
  "restore",
  "bind",
];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const identity = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerKey = (root: string, library: SyncLibrary) =>
  identity([path.resolve(root), library.id, library.instance_id ?? library.id]);
const sourceKey = (source: unknown) => {
  if (!source || typeof source !== "object") return identity(null);
  const row = source as Record<string, unknown>;
  return identity([
    row.kind,
    typeof row.repository === "string" ? row.repository.toLowerCase() : row.repository,
    row.path,
    row.ref_type,
    row.ref,
  ]);
};
const canAutoUpdate = (source: unknown) => Boolean(source && typeof source === "object");
class SyncReservationCleanupError extends Error {}

export function skillSynchronizationState(
  base: string | null,
  library: string | null,
  target: string | null,
): SkillSynchronizationState {
  if (!library || !target) return "missing";
  if (!base) return "unverified";
  if (library === target) return library === base ? "current" : "converged";
  if (target === base) return "outgoing";
  if (library === base) return "incoming";
  return "conflict";
}

export class SkillSyncService {
  readonly #store: SkillStateStore;
  readonly #previews = new Map<string, SyncPlan>();
  #running = false;
  constructor(
    readonly root: string,
    readonly manager: SkillManager,
    readonly hooks: SkillSyncLibraryHooks,
  ) {
    this.#store = new SkillStateStore(root);
    manager.setSyncPolicyHooks({ beforeRollback: (id) => this.pinDeployment(id) });
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "skills.syncState":
        return this.state();
      case "skills.prepareSync":
        return this.prepare(params);
      case "skills.applySync":
        return this.apply(params);
      case "skills.syncPolicy":
        return this.policy();
      case "skills.saveSyncPolicy":
        return this.savePolicy(params);
      case "skills.syncRuns":
        return this.runs(params);
      case "skills.recoverSync":
        return this.recover(params);
      case "skills.runDueSync":
        return this.runDue();
      default:
        throw new Error(`Unknown Skill sync method: ${method}`);
    }
  }
  #defaultPolicy(): SkillSyncPolicy {
    return {
      schema_version: 1,
      revision: 0,
      enabled: true,
      interval_hours: 24,
      default_mode: "check",
      libraries: {},
      deployments: {},
      updated_at: null,
    };
  }
  async policy(): Promise<SkillSyncPolicy> {
    const value = await readSkillJson<SkillSyncPolicy>(path.join(this.root, "skill-sync.json"));
    if (!value) return this.#defaultPolicy();
    this.#validatePolicy(value);
    return value;
  }
  #validatePolicy(value: SkillSyncPolicy) {
    if (
      !value ||
      value.schema_version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.enabled !== "boolean" ||
      ![0, 1, 6, 24].includes(value.interval_hours) ||
      !["manual", "check"].includes(value.default_mode) ||
      !value.libraries ||
      typeof value.libraries !== "object" ||
      Array.isArray(value.libraries) ||
      !value.deployments ||
      typeof value.deployments !== "object" ||
      Array.isArray(value.deployments) ||
      Object.keys(value.libraries).length > 4096 ||
      Object.keys(value.deployments).length > 4096
    )
      throw new Error("Invalid Skill sync policy");
    for (const row of Object.values(value.libraries)) {
      if (
        !row ||
        !["manual", "check", "auto_update"].includes(row.mode) ||
        (row.mode === "auto_update" &&
          (typeof row.owner_key !== "string" || typeof row.source_key !== "string"))
      )
        throw new Error("Invalid Skill library sync grant");
    }
    for (const row of Object.values(value.deployments)) {
      if (
        !row ||
        !["manual", "follow", "pinned"].includes(row.mode) ||
        typeof row.approve_home !== "boolean" ||
        typeof row.owner_key !== "string" ||
        typeof row.target_key !== "string"
      )
        throw new Error("Invalid Skill deployment sync grant");
    }
  }
  async savePolicy(params: Record<string, unknown>) {
    const next = params.policy as SkillSyncPolicy;
    this.#validatePolicy(next);
    return withSkillLocks([this.root], async () => {
      const current = await this.policy();
      if (params.revision !== current.revision)
        throw new Error("Skill sync policy changed; refresh before saving");
      for (const [id, grant] of Object.entries(next.libraries)) {
        if (!next.enabled || grant.mode !== "auto_update") continue;
        const library = await this.hooks.get(id);
        if (!library) throw new Error("Skill library no longer exists");
        if (grant.mode === "auto_update" && !canAutoUpdate(library.source))
          throw new Error("Local Skill snapshots have no upstream update source");
        if (
          grant.mode === "auto_update" &&
          (grant.owner_key !== ownerKey(this.root, library) ||
            grant.source_key !== sourceKey(library.source))
        )
          throw new Error("Skill source changed; review the automatic update grant again");
      }
      for (const [id, grant] of Object.entries(next.deployments)) {
        if (!next.enabled || grant.mode !== "follow") continue;
        const location = await this.manager.syncLocation({ deployment_id: id });
        if (
          grant.owner_key !== location.owner_key ||
          grant.target_key !== location.target_key ||
          !location.receipt?.library_root
        )
          throw new Error("Skill location changed; review the automatic distribution grant again");
        const previous = current.deployments[id];
        if (
          grant.mode === "follow" &&
          location.target.scope === "personal" &&
          (!previous ||
            previous.mode !== "follow" ||
            previous.owner_key !== grant.owner_key ||
            previous.target_key !== grant.target_key ||
            !previous.approve_home) &&
          params.approve_home !== true
        )
          throw new Error("Automatic personal Skill writes require Agent Home approval");
        if (grant.mode === "follow" && location.target.scope === "personal" && !grant.approve_home)
          throw new Error("Automatic personal Skill writes require a scoped grant");
      }
      const saved = {
        ...next,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      await writeSkillJson(path.join(this.root, "skill-sync.json"), saved);
      const schedule = await this.#runs();
      if (
        (!current.enabled && saved.enabled) ||
        current.interval_hours !== saved.interval_hours ||
        current.default_mode !== saved.default_mode
      ) {
        schedule.libraries = {};
        schedule.last_due_at = null;
      } else if (schedule.libraries) {
        for (const id of new Set([
          ...Object.keys(current.libraries),
          ...Object.keys(saved.libraries),
        ]))
          if (JSON.stringify(current.libraries[id]) !== JSON.stringify(saved.libraries[id]))
            delete schedule.libraries[id];
      }
      await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), schedule);
      return saved;
    });
  }
  async pauseLibrary(id: string) {
    return withSkillLocks([this.root], async () => {
      const policy = await this.policy();
      policy.libraries[id] = { ...policy.libraries[id], mode: "manual" };
      policy.revision++;
      policy.updated_at = new Date().toISOString();
      await writeSkillJson(path.join(this.root, "skill-sync.json"), policy);
    });
  }
  async pinDeployment(id: string) {
    return withSkillLocks([this.root], async () => {
      const policy = await this.policy();
      const location = await this.manager.syncLocation({ deployment_id: id });
      policy.deployments[id] = {
        mode: "pinned",
        approve_home: false,
        owner_key: location.owner_key,
        target_key: location.target_key,
      };
      policy.revision++;
      policy.updated_at = new Date().toISOString();
      await writeSkillJson(path.join(this.root, "skill-sync.json"), policy);
    });
  }
  async state(): Promise<SkillSyncState> {
    const policy = await this.policy();
    const libraries = await this.hooks.list();
    const snapshot = await this.manager.readSyncState();
    const { inventory, deployments: rows } = snapshot;
    const deployments: SkillSyncState["deployments"] = [];
    for (const row of rows) {
      const library = row.source_is_current_library
        ? libraries.find((item) => item.id === row.library_id)
        : null;
      let location: SkillSyncLocation | null = null;
      let failure: string | null = null;
      try {
        location = await snapshot.resolveLocation({ deployment_id: row.id });
      } catch (error) {
        failure = message(error);
      }
      const baseline = location ? await this.manager.syncBaseline(location) : null;
      deployments.push({
        ...row,
        base_hash: row.package_hash ?? null,
        library_hash: library?.observed_hash ?? null,
        target_hash: location?.target_hash ?? null,
        sync_state: !row.library_root
          ? "unverified"
          : !location
            ? "blocked"
            : !baseline
              ? "unverified"
              : row.status === "recovery-required" ||
                  !library?.valid ||
                  library.observed_hash !== library.hash
                ? "blocked"
                : skillSynchronizationState(
                    row.package_hash,
                    library.observed_hash,
                    location.target_hash,
                  ),
        owner_key: location?.owner_key ?? "",
        target_key: location?.target_key ?? "",
        baseline_available: Boolean(baseline),
        diagnostics: [...row.diagnostics, ...(failure ? [failure] : [])],
        policy: policy.deployments[row.id] ?? null,
      });
    }
    const observations: SkillSyncState["observations"] = [];
    for (const row of inventory.observations) {
      let targetId: string | undefined;
      if (row.owner === "external" && row.kind === "directory") {
        try {
          targetId = (await snapshot.resolveLocation({ observation_id: row.id })).target.id;
        } catch {
          /* Read-only source. */
        }
      }
      observations.push({
        ...row,
        can_adopt: Boolean(targetId),
        ...(targetId ? { target_id: targetId } : {}),
      });
    }
    return {
      library: libraries.map((row) => ({
        library_id: row.id,
        display_name: row.display_name,
        hash: row.hash,
        observed_hash: row.observed_hash,
        upstream_base_hash: row.upstream_base_hash ?? null,
        locally_customized: Boolean(
          row.upstream_base_hash && row.observed_hash !== row.upstream_base_hash,
        ),
        owner_key: ownerKey(this.root, row),
        source_key: sourceKey(row.source),
        valid: row.valid,
        can_auto_update: canAutoUpdate(row.source),
        diagnostics: row.diagnostics ?? [],
        policy: policy.libraries[row.id] ?? null,
      })),
      deployments,
      observations,
      warnings: inventory.warnings,
    };
  }
  hasPreview(token: unknown): boolean {
    return typeof token === "string" && this.#previews.has(token);
  }
  discardPreview(token: string) {
    return { discarded: this.#previews.delete(token) };
  }
  async readPreviewFile(params: Record<string, unknown>) {
    const plan = typeof params.token === "string" ? this.#previews.get(params.token) : null;
    if (!plan || plan.expires <= Date.now() || typeof params.path !== "string")
      throw new Error("Skill sync preview expired or does not exist");
    const comparison = params.comparison ?? "candidate";
    if (!["candidate", "base-library", "base-target"].includes(String(comparison)))
      throw new Error("Invalid Skill preview comparison");
    if (comparison !== "candidate" && !plan.base_snapshot)
      throw new Error("The synchronized baseline is unavailable");
    const before = comparison === "candidate" ? plan.before_hash : plan.base_snapshot;
    const after =
      comparison === "base-library"
        ? plan.library_snapshot
        : comparison === "base-target"
          ? plan.target_snapshot
          : plan.candidate_hash;
    return skillPreviewFile(
      before ? await this.#store.verifySnapshot(before) : null,
      after ? await this.#store.verifySnapshot(after) : null,
      params.path,
    );
  }
  async prepare(params: Record<string, unknown>): Promise<SkillSyncPreview> {
    if (!operations.includes(params.operation as SkillSyncOperation))
      throw new Error("Unsupported Skill synchronization operation");
    const operation = params.operation as SkillSyncOperation;
    if (
      params.resolution !== undefined &&
      !["library", "deployment"].includes(String(params.resolution))
    )
      throw new Error("Invalid Skill conflict resolution");
    const location = await this.manager.syncLocation(
      {
        ...(typeof params.deployment_id === "string"
          ? { deployment_id: params.deployment_id }
          : {}),
        ...(typeof params.observation_id === "string"
          ? { observation_id: params.observation_id }
          : {}),
      },
      operation === "detach" ? "ownership" : "package",
    );
    if (operation === "adopt" && location.receipt)
      throw new Error("Only external Skill installations can be adopted");
    if (operation !== "adopt" && operation !== "fork" && !location.receipt)
      throw new Error("Choose a managed deployment");
    if (operation === "bind" && location.receipt?.library_root)
      throw new Error("Only deployments without verified ownership can be bound");
    if (
      !["bind", "fork", "detach"].includes(operation) &&
      location.receipt &&
      !location.receipt.library_root
    )
      throw new Error("Bind this deployment to a verified library first");
    const libraryId =
      operation === "fork"
        ? null
        : typeof params.library_id === "string"
          ? params.library_id
          : (location.receipt?.library_id ?? null);
    if (
      operation !== "bind" &&
      location.receipt &&
      libraryId !== location.receipt.library_id &&
      operation !== "fork"
    )
      throw new Error("A deployment cannot be transferred by selecting another Skill");
    const library = libraryId ? await this.hooks.get(libraryId) : null;
    if (libraryId && !library) throw new Error("Skill library package no longer exists");
    const conflicts: string[] = [];
    const resolution = params.resolution as SkillSyncResolution | undefined;
    const base = location.receipt?.package_hash ?? null;
    const targetHash = location.target_hash;
    const libraryHash = library?.observed_hash ?? null;
    const state = skillSynchronizationState(base, libraryHash, targetHash);
    const targetSnapshot =
      targetHash && operation !== "detach"
        ? await this.#store.snapshot(location.destination, targetHash)
        : null;
    const librarySnapshot =
      libraryHash && library?.valid && operation !== "detach"
        ? await this.#store.snapshot(library.path, libraryHash)
        : null;
    let baseSnapshot: string | null = null;
    if (base && operation !== "detach") {
      try {
        await this.#store.verifySnapshot(base);
        baseSnapshot = base;
      } catch {
        /* Never invent a missing baseline. */
      }
    }
    let beforeHash = operation === "pull" ? librarySnapshot : targetSnapshot;
    let candidateHash =
      operation === "pull" || operation === "fork" || (operation === "adopt" && !library)
        ? targetSnapshot
        : librarySnapshot;
    if (operation === "detach") {
      beforeHash = targetSnapshot;
      candidateHash = targetSnapshot;
    }
    if (operation === "restore") {
      if (targetHash !== null)
        conflicts.push("Restore is available only for a missing Skill location");
      const previous = await this.manager.syncBaseline(location);
      candidateHash = previous ? base : libraryHash === base ? librarySnapshot : null;
      beforeHash = null;
      if (!candidateHash) conflicts.push("The last synchronized package cannot be reconstructed");
    } else if (operation !== "detach" && !targetHash)
      conflicts.push("Skill location is missing; restore it explicitly");
    if (operation === "bind" && (!library || libraryHash !== targetHash))
      conflicts.push("Binding requires identical library and target contents");
    if (
      operation === "pull" &&
      !["incoming", "converged", "current"].includes(state) &&
      resolution !== "deployment"
    )
      conflicts.push(
        "Both sides changed or the library is newer; explicitly choose the deployment version",
      );
    if (
      operation === "push" &&
      !["outgoing", "converged", "current"].includes(state) &&
      resolution !== "library"
    )
      conflicts.push("The deployment changed; explicitly choose the library version");
    if (operation === "adopt" && library && libraryHash !== targetHash && !resolution)
      conflicts.push("Choose which version becomes the first synchronized version");
    if (operation === "adopt" && resolution === "deployment") {
      candidateHash = targetSnapshot;
      // This choice updates the selected library while leaving the installation intact.
      if (library) beforeHash = librarySnapshot;
    }
    if (library && !library.valid && !["fork", "detach", "restore"].includes(operation))
      conflicts.push("The library package is invalid");
    if (
      library &&
      library.observed_hash !== library.hash &&
      resolution === undefined &&
      !["detach", "restore"].includes(operation)
    )
      conflicts.push("Library contents contain unaccepted local changes");
    if (!candidateHash && operation !== "detach")
      conflicts.push("No valid candidate package is available");
    const token = randomUUID();
    const plan: SyncPlan = {
      token,
      operation,
      resolution,
      location,
      library,
      library_id: libraryId,
      before_hash: beforeHash,
      candidate_hash: candidateHash,
      target_snapshot: targetSnapshot,
      library_snapshot: librarySnapshot,
      base_snapshot: baseSnapshot,
      base_hash: base,
      policy_revision: (await this.policy()).revision,
      expires: Date.now() + 15 * 60_000,
      conflicts,
    };
    this.#previews.set(token, plan);
    for (const [id, row] of this.#previews)
      if (row.expires <= Date.now()) this.#previews.delete(id);
    if (this.#previews.size > 8) this.#previews.delete(this.#previews.keys().next().value!);
    const delta = await this.#delta(beforeHash, candidateHash);
    const baseChanges = baseSnapshot
      ? {
          base_library: await this.#delta(baseSnapshot, librarySnapshot),
          base_target: await this.#delta(baseSnapshot, targetSnapshot),
        }
      : {};
    return {
      token,
      operation,
      library_id: libraryId,
      requires_home_approval: operation !== "fork" && location.target.scope === "personal",
      expires_at: new Date(plan.expires).toISOString(),
      targets: [
        {
          deployment_id: location.receipt?.id ?? null,
          target_id: location.target.id,
          path: location.destination,
          base_hash: base,
          library_hash: libraryHash,
          target_hash: targetHash,
          state,
          ...delta,
          ...baseChanges,
          conflicts,
        },
      ],
    };
  }
  async #delta(before: string | null, after: string | null) {
    const files = async (hash: string | null) =>
      new Map(
        hash
          ? (await skillPackage(await this.#store.verifySnapshot(hash))).files.map((row) => [
              row.path,
              row,
            ])
          : [],
      );
    const old = await files(before);
    const next = await files(after);
    return {
      added: [...next.keys()].filter((key) => !old.has(key)),
      removed: [...old.keys()].filter((key) => !next.has(key)),
      modified: [...next.keys()].filter(
        (key) =>
          old.has(key) &&
          (old.get(key)!.sha256 !== next.get(key)!.sha256 ||
            old.get(key)!.executable !== next.get(key)!.executable),
      ),
    };
  }
  async apply(
    params: Record<string, unknown>,
    trigger: SkillSyncRun["trigger"] = "manual",
  ): Promise<SkillSyncReport> {
    if (params.confirmed !== true || typeof params.token !== "string")
      throw new Error("Skill synchronization requires a confirmed preview");
    const plan = this.#previews.get(params.token);
    if (!plan || plan.expires <= Date.now())
      throw new Error("Skill sync preview expired or does not exist");
    if (plan.conflicts.length) throw new Error(plan.conflicts.join("; "));
    if (
      plan.operation !== "fork" &&
      plan.location.target.scope === "personal" &&
      params.approve_home !== true
    )
      throw new Error("Personal Skill writes require Agent Home approval");
    if ((await this.policy()).revision !== plan.policy_revision)
      throw new Error("Skill sync policy changed after preview");
    await this.manager.assertSyncOperationAvailable(plan.location.destination);
    this.#previews.delete(params.token);
    const journal: SyncJournal = {
      schema_version: 1,
      kind: "skill-sync",
      operation_id: randomUUID(),
      plan,
      phase: "prepared",
      library_id: plan.library_id,
      started_at: new Date().toISOString(),
      trigger,
    };
    assertSkillSyncJournal(journal, journal.operation_id);
    return this.#execute(journal, params.approve_home === true, true);
  }
  async #execute(
    journal: SyncJournal,
    approveHome: boolean,
    createJournal = false,
  ): Promise<SkillSyncReport> {
    const plan = journal.plan;
    const report: SkillSyncReport = {
      operation_id: journal.operation_id,
      results: [],
      warnings: [],
    };
    let terminalRecovered = false;
    let journalStarted = !createJournal;
    try {
      await withSkillTargetLocks(
        this.root,
        plan.operation === "fork"
          ? []
          : [
              {
                destination: plan.location.destination,
                scope_root: plan.location.target.scope_root,
              },
            ],
        async () => {
          currentTask()?.checkpoint();
          const committingPolicy = await this.policy();
          if (journal.trigger !== "recovery" && committingPolicy.revision !== plan.policy_revision)
            throw new Error("Skill sync policy changed after preview");
          if (journal.trigger === "automatic") {
            const grant = plan.location.receipt
              ? committingPolicy.deployments[plan.location.receipt.id]
              : null;
            if (
              !committingPolicy.enabled ||
              grant?.mode !== "follow" ||
              grant.owner_key !== plan.location.owner_key ||
              grant.target_key !== plan.location.target_key ||
              (plan.location.target.scope === "personal" && !grant.approve_home)
            )
              throw new Error("Skill automatic distribution authorization changed before commit");
          }
          if (createJournal) {
            await this.manager.assertSyncOperationAvailable(plan.location.destination);
            await this.#store.startJournal(journal.operation_id, journal);
            journalStarted = true;
          }
          if (journal.phase === "prepared") {
            const committed = await this.hooks.operationStatus?.(journal.operation_id);
            if (committed?.committed) {
              journal.library_id = committed.library_id;
              journal.phase = "library-committed";
              await this.#store.writeJournal(journal.operation_id, journal);
            } else if (
              (await this.hooks.transactions?.())?.some(
                (row) => row.operation_id === journal.operation_id && row.status === "recovered",
              )
            ) {
              terminalRecovered = true;
              report.results.push({
                success: false,
                status: "recovered",
                library_id: journal.library_id,
                deployment_id: plan.location.receipt?.id,
                path: plan.location.destination,
                error:
                  "The previous Skill library package was restored; prepare a new synchronization preview",
              });
              return;
            }
          }
          const existing = (await this.manager.listDeployments(journal.operation_id)).find(
            (row) => row.operation_id === journal.operation_id,
          );
          if (existing) {
            if (existing.status === "recovery-required") {
              const recovered = await this.manager.recoverSyncOperation(
                journal.operation_id,
                approveHome,
                true,
              );
              if (recovered.results.some((row) => row.status === "recovery-required"))
                throw new Error("Skill deployment still requires recovery");
              if (recovered.results.some((row) => !row.success)) {
                terminalRecovered = true;
                report.results.push({
                  success: false,
                  status: "recovered",
                  library_id: journal.library_id,
                  deployment_id: plan.location.receipt?.id,
                  path: plan.location.destination,
                  error:
                    "The previous Skill package was restored; prepare a new synchronization preview",
                });
                return;
              }
            }
            const completed = (await this.manager.listDeployments(journal.operation_id)).find(
              (row) => row.operation_id === journal.operation_id,
            );
            if (completed) {
              report.results.push({
                success: true,
                status: plan.operation === "detach" ? "detached" : "synchronized",
                deployment_id: completed.id,
                library_id: completed.library_id,
                path: completed.target,
              });
              journal.phase = "location-committed";
              return;
            }
          }
          const fresh = await this.manager.syncLocation(
            plan.location.receipt
              ? { deployment_id: plan.location.receipt.id }
              : {
                  observation_id: plan.location.observation_id,
                },
            plan.operation === "detach" ? "ownership" : "package",
            journal.operation_id,
          );
          if (
            fresh.target_key !== plan.location.target_key ||
            JSON.stringify(fresh.receipt) !== JSON.stringify(plan.location.receipt) ||
            (plan.operation === "detach" && fresh.target_identity !== plan.location.target_identity)
          )
            throw new Error("Skill ownership changed after preview");
          if (journal.phase === "prepared" && fresh.target_hash !== plan.location.target_hash)
            throw new Error("Skill location changed after preview");
          let library = journal.library_id ? await this.hooks.get(journal.library_id) : null;
          if (journal.phase === "prepared") {
            if (
              plan.library &&
              (!library ||
                library.observed_hash !== plan.library.observed_hash ||
                library.lock_fingerprint !== plan.library.lock_fingerprint)
            )
              throw new Error("Skill library changed after preview");
            if (
              ["pull", "push"].includes(plan.operation) &&
              library &&
              library.hash === plan.base_hash &&
              library.observed_hash === plan.base_hash &&
              fresh.target_hash === plan.base_hash
            ) {
              report.results.push({
                success: true,
                status: "current",
                library_id: library.id,
                deployment_id: fresh.receipt?.id,
                path: fresh.destination,
              });
              return;
            }
            if (plan.operation !== "fork")
              await this.manager.reserveSyncLocationLocked(
                fresh,
                journal.operation_id,
                journal.library_id,
                plan.candidate_hash ?? fresh.target_hash,
              );
            if (
              (plan.operation === "fork" || (plan.operation === "adopt" && !plan.library)) &&
              plan.candidate_hash
            ) {
              library = await this.hooks.fork({
                snapshotPath: await this.#store.verifySnapshot(plan.candidate_hash),
                displayName:
                  plan.library?.display_name ??
                  fresh.receipt?.display_name ??
                  path.basename(fresh.destination),
                operationId: journal.operation_id,
                localSource: fresh.destination,
              });
            } else if (
              library &&
              plan.candidate_hash &&
              (plan.candidate_hash !== library.hash || library.observed_hash !== library.hash) &&
              (plan.operation === "pull" ||
                (plan.operation === "adopt" && plan.resolution === "deployment") ||
                ((plan.operation === "push" ||
                  (plan.operation === "adopt" && plan.resolution === "library")) &&
                  library.observed_hash !== library.hash))
            ) {
              library = await this.hooks.accept({
                id: library.id,
                snapshotPath: await this.#store.verifySnapshot(plan.candidate_hash),
                expectedHash: plan.library!.observed_hash!,
                expectedLock: plan.library!.lock_fingerprint,
                operationId: journal.operation_id,
                originDeploymentId: plan.operation === "pull" ? fresh.receipt?.id : undefined,
                originKind:
                  plan.operation === "pull"
                    ? "deployment"
                    : plan.operation === "adopt" && plan.resolution === "deployment"
                      ? "local-import"
                      : "library-edit",
              });
            }
            journal.library_id = library?.id ?? plan.library_id;
            journal.phase = "library-committed";
            await this.#store.writeJournal(journal.operation_id, journal);
          }
          if (!journal.library_id && plan.operation !== "detach")
            throw new Error("Skill synchronization has no library identity");
          if (plan.operation === "fork") {
            report.results.push({
              success: true,
              status: "forked",
              library_id: journal.library_id,
              path: fresh.destination,
              deployment_id: fresh.receipt?.id,
            });
            journal.phase = "location-committed";
            await this.#store.writeJournal(journal.operation_id, journal);
            return;
          }
          await this.manager.reserveSyncLocationLocked(
            fresh,
            journal.operation_id,
            journal.library_id,
            plan.candidate_hash ?? fresh.target_hash,
          );
          const kind =
            plan.operation === "detach"
              ? "detach"
              : plan.operation === "bind"
                ? "bind"
                : plan.operation === "adopt"
                  ? fresh.target_hash === plan.candidate_hash
                    ? "adopt"
                    : "write"
                  : plan.operation === "pull" || fresh.target_hash === plan.candidate_hash
                    ? "baseline"
                    : "write";
          const result = await this.manager.commitSync({
            location: plan.location,
            kind,
            libraryId: journal.library_id ?? plan.location.receipt!.library_id,
            snapshotHash: plan.operation === "detach" ? null : plan.candidate_hash,
            displayName:
              library?.display_name ??
              plan.library?.display_name ??
              path.basename(fresh.destination),
            operationId: journal.operation_id,
            allowTargetDrift: plan.operation === "pull" && journal.phase === "library-committed",
          });
          journal.phase = "location-committed";
          await this.#store.writeJournal(journal.operation_id, journal);
          report.results.push({
            success: true,
            status: plan.operation === "detach" ? "detached" : "synchronized",
            library_id: result.library_id,
            deployment_id: result.id,
            path: result.target,
          });
        },
      );
    } catch (error) {
      let recoveryRequired = journal.phase !== "prepared";
      try {
        if (!journalStarted && createJournal) {
          const saved = await this.#store.readJournal<unknown>(journal.operation_id);
          if (saved !== null) {
            assertSkillSyncJournal(saved, journal.operation_id);
            if ((saved as SyncJournal).plan.token !== plan.token)
              throw new Error("Skill synchronization journal belongs to another preview");
            journalStarted = true;
          }
        }
        if (!journalStarted) {
          recoveryRequired = false;
        } else if (journal.phase === "prepared") {
          const committed = await this.hooks.operationStatus?.(journal.operation_id);
          if (committed?.committed) {
            journal.phase = "library-committed";
            journal.library_id = committed.library_id;
            recoveryRequired = true;
            await this.#store.writeJournal(journal.operation_id, journal);
          } else {
            const pendingLibrary = (await this.hooks.transactions?.())?.some(
              (row) =>
                row.operation_id === journal.operation_id &&
                ["prepared", "committing"].includes(row.status),
            );
            const pendingLocation = (await this.manager.listDeployments(journal.operation_id)).some(
              (row) =>
                row.operation_id === journal.operation_id && row.status === "recovery-required",
            );
            recoveryRequired = Boolean(pendingLibrary || pendingLocation);
            if (!recoveryRequired) {
              await this.#releaseSyncReservation(journal);
              if (await this.#store.readJournal(journal.operation_id))
                await this.#store.removeJournal(journal.operation_id);
            }
          }
        }
      } catch {
        recoveryRequired = true;
        report.warnings.push("The interrupted Skill operation needs recovery status verification");
      }
      report.results.push({
        success: false,
        status: recoveryRequired ? "recovery-required" : "failed",
        error: message(error),
        library_id: journal.library_id,
        deployment_id: plan.location.receipt?.id,
        path: plan.location.destination,
      });
    }
    const recorded = await this.#tryRecord({
      ...report,
      started_at: journal.started_at,
      finished_at: new Date().toISOString(),
      trigger: journal.trigger,
    });
    if (recorded && (terminalRecovered || report.results.every((row) => row.success))) {
      const terminalResults = report.results;
      try {
        await this.#finishJournal(journal);
      } catch (error) {
        if (error instanceof SyncReservationCleanupError)
          report.results = report.results.map((row) => ({
            ...row,
            success: false,
            status: "recovery-required",
            error: message(error),
          }));
        report.warnings.push(
          "Skill contents were saved, but synchronization recovery cleanup is still required",
        );
        await this.#tryRecord({
          ...report,
          results: terminalResults,
          started_at: journal.started_at,
          finished_at: new Date().toISOString(),
          trigger: journal.trigger,
        });
      }
    }
    return report;
  }

  async #releaseSyncReservation(journal: SyncJournal): Promise<void> {
    if (journal.plan.operation === "fork") return;
    await withSkillTargetLocks(
      this.root,
      [
        {
          destination: journal.plan.location.destination,
          scope_root: journal.plan.location.target.scope_root,
        },
      ],
      () => this.manager.releaseSyncReservationLocked(journal.plan.location, journal.operation_id),
    );
  }

  async #finishJournal(journal: SyncJournal): Promise<void> {
    // A durable result and terminal journal precede releasing shared ownership.
    // Keep the journal whenever release fails so recovery always has an entry point.
    try {
      journal.phase = "location-committed";
      await this.#store.writeJournal(journal.operation_id, journal);
      await this.#releaseSyncReservation(journal);
    } catch (error) {
      throw new SyncReservationCleanupError(
        `Skill synchronization cleanup requires recovery: ${message(error)}`,
        { cause: error },
      );
    }
    await this.#store.removeJournal(journal.operation_id);
  }

  async assertLibraryRemovable(libraryId: string): Promise<void> {
    for (const { id, journal: value } of await this.#store.listJournals<unknown>()) {
      assertSkillSyncJournal(value, id);
      if (value.phase === "location-committed") continue;
      const committed = await this.hooks.operationStatus?.(id);
      if (
        value.library_id === libraryId ||
        value.plan.library_id === libraryId ||
        (committed?.committed && committed.library_id === libraryId)
      )
        throw new Error(
          "Recover unfinished Skill synchronization before removing its library package",
        );
    }
  }

  async recoveryTargetId(id: string): Promise<string | null> {
    const value = await this.#store.readJournal<unknown>(id);
    if (value === null) return null;
    assertSkillSyncJournal(value, id);
    return value.plan.location.target.id;
  }
  async recover(params: Record<string, unknown>): Promise<SkillSyncReport> {
    if (params.confirmed !== true || typeof params.operation_id !== "string")
      throw new Error("Skill recovery requires confirmation and an operation ID");
    const value = await this.#store.readJournal<unknown>(params.operation_id);
    if (value === null) {
      const previous = (await this.#runs()).runs.find(
        (row) =>
          row.operation_id === params.operation_id &&
          row.results.every((result) => result.success || result.status === "recovered"),
      );
      if (previous)
        return {
          operation_id: previous.operation_id,
          results: previous.results,
          warnings: previous.warnings,
        };
      const transaction = (await this.hooks.transactions?.())?.find(
        (row) => row.operation_id === params.operation_id,
      );
      if (!transaction) throw new Error("Skill synchronization operation does not exist");
      const started = new Date().toISOString();
      await this.hooks.recover(params.operation_id);
      const recovered = (await this.hooks.transactions?.())?.find(
        (row) => row.operation_id === params.operation_id,
      );
      const success = recovered?.status === "committed" || recovered?.status === "recovered";
      const report: SkillSyncReport = {
        operation_id: params.operation_id,
        warnings: [],
        results: [
          {
            success,
            status: recovered?.status ?? "recovery-required",
            library_id: transaction.library_id,
          },
        ],
      };
      await this.#tryRecord({
        ...report,
        trigger: "recovery",
        started_at: started,
        finished_at: new Date().toISOString(),
      });
      return report;
    }
    assertSkillSyncJournal(value, params.operation_id);
    const journal = value as SyncJournal;
    if (
      journal.plan.operation !== "fork" &&
      journal.plan.location.target.scope === "personal" &&
      params.approve_home !== true
    )
      throw new Error("Personal Skill recovery requires Agent Home approval");
    const completed = (await this.#runs()).runs.find(
      (row) =>
        row.operation_id === journal.operation_id &&
        row.results.every((result) => result.success || result.status === "recovered"),
    );
    if (completed) {
      await this.#finishJournal(journal);
      return {
        operation_id: completed.operation_id,
        results: completed.results,
        warnings: completed.warnings,
      };
    }
    await this.hooks.recover(journal.operation_id);
    journal.trigger = "recovery";
    return this.#execute(journal, params.approve_home === true);
  }
  async runs(params: Record<string, unknown> = {}) {
    const stored = (await this.#runs()).runs;
    const transactions = (await this.hooks.transactions?.()) ?? [];
    const libraryRuns: SkillSyncRun[] = transactions
      .filter((row) => !stored.some((run) => run.operation_id === row.operation_id))
      .map((row) => ({
        operation_id: row.operation_id,
        started_at: row.started_at,
        finished_at: ["committed", "recovered"].includes(row.status) ? row.started_at : null,
        trigger: "manual",
        warnings: [],
        results: [
          {
            success: row.status === "committed",
            library_id: row.library_id,
            status: ["prepared", "committing"].includes(row.status)
              ? "recovery-required"
              : row.status,
            ...(row.error ? { error: row.error } : {}),
          },
        ],
      }));
    const pendingJournals = await this.#store.listJournals<unknown>();
    for (const { id, journal } of pendingJournals) assertSkillSyncJournal(journal, id);
    const pending = (pendingJournals as Array<{ id: string; journal: SyncJournal }>)
      .filter(
        ({ journal }) =>
          journal.kind === "skill-sync" &&
          !stored.some((run) => run.operation_id === journal.operation_id),
      )
      .map(({ journal }): SkillSyncRun => ({
        operation_id: journal.operation_id,
        started_at: journal.started_at,
        finished_at: null,
        trigger: journal.trigger,
        warnings: [],
        results: [
          {
            success: false,
            status: "recovery-required",
            library_id: journal.library_id,
            deployment_id: journal.plan.location.receipt?.id,
            path: journal.plan.location.destination,
          },
        ],
      }));
    const limit =
      typeof params.limit === "number" && Number.isSafeInteger(params.limit)
        ? Math.max(1, Math.min(100, params.limit))
        : 30;
    return {
      runs: [...stored, ...libraryRuns, ...pending]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, limit),
    };
  }
  async #runs(): Promise<RunStore> {
    const value = await readSkillJson<RunStore>(path.join(this.root, "skill-sync-runs.json"));
    if (!value) return { schema_version: 1, last_due_at: null, runs: [] };
    if (value.schema_version !== 1 || !Array.isArray(value.runs) || value.runs.length > 100)
      throw new Error("Invalid Skill synchronization run history");
    return value;
  }
  async #record(run: SkillSyncRun) {
    await withSkillLocks([this.root], async () => {
      const stored = await this.#runs();
      stored.runs = [
        run,
        ...stored.runs.filter((row) => row.operation_id !== run.operation_id),
      ].slice(0, 100);
      await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), stored);
    });
  }
  async #tryRecord(run: SkillSyncRun): Promise<boolean> {
    try {
      await this.#record(run);
      return true;
    } catch {
      run.warnings.push("Skill results were preserved, but saving synchronization history failed");
      return false;
    }
  }
  async #targetRetry(id: string, fingerprint: string, failed: boolean) {
    await withSkillLocks([this.root], async () => {
      const state = await this.#runs();
      state.target_retry ??= {};
      if (!failed) {
        delete state.target_retry[id];
        delete state.blocked_targets?.[id];
      } else {
        const previous = state.target_retry[id];
        const failures = Math.min(
          10,
          previous?.fingerprint === fingerprint ? previous.failures + 1 : 1,
        );
        state.target_retry[id] = {
          fingerprint,
          failures,
          next_at: new Date(
            Date.now() + Math.min(3_600_000, 60_000 * 2 ** (failures - 1)),
          ).toISOString(),
        };
      }
      await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), state);
    });
  }
  async runDue(): Promise<SkillSyncRun | null> {
    if (this.#running) return null;
    this.#running = true;
    try {
      const policy = await this.policy();
      const stored = await this.#runs();
      if (!policy.enabled) return null;
      const run: SkillSyncRun = {
        operation_id: randomUUID(),
        started_at: new Date().toISOString(),
        finished_at: null,
        trigger: "automatic",
        results: [],
        warnings: [],
      };
      const libraries = (await this.hooks.list()).sort((a, b) =>
        (stored.libraries?.[a.id]?.next_at ?? "").localeCompare(
          stored.libraries?.[b.id]?.next_at ?? "",
        ),
      );
      let checkedLibraries = 0;
      for (const library of libraries) {
        if (checkedLibraries >= 1 || policy.interval_hours === 0) break;
        currentTask()?.checkpoint();
        const latest = await this.policy();
        if (!latest.enabled) break;
        const grant = latest.libraries[library.id];
        const mode = grant?.mode ?? latest.default_mode;
        if (mode === "manual") continue;
        const due = await withSkillLocks([this.root], async () => {
          const admissionPolicy = await this.policy();
          if (!admissionPolicy.enabled || admissionPolicy.revision !== latest.revision)
            return false;
          const schedule = await this.#runs();
          const previous = schedule.libraries?.[library.id];
          if (
            previous &&
            previous.owner_key === ownerKey(this.root, library) &&
            previous.source_key === sourceKey(library.source) &&
            Date.parse(previous.next_at) > Date.now()
          )
            return false;
          schedule.libraries ??= {};
          schedule.libraries[library.id] = {
            next_at: new Date(Date.now() + 180_000).toISOString(),
            failures: previous?.failures ?? 0,
            owner_key: ownerKey(this.root, library),
            source_key: sourceKey(library.source),
          };
          schedule.last_due_at = run.started_at;
          await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), schedule);
          return true;
        });
        if (!due) continue;
        checkedLibraries++;
        let checkFailed = false;
        let stage = "check";
        try {
          if (
            mode === "auto_update" &&
            (grant?.owner_key !== ownerKey(this.root, library) ||
              grant.source_key !== sourceKey(library.source))
          )
            throw new Error("Automatic update grant no longer matches the Skill source");
          const checked = await this.hooks.check(library.id);
          if (checked.error) throw new Error(checked.error);
          stage = "apply";
          if (checked.available && mode === "auto_update") {
            if (
              !library.valid ||
              library.observed_hash !== library.hash ||
              (library.upstream_base_hash && library.hash !== library.upstream_base_hash)
            )
              throw new Error(
                "Local Skill changes require manual review before an upstream update",
              );
            const policyRevision = latest.revision;
            await this.hooks.update(
              library.id,
              `${run.operation_id}-${identity(library.id).slice(0, 12)}`,
              async () => {
                const currentPolicy = await this.policy();
                const currentLibrary = await this.hooks.get(library.id);
                const currentGrant = currentPolicy.libraries[library.id];
                if (
                  !currentPolicy.enabled ||
                  currentPolicy.revision !== policyRevision ||
                  currentGrant?.mode !== "auto_update" ||
                  !currentLibrary ||
                  currentGrant.owner_key !== ownerKey(this.root, currentLibrary) ||
                  currentGrant.source_key !== sourceKey(currentLibrary.source)
                )
                  throw new Error("Skill automatic update authorization changed before commit");
              },
            );
            run.results.push({ success: true, status: "library-updated", library_id: library.id });
          } else
            run.results.push({
              success: true,
              status: checked.available ? "update-available" : "current",
              library_id: library.id,
            });
        } catch (error) {
          checkFailed = true;
          run.results.push({
            success: false,
            status: stage === "check" ? "check-failed" : "blocked",
            library_id: library.id,
            error: message(error),
          });
        }
        try {
          await withSkillLocks([this.root], async () => {
            const schedule = await this.#runs();
            schedule.libraries ??= {};
            const failures = checkFailed
              ? Math.min(10, (schedule.libraries[library.id]?.failures ?? 0) + 1)
              : 0;
            const delay = checkFailed
              ? Math.min(3_600_000, 60_000 * 2 ** (failures - 1))
              : latest.interval_hours * 3_600_000;
            schedule.libraries[library.id] = {
              next_at: new Date(Date.now() + delay).toISOString(),
              failures,
              owner_key: ownerKey(this.root, library),
              source_key: sourceKey(library.source),
            };
            await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), schedule);
          });
        } catch {
          run.warnings.push("The Skill check completed, but saving its next check time failed");
        }
      }
      let appliedTargets = 0;
      for (const deployment of (await this.state()).deployments) {
        if (appliedTargets >= 8) break;
        currentTask()?.checkpoint();
        const latest = await this.policy();
        if (!latest.enabled) break;
        const grant = latest.deployments[deployment.id];
        if (!grant || grant.mode !== "follow" || deployment.status === "inactive") continue;
        const fingerprint = identity([
          deployment.sync_state,
          deployment.library_hash,
          deployment.target_hash,
          deployment.base_hash,
          grant,
          latest.revision,
        ]);
        const previous = await this.#runs();
        if (previous.blocked_targets?.[deployment.id] === fingerprint) continue;
        const retry = previous.target_retry?.[deployment.id];
        if (retry?.fingerprint === fingerprint && Date.parse(retry.next_at) > Date.now()) continue;
        try {
          if (
            grant.owner_key !== deployment.owner_key ||
            grant.target_key !== deployment.target_key ||
            (deployment.scope === "personal" && !grant.approve_home)
          )
            throw new Error("Automatic distribution grant no longer matches the Skill location");
          if (deployment.sync_state === "current") continue;
          if (!["outgoing", "converged"].includes(deployment.sync_state)) {
            await withSkillLocks([this.root], async () => {
              const state = await this.#runs();
              state.blocked_targets ??= {};
              state.blocked_targets[deployment.id] = fingerprint;
              await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), state);
            });
            throw new Error("Skill location changes require manual review");
          }
          appliedTargets++;
          const preview = await this.prepare({ operation: "push", deployment_id: deployment.id });
          // A new policy read immediately before application prevents stale grants from being replayed.
          const applyingPolicy = await this.policy();
          if (applyingPolicy.revision !== latest.revision || !applyingPolicy.enabled)
            throw new Error("Skill sync policy changed before automatic distribution");
          const result = await this.apply(
            { token: preview.token, confirmed: true, approve_home: grant.approve_home },
            "automatic",
          );
          run.results.push(...result.results);
          run.warnings.push(...result.warnings);
          try {
            await this.#targetRetry(
              deployment.id,
              fingerprint,
              result.results.some((row) => !row.success),
            );
          } catch {
            run.warnings.push("Skill distribution completed, but saving its retry state failed");
          }
        } catch (error) {
          if (message(error).includes("grant no longer matches")) {
            await withSkillLocks([this.root], async () => {
              const state = await this.#runs();
              state.blocked_targets ??= {};
              state.blocked_targets[deployment.id] = fingerprint;
              await writeSkillJson(path.join(this.root, "skill-sync-runs.json"), state);
            });
          } else await this.#targetRetry(deployment.id, fingerprint, true);
          run.results.push({
            success: false,
            status: "blocked",
            deployment_id: deployment.id,
            library_id: deployment.library_id,
            error: message(error),
          });
        }
      }
      run.finished_at = new Date().toISOString();
      if (!run.results.length && !run.warnings.length) return null;
      await this.#tryRecord(run);
      return run;
    } finally {
      this.#running = false;
    }
  }
}
