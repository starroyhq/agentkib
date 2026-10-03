import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { changeSet as changeSetSchema } from "./change-apply";
import { applyRequest } from "./changes";
import { canonicalProject } from "./files";
import { CursorBridge } from "./cursor-bridge";
import { CursorIdeSessions, prepareCursorIdePayload } from "./cursor-ide-sessions";
import { fingerprintSessionDocument } from "./session-handoff";
import type { SessionDocument } from "./session-model";
import type { SessionStore } from "./session-store";
import type { BackendStore } from "./store";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export class CursorImportOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorImportOutcomeUnknownError";
  }
}

function promptProjection(document: SessionDocument) {
  return document.turns.map((turn) => ({
    role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
    text: turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
  }));
}
const envelopeSchema = z
  .object({
    changeSet: z.unknown(),
    approveHome: z.literal(true),
    launchRequest: z
      .object({
        mode: z.literal("native-import"),
        operation_id: z.string().uuid(),
        workspace_id: z.string(),
        target_agent: z.literal("cursor"),
        plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
        binding_id: z.string().uuid(),
      })
      .strict(),
  })
  .strict();
type Plan = {
  schema_version: 1;
  operation_id: string;
  workspace_id: string;
  workspace: string;
  source_session_id: string;
  source_fingerprint: string;
  target_agent: "cursor";
  target_session_id: string;
  context: import("./cursor-bridge").CursorBridgeContext;
  before_native_refs: string[];
  document: SessionDocument;
  expected: SessionDocument;
  payload: string;
  marker: string;
};

function saveReceipt(
  file: string,
  receipt: {
    schema_version: 1;
    plan_hash: string;
    target_session_id: string;
    verified: boolean;
    launched: boolean;
  },
): void {
  if (existsSync(file)) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Unsafe Cursor import receipt");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    if (existsSync(temporary))
      try {
        unlinkSync(temporary);
      } catch {}
  }
}

export async function continueCursorNativeImport(
  value: unknown,
  sessions: { document(id: string): Promise<SessionDocument> },
  sessionStore: SessionStore,
  store: BackendStore,
  dataDir: string,
  bridge: CursorBridge,
  environment: NodeJS.ProcessEnv,
): Promise<{ status: "launched"; receipt: { target_agent: "cursor"; terminal: string } }> {
  const input = envelopeSchema.parse(value);
  const request = input.launchRequest;
  const changeSet = changeSetSchema.parse(input.changeSet);
  if (
    changeSet.id !== request.operation_id ||
    !changeSet.requires_home_approval ||
    changeSet.changes.length !== 1
  )
    throw new Error("Cursor import requires one reviewed plan and Agent Home approval");
  const change = changeSet.changes[0]!;
  const directory = path.join(
    dataDir,
    "continuations",
    hash(request.workspace_id).slice(0, 32),
    request.operation_id,
    "import",
  );
  const planFile = path.join(directory, "plan.json");
  const content = Buffer.from(change.after);
  if (
    change.scope !== "application-data" ||
    change.validator !== "json" ||
    change.target !== planFile ||
    change.original_hash !== null ||
    change.before !== "" ||
    hash(content) !== request.plan_hash
  )
    throw new Error("Cursor import plan does not match the reviewed operation");
  const plan = JSON.parse(content.toString("utf8")) as Plan;
  const persisted = existsSync(planFile);
  if (persisted) {
    const metadata = lstatSync(planFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !readFileSync(planFile).equals(content))
      throw new Error("Persisted Cursor import plan changed");
  }
  const sourceSummary = persisted ? null : sessionStore.get(plan.source_session_id);
  if (!persisted && !sourceSummary) throw new Error("Cursor import source is unavailable");
  const workspaceRecord = (
    persisted
      ? (
          store.listWorkspaces() as Array<{
            id: string;
            path: string;
            manifest_workspace_id?: string | null;
          }>
        ).find(
          (item) =>
            (item.manifest_workspace_id ?? item.id) === request.workspace_id &&
            canonicalProject(item.path) === plan.workspace,
        )
      : store.getWorkspace(sourceSummary!.workspace_id)
  ) as {
    id: string;
    path: string;
    manifest_workspace_id?: string | null;
  };
  if (!workspaceRecord) throw new Error("Cursor import workspace is unavailable");
  const effectiveWorkspace = workspaceRecord.manifest_workspace_id ?? workspaceRecord.id;
  const workspace = canonicalProject(store.workspacePath(workspaceRecord.id));
  if (
    plan.schema_version !== 1 ||
    plan.operation_id !== request.operation_id ||
    plan.workspace_id !== effectiveWorkspace ||
    plan.target_agent !== "cursor" ||
    plan.context.binding_id !== request.binding_id ||
    plan.workspace !== workspace ||
    plan.source_session_id === "" ||
    plan.target_session_id !== plan.operation_id ||
    effectiveWorkspace !== request.workspace_id ||
    plan.document.source.workspace_id !== effectiveWorkspace
  )
    throw new Error("Cursor import plan identity mismatch");
  bridge.validateContext(plan.context);
  if (fingerprintSessionDocument(plan.document) !== plan.source_fingerprint)
    throw new Error("Persisted Cursor source snapshot changed");
  if (!persisted) {
    const current = await sessions.document(plan.source_session_id);
    current.source.workspace_id = effectiveWorkspace;
    if (fingerprintSessionDocument(current) !== plan.source_fingerprint)
      throw new Error("Source changed after Cursor import preview");
  }
  const currentBinding = bridge.context(request.binding_id, workspace);
  if (JSON.stringify(currentBinding) !== JSON.stringify(plan.context))
    throw new Error("Cursor binding changed after preview");
  const prepared = prepareCursorIdePayload(plan.document, plan.operation_id, plan.workspace);
  if (
    prepared.payload !== plan.payload ||
    prepared.marker !== plan.marker ||
    JSON.stringify(prepared.expected) !== JSON.stringify(plan.expected)
  )
    throw new Error("Cursor import payload differs from the reviewed source");

  if (!persisted) {
    applyRequest(
      { changeSet, approveHome: true },
      store,
      dataDir,
      environment,
      (reviewed, applicationId, currentDataDir) => {
        if (
          applicationId !== request.workspace_id ||
          currentDataDir !== dataDir ||
          reviewed.id !== request.operation_id ||
          reviewed.changes.length !== 1 ||
          !reviewed.requires_home_approval ||
          reviewed.changes[0]!.target !== planFile ||
          reviewed.changes[0]!.after !== content.toString("utf8")
        )
          throw new Error("Cursor import plan changed before approval");
        return [planFile];
      },
    );
  }

  const receiptFile = path.join(directory, "receipt.json");
  let receipt: {
    schema_version: 1;
    plan_hash: string;
    target_session_id: string;
    verified: boolean;
    launched: boolean;
  } = {
    schema_version: 1,
    plan_hash: request.plan_hash,
    target_session_id: "",
    verified: false,
    launched: false,
  };
  if (existsSync(receiptFile)) {
    const metadata = lstatSync(receiptFile);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Unsafe Cursor import receipt");
    receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as typeof receipt;
    if (
      receipt.schema_version !== 1 ||
      receipt.plan_hash !== request.plan_hash ||
      typeof receipt.target_session_id !== "string" ||
      typeof receipt.verified !== "boolean" ||
      typeof receipt.launched !== "boolean"
    )
      throw new Error("Cursor import receipt mismatch");
  }
  if (!receipt.target_session_id) {
    const attemptFile = path.join(directory, "attempted.json");
    if (!existsSync(attemptFile))
      writeFileSync(attemptFile, JSON.stringify({ plan_hash: request.plan_hash }), {
        flag: "wx",
        mode: 0o600,
      });
    else if (JSON.parse(readFileSync(attemptFile, "utf8")).plan_hash !== request.plan_hash)
      throw new Error("Cursor import attempt fingerprint changed");
    try {
      const importer = await bridge.call(plan.context, "import", {
        operation_id: plan.operation_id,
        plan_hash: request.plan_hash,
        payload: plan.payload,
        payload_hash: hash(plan.payload),
      });
      if (
        !importer ||
        typeof importer !== "object" ||
        (importer as { consumed?: unknown }).consumed !== true
      )
        throw new Error("Cursor did not confirm consuming the import operation");
      const provider = new CursorIdeSessions(bridge);
      const before = new Set(plan.before_native_refs);
      const deadline = Date.now() + 30_000;
      let found: string | undefined;
      while (Date.now() < deadline) {
        const candidates = provider
          .list(workspace)
          .sessions.filter(
            (session) =>
              !before.has(session.native_ref) &&
              (session.title === plan.marker || session.title === `(1) ${plan.marker}`),
          );
        if (candidates.length === 1) {
          const actual = provider.document(candidates[0]!, effectiveWorkspace, workspace);
          provider.verifyPromptProjection(
            candidates[0]!.native_ref,
            workspace,
            promptProjection(plan.expected),
          );
          const projected = actual.turns.map((turn) => [
            turn.role,
            turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
          ]);
          const expected = plan.expected.turns.map((turn) => [
            turn.role,
            turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
          ]);
          if (JSON.stringify(projected) !== JSON.stringify(expected))
            throw new Error("Cursor imported history differs from the approved preview");
          found = candidates[0]!.native_ref;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!found) throw new Error("Cursor history readback is not yet available");
      receipt.target_session_id = found;
      receipt.verified = true;
      saveReceipt(receiptFile, receipt);
    } catch (error) {
      throw new CursorImportOutcomeUnknownError(
        `Cursor import outcome needs reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const provider = new CursorIdeSessions(bridge);
  const actual = provider
    .list(workspace)
    .sessions.find((session) => session.native_ref === receipt.target_session_id);
  if (!actual) throw new Error("Verified Cursor import is no longer readable");
  const imported = provider.document(actual, effectiveWorkspace, workspace);
  provider.verifyPromptProjection(
    actual.native_ref,
    workspace,
    promptProjection(plan.expected),
    !receipt.verified,
  );
  if (
    (!receipt.verified && imported.turns.length !== plan.expected.turns.length) ||
    JSON.stringify(
      imported.turns
        .slice(0, plan.expected.turns.length)
        .map((turn) => [
          turn.role,
          turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
        ]),
    ) !==
      JSON.stringify(
        plan.expected.turns.map((turn) => [
          turn.role,
          turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
        ]),
      ) ||
    (!receipt.verified && actual.title !== plan.marker && actual.title !== `(1) ${plan.marker}`)
  )
    throw new Error("Cursor imported history no longer matches its reviewed preview");
  receipt.verified = true;
  const nativeId = new CursorIdeSessions(bridge).nativeId(receipt.target_session_id, workspace);
  await bridge.call(plan.context, "open", { native_id: nativeId }).catch((error: unknown) => {
    throw new Error(
      `Cursor imported the session but could not reopen it: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  receipt.launched = true;
  saveReceipt(receiptFile, receipt);
  return { status: "launched", receipt: { target_agent: "cursor", terminal: "Cursor IDE" } };
}

export async function reconcileCursorNativeImport(
  requestValue: unknown,
  sessions: { document(id: string): Promise<SessionDocument> },
  sessionStore: SessionStore,
  store: BackendStore,
  dataDir: string,
  bridge: CursorBridge,
  environment: NodeJS.ProcessEnv,
) {
  const request = z
    .object({
      mode: z.literal("native-import"),
      operation_id: z.string().uuid(),
      workspace_id: z.string(),
      target_agent: z.literal("cursor"),
      plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
      binding_id: z.string().uuid(),
    })
    .strict()
    .parse(requestValue);
  const directory = path.join(
    dataDir,
    "continuations",
    hash(request.workspace_id).slice(0, 32),
    request.operation_id,
    "import",
  );
  const planFile = path.join(directory, "plan.json");
  const metadata = lstatSync(planFile);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Cursor import plan is unavailable");
  const content = readFileSync(planFile);
  if (hash(content) !== request.plan_hash) throw new Error("Cursor import recovery plan changed");
  const plan = JSON.parse(content.toString("utf8")) as Plan;
  const changeSet = {
    id: request.operation_id,
    project_root: plan.workspace,
    created_at: new Date().toISOString(),
    requires_home_approval: true,
    changes: [
      {
        target: planFile,
        scope: "application-data",
        original_hash: null,
        before: "",
        after: content.toString("utf8"),
        risk: "high",
        validator: "json",
      },
    ],
  };
  return continueCursorNativeImport(
    { changeSet, launchRequest: request, approveHome: true },
    sessions,
    sessionStore,
    store,
    dataDir,
    bridge,
    environment,
  );
}
