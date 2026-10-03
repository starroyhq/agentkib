import { isReparseOrSymlink } from "./native-files";
import path from "node:path";
import { lstatSync } from "node:fs";
import { z } from "zod";
import { parameters } from "./rpc";
import {
  applyChanges,
  changeSet,
  validateApplicationArchive,
  type ApplyOptions,
} from "./change-apply";
import { canonicalProject, withinLexical } from "./files";
import { pathIdentity } from "./paths";
import { loadManifest, manifestPath } from "./manifest";
import { userHome } from "./mcp-config-read";
import type { BackendStore } from "./store";
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
  const approvedHome = [
    path.join(home, ".openclaw/openclaw.json"),
    path.join(home, ".hermes/config.yaml"),
    path.join(home, ".codex/config.toml"),
    path.join(home, ".claude.json"),
    path.join(home, ".gemini/config/mcp_config.json"),
    path.join(xdg, "opencode/opencode.json"),
    path.join(xdg, "opencode/opencode.jsonc"),
    path.join(environment.GROK_HOME ?? path.join(home, ".grok"), "config.toml"),
  ];
  let projectId: string | null = null;
  try {
    projectId = loadManifest(plan.project_root).workspace.id;
  } catch {}
  let applicationId: string | null = null,
    approvedApplication: string[] = [];
  if (plan.changes.some((change) => change.scope === "application-data")) {
    const root = canonicalProject(plan.project_root);
    try {
      applicationId = loadManifest(root).workspace.id;
    } catch (error) {
      try {
        lstatSync(manifestPath(root));
        throw error;
      } catch (metadata) {
        if ((metadata as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const rows = store.sql
        .rows("SELECT id,canonical_path,manifest_workspace_id FROM workspaces")
        .filter((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(root));
      if (rows.length !== 1)
        throw new Error("Application data changes require a registered workspace");
      applicationId = String(rows[0]!.manifest_workspace_id ?? rows[0]!.id);
    }
    try {
      approvedApplication = validateApplicationArchive(plan, applicationId, dataDir);
    } catch (archiveError) {
      if (!validateAdditionalApplicationData) throw archiveError;
      approvedApplication = validateAdditionalApplicationData(plan, applicationId, dataDir);
    }
  }
  const roots = [
      path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions"),
      path.join(environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects"),
    ],
    protectedHome: string[] = [];
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
  const options: ApplyOptions = { approvedHome, protectedHome, approvedApplication, approveHome };
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
    } catch {}
  }
}
