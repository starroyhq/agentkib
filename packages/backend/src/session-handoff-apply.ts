import path from "node:path";
import { z } from "zod";
import { applyRequest } from "./changes";
import { changeSet, validateApplicationArchive } from "./change-apply";
import { canonicalProject, withinLexical } from "./files";
import { pathIdentity } from "./paths";
import { userHome } from "./mcp-config-read";
import { archiveManifest } from "./session-model";
import type { BackendStore } from "./store";

const targetAgent = z.enum([
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "deepseek-harness",
]);
const launchRequest = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("native-session"),
    workspace_id: z.string(),
    target_agent: targetAgent,
    target_session_id: z.string(),
    target_path: z.string(),
    archive_id: z.string().optional(),
    archive_hash: z.string().optional(),
  }),
  z.object({
    mode: z.literal("handoff-file"),
    workspace_id: z.string(),
    filename: z.string(),
    target_agent: targetAgent,
    archive_id: z.string().optional(),
    archive_hash: z.string().optional(),
  }),
]);

function archiveChanges(
  plan: z.infer<typeof changeSet>,
  launch: z.infer<typeof launchRequest>,
  dataDir: string,
): void {
  const changes = plan.changes.filter((change) => change.scope === "application-data");
  if (Boolean(launch.archive_id) !== Boolean(launch.archive_hash))
    throw new Error("Session archive launch metadata is incomplete");
  if (!launch.archive_id || !launch.archive_hash) {
    if (changes.length) throw new Error("Unexpected session archive changes");
    return;
  }
  if (changes.length !== 3) throw new Error("Session archive must contain three files");
  validateApplicationArchive(plan, launch.workspace_id, dataDir);
  const manifestChange = changes.find(
    (change) => path.basename(change.target) === "manifest.json",
  )!;
  const manifest = archiveManifest.parse(JSON.parse(manifestChange.after));
  if (
    manifest.archive_id !== launch.archive_id ||
    manifest.workspace_id !== launch.workspace_id ||
    manifest.document_sha256 !== launch.archive_hash
  )
    throw new Error("Session archive manifest does not match its launch request");
}

export function applySessionHandoff(
  value: unknown,
  store: BackendStore,
  dataDir: string,
  environment: NodeJS.ProcessEnv,
): null {
  const request = z.object({ changeSet, launchRequest, approveHome: z.boolean() }).parse(value);
  const workspacePath = canonicalProject(store.workspacePath(request.launchRequest.workspace_id));
  const changeRoot = canonicalProject(request.changeSet.project_root);
  if (pathIdentity(changeRoot) !== pathIdentity(workspacePath))
    throw new Error("handoff workspace does not match ChangeSet");
  const projectChanges = request.changeSet.changes.filter((change) => change.scope === "project");
  const homeChanges = request.changeSet.changes.filter((change) => change.scope === "agent-home");
  if (request.launchRequest.mode === "native-session") {
    if (!request.changeSet.requires_home_approval || homeChanges.length !== 1)
      throw new Error(
        "Native session ChangeSet must require home approval and contain one Agent Home file",
      );
    const change = homeChanges[0]!;
    const home = userHome(environment);
    const root =
      request.launchRequest.target_agent === "codex"
        ? path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions")
        : request.launchRequest.target_agent === "claude-code"
          ? path.join(environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects")
          : null;
    if (
      !root ||
      !path.isAbsolute(request.launchRequest.target_path) ||
      !withinLexical(request.launchRequest.target_path, root) ||
      path.extname(request.launchRequest.target_path) !== ".jsonl"
    )
      throw new Error("Native session escapes the target Agent Home");
    const parts = request.launchRequest.target_path.split(/[\\/]/);
    if (parts.includes(".") || parts.includes(".."))
      throw new Error("Native session path contains an unsafe component");
    if (
      pathIdentity(change.target) !== pathIdentity(request.launchRequest.target_path) ||
      change.validator !== "jsonl"
    )
      throw new Error("Native session ChangeSet contains an unexpected target");
    if (!path.basename(change.target).includes(request.launchRequest.target_session_id))
      throw new Error("Native session ID does not match its file");
    if (
      request.changeSet.changes.some(
        (candidate) => candidate.scope !== "application-data" && candidate.scope !== "agent-home",
      )
    )
      throw new Error("Native session ChangeSet contains an unexpected file");
    const records = change.after
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (!records.length) throw new Error("Native session is empty");
    if (request.launchRequest.target_agent === "codex") {
      const payload = records[0]!.payload;
      if (
        records[0]!.type !== "session_meta" ||
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).id !== "string"
      )
        throw new Error("Codex session metadata is invalid");
    } else if (
      records.some(
        (record) =>
          ["user", "assistant"].includes(String(record.type)) &&
          typeof record.sessionId !== "string",
      )
    ) {
      throw new Error("Claude session metadata is invalid");
    }
  } else {
    if (request.changeSet.requires_home_approval || homeChanges.length)
      throw new Error("Handoff file may not modify Agent Home");
    if (
      !request.launchRequest.filename ||
      request.launchRequest.filename.includes("/") ||
      request.launchRequest.filename.includes("\\") ||
      request.launchRequest.filename.includes("..") ||
      !/\.(md|json)$/.test(request.launchRequest.filename)
    )
      throw new Error("handoff filename must be a Markdown or JSON basename");
    const handoffTarget = pathIdentity(
      path.join(workspacePath, ".agentkib", "handoffs", request.launchRequest.filename),
    );
    const ignoreTarget = pathIdentity(path.join(workspacePath, ".gitignore"));
    const exportChange = projectChanges.find(
      (change) => pathIdentity(change.target) === handoffTarget,
    );
    if (!exportChange) throw new Error("handoff ChangeSet is missing its export file");
    if (
      exportChange.validator !==
      (request.launchRequest.filename.endsWith(".json") ? "json" : "markdown")
    )
      throw new Error("handoff ChangeSet validator does not match its export file");
    if (
      projectChanges.some(
        (change) => ![handoffTarget, ignoreTarget].includes(pathIdentity(change.target)),
      )
    )
      throw new Error("handoff ChangeSet contains an unexpected target");
  }
  archiveChanges(request.changeSet, request.launchRequest, dataDir);
  applyRequest(
    { changeSet: request.changeSet, approveHome: request.approveHome },
    store,
    dataDir,
    environment,
  );
  return null;
}
