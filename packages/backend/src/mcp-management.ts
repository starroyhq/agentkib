import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";
import { mcpDiagnostic, mcpErrorDiagnostic } from "./mcp-diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyChanges } from "./change-apply";
import { type ChangeSet, type FileChange } from "./change-plan";
import { hash } from "./doctor-files";
import { canonicalize, pathIdentity } from "./paths";
import { safeAgentHomePath } from "./agent-home";
import {
  effectiveMcp,
  mergeMcpDocuments,
  readMcpDocument,
  serverSchema,
  userHome,
  type McpServer,
} from "./mcp-config-read";
import {
  hasInlineMcpCredentials,
  parseMcpImport,
  publicMcpConfig,
  type ParsedMcpImport,
} from "./mcp-import";
import { recordClaudeGlobalWrite } from "./agents/claude/claude-global-writes";
import { readNativeMcpImports, scanNativeMcp } from "./mcp-native-scan";
import type { BackendStore } from "./store";
import type { McpManager } from "./mcp";
import { planNativeMcpMigration } from "./mcp-migration-plan";
import { publicMcpMigrationChanges } from "./mcp-migration-preview";

export type McpSecretOperation =
  | { action: "keep" | "delete" }
  | { action: "replace"; value: string };
export type McpSecretOperations = {
  env?: Record<string, McpSecretOperation>;
  headers?: Record<string, McpSecretOperation>;
};
export type McpManagedServer = {
  config: McpServer;
  scope: "global" | "workspace";
  inherited: boolean;
  required_env: string[];
  required_headers: string[];
  configured_env: string[];
  configured_headers: string[];
  oauth_configured: boolean;
};
export type McpManagementState = { revision: string; servers: McpManagedServer[] };
export type McpImportPreviewItem = {
  key: string;
  config?: McpServer;
  status: "new" | "identical" | "conflict" | "blocked";
  warnings: string[];
  warning_messages?: McpDiagnosticMessage[];
  required_env: string[];
  required_headers: string[];
};
export type McpImportPreview = { token: string; revision: string; items: McpImportPreviewItem[] };
export type McpImportSelection = { key: string; action: "add" | "replace" | "skip"; id?: string };
export type McpImportResult = {
  revision: string;
  results: {
    key: string;
    id?: string;
    status: "saved" | "skipped" | "failed";
    error?: string;
    error_message?: McpDiagnosticMessage;
  }[];
};
export type McpMigrationPreview = {
  token: string;
  revision: string;
  requires_home_approval: boolean;
  changes: { target: string; scope: string; before: string; after: string }[];
};
export type McpMigrationResult = { changeset_id: string; applied: string[]; backup_dir: string };
const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
  z.object({ action: z.literal("replace"), value: z.string().max(64 * 1024) }).strict(),
]);
const secretOperationsSchema = z
  .object({
    env: z.record(z.string(), operationSchema).optional(),
    headers: z.record(z.string(), operationSchema).optional(),
  })
  .strict();
const scopeSchema = z.object({ project: z.string().optional() });
const saveSchema = scopeSchema
  .extend({
    revision: z.string(),
    server: z.unknown(),
    originalId: z.string().optional(),
    secretOperations: secretOperationsSchema.optional(),
    overrideInherited: z.boolean().optional(),
  })
  .strict();
const removeSchema = scopeSchema.extend({ revision: z.string(), id: z.string() }).strict();
const previewSchema = scopeSchema
  .extend({
    text: z.string().optional(),
    candidateIds: z.array(z.string()).min(1).max(128).optional(),
  })
  .strict();
const importSchema = scopeSchema
  .extend({
    revision: z.string(),
    token: z.string(),
    selections: z
      .array(
        z
          .object({
            key: z.string(),
            action: z.enum(["add", "replace", "skip"]),
            id: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();
type Snapshot = { file: string; before: string | null };
type Scope = { project: string | null; directory: string; snapshots: Snapshot[]; revision: string };
type StoredPreview = {
  project: string | null;
  expires: number;
  revision: string;
  parsed: ParsedMcpImport[];
  candidateIds?: string[];
  fingerprints?: string[];
};
const encode = (servers: McpServer[]) =>
  JSON.stringify(
    { schema_version: 1, servers: [...servers].sort((a, b) => a.id.localeCompare(b.id)) },
    null,
    2,
  ) + "\n";
const equal = (a: unknown, b: unknown): boolean => stable(a) === stable(b);
function connectionText(config: McpServer): Record<string, string> {
  return config.transport === "stdio"
    ? {
        command: config.command,
        cwd: config.cwd ?? "",
        ...Object.fromEntries(config.args.map((value, index) => [`args.${index}`, value])),
      }
    : { url: config.url };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function comparable(server: McpServer) {
  const result = { ...server };
  delete result.native_source;
  delete result.required_env;
  delete result.required_headers;
  delete result.local_values_only;
  delete result.deleted_env;
  delete result.deleted_headers;
  delete result.clear_oauth;
  result.enabled = false;
  return result;
}
function sameDefinition(imported: McpServer, existing: McpServer): boolean {
  const a = comparable(imported),
    b = comparable(existing);
  if (imported.native_source) {
    a.env = {};
    a.headers = {};
    b.env = {};
    b.headers = {};
    delete a.oauth_credentials;
    delete b.oauth_credentials;
  }
  return equal(a, b);
}
function snapshot(file: string): Snapshot {
  safeAgentHomePath(file);
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error("MCP configuration must be a regular file of at most 1 MiB");
    return { file, before: readFileSync(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, before: null };
    throw error;
  }
}
function cleanPublic(server: McpServer): McpServer {
  const result = { ...server, env: {}, headers: {} };
  delete result.oauth_credentials;
  delete result.local_values_only;
  delete result.deleted_env;
  delete result.deleted_headers;
  delete result.clear_oauth;
  return result;
}

/** Mutations remain synchronous between revision validation and final replacement.
 * Internal ChangeSets keep private bytes in the host and its restricted backups. */
export class McpManagement {
  #previews = new Map<string, StoredPreview>();
  #migrations = new Map<
    string,
    {
      project: string;
      revision: string;
      expires: number;
      hub: string;
      candidates: string[];
      fingerprints: string[];
      plan: ChangeSet;
      /** Servers this migration takes out of Claude Code's global file, kept for a later check. */
      claudeGlobal: { file: string; names: string[] }[];
    }
  >();
  constructor(
    readonly store: BackendStore,
    readonly environment: NodeJS.ProcessEnv,
    readonly dataDir: string,
    readonly manager: McpManager,
  ) {}

  #scope(project?: string): Scope {
    let root: string | null = null;
    let identity: unknown = null;
    if (project) {
      root = canonicalize(project);
      const rows = this.store.sql
        .rows("SELECT id,canonical_path FROM workspaces")
        .filter((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(root!));
      if (rows.length !== 1)
        throw new Error("MCP project scope must identify one registered workspace");
      identity = rows[0];
    }
    const global = path.join(canonicalize(userHome(this.environment)), ".agentkib");
    const directory = root ? path.join(root, ".agentkib") : global;
    if (root && pathIdentity(directory) === pathIdentity(global))
      throw new Error(
        "Workspace MCP scope overlaps global configuration; use the explicit global scope",
      );
    const snapshots = [...new Set([global, directory])].flatMap((dir) => [
      snapshot(path.join(dir, "mcp.json")),
      snapshot(path.join(dir, "mcp.local.json")),
    ]);
    const revision = createHash("sha256")
      .update(stable([identity, snapshots]))
      .digest("hex");
    return { project: root, directory, snapshots, revision };
  }

  state(request: unknown = {}): McpManagementState {
    const { project } = scopeSchema.strict().parse(request);
    const scope = this.#scope(project);
    const own = new Set(
      ["mcp.json", "mcp.local.json"]
        .flatMap((file) => readMcpDocument(path.join(scope.directory, file)))
        .filter((server) => !server.local_values_only)
        .map((server) => server.id),
    );
    return {
      revision: scope.revision,
      servers: effectiveMcp(scope.project, this.environment).map((server) => ({
        config: publicMcpConfig(server),
        scope: scope.project && own.has(server.id) ? "workspace" : "global",
        inherited: !!scope.project && !own.has(server.id),
        required_env: server.required_env ?? [],
        required_headers: server.required_headers ?? [],
        configured_env: Object.keys(server.env),
        configured_headers: Object.keys(server.headers),
        oauth_configured: server.oauth_credentials != null,
      })),
    };
  }

  save(request: unknown): McpManagementState {
    const input = saveSchema.parse(request),
      scope = this.#scope(input.project);
    this.#revision(scope, input.revision);
    const raw = input.server;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("MCP server must be an object");
    const allowed = [
      "id",
      "name",
      "enabled",
      "transport",
      "command",
      "args",
      "cwd",
      "url",
      "env",
      "headers",
      "targets",
      "allow_tools",
      "lan_allow_tools",
      "supports_parallel_tool_calls",
      "package",
      "required_env",
      "required_headers",
      "native_source",
    ];
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
      throw new Error("Unsupported MCP configuration fields");
    const server = serverSchema.parse(raw);
    const rawServer = raw as Record<string, unknown>;
    if (
      server.transport === "stdio"
        ? rawServer.url !== undefined
        : rawServer.command !== undefined ||
          rawServer.args !== undefined ||
          rawServer.cwd !== undefined
    )
      throw new Error("MCP entry mixes process and URL fields");
    if (!/^[A-Za-z0-9_-]+$/.test(server.id) || !server.name.trim())
      throw new Error("MCP server ID and name are required");
    if (input.originalId !== undefined && input.originalId !== server.id)
      throw new Error("Editing cannot change the MCP server ID");
    if (server.transport === "sse")
      throw new Error("SSE requires an explicit supported transport conversion");
    if (Object.keys(server.env).length || Object.keys(server.headers).length)
      throw new Error("Use secretOperations for private values");
    const current = effectiveMcp(scope.project, this.environment).find(
      (item) => item.id === server.id,
    );
    if (current && !input.originalId && !input.overrideInherited)
      throw new Error("MCP server ID already exists; explicitly edit it or choose a different ID");
    if (input.originalId && !current) throw new Error("MCP server no longer exists");
    const own = readMcpDocument(path.join(scope.directory, "mcp.json"));
    const local = readMcpDocument(path.join(scope.directory, "mcp.local.json"));
    const inherited =
      !!current &&
      ![...own, ...local.filter((item) => !item.local_values_only)].some(
        (item) => item.id === server.id,
      );
    if (inherited && !input.overrideInherited)
      throw new Error("Create a workspace override before editing an inherited server");
    if (!current) server.enabled = false;
    if (current && current.targets.length && !server.targets.length)
      throw new Error("Keep at least one target; use the server switch to disable it");
    if (server.transport === "stdio" ? !server.command.trim() : !/^https?:\/\//.test(server.url))
      throw new Error("Invalid MCP command or URL");
    // Restore unchanged placeholders against this exact revision and identity only.
    if (current) {
      const publicCurrent = publicMcpConfig(current);
      const originalText = connectionText(current),
        marker = /\[redacted\]|%5bredacted%5d/i,
        normalizeMarker = (value: string) => value.replace(/%5bredacted%5d/gi, "[redacted]"),
        hadHiddenValues = Object.entries(connectionText(publicCurrent)).some(
          ([key, value]) =>
            marker.test(value) &&
            normalizeMarker(value) !== normalizeMarker(originalText[key] ?? ""),
        );
      if (
        server.transport === "stdio" &&
        current.transport === "stdio" &&
        publicCurrent.transport === "stdio"
      ) {
        if (server.command === publicCurrent.command) server.command = current.command;
        server.args = server.args.map((value, index) =>
          value === publicCurrent.args[index] ? current.args[index]! : value,
        );
        if (server.cwd === publicCurrent.cwd) server.cwd = current.cwd;
      } else if (
        server.transport !== "stdio" &&
        current.transport !== "stdio" &&
        publicCurrent.transport !== "stdio" &&
        server.url === publicCurrent.url
      )
        server.url = current.url;
      // A moved or edited placeholder cannot identify the old secret safely. Accept
      // restored fields and existing literal markers, but never persist an unresolved edit.
      if (
        hadHiddenValues &&
        Object.entries(connectionText(server)).some(
          ([key, value]) => marker.test(value) && value !== originalText[key],
        )
      )
        throw new Error(
          "Redacted connection values cannot be recovered; move credentials to env or headers before saving",
        );
      server.native_source = current.native_source;
    } else delete server.native_source;
    const values = local.find((item) => item.id === server.id);
    const privateServer: McpServer & { deleted_env: string[]; deleted_headers: string[] } = {
      ...server,
      env: { ...(values?.env ?? {}) },
      headers: { ...(values?.headers ?? {}) },
      local_values_only: true,
      deleted_env: [...(values?.deleted_env ?? [])],
      deleted_headers: [...(values?.deleted_headers ?? [])],
      ...(values?.clear_oauth ? { clear_oauth: true } : {}),
      ...(values?.oauth_credentials == null ? {} : { oauth_credentials: values.oauth_credentials }),
    };
    const connection = (config: McpServer) =>
      config.transport === "stdio"
        ? [config.transport, config.command, config.args, config.cwd ?? null]
        : [config.transport, config.url];
    if (current && !equal(connection(current), connection(server))) {
      delete privateServer.oauth_credentials;
      privateServer.clear_oauth = true;
    }
    // New inline credentials have no safe public representation. Legacy inline values
    // may be preserved in place, but cannot be copied from an inherited/private source.
    const inline = hasInlineMcpCredentials({
      ...server,
      env: current?.env ?? {},
      headers: current?.headers ?? {},
    });
    const existingPublic = own.find((value) => value.id === server.id);
    if (inline && (!existingPublic || !equal(connection(server), connection(existingPublic))))
      throw new Error("Inline credentials must be moved to env or headers before saving");
    for (const kind of ["env", "headers"] as const) {
      const deleted = kind === "env" ? privateServer.deleted_env : privateServer.deleted_headers;
      for (const [key, operation] of Object.entries(input.secretOperations?.[kind] ?? {})) {
        if (!key || key.includes("\0") || /[\r\n]/.test(key))
          throw new Error("Invalid private configuration key");
        if (operation.action === "keep") continue;
        if (operation.action === "replace") {
          privateServer[kind][key] = operation.value;
          const index = deleted.indexOf(key);
          if (index >= 0) deleted.splice(index, 1);
        } else {
          delete privateServer[kind][key];
          if (!deleted.includes(key)) deleted.push(key);
        }
      }
    }
    if (
      hasInlineMcpCredentials(privateServer) &&
      (!existingPublic || !equal(connection(server), connection(existingPublic)))
    )
      throw new Error("Inline credentials must be moved to env or headers before saving");
    this.#write(
      scope,
      [...own.filter((item) => item.id !== server.id), cleanPublic(server)],
      [...local.filter((item) => item.id !== server.id), privateServer],
    );
    return this.state({ project: input.project });
  }

  remove(request: unknown): McpManagementState {
    const input = removeSchema.parse(request),
      scope = this.#scope(input.project);
    this.#revision(scope, input.revision);
    const own = readMcpDocument(path.join(scope.directory, "mcp.json")),
      local = readMcpDocument(path.join(scope.directory, "mcp.local.json"));
    if (![...own, ...local].some((server) => server.id === input.id))
      throw new Error(
        "This scope has no local definition to remove; inherited definitions are unchanged",
      );
    this.#write(
      scope,
      own.filter((server) => server.id !== input.id),
      local.filter((server) => server.id !== input.id),
    );
    return this.state({ project: input.project });
  }

  previewImport(request: unknown): McpImportPreview {
    const input = previewSchema.parse(request),
      scope = this.#scope(input.project);
    if ((input.text === undefined) === (input.candidateIds === undefined))
      throw new Error("Choose pasted content or native candidates");
    const parsed =
      input.text === undefined
        ? this.#native(input.candidateIds!, scope.project)
        : parseMcpImport(input.text);
    const existing = effectiveMcp(scope.project, this.environment),
      seen = new Set<string>();
    const items: McpImportPreviewItem[] = parsed.map((item) => {
      const config = item.server && publicMcpConfig(item.server),
        current = existing.find((value) => value.id === item.server?.id);
      let status: McpImportPreviewItem["status"] = !item.server
        ? "blocked"
        : current
          ? sameDefinition(item.server, current)
            ? "identical"
            : "conflict"
          : "new";
      if (config && seen.has(config.id)) status = "conflict";
      if (config) seen.add(config.id);
      return {
        key: item.key,
        ...(config ? { config } : {}),
        status,
        warning_messages: item.error
          ? [item.error_message ?? mcpDiagnostic("invalid_entry")]
          : item.server?.native_source
            ? [mcpDiagnostic("native_values_not_copied")]
            : [],
        warnings: item.error
          ? [item.error]
          : item.server?.native_source
            ? ["Native private values are not copied; enter the required keys before enabling"]
            : [],
        required_env: item.required_env,
        required_headers: item.required_headers,
      };
    });
    const token = randomUUID();
    for (const [id, preview] of this.#previews)
      if (preview.expires < Date.now()) this.#previews.delete(id);
    if (this.#previews.size >= 32)
      throw new Error("Too many import previews; wait for the old preview to expire");
    this.#previews.set(token, {
      project: scope.project,
      revision: scope.revision,
      expires: Date.now() + 10 * 60_000,
      parsed,
      ...(input.candidateIds
        ? {
            candidateIds: input.candidateIds,
            fingerprints: parsed.map((item) => item.server?.native_source?.fingerprint ?? ""),
          }
        : {}),
    });
    return { token, revision: scope.revision, items };
  }

  applyImport(request: unknown): McpImportResult {
    const input = importSchema.parse(request),
      scope = this.#scope(input.project),
      preview = this.#previews.get(input.token);
    if (!preview || preview.expires < Date.now() || preview.project !== scope.project)
      throw new Error("Import preview expired; preview again");
    this.#revision(scope, input.revision);
    if (preview.revision !== input.revision)
      throw new Error("Import configuration changed; preview again");
    if (new Set(input.selections.map((item) => item.key)).size !== input.selections.length)
      throw new Error("Duplicate import selection");
    if (
      preview.candidateIds &&
      !equal(
        preview.fingerprints,
        this.#native(preview.candidateIds, scope.project).map(
          (item) => item.server?.native_source?.fingerprint ?? "",
        ),
      )
    )
      throw new Error("Native source or profile changed; scan and preview again");
    const own = readMcpDocument(path.join(scope.directory, "mcp.json")),
      local = readMcpDocument(path.join(scope.directory, "mcp.local.json")),
      effective = effectiveMcp(scope.project, this.environment);
    const results: McpImportResult["results"] = [],
      selected = new Set<string>();
    let provenanceUpdated = false;
    for (const selection of input.selections) {
      const item = preview.parsed.find((candidate) => candidate.key === selection.key);
      if (!item) throw new Error("Unknown import item");
      if (selection.action === "skip") {
        results.push({ key: item.key, status: "skipped" });
        continue;
      }
      if (!item.server) throw new Error("Blocked import item cannot be collected");
      if (
        selection.action === "replace" &&
        selection.id !== undefined &&
        selection.id !== item.server.id
      )
        throw new Error("Replacement target must match the previewed MCP server ID");
      const server = {
        ...item.server,
        id: selection.action === "add" ? (selection.id ?? item.server.id) : item.server.id,
        enabled: false,
      };
      if (!/^[A-Za-z0-9_-]+$/.test(server.id) || selected.has(server.id))
        throw new Error("Import IDs must be valid and distinct");
      selected.add(server.id);
      const current = effective.find((value) => value.id === server.id);
      if (current && sameDefinition(server, current)) {
        const source = server.native_source;
        if (
          source &&
          current.native_source?.candidate_id === source.candidate_id &&
          current.native_source.agent === source.agent &&
          (current.native_source.fingerprint !== source.fingerprint ||
            !equal(current.required_env ?? [], server.required_env ?? []) ||
            !equal(current.required_headers ?? [], server.required_headers ?? []))
        ) {
          // Reconfirmation may advance the same source's snapshot without replacing
          // local state. A matching name/config alone cannot establish source ownership.
          const definitions = [...own, ...local.filter((value) => !value.local_values_only)].filter(
            (value) =>
              value.id === server.id &&
              value.native_source?.candidate_id === source.candidate_id &&
              value.native_source.agent === source.agent,
          );
          if (!definitions.length)
            throw new Error(
              "Reconfirm this inherited native source in global scope before migration",
            );
          for (const definition of definitions) {
            definition.native_source = { ...source };
            // Keep local values and execution settings; only the explicitly reviewed
            // source's credential names accompany its new provenance snapshot.
            definition.required_env = [...(server.required_env ?? [])];
            definition.required_headers = [...(server.required_headers ?? [])];
          }
          provenanceUpdated = true;
        }
        results.push({ key: item.key, id: server.id, status: "skipped" });
        continue;
      }
      if (current && selection.action !== "replace")
        throw new Error("Conflicting MCP server requires explicit replace or rename");
      if (
        current &&
        !own.some((value) => value.id === server.id) &&
        !local.some((value) => value.id === server.id && !value.local_values_only)
      )
        throw new Error("Create a local override before replacing an inherited definition");
      const publicIndex = own.findIndex((value) => value.id === server.id),
        privateIndex = local.findIndex((value) => value.id === server.id),
        previous = local[privateIndex];
      const privateServer: McpServer = { ...server, local_values_only: true };
      if (current || previous) {
        // Replacement removes old private values, including inherited ones. Preserve
        // revocations so omission cannot resurrect a global secret at the new definition.
        for (const kind of ["env", "headers"] as const) {
          const deleted = kind === "env" ? "deleted_env" : "deleted_headers";
          privateServer[deleted] = [
            ...new Set([...(previous?.[deleted] ?? []), ...Object.keys(current?.[kind] ?? {})]),
          ].filter((key) => !Object.hasOwn(server[kind], key));
        }
        // Imports do not authorize OAuth credentials; require an explicit new login.
        privateServer.clear_oauth = true;
      }
      if (publicIndex >= 0) own.splice(publicIndex, 1);
      if (privateIndex >= 0) local.splice(privateIndex, 1);
      own.push(cleanPublic(server));
      local.push(privateServer);
      results.push({ key: item.key, id: server.id, status: "saved" });
    }
    if (provenanceUpdated || results.some((item) => item.status === "saved"))
      this.#write(scope, own, local);
    this.#previews.delete(input.token);
    return { revision: this.#scope(input.project).revision, results };
  }

  async previewMigration(request: unknown, hub: unknown): Promise<McpMigrationPreview> {
    const binding = migrationHubBinding(hub);
    const input = z
      .object({
        project: z.string(),
        revision: z.string(),
        candidateIds: z.array(z.string()).min(1).max(128),
      })
      .strict()
      .parse(request);
    const scope = this.#scope(input.project);
    this.#revision(scope, input.revision);
    const parsed = this.#native(input.candidateIds, scope.project);
    if (parsed.some((item) => !item.server))
      throw new Error("Blocked native definitions cannot be migrated");
    const plan = await planNativeMcpMigration(
      { ...input, mcpHubStatus: hub, collectedOnly: true },
      this.store,
      this.manager,
      this.environment,
    );
    this.#revision(this.#scope(input.project), input.revision);
    if (
      !equal(
        parsed.map((item) => item.server!.native_source!.fingerprint),
        this.#native(input.candidateIds, scope.project).map(
          (item) => item.server?.native_source?.fingerprint ?? "",
        ),
      )
    )
      throw new Error("Native source or active profile changed while planning; preview again");
    const changes = publicMcpMigrationChanges(plan.changes);
    const token = randomUUID();
    for (const [key, value] of this.#migrations)
      if (value.expires < Date.now()) this.#migrations.delete(key);
    if (this.#migrations.size >= 32) throw new Error("Too many migration previews");
    this.#migrations.set(token, {
      project: scope.project!,
      revision: input.revision,
      expires: Date.now() + 10 * 60_000,
      hub: binding,
      candidates: input.candidateIds,
      fingerprints: parsed.map((item) => item.server!.native_source!.fingerprint),
      plan,
      claudeGlobal: this.#claudeGlobal(input.candidateIds, scope.project),
    });
    return {
      token,
      revision: input.revision,
      requires_home_approval: plan.requires_home_approval,
      changes,
    };
  }

  applyMigration(request: unknown, hub: unknown): McpMigrationResult {
    const input = z.object({ token: z.string(), approveHome: z.boolean() }).strict().parse(request),
      pending = this.#migrations.get(input.token);
    if (!pending || pending.expires < Date.now())
      throw new Error("Migration preview expired; preview again");
    this.#revision(this.#scope(pending.project), pending.revision);
    if (migrationHubBinding(hub) !== pending.hub) throw new Error("MCP Hub changed; preview again");
    const current = this.#native(pending.candidates, pending.project);
    if (
      !equal(
        current.map((item) => item.server?.native_source?.fingerprint ?? ""),
        pending.fingerprints,
      )
    )
      throw new Error("Native source or profile changed; preview again");
    // Token is consumed before writing: rollback errors require fresh inspection, never replay.
    this.#migrations.delete(input.token);
    const result = applyChanges(pending.plan, path.join(this.dataDir, "mcp-migration-backups"), {
      approveHome: input.approveHome,
      approvedHome: pending.plan.changes
        .filter((change) => change.scope === "agent-home")
        .map((change) => change.target),
      protectedHome: pending.plan.changes
        .filter((change) => change.scope === "agent-home")
        .map((change) => path.dirname(change.target)),
      approvedApplication: [],
    });
    // A running Claude Code can write its older copy of the global file back over this change.
    // The write itself was verified by applyChanges; this record lets a later scan notice it.
    for (const entry of pending.claudeGlobal) {
      const change = pending.plan.changes.find(
        (item) => pathIdentity(item.target) === pathIdentity(entry.file),
      );
      if (change && result.applied.includes(change.target))
        recordClaudeGlobalWrite(this.dataDir, {
          file: change.target,
          names: entry.names,
          content: change.after,
        });
    }
    return result;
  }
  /** The user-scope Claude Code servers among the chosen candidates, by file. */
  #claudeGlobal(ids: string[], project: string | null): { file: string; names: string[] }[] {
    const byFile = new Map<string, string[]>();
    for (const candidate of scanNativeMcp(
      { ...(project ? { project } : {}) },
      this.store,
      this.environment,
    ))
      if (
        ids.includes(candidate.id) &&
        candidate.agent === "claude-code" &&
        candidate.scope === "home"
      )
        byFile.set(candidate.source_path, [
          ...(byFile.get(candidate.source_path) ?? []),
          candidate.name,
        ]);
    return [...byFile].map(([file, names]) => ({ file, names }));
  }
  #native(ids: string[], project: string | null): ParsedMcpImport[] {
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate native MCP selection");
    const candidates = scanNativeMcp(
      { ...(project ? { project } : {}) },
      this.store,
      this.environment,
    );
    const selected = ids.map((id) => {
      const candidate = candidates.find((value) => value.id === id);
      if (!candidate) throw new Error("Native source or active profile changed; scan again");
      return candidate;
    });
    return readNativeMcpImports(selected, project).map((result) => {
      const id = result.candidate.id;
      try {
        if ("error" in result) throw result.error;
        const server = result.server;
        return {
          key: id,
          server,
          required_env: server.required_env ?? [],
          required_headers: server.required_headers ?? [],
        };
      } catch (error) {
        return {
          key: id,
          error_message: mcpErrorDiagnostic(error, "invalid_native_entry"),
          error:
            error instanceof Error && error.name !== "ZodError"
              ? error.message
              : "Invalid native MCP entry",
          required_env: [],
          required_headers: [],
        };
      }
    });
  }

  #revision(scope: Scope, expected: string) {
    if (scope.revision !== expected)
      throw new Error("MCP configuration changed; refresh and review again");
  }
  #write(scope: Scope, publicServers: McpServer[], localServers: McpServer[]) {
    const publicFile = path.join(scope.directory, "mcp.json"),
      privateFile = path.join(scope.directory, "mcp.local.json");
    const outputs: [string, string][] = [
      [publicFile, encode(publicServers.map((server) => serverSchema.parse(server)))],
      [privateFile, encode(localServers.map((server) => serverSchema.parse(server)))],
    ];
    for (const [, after] of outputs)
      if (Buffer.byteLength(after) > 1024 * 1024)
        throw new Error("MCP configuration exceeds the 1 MiB limit");
    // Reject an unrenderable effective configuration before either file changes,
    // including private values inherited from global scope.
    for (const server of mergeMcpDocuments([
      scope.project ? effectiveMcp(null, this.environment) : [],
      publicServers,
      localServers,
    ]))
      publicMcpConfig(server);
    const snapshots = [...scope.snapshots];
    if (scope.project) {
      const ignore = snapshot(path.join(scope.project, ".gitignore"));
      snapshots.push(ignore);
      // An earlier ignore rule can be undone by a later negation. Keep a private-file
      // rule last; leading whitespace is part of a Git pattern, not indentation.
      const lastRule = (ignore.before ?? "")
        .split(/\r?\n/)
        .reverse()
        .find((line) => line !== "" && !line.startsWith("#"));
      if (
        ![".agentkib/mcp.local.json", "/.agentkib/mcp.local.json", "mcp.local.json"].includes(
          lastRule ?? "",
        )
      )
        outputs.push([
          ignore.file,
          `${ignore.before ?? ""}${ignore.before && !ignore.before.endsWith("\n") ? "\n" : ""}.agentkib/mcp.local.json\n`,
        ]);
    }
    const changes: FileChange[] = outputs.flatMap(([file, after]) => {
      const before = snapshots.find((entry) => entry.file === file)?.before ?? null;
      return before === after
        ? []
        : [
            {
              target: file,
              before: before ?? "",
              after,
              original_hash: before === null ? null : hash(before),
              scope: "application-data" as const,
              risk: "medium" as const,
              validator: file.endsWith(".json") ? "json" : "text",
            },
          ];
    });
    this.#revision(this.#scope(scope.project ?? undefined), scope.revision);
    if (!changes.length) return;
    if (existsSync(privateFile) && process.platform !== "win32") chmodSync(privateFile, 0o600);
    const backups = path.join(this.dataDir, "mcp-config-backups");
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(backups, 0o700);
    const plan: ChangeSet = {
      id: randomUUID(),
      project_root: scope.project ?? canonicalize(userHome(this.environment)),
      created_at: new Date().toISOString(),
      changes,
      requires_home_approval: false,
    };
    applyChanges(plan, backups, {
      approveHome: false,
      approvedHome: [],
      protectedHome: [],
      approvedApplication: changes.map((change) => change.target),
    });
    if (process.platform !== "win32") chmodSync(privateFile, 0o600);
  }
}

function migrationHubBinding(hub: unknown): string {
  const binding = z
    .object({ running: z.literal(true), port: z.number().int().min(1).max(65535) })
    .parse(hub);
  return stable(binding);
}
