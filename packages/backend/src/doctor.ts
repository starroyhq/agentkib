import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { z } from "zod";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { AGENTS, parameters } from "./rpc";
import { Context } from "./context";
import { scanWorkspace } from "./asset-scanner";
import { withinLexical } from "./files";
import { isDirectory, pathIdentity } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { stripBlockComments } from "./context-claude";
import { CONTEXT_NOTE_PREFIX, isProjectScope } from "./context-files";
import { effectiveMcp, type McpServer } from "./mcp-config-read";
import type { Sql } from "./sql";
import { compareUtf8, utcNow } from "./workspaces";
import { sharedInstructionOverlap, unmanagedInstructions } from "./instruction-adoption";
import { MANAGED_START } from "./default-manifest";
import {
  adapterEnabled,
  boundedText,
  assetKind,
  fileHash,
  hash,
  instructionRepairable,
  mcpRepairable,
  normalize,
  safeTarget,
  skillCurrent,
  skillFiles,
  skillRepairable,
  type Agent,
} from "./doctor-files";
interface Issue {
  id: string;
  code: string;
  severity: "error" | "warning" | "info";
  agent?: Agent;
  asset_kind?: string;
  repairable: boolean;
  evidence: { path?: string; detail: string; expected?: string; actual?: string }[];
}
const variants: Record<Agent, string> = {
  codex: "Codex",
  "claude-code": "ClaudeCode",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "GrokBuild",
  antigravity: "Antigravity",
  "deepseek-harness": "DeepSeekHarness",
  devin: "Devin",
};
const summary = (workspace_id: string, issues: Issue[]) => ({
  workspace_id,
  error_count: issues.filter((i) => i.severity === "error").length,
  warning_count: issues.filter((i) => i.severity === "warning").length,
  info_count: issues.filter((i) => i.severity === "info").length,
  repairable_count: issues.filter((i) => i.repairable).length,
  checked_at: utcNow(),
});
export type DoctorSummary = ReturnType<typeof summary>;

/** The latest diagnostic summary of each workspace, read without diagnosing it again. */
export interface DoctorSummaryCache {
  get(workspaceIds: readonly string[]): DoctorSummary[];
  put(summary: DoctorSummary): void;
  delete(workspaceId: string): void;
  /** Drops the summaries of workspaces that are no longer registered. */
  retain(workspaceIds: readonly string[]): void;
}

export function memoryDoctorSummaries(): DoctorSummaryCache {
  const rows = new Map<string, DoctorSummary>();
  return {
    get: (ids) => ids.flatMap((id) => rows.get(id) ?? []),
    put: (row) => void rows.set(row.workspace_id, row),
    delete: (id) => void rows.delete(id),
    retain: (ids) => {
      const keep = new Set(ids);
      for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
    },
  };
}

const storedSummary = z.object({
  workspace_id: z.string(),
  error_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
  info_count: z.number().int().nonnegative(),
  repairable_count: z.number().int().nonnegative(),
  checked_at: z.string(),
});

/**
 * Summaries kept in a table of the shared database, so the last results show right after a
 * restart. The table is created here rather than by a schema migration: an older AgentKib, which
 * requires the shared schema version it knows, keeps opening the database and ignores it.
 */
export class StoredDoctorSummaries implements DoctorSummaryCache {
  constructor(readonly sql: Sql) {
    sql.database.exec(
      "CREATE TABLE IF NOT EXISTS doctor_summaries(workspace_id TEXT PRIMARY KEY, summary TEXT NOT NULL)",
    );
  }
  get(workspaceIds: readonly string[]): DoctorSummary[] {
    return workspaceIds.flatMap((id) => {
      const row = this.sql.one("SELECT summary FROM doctor_summaries WHERE workspace_id = ?", id);
      if (!row) return [];
      try {
        const parsed = storedSummary.safeParse(JSON.parse(String(row.summary)));
        return parsed.success && parsed.data.workspace_id === id ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }
  put(summary: DoctorSummary): void {
    this.sql.run(
      "INSERT OR REPLACE INTO doctor_summaries(workspace_id, summary) VALUES (?, ?)",
      summary.workspace_id,
      JSON.stringify(summary),
    );
  }
  delete(workspaceId: string): void {
    this.sql.run("DELETE FROM doctor_summaries WHERE workspace_id = ?", workspaceId);
  }
  retain(workspaceIds: readonly string[]): void {
    const keep = new Set(workspaceIds);
    for (const row of this.sql.rows("SELECT workspace_id FROM doctor_summaries"))
      if (!keep.has(String(row.workspace_id))) this.delete(String(row.workspace_id));
  }
}

export class Doctor {
  constructor(
    readonly context: Context,
    readonly workspacePath: (id: string) => string,
    readonly summaries: DoctorSummaryCache = memoryDoctorSummaries(),
  ) {}
  async request(method: string, value: unknown) {
    if (method === RUNTIME_METHODS.workspaceDoctorReport) {
      const { id } = parameters(z.object({ id: z.string() }), value);
      try {
        return await this.report(id);
      } catch (error) {
        // As in the app's own caches, a workspace whose report fails is shown as unchecked.
        this.summaries.delete(id);
        throw error;
      }
    }
    const { workspaceIds } = parameters(z.object({ workspaceIds: z.array(z.string()) }), value);
    if (workspaceIds.length > 100)
      throw new Error("workspace doctor accepts at most 100 workspaces");
    // Diagnosing every listed workspace on each read kept the home page waiting for minutes.
    // Reads return the last results; refresh() brings them up to date in the background. A
    // workspace without a summary has never been checked or failed its last check, and callers
    // show it as unchecked.
    return this.summaries.get(workspaceIds);
  }

  /**
   * Diagnoses the workspaces one at a time, in the given order, and keeps each summary. With
   * `maxAgeMs`, a workspace whose summary is younger than that is skipped. Summaries of
   * workspaces not in the list are dropped.
   */
  async refresh(
    workspaceIds: readonly string[],
    maxAgeMs?: number,
  ): Promise<{ checked: number; failed: number }> {
    this.summaries.retain(workspaceIds);
    const now = Date.now();
    const fresh = new Set(
      maxAgeMs === undefined
        ? []
        : this.summaries
            .get(workspaceIds)
            .filter((row) => now - Date.parse(row.checked_at) < maxAgeMs)
            .map((row) => row.workspace_id),
    );
    let checked = 0,
      failed = 0;
    for (const id of workspaceIds) {
      if (fresh.has(id)) continue;
      // Each workspace starts on a new turn of the event loop, so requests that arrive meanwhile
      // are answered between workspaces instead of waiting for the whole list.
      await nextEventLoopTurn();
      if (await this.update(id)) checked++;
      else failed++;
    }
    return { checked, failed };
  }

  /** Diagnoses one workspace and keeps its summary; one that cannot be checked loses it. */
  async update(id: string): Promise<boolean> {
    try {
      await this.report(id);
      return true;
    } catch {
      this.summaries.delete(id);
      return false;
    }
  }

  async report(id: string) {
    const scan = scanWorkspace(this.workspacePath(id)),
      project = scan.root,
      issues: Issue[] = [],
      matrix = [];
    const push = (
      code: string,
      severity: Issue["severity"],
      agent: Agent | null,
      kind: string | null,
      repairable: boolean,
      file: string | null,
      detail: string,
      expected: string | null = null,
      actual: string | null = null,
    ) => {
      const source = `${code}:${agent === null ? "None" : `Some(${variants[agent]})`}:${file === null ? "None" : `Some(${JSON.stringify(file)})`}:${detail}`;
      issues.push({
        id: hash(source).slice(0, 16),
        code,
        severity,
        ...(agent ? { agent } : {}),
        ...(kind ? { asset_kind: kind } : {}),
        repairable,
        evidence: [
          {
            ...(file ? { path: file } : {}),
            detail,
            ...(expected !== null ? { expected } : {}),
            ...(actual !== null ? { actual } : {}),
          },
        ],
      });
    };
    let manifest: Manifest | null = null,
      manifestError: string | null = null;
    if (scan.manifest_exists)
      try {
        manifest = loadManifest(project);
      } catch (error) {
        manifestError = (error as Error).message;
      }
    const installed = new Set(
      this.context.catalog
        .installations()
        .filter((row) => row.installed)
        .map((row) => row.agent),
    );
    let servers: McpServer[] = [],
      mcpError: string | null = null;
    try {
      servers = effectiveMcp(project, this.context.environment);
    } catch (error) {
      mcpError = (error as Error).message;
    }
    if (mcpError)
      push(
        "mcp.config-unavailable",
        "error",
        null,
        "configuration",
        false,
        null,
        mcpError,
        "Readable, valid MCP configuration",
        "Unavailable",
      );
    if (manifestError)
      push(
        "manifest.invalid",
        "error",
        null,
        "configuration",
        false,
        manifestPath(project),
        manifestError,
      );
    for (const warning of scan.warnings) {
      if (warning === manifestError) continue;
      push(
        "native.invalid",
        "error",
        scan.agents.find((item) => item.warnings.includes(warning))?.agent ?? null,
        "configuration",
        false,
        null,
        warning,
      );
    }
    if (manifest) {
      for (const skill of manifest.skills)
        if (!skillFiles(project, path.join(project, skill.path)))
          push(
            "skill.source-unavailable",
            "error",
            null,
            "skill",
            false,
            path.join(project, skill.path),
            `Skill source is missing, unreadable, or has no SKILL.md: ${skill.name}`,
          );
      for (const agent of AGENTS) {
        const state = manifest.adapters[agent];
        if (!state?.enabled) continue;
        for (const target of Object.keys(state.generated_hashes).sort(compareUtf8)) {
          const file = path.isAbsolute(target) ? target : `${project}${path.sep}${target}`,
            expected = state.generated_hashes[target]!,
            actual = fileHash(file);
          if (actual.value === expected) continue;
          push(
            actual.kind === "missing" ? "managed.missing" : "managed.drift",
            "warning",
            agent,
            assetKind(file),
            withinLexical(file, project) &&
              safeTarget(project, file) &&
              actual.kind !== "unavailable" &&
              agent !== "deepseek-harness",
            file,
            actual.kind === "missing"
              ? "AgentKib-managed file is missing"
              : actual.kind === "unavailable"
                ? "AgentKib-managed file is not a readable bounded regular file"
                : "AgentKib-managed file differs from its recorded hash",
            expected,
            actual.value ?? null,
          );
        }
      }
    }
    for (const agent of AGENTS) {
      const native = scan.agents.find((item) => item.agent === agent),
        detected = native?.detected ?? false,
        installedAgent = installed.has(agent),
        applicable = detected || installedAgent,
        writable = agent !== "deepseek-harness",
        enabled = writable && (manifest ? adapterEnabled(manifest, agent) : applicable),
        active = applicable && (enabled || agent === "deepseek-harness");
      const fragments: { cwd: string; content: string; scoped: boolean }[] = [];
      if (manifest) {
        if (manifest.instructions.shared.trim())
          fragments.push({ cwd: project, content: manifest.instructions.shared, scoped: false });
        const override = manifest.instructions.platform_overrides[agent];
        if (override?.trim()) fragments.push({ cwd: project, content: override, scoped: false });
        for (const rule of manifest.instructions.scoped)
          if (rule.content.trim())
            fragments.push({
              cwd: path.join(project, rule.path),
              content: rule.content,
              scoped: true,
            });
      }
      const instructionExpected = fragments.length;
      let instructionActual = 0;
      // Claude Code drops block-level HTML comments from CLAUDE.md files, so what its preview
      // shows may lack a comment the manifest text has; both sides are compared without them.
      const plain = agent === "claude-code" ? stripBlockComments : (text: string) => text;
      const skills =
          manifest?.skills.filter(
            (skill) => !skill.targets.length || skill.targets.includes(agent),
          ) ?? [],
        skillExpected = skills.length,
        skillActual = manifest
          ? skills.filter((skill) => skillCurrent(project, manifest, agent, skill)).length
          : 0,
        canRepairSkills = manifest
          ? skills
              .filter((skill) => !skillCurrent(project, manifest, agent, skill))
              .every((skill) => skillRepairable(project, manifest, agent, skill))
          : true;
      const expectedMcp = new Set(
        manifest && writable
          ? manifest.connections
              .filter(
                (connection) =>
                  connection.name !== "agentkib" &&
                  (!connection.targets.length || connection.targets.includes(agent)),
              )
              .map((connection) => connection.name)
          : [],
      );
      if (active) {
        const cwds = [project];
        for (const fragment of fragments)
          if (isDirectory(fragment.cwd) && !cwds.includes(fragment.cwd)) cwds.push(fragment.cwd);
        const sections: Awaited<ReturnType<Context["resolve"]>>["sections"] = [],
          satisfied = new Set<number>(),
          indeterminate = new Set<number>(),
          seenWarnings = new Set<string>();
        let missingReported = false;
        for (const cwd of cwds)
          try {
            // Claude Code sources outside the workspace are never looked at here: files the
            // Doctor does not manage cannot become a finding.
            const preview = await this.context.resolve(project, cwd, agent, manifest, [], {
                includeOutsideSources: false,
              }),
              truncated = preview.warnings.some(
                (warning) =>
                  !warning.startsWith("Agent home: ") &&
                  (warning.includes("truncated for preview") ||
                    warning.includes("instruction budget")),
              ),
              current = preview.sections.filter(
                (section) =>
                  section.scope !== "platform-override" && isProjectScope(agent, section.scope),
              ),
              here = fragments
                .map((fragment, index) => ({ fragment, index }))
                .filter(({ fragment }) => fragment.cwd === cwd);
            for (const { fragment, index } of here) {
              if (
                current.some(
                  (section) =>
                    normalize(plain(section.content)).includes(
                      normalize(plain(fragment.content)),
                    ) &&
                    (!fragment.scoped ||
                      pathIdentity(path.dirname(section.source)) === pathIdentity(cwd)),
                )
              )
                satisfied.add(index);
              if (truncated) indeterminate.add(index);
            }
            for (const warning of preview.warnings) {
              // Notes only inform (for example "directories above the root were not checked").
              if (warning.startsWith("Agent home: ") || warning.startsWith(CONTEXT_NOTE_PREFIX))
                continue;
              const missing = warning.includes("No project instruction");
              if (
                warning.includes("semantic conflicts") ||
                (missing && !here.length) ||
                seenWarnings.has(warning)
              )
                continue;
              seenWarnings.add(warning);
              missingReported ||= missing;
              push(
                missing ? "instruction.missing" : "context.warning",
                "warning",
                agent,
                "instruction",
                missing &&
                  enabled &&
                  writable &&
                  here.every(({ fragment }) =>
                    instructionRepairable(
                      project,
                      fragment.cwd,
                      agent,
                      manifest,
                      fragment.content,
                      fragment.scoped,
                    ),
                  ),
                cwd,
                warning,
              );
            }
            for (const section of current)
              if (!sections.some((existing) => existing.source === section.source))
                sections.push(section);
          } catch (error) {
            push(
              "context.unavailable",
              "error",
              agent,
              "instruction",
              false,
              cwd,
              (error as Error).message,
            );
          }
        instructionActual = fragments.length
          ? new Set([...satisfied, ...indeterminate]).size
          : sections.length;
        const seen = new Map<string, string>();
        for (const section of sections) {
          const text = normalize(plain(section.content));
          if (!text) continue;
          const first = seen.get(text);
          seen.set(text, section.source);
          if (first)
            push(
              "instruction.exact-duplicate",
              "warning",
              agent,
              "instruction",
              false,
              section.source,
              `Exact duplicate of ${first}`,
            );
          if (
            manifest?.instructions.shared.trim() &&
            withinLexical(section.source, project) &&
            safeTarget(project, section.source)
          ) {
            const raw = boundedText(section.source),
              unmanaged = raw?.includes(MANAGED_START) ? unmanagedInstructions(raw) : null;
            if (unmanaged && sharedInstructionOverlap(manifest.instructions.shared, unmanaged))
              push(
                "instruction.unmanaged-duplicate",
                "warning",
                agent,
                "instruction",
                false,
                section.source,
                "Instruction content outside the AgentKib-managed block overlaps shared project instructions",
                path.join(project, "AGENTS.md"),
              );
          }
        }
        if (instructionActual < instructionExpected && !missingReported) {
          const missing = fragments.filter(
            (_, index) => !satisfied.has(index) && !indeterminate.has(index),
          );
          if (missing.length)
            push(
              "instruction.expected-content-missing",
              "warning",
              agent,
              "instruction",
              enabled &&
                writable &&
                missing.every((fragment) =>
                  instructionRepairable(
                    project,
                    fragment.cwd,
                    agent,
                    manifest,
                    fragment.content,
                    fragment.scoped,
                  ),
                ),
              missing[0]!.cwd,
              "Configured instructions are not present in native context sources",
              String(instructionExpected),
              String(instructionActual),
            );
        }
      }
      if (active && skillActual < skillExpected)
        push(
          "skill.target-missing",
          "warning",
          agent,
          "skill",
          enabled && writable && canRepairSkills,
          null,
          "Manifest Skills are not all visible in the target Agent's project paths",
          String(skillExpected),
          String(skillActual),
        );
      if (agent === "deepseek-harness" && detected)
        push(
          "agent.read-only",
          "info",
          agent,
          null,
          false,
          null,
          "DeepSeek Harness is available for diagnostics only",
        );
      const visible = new Set(
          servers
            .filter(
              (server) =>
                server.enabled && (!server.targets.length || server.targets.includes(agent)),
            )
            .map((server) => server.name),
        ),
        mcpExpected = expectedMcp.size,
        mcpActual = expectedMcp.size
          ? [...expectedMcp].filter((name) => visible.has(name)).length
          : visible.size;
      if (active && !mcpError && [...expectedMcp].some((name) => !visible.has(name)))
        push(
          "mcp.target-missing",
          "warning",
          agent,
          "connection",
          enabled &&
            writable &&
            (!native || !native.warnings.length) &&
            mcpRepairable(project, agent),
          null,
          "Manifest MCP connections are not all visible to the target Agent",
          [...expectedMcp].sort(compareUtf8).join(", "),
          [...visible].sort(compareUtf8).join(", "),
        );
      const agentIssues = issues.filter((issue) => issue.agent === agent),
        attention = (kind: string) =>
          agentIssues.some((issue) => issue.asset_kind === kind && issue.severity !== "info"),
        base = applicable && manifestError ? "unavailable" : active ? "healthy" : "not-applicable",
        status = (flag: boolean) => (base === "not-applicable" ? base : flag ? "attention" : base);
      matrix.push({
        agent,
        detected,
        installed: installedAgent,
        enabled,
        writable,
        instructions: {
          status: status(attention("instruction")),
          expected: instructionExpected,
          actual: instructionActual,
        },
        skills: {
          status: status(attention("skill") || skillActual < skillExpected),
          expected: skillExpected,
          actual: skillActual,
        },
        mcp: {
          status:
            mcpError && active
              ? "unavailable"
              : status((!!mcpError && active) || attention("connection")),
          expected: mcpExpected,
          actual: mcpActual,
        },
      });
    }
    for (const issue of issues) for (const evidence of issue.evidence) evidence.path ??= project;
    if (
      issues.some(
        (issue) =>
          !issue.repairable &&
          issue.severity !== "info" &&
          ([
            "skill.source-unavailable",
            "native.invalid",
            "context.unavailable",
            "mcp.config-unavailable",
          ].includes(issue.code) ||
            (["managed.missing", "managed.drift"].includes(issue.code) &&
              issue.evidence.some((evidence) => withinLexical(evidence.path!, project)))),
      )
    )
      for (const issue of issues) issue.repairable = false;
    const ranks = { error: 0, warning: 1, info: 2 };
    issues.sort(
      (a, b) =>
        ranks[a.severity] - ranks[b.severity] ||
        compareUtf8(a.code, b.code) ||
        compareUtf8(a.id, b.id),
    );
    const result = { summary: summary(id, issues), matrix, issues };
    this.summaries.put(result.summary);
    return result;
  }
}
