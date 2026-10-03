import path from "node:path";
import { readText } from "./files";
import { scanWorkspace, readableSkillPath } from "./asset-scanner";
import { loadManifest } from "./manifest";
import { searchSessionArchive, readSessionArchiveChunk } from "./session-archive";
import type { BackendStore } from "./store";
import type { Context } from "./context";
import { canonicalize, pathIdentity } from "./paths";
import { isFile, within } from "./files";

export const BUILTIN_MCP_TOOLS = [
  {
    name: "workspace_get_context",
    description: "Resolve the effective Agent context for this workspace",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    readOnlyHint: true,
  },
  {
    name: "asset_list",
    description: "List governed Agent assets in this workspace",
    inputSchema: { type: "object", properties: {} },
    readOnlyHint: true,
  },
  {
    name: "asset_get",
    description: "Read one text asset from the governed workspace asset inventory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    readOnlyHint: true,
  },
  {
    name: "skill_list",
    description: "List shared Skills visible in this workspace",
    inputSchema: { type: "object", properties: {} },
    readOnlyHint: true,
  },
  {
    name: "memory_search",
    description: "Search user-approved shared memories",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
    readOnlyHint: true,
  },
  {
    name: "memory_propose",
    description: "Propose a memory for user review; this never approves it",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "user_preference",
            "project_fact",
            "decision",
            "constraint",
            "failed_attempt",
            "open_loop",
            "task_state",
            "agent_observation",
          ],
        },
        content: { type: "string" },
        source_thread: { type: "string" },
        source_reference: { type: "string" },
      },
      required: ["type", "content"],
    },
    readOnlyHint: false,
  },
  {
    name: "session_search",
    description:
      "Search archive text or an exact block/turn locator; hits include bounded chunk ranges",
    inputSchema: {
      type: "object",
      properties: {
        archive_id: { type: "string" },
        query: { type: "string", maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["archive_id"],
    },
    readOnlyHint: true,
  },
  {
    name: "session_read_chunk",
    description: "Read one bounded chunk from a private AgentKib continuation archive",
    inputSchema: {
      type: "object",
      properties: {
        archive_id: { type: "string" },
        chunk_id: { type: "string", pattern: "^chunk-[0-9]{6}$" },
      },
      required: ["archive_id", "chunk_id"],
    },
    readOnlyHint: true,
  },
] as const;

export class McpBuiltins {
  constructor(
    readonly store: BackendStore,
    readonly context: Context,
    readonly dataDir: string,
  ) {}

  async call(
    project: string,
    workspaceId: string,
    agent: string,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case "workspace_get_context":
        return this.context.request({
          project,
          cwd: typeof arguments_.cwd === "string" ? arguments_.cwd : project,
          agent,
        });
      case "asset_list":
        return scanWorkspace(project).assets;
      case "asset_get":
        return this.#asset(project, arguments_.path);
      case "skill_list":
        return loadManifest(project).skills;
      case "memory_search": {
        const query = typeof arguments_.query === "string" ? arguments_.query : "";
        const requestedLimit = Number.isInteger(arguments_.limit)
          ? (arguments_.limit as number)
          : 10;
        return this.store.catalog.search(
          loadManifest(project).workspace.id,
          query,
          Math.min(50, Math.max(1, requestedLimit)),
        );
      }
      case "memory_propose": {
        const manifest = loadManifest(project);
        if (typeof arguments_.type !== "string" || typeof arguments_.content !== "string")
          throw new Error("Missing memory type or content");
        return this.store.catalog.propose({
          project_id: manifest.workspace.id,
          memory_type: arguments_.type,
          content: arguments_.content,
          source_agent: agent,
          source_thread: optionalText(arguments_.source_thread),
          source_reference: optionalText(arguments_.source_reference),
        });
      }
      case "session_search": {
        const archiveId = requiredText(arguments_.archive_id, "archive ID");
        const query = typeof arguments_.query === "string" ? arguments_.query : "";
        const limit = Number.isInteger(arguments_.limit) ? (arguments_.limit as number) : 10;
        return searchSessionArchive(this.dataDir, workspaceId, archiveId, query, limit);
      }
      case "session_read_chunk":
        return readSessionArchiveChunk(
          this.dataDir,
          workspaceId,
          requiredText(arguments_.archive_id, "archive ID"),
          requiredText(arguments_.chunk_id, "chunk ID"),
        );
      default:
        throw new Error(`Unknown built-in tool: ${name}`);
    }
  }

  #asset(project: string, value: unknown) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Missing asset path");
    const root = canonicalize(project);
    const requestedInput = path.resolve(root, value);
    const requested = canonicalize(requestedInput);
    const scan = scanWorkspace(root);
    const readable = scan.assets.some((asset) => {
      if (asset.kind === "memory") return false;
      if (pathIdentity(asset.path) === pathIdentity(requested)) return true;
      if (asset.kind !== "skill" || !isFile(asset.path)) return false;
      const relative = path.relative(path.dirname(asset.path), requestedInput);
      return (
        within(requested, path.dirname(asset.path)) &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        readableSkillPath(relative)
      );
    });
    if (!readable) throw new Error("The requested path is not in the readable asset inventory");
    return { path: requested, content: readText(requested, 256 * 1024) };
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
}
