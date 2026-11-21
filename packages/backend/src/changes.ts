import { isReparseOrSymlink } from "./native-files";
import path from "node:path";
import { lstatSync } from "node:fs";
import { z } from "zod";
import JSON5 from "json5";
import { parameters } from "./rpc";
import {
  applyChanges,
  changeSet,
  validateApplicationArchive,
  type ApplyOptions,
} from "./change-apply";
import {
  assertClaudeConfigWritable,
  claudeConfigFiles,
  claudeGlobalConfigFile,
  claudeGlobalConfigGate,
  resolveClaudeConfig,
} from "./agents/claude/claude-config";
import { canonicalProject, withinLexical } from "./files";
import { lexicalPathIdentity, pathIdentity } from "./paths";
import { loadManifest, manifestPath } from "./manifest";
import { userHome } from "./mcp-config-read";
import type { BackendStore } from "./store";
import { agentMcpHome } from "./agent-home";
import { requireUniqueContinuationWorkspace } from "./workspace-identity";
export function applyRequest(
  value: unknown,
  store: BackendStore,
  dataDir: string,
  environment: NodeJS.ProcessEnv,
  validateAdditionalApplicationData?: (
    changeSet: import("./change-plan").ChangeSet,
    applicationId: string,
    dataDir: string,
  ) => string[],
) {
  const { changeSet: plan, approveHome } = parameters(
      z.object({ changeSet, approveHome: z.boolean() }),
      value,
    ),
    home = userHome(environment),
    xdg =
      environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME
        : path.join(home, ".config");
  const claude = resolveClaudeConfig(environment, home);
  if (claude.invalid) {
    // A request prepared against the default Claude locations gets the real reason instead of the
    // generic "not approved" error below. Nothing under an unusable variable is ever approved.
    const defaults = resolveClaudeConfig({}, home);
    for (const change of plan.changes)
      if (
        change.scope === "agent-home" &&
        (lexicalPathIdentity(change.target) ===
          lexicalPathIdentity(claudeGlobalConfigFile(defaults, home)) ||
          withinLexical(change.target, claudeConfigFiles(defaults).projects))
      )
        assertClaudeConfigWritable(claude);
  }
  const approvedHome = [
    path.join(home, ".codex/config.toml"),
    // The global file only counts while it is certain to be the one Claude Code reads.
    ...(claudeGlobalConfigGate(claude).usable ? [claudeGlobalConfigFile(claude, home)] : []),
    path.join(home, ".gemini/config/mcp_config.json"),
    path.join(xdg, "opencode/opencode.json"),
    path.join(xdg, "opencode/opencode.jsonc"),
    path.join(environment.GROK_HOME ?? path.join(home, ".grok"), "config.toml"),
  ];
  const protectedHome: string[] = [];
  const selectedConfigs = new Map<"open-claw" | "hermes", string[]>();
  for (const change of plan.changes) {
    if (change.scope !== "agent-home") continue;
    let agent: "open-claw" | "hermes" | undefined;
    if (change.validator === "yaml") agent = "hermes";
    else if (change.validator === "json" || change.validator === "jsonc") {
      const openClawMcp = z
        .object({ mcp: z.object({ servers: z.object({ agentkib: z.object({}).passthrough() }) }) })
        .safeParse(JSON5.parse(change.after));
      if (
        openClawMcp.success ||
        !approvedHome.some(
          (target) => lexicalPathIdentity(target) === lexicalPathIdentity(change.target),
        )
      )
        agent = "open-claw";
    }
    if (agent) selectedConfigs.set(agent, [...(selectedConfigs.get(agent) ?? []), change.target]);
  }
  for (const [agent, targets] of selectedConfigs) {
    // Resolve only the involved adapter. A broken unrelated profile cannot block
    // this write, and a configured path overlapping another allowlist stays bound
    // to the OpenClaw config represented by the reviewed payload.
    const selected = agentMcpHome(agent, environment);
    if (
      targets.some((target) => lexicalPathIdentity(target) !== lexicalPathIdentity(selected.config))
    )
      throw new Error("Agent Home target is no longer approved by the current configuration");
    approvedHome.push(selected.config);
    protectedHome.push(path.dirname(selected.config));
  }
  let projectId: string | null = null;
  try {
    projectId = loadManifest(plan.project_root).workspace.id;
  } catch {}
  let applicationId: string | null = null,
    approvedApplication: string[] = [];
  if (plan.changes.some((change) => change.scope === "application-data")) {
    const root = canonicalProject(plan.project_root);
    const rows = store.sql
      .rows("SELECT id,canonical_path,manifest_workspace_id FROM workspaces")
      .filter((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(root));
    if (rows.length !== 1)
      throw new Error("Application data changes require a registered workspace");
    const identity = requireUniqueContinuationWorkspace(store, String(rows[0]!.id), root);
    try {
      applicationId = loadManifest(root).workspace.id;
    } catch (error) {
      try {
        lstatSync(manifestPath(root));
        throw error;
      } catch (metadata) {
        if ((metadata as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      applicationId = identity.archiveWorkspaceId;
    }
    if (applicationId !== identity.archiveWorkspaceId)
      throw new Error("Continuation workspace manifest changed; refresh the workspace");
    try {
      approvedApplication = validateApplicationArchive(plan, applicationId, dataDir);
    } catch (archiveError) {
      if (!validateAdditionalApplicationData) throw archiveError;
      approvedApplication = validateAdditionalApplicationData(plan, applicationId, dataDir);
    }
  }
  const roots = [
    path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions"),
    ...(claude.invalid ? [] : [claudeConfigFiles(claude).projects]),
  ];
  for (const change of plan.changes)
    if (change.scope === "agent-home" && change.validator === "jsonl") {
      const root = roots.find(
        (root) =>
          path.isAbsolute(root) &&
          path.isAbsolute(change.target) &&
          path.extname(change.target) === ".jsonl" &&
          withinLexical(change.target, root),
      );
      if (!root) continue;
      const components =
        process.platform === "win32" ? change.target.split(/[\\/]/) : change.target.split("/");
      if (components.includes("..") || components.includes(".")) continue;
      let safe = true;
      for (let current = path.dirname(change.target); ; current = path.dirname(current)) {
        try {
          if (isReparseOrSymlink(current)) safe = false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") safe = false;
        }
        if (current === root || path.dirname(current) === current) break;
      }
      if (safe) {
        approvedHome.push(change.target);
        protectedHome.push(root);
      }
    }
  for (const change of plan.changes)
    if (
      change.scope === "agent-home" &&
      !approvedHome.some(
        (target) => lexicalPathIdentity(target) === lexicalPathIdentity(change.target),
      )
    )
      throw new Error("Agent Home target is no longer approved by the current configuration");
  const options: ApplyOptions = {
    approvedHome,
    protectedHome,
    approvedApplication,
    approveHome,
    skillHomes: [
      environment.AGENTKIB_HOME ??
        path.join(
          home,
          environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
        ),
    ],
  };
  let success = false;
  try {
    const result = applyChanges(plan, path.join(dataDir, "backups"), options);
    success = true;
    return result;
  } finally {
    try {
      store.sql.audit(
        applicationId ?? projectId,
        success ? "changeset.apply" : "changeset.apply_failed",
        plan.id,
      );
    } catch {
      // The change set already ran: never replace its result or error with an audit failure,
      // but do not let the gap in the audit trail go unnoticed. Static text only, no IDs or paths.
      console.warn("Change set audit event could not be recorded");
    }
  }
}
