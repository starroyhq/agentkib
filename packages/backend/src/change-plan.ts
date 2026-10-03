import { isReparseOrSymlink } from "./native-files";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalProject, isFile, readText, withinLexical } from "./files";
import { canonicalize } from "./paths";
import { manifestYaml, manifestPath, validateManifest, type Manifest } from "./manifest";
import { MANAGED_START, openCodeManagedRegistered } from "./default-manifest";
import { adapterEnabled, hash, safeTarget, type Agent } from "./doctor-files";
import {
  cursorRule,
  managedConfigPath,
  managedMarkdown,
  mergeHermes,
  mergeJson,
  mergeToml,
  optionalRead,
  promotedGemini,
  safeKey,
  type Connection,
} from "./config-merge";
import { compareUtf8, utcNow } from "./workspaces";
import { mcpDocumentSchema, type McpServer } from "./mcp-config-read";
export interface FileChange {
  target: string;
  scope: "project" | "agent-home" | "application-data";
  original_hash: string | null;
  before: string;
  after: string;
  risk: "low" | "medium" | "high";
  validator: string;
}
export interface ChangeSet {
  id: string;
  project_root: string;
  created_at: string;
  changes: FileChange[];
  requires_home_approval: boolean;
}
export interface HomeTargets {
  openclaw_config?: string;
  hermes_config?: string;
}
export function ensureGateway(manifest: Manifest, port: number): void {
  const segment = encodeURIComponent(manifest.workspace.id).replace(
    /[!'()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  const connection: Connection = {
    name: "agentkib",
    transport: "http",
    url: `http://127.0.0.1:${port}/mcp/v1/workspaces/${segment}/agents/{agent}`,
    env: {},
    allow_tools: [],
    targets: [
      "codex",
      "claude-code",
      "cursor",
      "opencode",
      "open-claw",
      "hermes",
      "grok-build",
      "antigravity",
    ],
  };
  const index = manifest.connections.findIndex((item) => item.name === "agentkib");
  if (index < 0) manifest.connections.push(connection);
  else manifest.connections[index] = connection;
}
export function pushChange(
  changes: FileChange[],
  target: string,
  after: string,
  scope: FileChange["scope"] = "project",
  risk: FileChange["risk"] = "medium",
  validator = "markdown",
): void {
  let before: string | null = null;
  try {
    statSync(target);
    before = readText(target, Infinity, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Could not read existing configuration: ${target}`);
  }
  changes.push({
    target,
    scope,
    original_hash: before === null ? null : hash(before),
    before: before ?? "",
    after,
    risk,
    validator,
  });
}
function sourceFiles(project: string, relative: string): [string, string][] {
  const source = path.join(project, relative);
  try {
    lstatSync(source);
  } catch {
    throw new Error(`Skill path does not exist: ${source}`);
  }
  if (!safeTarget(project, source))
    throw new Error(
      `Skill path cannot contain symbolic links or non-directory ancestors: ${source}`,
    );
  const canonical = canonicalize(source);
  if (!withinLexical(canonical, project))
    throw new Error(`Skill path must be inside the project: ${source}`);
  const files: [string, string][] = [];
  let total = 0;
  const add = (file: string, key: string) => {
    if (files.length >= 512) throw new Error("Skill source exceeds the 512 file limit");
    let content: string;
    try {
      const metadata = lstatSync(file);
      if (metadata.size > 8 * 1024 * 1024)
        throw new Error(`Skill asset exceeds the 8 MiB read limit: ${file}`);
      content = readText(file, 8 * 1024 * 1024);
    } catch (error) {
      if ((error as Error).message.startsWith("Skill asset exceeds")) throw error;
      throw new Error(`The MVP supports only UTF-8 text Skill assets; could not read: ${file}`);
    }
    total += Buffer.byteLength(content);
    if (total > 32 * 1024 * 1024)
      throw new Error("Skill source exceeds the 32 MiB total read limit");
    files.push([key, content]);
  };
  if (isFile(canonical)) {
    if (path.basename(canonical) !== "SKILL.md")
      throw new Error(`A single-file Skill source must be named SKILL.md: ${source}`);
    add(canonical, "SKILL.md");
    return files;
  }
  const pending = [canonical];
  while (pending.length) {
    const file = pending.pop()!,
      metadata = lstatSync(file);
    if (isReparseOrSymlink(file, metadata))
      throw new Error(`Skill directories cannot contain symbolic links: ${file}`);
    if (metadata.isDirectory())
      for (const name of readdirSync(file)) pending.push(path.join(file, name));
    else if (metadata.isFile()) {
      const real = canonicalize(file);
      if (!withinLexical(real, project))
        throw new Error(`Skill file must be inside the project: ${file}`);
      add(real, path.relative(canonical, real));
    } else throw new Error(`Skill directories can contain only regular files: ${file}`);
  }
  if (!files.some(([name]) => name === "SKILL.md"))
    throw new Error(`Skill directory has no SKILL.md entry point: ${source}`);
  return files.sort(([a], [b]) => compareUtf8(a, b));
}
function legacyServers(project: string, manifest: Manifest, changes: FileChange[]): void {
  const legacy = manifest.connections.filter((connection) => connection.name !== "agentkib");
  if (!legacy.length) return;
  const target = path.join(project, ".agentkib", manifest.mcp.config);
  let document: any = { schema_version: 1, servers: [] };
  try {
    const parsed = JSON.parse(optionalRead(target));
    const result = mcpDocumentSchema.safeParse(parsed);
    if (result.success)
      document = {
        schema_version: result.data.schema_version,
        servers: result.data.servers.map((server: McpServer) => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          ...(server.transport === "stdio"
            ? {
                transport: server.transport,
                command: server.command,
                args: server.args,
                ...(server.cwd != null ? { cwd: server.cwd } : {}),
              }
            : { transport: server.transport, url: server.url }),
          env: server.env,
          headers: server.headers,
          ...(server.oauth_credentials != null
            ? { oauth_credentials: server.oauth_credentials }
            : {}),
          targets: server.targets,
          allow_tools: server.allow_tools,
          lan_allow_tools: server.lan_allow_tools,
          supports_parallel_tool_calls: server.supports_parallel_tool_calls,
          ...(server.package != null ? { package: server.package } : {}),
        })),
      };
  } catch {}
  for (const connection of legacy) {
    const server = {
      id: safeKey(connection.name),
      name: connection.name,
      enabled: true,
      ...(connection.transport === "stdio"
        ? { transport: "stdio", command: connection.command, args: connection.args }
        : { transport: "streamable-http", url: connection.url }),
      env: {},
      headers: {},
      targets: connection.targets,
      allow_tools: connection.allow_tools,
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
    };
    const index = document.servers.findIndex((item: any) => item.id === server.id);
    if (index < 0) document.servers.push(server);
    else document.servers[index] = server;
  }
  document.servers.sort((a: any, b: any) => compareUtf8(a.name, b.name));
  pushChange(
    changes,
    target,
    JSON.stringify(document, null, 2) + "\n",
    "project",
    "medium",
    "json",
  );
}
export function planWorkspace(project: string, input: Manifest, home: HomeTargets = {}): ChangeSet {
  validateManifest(input);
  const root = canonicalProject(project),
    manifest = structuredClone(input),
    changes: FileChange[] = [],
    enabled = (agent: Agent) => adapterEnabled(manifest, agent),
    override = (agent: Agent) => manifest.instructions.platform_overrides[agent] ?? "",
    read = (name: string) => optionalRead(path.join(root, name)),
    write = (
      name: string,
      after: string,
      validator = "markdown",
      risk: FileChange["risk"] = "medium",
    ) => pushChange(changes, path.join(root, name), after, "project", risk, validator);
  legacyServers(root, manifest, changes);
  const common = [
      "codex",
      "cursor",
      "opencode",
      "open-claw",
      "hermes",
      "grok-build",
      "antigravity",
    ].some((agent) => enabled(agent as Agent)),
    gemini = read("GEMINI.md"),
    remainder = common ? promotedGemini(root, gemini, manifest.instructions.shared) : null;
  if (common) {
    write("AGENTS.md", managedMarkdown(read("AGENTS.md"), manifest.instructions.shared));
    if (!enabled("antigravity") && remainder !== null) write("GEMINI.md", remainder);
  }
  const gateway = manifest.connections.filter((connection) => connection.name === "agentkib");
  if (enabled("claude-code")) {
    write(
      "CLAUDE.md",
      managedMarkdown(
        read("CLAUDE.md"),
        override("claude-code").trim()
          ? `@AGENTS.md\n\n${override("claude-code")}`
          : "@AGENTS.md\n\nClaude Code uses AGENTS.md as the shared project instructions.",
      ),
    );
    write(".mcp.json", mergeJson(path.join(root, ".mcp.json"), gateway, "claude-code"), "json");
  }
  if (enabled("antigravity")) {
    const extra = override("antigravity");
    if (
      isFile(path.join(root, "AGENTS.md")) &&
      !gemini.includes(MANAGED_START) &&
      remainder !== null &&
      remainder.trim() &&
      remainder.trim() !== extra.trim()
    )
      throw new Error(
        "GEMINI.md contains a previously promoted platform override that differs from the edited Antigravity override; reconcile them before applying",
      );
    if (remainder !== null || extra.trim() || gemini.includes(MANAGED_START))
      write("GEMINI.md", managedMarkdown(remainder ?? gemini, extra));
    write(
      ".agents/mcp_config.json",
      mergeJson(path.join(root, ".agents/mcp_config.json"), gateway, "antigravity"),
      "json",
    );
  }
  if (enabled("codex")) {
    const extra = override("codex");
    if (extra.trim() || isFile(path.join(root, "AGENTS.override.md")))
      write(
        "AGENTS.override.md",
        managedMarkdown(
          read("AGENTS.override.md"),
          extra.trim()
            ? manifest.instructions.shared.trim() + "\n\n" + extra.trim()
            : manifest.instructions.shared,
        ),
      );
    write(
      ".codex/config.toml",
      mergeToml(path.join(root, ".codex/config.toml"), gateway, "codex"),
      "toml",
    );
  }
  if (enabled("grok-build"))
    write(
      ".grok/config.toml",
      mergeToml(path.join(root, ".grok/config.toml"), gateway, "grok-build"),
      "toml",
    );
  if (enabled("cursor")) {
    const name = ".cursor/rules/agentkib.mdc",
      existing = read(name),
      extra = override("cursor");
    if (extra.trim() || (isFile(path.join(root, name)) && existing.includes(MANAGED_START)))
      write(name, cursorRule(existing, extra));
    write(
      ".cursor/mcp.json",
      mergeJson(path.join(root, ".cursor/mcp.json"), gateway, "cursor"),
      "json",
    );
  }
  if (enabled("opencode")) {
    const name = ".opencode/agentkib-instructions.md",
      existing = read(name),
      extra = override("opencode"),
      managed =
        !!extra.trim() || (existing.includes(MANAGED_START) && openCodeManagedRegistered(root));
    if (managed) write(name, managedMarkdown(existing, extra));
    const config = managedConfigPath(root);
    pushChange(
      changes,
      config,
      mergeJson(config, gateway, "opencode", managed),
      "project",
      "medium",
      config.endsWith(".jsonc") ? "jsonc" : "json",
    );
  }
  for (const [agent, name] of [
    ["open-claw", "TOOLS.md"],
    ["hermes", ".hermes.md"],
  ] as const)
    if (enabled(agent)) {
      const extra = override(agent),
        existing = read(name);
      if (extra.trim() || (isFile(path.join(root, name)) && existing.includes(MANAGED_START)))
        write(
          name,
          managedMarkdown(
            existing,
            agent === "hermes"
              ? extra.trim()
                ? manifest.instructions.shared.trim() + "\n\n" + extra.trim()
                : manifest.instructions.shared
              : extra,
          ),
        );
    }
  for (const scoped of manifest.instructions.scoped) {
    const directory = path.join(root, scoped.path);
    if (common)
      pushChange(
        changes,
        path.join(directory, "AGENTS.md"),
        managedMarkdown(optionalRead(path.join(directory, "AGENTS.md")), scoped.content),
      );
    if (enabled("claude-code"))
      pushChange(
        changes,
        path.join(directory, "CLAUDE.md"),
        managedMarkdown(optionalRead(path.join(directory, "CLAUDE.md")), "@AGENTS.md"),
      );
  }
  for (const skill of manifest.skills) {
    const targets = (agent: Agent) =>
        enabled(agent) && (!skill.targets.length || skill.targets.includes(agent)),
      shared = ["codex", "opencode", "open-claw", "hermes", "antigravity"].some((agent) =>
        targets(agent as Agent),
      );
    for (const [relative, content] of sourceFiles(root, skill.path)) {
      const roots = [
        ...(shared ? [".agents/skills"] : []),
        ...(targets("cursor") && !shared ? [".cursor/skills"] : []),
        ...(targets("claude-code") ? [".claude/skills"] : []),
        ...(targets("grok-build") ? [".grok/skills"] : []),
      ];
      const extension = path.extname(relative).slice(1),
        validator = ["json", "toml", "yaml"].includes(extension)
          ? extension
          : extension === "yml"
            ? "yaml"
            : extension === "md"
              ? "markdown"
              : "text";
      for (const directory of roots)
        pushChange(
          changes,
          path.join(root, directory, skill.name, relative),
          content,
          "project",
          "low",
          validator,
        );
    }
  }
  if (enabled("open-claw") && home.openclaw_config)
    pushChange(
      changes,
      home.openclaw_config,
      mergeJson(home.openclaw_config, gateway, "open-claw"),
      "agent-home",
      "high",
      "json",
    );
  if (enabled("hermes") && home.hermes_config)
    pushChange(
      changes,
      home.hermes_config,
      mergeHermes(home.hermes_config, root, gateway),
      "agent-home",
      "high",
      "yaml",
    );
  for (const [agent, state] of Object.entries(manifest.adapters)) {
    const refreshHome =
      (agent === "open-claw" && !!home.openclaw_config) ||
      (agent === "hermes" && !!home.hermes_config);
    state.generated_hashes = Object.fromEntries(
      Object.entries(state.generated_hashes).filter(
        ([target]) => path.isAbsolute(target) && !withinLexical(target, root) && !refreshHome,
      ),
    );
  }
  for (const change of changes) {
    const projectScoped = withinLexical(change.target, root),
      key = projectScoped ? path.relative(root, change.target) : change.target,
      parts = key.split(path.sep),
      name = path.basename(key);
    const agents: Agent[] = parts.includes(".opencode")
      ? ["opencode"]
      : parts.includes(".openclaw") || change.target === home.openclaw_config || name === "TOOLS.md"
        ? ["open-claw"]
        : parts.includes(".hermes") || change.target === home.hermes_config || name === ".hermes.md"
          ? ["hermes"]
          : parts.includes(".grok")
            ? ["grok-build"]
            : parts.includes(".codex") || name === "AGENTS.override.md"
              ? ["codex"]
              : parts.includes(".cursor")
                ? ["cursor"]
                : parts.includes(".claude") || ["CLAUDE.md", ".mcp.json"].includes(name)
                  ? ["claude-code"]
                  : ["GEMINI.md", "mcp_config.json"].includes(name)
                    ? ["antigravity"]
                    : [
                        "codex",
                        "cursor",
                        "opencode",
                        "open-claw",
                        "hermes",
                        "grok-build",
                        "antigravity",
                      ];
    for (const agent of agents) {
      const state = manifest.adapters[agent];
      if (state) state.generated_hashes[key] = hash(change.after);
    }
  }
  manifest.schema_version = 2;
  manifest.connections = [];
  const final = changes.filter((change) => change.before !== change.after),
    target = manifestPath(root),
    after = manifestYaml(manifest),
    before = optionalRead(target);
  if (before !== after) {
    const item: FileChange[] = [];
    pushChange(item, target, after, "project", "low", "yaml");
    final.unshift(item[0]!);
  }
  return {
    id: randomUUID(),
    project_root: root,
    created_at: utcNow(),
    changes: final,
    requires_home_approval: final.some((change) => change.scope === "agent-home"),
  };
}
