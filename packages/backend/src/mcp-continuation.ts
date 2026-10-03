import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { canonicalProject } from "./files";
import { pushChange, type ChangeSet } from "./change-plan";
import { safeKey, mergeToml, object } from "./config-merge";
import { safeTarget } from "./doctor-files";
import type { BackendStore } from "./store";

const TOML_START = "# agentkib:managed:start";
const TOML_END = "# agentkib:managed:end";
const CONTINUATION_ARCHIVE_TOOLS = ["session_search", "session_read_chunk"];

export function planSessionMcpConnection(value: unknown, store: BackendStore): ChangeSet {
  if (!object(value)) throw new Error("Invalid MCP continuation request");
  const workspaceId = value.workspaceId;
  const targetAgent = value.targetAgent;
  const hubStatus = value.mcpHubStatus;
  if (typeof workspaceId !== "string" || !workspaceId.trim())
    throw new Error("Workspace id is required");
  if (workspaceId === "." || workspaceId === "..")
    throw new Error("Workspace id cannot be `.` or `..`");
  if (targetAgent !== "codex" && targetAgent !== "claude-code")
    throw new Error("Continuation MCP setup only supports Codex and Claude Code");
  if (
    !object(hubStatus) ||
    hubStatus.running !== true ||
    typeof hubStatus.port !== "number" ||
    !Number.isInteger(hubStatus.port) ||
    hubStatus.port < 1 ||
    hubStatus.port > 65535
  )
    throw new Error("AgentKib MCP Hub is not running");

  const project = canonicalProject(store.workspacePath(workspaceId));
  const workspace = store.sql.rows(
    "SELECT manifest_workspace_id FROM workspaces WHERE id=?",
    workspaceId,
  )[0];
  if (!workspace) throw new Error("Unknown workspace");
  const continuationWorkspaceId =
    typeof workspace.manifest_workspace_id === "string" && workspace.manifest_workspace_id
      ? workspace.manifest_workspace_id
      : workspaceId;
  const workspaceSegment = encodeSegment(continuationWorkspaceId);
  const url = `http://127.0.0.1:${hubStatus.port}/mcp/v1/workspaces/${workspaceSegment}/agents/{agent}`;
  const target =
    targetAgent === "codex"
      ? path.join(project, ".codex", "config.toml")
      : path.join(project, ".mcp.json");
  if (!safeTarget(project, target))
    throw new Error(
      `MCP configuration path contains a symbolic link or unsafe ancestor: ${target}`,
    );

  const after =
    targetAgent === "codex"
      ? mergeCodexContinuation(target, url)
      : mergeClaudeContinuation(target, url);
  let existed = true;
  let before: string;
  try {
    before = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
    before = "";
  }

  const changes: ChangeSet["changes"] = [];
  if (before !== after) {
    pushChange(
      changes,
      target,
      after,
      "project",
      "medium",
      targetAgent === "codex" ? "toml" : "json",
    );
    const planned = changes[0];
    if (planned && !existed) {
      planned.original_hash = null;
      planned.before = "";
    }
  }
  return {
    id: randomUUID(),
    project_root: project,
    created_at: new Date().toISOString(),
    changes,
    requires_home_approval: false,
  };
}

function mergeCodexContinuation(target: string, url: string): string {
  let existing = "";
  try {
    existing = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const startCount = existing.split(TOML_START).length - 1;
  const endCount = existing.split(TOML_END).length - 1;
  if (startCount === 0 && endCount === 0) {
    return mergeToml(
      target,
      [
        {
          name: "agentkib",
          transport: "http",
          url,
          env: {},
          allow_tools: [],
          targets: ["codex"],
        },
      ],
      "codex",
    );
  }
  if (startCount !== 1 || endCount !== 1)
    throw new Error("AgentKib-managed Codex MCP block is incomplete or ambiguous");
  const start = existing.indexOf(TOML_START);
  const contentStart = start + TOML_START.length;
  const endRelative = existing.slice(contentStart).indexOf(TOML_END);
  if (endRelative < 0) throw new Error("AgentKib-managed Codex MCP block is incomplete");
  const end = contentStart + endRelative;
  const config = parseToml(existing) as Record<string, unknown>;
  const managed = parseToml(existing.slice(contentStart, end)) as Record<string, unknown>;
  const key = safeKey("agentkib");
  const fullServers = config.mcp_servers;
  const managedServers = managed.mcp_servers;
  if (
    object(fullServers) &&
    Object.hasOwn(fullServers, key) &&
    (!object(managedServers) || !Object.hasOwn(managedServers, key))
  )
    throw new Error(
      "Codex configuration already contains an unmanaged MCP with the same name: agentkib. Rename one entry or migrate it to AgentKib to preserve platform-specific fields.",
    );
  if (managedServers === undefined) managed.mcp_servers = {};
  else if (!object(managedServers))
    throw new Error("AgentKib-managed Codex mcp_servers must be a table");
  const servers = managed.mcp_servers as Record<string, unknown>;
  let server = servers[key];
  if (server === undefined) server = {};
  if (!object(server)) throw new Error("AgentKib-managed Codex server must be a table");
  server.url = url.replaceAll("{agent}", "codex");
  for (const field of ["command", "args", "env", "cwd"]) delete server[field];
  server.enabled = true;
  ensureContinuationArchiveTools(server);
  servers[key] = server;
  const block = `${TOML_START}\n${stringifyToml(managed).trimEnd()}\n${TOML_END}`;
  return `${existing.slice(0, start)}${block}${existing.slice(end + TOML_END.length)}`;
}

function ensureContinuationArchiveTools(server: Record<string, unknown>): void {
  for (const key of ["enabled_tools", "disabled_tools"]) {
    const value = server[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    )
      throw new Error(`Codex ${key} must be an array of strings`);
  }
  if (Array.isArray(server.enabled_tools)) {
    const enabled = server.enabled_tools as string[];
    for (const tool of CONTINUATION_ARCHIVE_TOOLS) if (!enabled.includes(tool)) enabled.push(tool);
  }
  if (Array.isArray(server.disabled_tools)) {
    server.disabled_tools = (server.disabled_tools as string[]).filter(
      (tool) => !CONTINUATION_ARCHIVE_TOOLS.includes(tool),
    );
  }
}

function mergeClaudeContinuation(target: string, url: string): string {
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!object(parsed)) throw new Error("JSON root must be an object");
    root = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Invalid JSON: ${target}`, { cause: error });
  }
  if (root.mcpServers === undefined) root.mcpServers = {};
  if (!object(root.mcpServers)) throw new Error("mcpServers must be an object");
  const servers = root.mcpServers;
  const existing = servers.agentkib;
  if (existing !== undefined && !isAgentKibClaudeContinuation(existing))
    throw new Error(
      "Claude configuration already contains an unmanaged MCP with the same name: agentkib",
    );
  const endpoint = url.replaceAll("{agent}", "claude-code");
  if (existing === undefined) {
    servers.agentkib = { type: "http", url: endpoint };
  } else {
    if (!object(existing)) throw new Error("Recognized AgentKib Claude MCP must be an object");
    existing.type = "http";
    existing.url = endpoint;
    delete existing.command;
    delete existing.args;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

function isAgentKibClaudeContinuation(value: unknown): boolean {
  if (
    !object(value) ||
    typeof value.url !== "string" ||
    (value.type !== undefined && value.type !== "http")
  )
    return false;
  const match =
    /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/mcp\/v1\/workspaces\/([^/]+)\/agents\/claude-code$/.exec(
      value.url,
    );
  if (
    !match ||
    !Number.isInteger(Number(match[1])) ||
    Number(match[1]) < 1 ||
    Number(match[1]) > 65535
  )
    return false;
  try {
    const decoded = decodeURIComponent(match[2]!);
    if (!decoded.trim()) return false;
    const canonical = encodeSegment(decoded);
    return canonical === match[2] || (decoded === match[2] && /[^\x00-\x7f]/.test(decoded));
  } catch {
    return false;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
