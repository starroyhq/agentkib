import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { McpManager } from "../../../packages/backend/src/mcp";
import { Commands } from "../../../packages/backend/src/commands";
import { effectiveMcp, serverSchema } from "../../../packages/backend/src/mcp-config-read";
import {
  normalizeMcpImport,
  parseMcpImport,
  publicMcpConfig,
  redactMcpText,
} from "../../../packages/backend/src/mcp-import";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { planNativeMcpMigration } from "../../../packages/backend/src/mcp-migration-plan";
import { McpStdioTransport } from "../../../packages/backend/src/mcp-stdio-transport";
import { oauthProvider } from "../../../packages/backend/src/mcp-oauth";
import * as nativeFiles from "../../../packages/backend/src/native-files";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function fixture({ database }: { database?: ":memory:" } = {}) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-management-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  mkdirSync(home);
  mkdirSync(project);
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  const store = new BackendStore(database ?? path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const management = new McpManagement(store, environment, data, manager);
  const config = {
    id: "demo",
    name: "demo",
    transport: "stdio",
    command: "must-not-run",
    args: [],
    enabled: true,
    targets: ["codex"],
  };
  const state = () => management.state({ project });
  const save = (server: unknown, extra = {}) =>
    management.save({ project, revision: state().revision, server, ...extra });
  const collect = (text: string) => {
    const preview = management.previewImport({ project, text });
    return management.applyImport({
      project,
      token: preview.token,
      revision: preview.revision,
      selections: preview.items.map((item) => ({ key: item.key, action: "add" })),
    });
  };
  return {
    root,
    home,
    project,
    data,
    environment,
    store,
    manager,
    management,
    config,
    state,
    save,
    collect,
  };
}

function nativeProvenanceFixture() {
  const f = fixture(),
    script = path.join(f.root, "provenance-fixture.cjs"),
    native = path.join(f.project, ".mcp.json"),
    hub = { running: true, port: 47653 };
  writeFileSync(
    script,
    String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'read',inputSchema:{type:'object'}}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');});`,
  );
  const definition = {
    command: process.execPath,
    args: [script],
    env: { KEY: "native-private" },
    headers: { "X-Fixture": "native-header" },
  };
  write(native, JSON.stringify({ mcpServers: { tool: definition, other: definition } }));
  const candidate = (name: string, source = native) =>
    scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === name && item.source_path === source,
    )!;
  const preview = (ids: string[]) =>
    f.management.previewImport({ project: f.project, candidateIds: ids });
  const collect = (ids: string[], action: "add" | "replace" | "skip" = "add") => {
    const plan = preview(ids);
    return {
      plan,
      result: f.management.applyImport({
        project: f.project,
        token: plan.token,
        revision: plan.revision,
        selections: ids.map((key) => ({ key, action })),
      }),
    };
  };
  const prepare = async (names: string[]) => {
    collect(names.map((name) => candidate(name).id));
    for (const name of names) {
      const entry = f.state().servers.find((item) => item.config.id === name)!;
      f.save(
        { ...entry.config, enabled: true },
        {
          originalId: name,
          secretOperations: {
            env: { KEY: { action: "replace", value: "entered-private" } },
            headers: { "X-Fixture": { action: "replace", value: "entered-header" } },
          },
        },
      );
      await f.manager.probe(name, f.project);
    }
  };
  const migrate = (ids: string[]) =>
    f.management.previewMigration(
      { project: f.project, revision: f.state().revision, candidateIds: ids },
      hub,
    );
  return { ...f, native, hub, definition, candidate, preview, collect, prepare, migrate };
}

describe("MCP parsing and collect-first management", () => {
  it.each([
    ['{"mcpServers":{"demo":{"command":"node","args":["x"]}}}', "stdio"],
    ['[mcp_servers.demo]\ncommand="node"\nargs=["x"]', "stdio"],
    [
      '{"mcp_servers":{"demo":{"url":"https://example.test/mcp","http_headers":{"Authorization":"private"}}}}',
      "streamable-http",
    ],
    [
      '{"mcp":{"demo":{"type":"local","command":["node","x"],"environment":{"KEY":"private"}}}}',
      "stdio",
    ],
    ['{"mcp":{"demo":{"type":"remote","url":"https://example.test/mcp"}}}', "streamable-http"],
    ['{"id":"demo","name":"demo","transport":"stdio","command":"node"}', "stdio"],
    ['{"demo":{"command":"node"}}', "stdio"],
  ])("normalizes supported input without enabling: %s", (text, transport) => {
    const parsed = parseMcpImport(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.server).toMatchObject({ enabled: false, transport });
  });
  it.each([
    '{"mcpServers":{"demo":{"url":"https://example.test","type":"sse"}}}',
    '{"mcpServers":{"demo":{"command":"node","timeout":100}}}',
    '{"mcpServers":{"demo":{"url":"https://example.test?token=private"}}}',
    '{"mcpServers":{"demo":{"command":"node","args":["--api-key","private"]}}}',
    '{"mcp":{"demo":{"type":"local","command":["node"],"environment":{"A":3}}}}',
  ])("blocks lossy or secret-inline input: %s", (text) =>
    expect(parseMcpImport(text)[0]?.server).toBeUndefined(),
  );
  describe.each([
    {
      agent: "opencode",
      file: "opencode.json",
      container: "mcp",
      entries: [
        { type: "local", command: ["{env:IMPORT_VALUE}"] },
        { type: "local", command: ["node", "prefix-{env:IMPORT_VALUE}-suffix"] },
        { type: "local", command: ["node", "{file:./private.txt}"] },
        { type: "local", command: ["node"], environment: { KEY: "{env:IMPORT_VALUE}" } },
        { type: "local", command: ["node"], environment: { KEY: "{file:./private.txt}" } },
        { type: "remote", url: "https://example.test/{env:IMPORT_VALUE}" },
        { type: "remote", url: "https://example.test/{file:./private.txt}" },
        { type: "remote", url: "https://example.test", headers: { KEY: "{env:IMPORT_VALUE}" } },
        { type: "remote", url: "https://example.test", headers: { KEY: "{file:./private.txt}" } },
        { type: "local", command: ["node"], environment: { "{env:IMPORT_VALUE}": "value" } },
      ],
    },
    {
      agent: "claude-code",
      file: ".mcp.json",
      container: "mcpServers",
      entries: [
        { command: "${IMPORT_VALUE}" },
        { command: "node", args: ["prefix-${IMPORT_VALUE:-fallback-private-value}-suffix"] },
        { command: "node", env: { KEY: "${IMPORT_VALUE}" } },
        { command: "node", env: { KEY: "${IMPORT_VALUE:-}" } },
        { type: "http", url: "https://example.test/${IMPORT_VALUE}" },
        { type: "http", url: "https://example.test", headers: { KEY: "${IMPORT_VALUE}" } },
      ],
    },
    {
      agent: "cursor",
      file: ".cursor/mcp.json",
      container: "mcpServers",
      entries: [
        { command: "${userHome}/bin/server" },
        { command: "node", args: ["${workspaceFolder}/server.js"] },
        { command: "node", args: ["${workspaceFolderBasename}"] },
        { command: "node", args: ["prefix${pathSeparator}suffix"] },
        { command: "node", args: ["prefix${/}suffix"] },
        { command: "node", cwd: "/base/${env:IMPORT_VALUE}" },
        { command: "node", cwd: "/base/${workspaceFolderBasename}" },
        { command: "node", env: { KEY: "${env:IMPORT_VALUE}" } },
        { url: "https://example.test/${env:IMPORT_VALUE}" },
        { url: "https://example.test", headers: { KEY: "${env:IMPORT_VALUE}" } },
      ],
    },
    {
      agent: "hermes",
      file: ".hermes/config.yaml",
      container: "mcpServers",
      entries: [
        { command: "node", args: ["${workspaceFolder}/server.js"] },
        { command: "node", env: { KEY: "${env:IMPORT_VALUE}" } },
        { url: "https://example.test", headers: { KEY: "${IMPORT_VALUE}" } },
      ],
    },
    {
      agent: "open-claw",
      file: ".openclaw/openclaw.json",
      container: "mcpServers",
      entries: [
        { command: "node", args: ["${IMPORT_VALUE:-fallback-private-value}"] },
        { command: "node", env: { KEY: "${IMPORT_VALUE:-}" } },
        { command: "node", args: ["$${IMPORT_VALUE}"] },
        { url: "https://example.test", headers: { KEY: "${IMPORT_VALUE}" } },
      ],
    },
  ])("$agent substitutions", ({ agent, file, container, entries }) => {
    it.each(entries)("blocks native and pasted expressions before saving: %j", (entry) => {
      const f = fixture(),
        probe = vi.spyOn(f.manager, "probe"),
        start = vi.spyOn(McpStdioTransport.prototype, "start"),
        run = vi.spyOn(Commands.prototype, "run"),
        readVariable = vi.fn(() => "resolved-private-value");
      Object.defineProperty(f.environment, "IMPORT_VALUE", { get: readVariable });
      const native = path.join(
          agent === "hermes" || agent === "open-claw" ? f.home : f.project,
          file,
        ),
        privateFile = path.join(f.project, "private.txt"),
        pastedText = JSON.stringify({ [container]: { demo: entry } }),
        text =
          JSON.stringify(
            agent === "hermes"
              ? { mcp_servers: { demo: entry } }
              : agent === "open-claw"
                ? { mcp: { servers: { demo: entry } } }
                : { [container]: { demo: entry } },
            null,
            2,
          ) + "\n";
      write(native, text);
      write(privateFile, "private-file-value");
      const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
        (item) => item.agent === agent && item.name === "demo",
      )!;
      expect(candidate.supported).toBe(false);
      const sources = [
        { candidateIds: [candidate.id] },
        { text: pastedText },
        ...(agent === "opencode"
          ? [{ text: JSON.stringify(entry) }, { text: JSON.stringify({ demo: entry }) }]
          : []),
      ];
      for (const source of sources) {
        const preview = f.management.previewImport({ project: f.project, ...source });
        expect(preview.items[0]?.status).toBe("blocked");
        expect(preview.items[0]?.config).toBeUndefined();
        if ("text" in source)
          expect(preview.items[0]?.warnings[0]).toMatch(/substitutions cannot be collected/);
        expect(JSON.stringify(preview)).not.toMatch(
          /resolved-private-value|fallback-private-value|private-file-value|IMPORT_VALUE|private\.txt/,
        );
        expect(() =>
          f.management.applyImport({
            project: f.project,
            token: preview.token,
            revision: preview.revision,
            selections: [{ key: preview.items[0]!.key, action: "add" }],
          }),
        ).toThrow("Blocked import item");
      }
      expect(f.state().servers).toEqual([]);
      expect(existsSync(path.join(f.project, ".agentkib/mcp.json"))).toBe(false);
      expect(existsSync(path.join(f.project, ".agentkib/mcp.local.json"))).toBe(false);
      expect(readFileSync(native, "utf8")).toBe(text);
      expect(readFileSync(privateFile, "utf8")).toBe("private-file-value");
      expect(readVariable).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });
  });
  it("keeps OpenCode container semantics for entries accepted by other parsing branches", () => {
    for (const entry of [
      { command: "node", args: ["{env:IMPORT_VALUE}"] },
      { command: "node", args: ["{file:./private.txt}"] },
      { id: "demo", transport: "stdio", command: "node", args: ["{env:IMPORT_VALUE}"] },
    ]) {
      expect(parseMcpImport(JSON.stringify({ mcp: { demo: entry } }))[0]?.error).toMatch(
        /OpenCode env\/file substitutions/,
      );
      expect(() => normalizeMcpImport("demo", entry, "opencode", true)).toThrow(
        /OpenCode env\/file substitutions/,
      );
    }
  });
  it("preserves literal syntax outside the source format that expands it", () => {
    const args = ["{env:IMPORT_VALUE}", "{file:./private.txt}", "${IMPORT_VALUE:-default}"];
    expect(normalizeMcpImport("demo", { command: "node", args }, "codex", true)).toMatchObject({
      args,
    });
    for (const root of [
      { id: "demo", transport: "stdio", command: "node", args },
      { demo: { id: "demo", transport: "stdio", command: "node", args } },
      { mcpServers: { demo: { id: "demo", transport: "stdio", command: "node", args } } },
      { mcp_servers: { demo: { command: "node", args } } },
      { mcp: { demo: { type: "local", command: ["node", "${IMPORT_VALUE:-default}"] } } },
      { mcpServers: { demo: { type: "local", command: ["node", "${IMPORT_VALUE:-default}"] } } },
    ])
      expect(parseMcpImport(JSON.stringify(root))[0]?.server?.transport).toBe("stdio");
    expect(
      parseMcpImport(
        JSON.stringify({ mcpServers: { demo: { command: "node", args: args.slice(0, 2) } } }),
      )[0]?.server,
    ).toMatchObject({ args: args.slice(0, 2) });
  });
  it("uses the documented native substitution boundaries without evaluating their values", () => {
    expect(() =>
      normalizeMcpImport("demo", { command: "node", cwd: "${custom.variable}" }, "hermes", true),
    ).toThrow(/Hermes environment\/context substitutions/);
    expect(() =>
      normalizeMcpImport("demo", { command: "node", cwd: "${IMPORT_VALUE}" }, "open-claw", true),
    ).toThrow(/OpenClaw environment substitutions/);
    const args = ["${lowercase}", "${UPPERCASE:+literal}", "${UPPERCASE-default}"];
    expect(normalizeMcpImport("demo", { command: "node", args }, "open-claw", true)).toMatchObject({
      args,
    });
  });
  it.each(["native", "pasted"])(
    "collects literal OpenCode %s entries without expansion",
    (source) => {
      const f = fixture(),
        start = vi.spyOn(McpStdioTransport.prototype, "start"),
        native = path.join(f.project, "opencode.json"),
        args = ["serve", "file:./literal.txt", "{unknown:literal}", "${IMPORT_VALUE:-literal}"],
        text = JSON.stringify({
          mcp: {
            local: {
              type: "local",
              command: ["node", ...args],
              environment: { KEY: "local-private-value" },
            },
            remote: {
              type: "remote",
              url: "https://example.test/mcp",
              headers: { "X-Key": "remote-private-value" },
            },
          },
        });
      write(native, text);
      const candidates = scanNativeMcp({ project: f.project }, f.store, f.environment).filter(
        (item) => item.agent === "opencode",
      );
      expect(candidates).toHaveLength(2);
      expect(candidates.every((item) => item.supported)).toBe(true);
      const preview = f.management.previewImport({
        project: f.project,
        ...(source === "native" ? { candidateIds: candidates.map((item) => item.id) } : { text }),
      });
      expect(preview.items.map((item) => item.status)).toEqual(["new", "new"]);
      expect(JSON.stringify(preview)).not.toMatch(/local-private-value|remote-private-value/);
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: preview.items.map((item) => ({ key: item.key, action: "add" })),
      });
      expect(effectiveMcp(f.project, f.environment)).toMatchObject([
        {
          id: "local",
          enabled: false,
          args,
          env: source === "native" ? {} : { KEY: "local-private-value" },
          required_env: ["KEY"],
        },
        {
          id: "remote",
          enabled: false,
          headers: source === "native" ? {} : { "X-Key": "remote-private-value" },
          required_headers: ["X-Key"],
        },
      ]);
      expect(readFileSync(native, "utf8")).toBe(text);
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each([
    '{"mcp_servers":{"demo":{"command":"node","enabled_tools":[]}}}',
    '[mcp_servers.demo]\ncommand="node"\nenabled_tools=[]',
    '{"mcpServers":{"demo":{"command":"node","enabledTools":[]}}}',
    '{"mcp_servers":{"demo":{"command":"node","enabled_tools":null}}}',
  ])("does not turn an explicit empty or invalid native allow list into all tools: %s", (text) => {
    const f = fixture();
    const preview = f.management.previewImport({ project: f.project, text });
    expect(preview.items[0]?.status).toBe("blocked");
    expect(() =>
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: preview.items[0]!.key, action: "add" }],
      }),
    ).toThrow("Blocked import item");
    expect(f.state().servers).toEqual([]);
  });
  it("retains a finite native tool list and distinguishes an omitted list", () => {
    expect(
      normalizeMcpImport("demo", { command: "node", enabled_tools: ["read"] }).allow_tools,
    ).toEqual(["read"]);
    expect(normalizeMcpImport("demo", { command: "node" }).allow_tools).toEqual([]);
    expect(() =>
      normalizeMcpImport("demo", { command: "node", enabled_tools: [] }, "codex", true),
    ).toThrow("empty effective native allow list");
  });
  it.each([
    { args: ["https://synthetic-user:synthetic-password@example.test/mcp"] },
    { args: ["-c", "curl 'https://synthetic-user:synthetic-password@example.test/mcp'"] },
    { command: "curl https://synthetic-user:synthetic-password@example.test/mcp" },
    { args: ["https://example.test/mcp?signature=synthetic-password"] },
  ])("blocks inline URL credentials in stdio collection: %j", (fields) => {
    const f = fixture();
    const entry = { command: "npx", args: [], ...fields };
    const native = path.join(f.project, ".mcp.json");
    const before = JSON.stringify({ mcpServers: { demo: entry } });
    write(native, before);
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === "demo",
    )!;
    expect(candidate.supported).toBe(false);
    const preview = f.management.previewImport({ project: f.project, text: before });
    expect(preview.items[0]?.status).toBe("blocked");
    expect(JSON.stringify({ candidate, preview })).not.toMatch(/synthetic-user|synthetic-password/);
    expect(() =>
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: preview.items[0]!.key, action: "add" }],
      }),
    ).toThrow("Blocked import item");
    expect(f.state().servers).toEqual([]);
    expect(readFileSync(native, "utf8")).toBe(before);
  });
  it("redacts existing stdio URL credentials in all public connection fields", () => {
    const source = serverSchema.parse({
      id: "legacy",
      name: "legacy",
      transport: "stdio",
      command: "curl https://synthetic-user:synthetic-password@example.test/mcp",
      args: ["-c", "curl 'https://synthetic-user:synthetic-password@example.test/mcp'"],
      cwd: "https://synthetic-user:synthetic-password@example.test/mcp",
    });
    const view = publicMcpConfig(source);
    expect(JSON.stringify(view)).not.toMatch(/synthetic-user|synthetic-password/);
    expect(view.args[1]).toContain("example.test/mcp");
    expect(publicMcpConfig(view)).toEqual(view);
    expect(source.args[1]).toContain("synthetic-password");
  });
  it("accepts a credential-free endpoint containing the word redacted", () => {
    const server = normalizeMcpImport("demo", { url: "https://example.test/redacted-mcp" });
    expect(server.transport).toBe("streamable-http");
    expect(publicMcpConfig(server)).toEqual(server);
  });
  it.each([
    {
      args: [
        "mcp-remote",
        "https://example.test/mcp",
        "--header",
        "X-API-Key:synthetic-header-private",
      ],
    },
    { args: ["-H", "authorization: Custom synthetic-header-private"] },
    {
      args: ["--header=Cookie:session=synthetic-header-private; refresh=synthetic-cookie-private"],
    },
    { args: ["-HX-Access-Key:synthetic-header-private"] },
    { args: ["--header", "X-Auth: synthetic-header-private"] },
    { args: ["--header", "Set-Cookie:session=synthetic-header-private; HttpOnly"] },
    { args: ["-c", "curl -H 'Authorization: Custom synthetic-header-private"] },
    { args: ["-c", String.raw`curl --header Authorization:Custom\ synthetic-header-private`] },
    {
      args: [
        "-c",
        String.raw`curl -H Cookie:session=synthetic-header-private\;\ refresh=synthetic-cookie-private`,
      ],
    },
    {
      command: `curl -H 'Authorization: Digest username="synthetic-header-private", response="synthetic-cookie-private"'`,
    },
    {
      args: [
        "-c",
        `curl --header "Cookie: session=synthetic-header-private; other=synthetic-cookie-private"`,
      ],
    },
    { args: ["-c", `curl --header='Proxy-Authorization: Negotiate synthetic-header-private'`] },
    {
      args: [
        "-c",
        String.raw`curl -H "Authorization: Digest username=\"synthetic-header-private\", response=\"synthetic-cookie-private\""`,
      ],
    },
  ])("blocks inline header credentials and masks legacy public fields: %j", (fields) => {
    const f = fixture(),
      start = vi.spyOn(McpStdioTransport.prototype, "start"),
      entry = { command: "npx", args: [], ...fields },
      native = path.join(f.home, ".claude.json"),
      before = JSON.stringify({ mcpServers: { demo: entry } });
    write(native, before);
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === "demo",
    )!;
    expect(candidate.supported).toBe(false);
    expect(JSON.stringify(candidate)).not.toMatch(/synthetic-(?:header|cookie)-private/);
    for (const source of [{ text: before }, { candidateIds: [candidate.id] }]) {
      const preview = f.management.previewImport({ project: f.project, ...source });
      expect(preview.items[0]?.status).toBe("blocked");
      expect(JSON.stringify(preview)).not.toMatch(/synthetic-(?:header|cookie)-private/);
      expect(() =>
        f.management.applyImport({
          project: f.project,
          token: preview.token,
          revision: preview.revision,
          selections: [{ key: preview.items[0]!.key, action: "add" }],
        }),
      ).toThrow("Blocked import item");
    }
    expect(f.state().servers).toEqual([]);
    expect(readFileSync(native, "utf8")).toBe(before);
    expect(existsSync(path.join(f.project, ".agentkib/mcp.json"))).toBe(false);
    const legacy = serverSchema.parse({ id: "demo", name: "demo", transport: "stdio", ...entry }),
      view = publicMcpConfig(legacy);
    expect(JSON.stringify(view)).not.toMatch(/synthetic-(?:header|cookie)-private/);
    expect(publicMcpConfig(view)).toEqual(view);
    expect(JSON.stringify(legacy)).toContain("synthetic-header-private");
    write(
      path.join(f.project, ".agentkib/mcp.json"),
      JSON.stringify({ schema_version: 1, servers: [legacy] }),
    );
    expect(JSON.stringify(f.state())).not.toMatch(/synthetic-(?:header|cookie)-private/);
    expect(start).not.toHaveBeenCalled();
  });
  it("preserves non-sensitive header arguments and shell fragments", () => {
    const entry = {
      command: "npx",
      args: [
        "mcp-remote",
        "https://example.test/mcp",
        "--header",
        "Accept: application/json",
        "--header=X-Request-ID:trace-123",
        "-HContent-Type:application/json",
        "--header",
        "Authorization:",
        "-HCookie:",
        "-c",
        `curl -H 'User-Agent: Example App' --header "X-Trace-ID: trace-123"`,
      ],
    };
    const imported = normalizeMcpImport("demo", entry, "claude-code", true);
    expect(publicMcpConfig(imported)).toEqual(imported);
    expect(imported).toMatchObject(entry);
    for (const value of [entry.command, ...entry.args]) expect(redactMcpText(value)).toBe(value);
  });
  it("collects disabled definitions and private values with no process startup or native change", () => {
    const f = fixture(),
      probe = vi.spyOn(f.manager, "probe"),
      run = vi.spyOn(Commands.prototype, "run");
    const native = path.join(f.project, ".mcp.json");
    write(native, '{"mcpServers":{"original":{"command":"original"}}}\n');
    const before = readFileSync(native, "utf8");
    const preview = f.management.previewImport({
      project: f.project,
      text: '{"mcpServers":{"demo":{"command":"node","env":{"KEY":"secret-value"}}}}',
    });
    expect(JSON.stringify(preview)).not.toContain("secret-value");
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: "0", action: "add" }],
    });
    expect(readFileSync(native, "utf8")).toBe(before);
    expect(probe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("persists pasted secrets privately and skips identical imports without changing enabled", () => {
    const f = fixture(),
      text = '{"mcpServers":{"demo":{"command":"node","env":{"KEY":"secret-value"}}}}';
    f.collect(text);
    expect(readFileSync(path.join(f.project, ".agentkib/mcp.json"), "utf8")).not.toContain(
      "secret-value",
    );
    expect(readFileSync(path.join(f.project, ".agentkib/mcp.local.json"), "utf8")).toContain(
      "secret-value",
    );
    if (process.platform !== "win32")
      expect(statSync(path.join(f.project, ".agentkib/mcp.local.json")).mode & 0o777).toBe(0o600);
    const current = f.state().servers[0]!.config;
    f.save({ ...current, enabled: true }, { originalId: "demo" });
    const before = f.state().revision;
    expect(f.collect(text).results[0]?.status).toBe("skipped");
    expect(f.state().revision).toBe(before);
    expect(f.state().servers[0]?.config.enabled).toBe(true);
  });
  it("requires explicit replacement or rename for collisions and refuses implicit manual overwrite", () => {
    const f = fixture();
    f.save(f.config);
    expect(() => f.save({ ...f.config, command: "other" })).toThrow(/already exists/);
    const preview = f.management.previewImport({
      project: f.project,
      text: '{"demo":{"command":"other"}}',
    });
    expect(preview.items[0]?.status).toBe("conflict");
    expect(() =>
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: "0", action: "add" }],
      }),
    ).toThrow(/explicit/);
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: "0", action: "add", id: "other" }],
    });
    expect(f.state().servers.map((item) => item.config.id)).toEqual(["demo", "other"]);
  });
  it.each(["other", "unpreviewed-new"])(
    "rejects an unpreviewed replace target %s without writing any selection",
    (id) => {
      const f = fixture();
      f.save(f.config, {
        secretOperations: { env: { KEY: { action: "replace", value: "original-private" } } },
      });
      f.save(
        { ...f.config, id: "other", name: "Other" },
        {
          secretOperations: {
            headers: { Authorization: { action: "replace", value: "other-private" } },
          },
        },
      );
      const publicFile = path.join(f.project, ".agentkib/mcp.json"),
        privateFile = path.join(f.project, ".agentkib/mcp.local.json"),
        publicBefore = readFileSync(publicFile, "utf8"),
        privateBefore = readFileSync(privateFile, "utf8"),
        effectiveBefore = effectiveMcp(f.project, f.environment),
        stateBefore = f.state();
      const preview = f.management.previewImport({
        project: f.project,
        text: JSON.stringify({
          queued: { command: "queued-import" },
          demo: { command: "imported", env: { KEY: "imported-private" } },
        }),
      });
      expect(() =>
        f.management.applyImport({
          project: f.project,
          token: preview.token,
          revision: preview.revision,
          selections: [
            { key: preview.items.find((item) => item.config?.id === "queued")!.key, action: "add" },
            {
              key: preview.items.find((item) => item.config?.id === "demo")!.key,
              action: "replace",
              id,
            },
          ],
        }),
      ).toThrow("Replacement target must match the previewed MCP server ID");
      expect(readFileSync(publicFile, "utf8")).toBe(publicBefore);
      expect(readFileSync(privateFile, "utf8")).toBe(privateBefore);
      expect(effectiveMcp(f.project, f.environment)).toEqual(effectiveBefore);
      expect(f.state()).toEqual(stateBefore);
    },
  );
  it.each([undefined, "demo"])("replaces only the original service with compatible ID %s", (id) => {
    const f = fixture();
    f.save(f.config);
    f.save(
      { ...f.config, id: "other", name: "Other" },
      {
        secretOperations: {
          headers: { Authorization: { action: "replace", value: "other-private" } },
        },
      },
    );
    const otherBefore = f.manager.getPrivate("other", f.project);
    const preview = f.management.previewImport({
      project: f.project,
      text: '{"demo":{"command":"imported","env":{"KEY":"imported-private"}}}',
    });
    const result = f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [
        { key: preview.items[0]!.key, action: "replace", ...(id === undefined ? {} : { id }) },
      ],
    });
    expect(result.results[0]).toMatchObject({ id: "demo", status: "saved" });
    expect(f.manager.getPrivate("demo", f.project)).toMatchObject({
      command: "imported",
      env: { KEY: "imported-private" },
    });
    expect(f.manager.getPrivate("other", f.project)).toEqual(otherBefore);
  });
  it("keeps explicit add-as imports separate from the original service and its secrets", () => {
    const f = fixture();
    f.save(f.config, {
      secretOperations: { env: { KEY: { action: "replace", value: "original-private" } } },
    });
    const original = f.manager.getPrivate("demo", f.project),
      preview = f.management.previewImport({
        project: f.project,
        text: '{"demo":{"command":"imported","env":{"KEY":"imported-private"}}}',
      });
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: preview.items[0]!.key, action: "add", id: "confirmed-copy" }],
    });
    expect(f.manager.getPrivate("demo", f.project)).toEqual(original);
    expect(f.manager.getPrivate("confirmed-copy", f.project)).toMatchObject({
      command: "imported",
      env: { KEY: "imported-private" },
    });
  });
});

describe("MCP inline credential classification", () => {
  const ordinary = {
    command: "npx",
    args: ["server@1.0.0", "--mode", "production", "--port=3000", "application/json"],
    env: { DEBUG: "1", NODE_ENV: "production", PORT: "3000", REVISION: "1" },
    headers: { "Content-Type": "application/json", "X-Retry-Count": "1" },
  };

  function submit(entry: typeof ordinary, source: "paste" | "native" | "manual") {
    const f = fixture();
    if (source === "manual") {
      f.save(
        { ...f.config, command: entry.command, args: entry.args },
        {
          secretOperations: Object.fromEntries(
            (["env", "headers"] as const).map((kind) => [
              kind,
              Object.fromEntries(
                Object.entries(entry[kind]).map(([key, value]) => [
                  key,
                  { action: "replace", value },
                ]),
              ),
            ]),
          ),
        },
      );
    } else {
      const text = JSON.stringify({ mcpServers: { demo: entry } });
      let input: { text: string } | { candidateIds: string[] } = { text };
      if (source === "native") {
        const native = path.join(f.project, ".mcp.json");
        write(native, text);
        const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
          (item) => item.name === "demo",
        )!;
        expect(candidate.supported).toBe(true);
        input = { candidateIds: [candidate.id] };
      }
      const preview = f.management.previewImport({ project: f.project, ...input });
      expect(preview.items[0]?.status).toBe("new");
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: preview.items[0]!.key, action: "add" }],
      });
    }
    return f;
  }

  it.each(["paste", "native", "manual"] as const)(
    "accepts ordinary settings and incidental value substrings through %s",
    (source) => {
      const f = submit(ordinary, source);
      expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
        command: ordinary.command,
        args: ordinary.args,
        env: source === "native" ? {} : ordinary.env,
        headers: source === "native" ? {} : ordinary.headers,
      });
      if (source !== "native") {
        const view = f.state().servers[0]!.config;
        expect(view).toMatchObject({
          env: {},
          headers: {},
          args: expect.arrayContaining(["[redacted]"]),
        });
        if (view.transport !== "stdio") throw new Error("Expected stdio fixture");
        f.save({ ...view, args: [...view.args, "--verbose"] }, { originalId: "demo" });
        expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
          args: [...ordinary.args, "--verbose"],
          env: ordinary.env,
        });
      }
    },
  );

  it.each([
    { env: { API_KEY: "1" }, args: ["server@1.0.0"] },
    { env: { XYZ: "synthetic-private" }, args: ["synthetic-private"] },
    { env: { XYZ: "synthetic-private" }, args: ["--endpoint=synthetic-private"] },
    { env: { XYZ: "synthetic-private" }, command: "/synthetic-private/tool" },
    { headers: { "X-Private": "synthetic-private" }, args: ["/synthetic-private/tool"] },
    { headers: { Authorization: "1" }, args: ["server@1.0.0"] },
    { headers: { "X-API-Key": "1" }, args: ["server@1.0.0"] },
    { headers: { Cookie: "1" }, args: ["server@1.0.0"] },
    { env: { NODE_ENV: "synthetic-private" }, args: ["synthetic-private"] },
  ])("blocks repeated private values without a minimum secret length: %j", (fields) => {
    const f = fixture(),
      entry = { command: "npx", args: [], env: {}, headers: {}, ...fields },
      text = JSON.stringify({ mcpServers: { demo: entry } }),
      native = path.join(f.project, ".mcp.json");
    write(native, text);
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === "demo",
    )!;
    expect(candidate.supported).toBe(false);
    for (const source of [{ text }, { candidateIds: [candidate.id] }]) {
      const preview = f.management.previewImport({ project: f.project, ...source });
      expect(preview.items[0]?.status).toBe("blocked");
      expect(JSON.stringify(preview)).not.toContain("synthetic-private");
    }
    expect(() =>
      f.save(
        { ...f.config, command: entry.command, args: entry.args },
        {
          secretOperations: Object.fromEntries(
            (["env", "headers"] as const).map((kind) => [
              kind,
              Object.fromEntries(
                Object.entries(entry[kind]).map(([key, value]) => [
                  key,
                  { action: "replace", value },
                ]),
              ),
            ]),
          ),
        },
      ),
    ).toThrow("Inline credentials must be moved to env or headers before saving");
    expect(f.state().servers).toEqual([]);
    expect(existsSync(path.join(f.project, ".agentkib/mcp.json"))).toBe(false);
    const legacy = serverSchema.parse({ ...f.config, ...entry }),
      view = publicMcpConfig(legacy);
    expect(JSON.stringify(view)).not.toContain("synthetic-private");
    expect(view).not.toMatchObject({ command: entry.command, args: entry.args });
    expect(publicMcpConfig(view)).toEqual(view);
  });
});

describe("MCP import replacement credential revocations", () => {
  function revokedFixture(scope: "global" | "workspace", legacy = false) {
    const f = fixture(),
      project = scope === "workspace" ? f.project : undefined,
      directory = path.join(project ?? f.home, ".agentkib"),
      server = {
        id: "demo",
        name: "demo",
        transport: "streamable-http",
        url: "https://global.example.test/mcp",
        targets: ["codex"],
      };
    f.management.save({
      revision: f.management.state({}).revision,
      server,
      secretOperations: {
        env: {
          TOKEN: { action: "replace", value: "synthetic-global-token" },
          OMITTED: { action: "replace", value: "synthetic-global-omitted" },
        },
        headers: {
          Authorization: { action: "replace", value: "synthetic-global-header" },
          "X-Omitted": { action: "replace", value: "synthetic-global-omitted" },
        },
      },
    });
    f.manager.saveOAuthCredentials("demo", {
      token_response: {
        access_token: "synthetic-global-oauth",
        token_type: "Bearer",
        issuer: "https://issuer.example.test",
      },
    });
    const url = project ? "https://workspace.example.test/mcp" : server.url;
    f.management.save({
      project,
      revision: f.management.state({ project }).revision,
      originalId: "demo",
      overrideInherited: !!project,
      server: { ...server, url },
      secretOperations: {
        env: {
          TOKEN: { action: "delete" },
          OMITTED: { action: "replace", value: "synthetic-current-omitted" },
        },
        headers: {
          Authorization: { action: "delete" },
          "X-Omitted": { action: "replace", value: "synthetic-current-omitted" },
        },
      },
    });
    f.manager.clearOAuthCredentials("demo", project);
    const privateFile = path.join(directory, "mcp.local.json");
    if (legacy) {
      const document = JSON.parse(readFileSync(privateFile, "utf8"));
      delete document.servers[0].local_values_only;
      writeFileSync(privateFile, JSON.stringify(document));
    }
    const replace = (fields: Record<string, unknown> = {}) => {
      const preview = f.management.previewImport({
        project,
        text: JSON.stringify({ ...server, url, name: "Replacement", ...fields }),
      });
      expect(preview.items[0]?.status).toBe("conflict");
      return f.management.applyImport({
        project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: preview.items[0]!.key, action: "replace" }],
      });
    };
    return { ...f, project, directory, privateFile, url, replace };
  }

  it.each(
    (["global", "workspace"] as const).flatMap((scope) =>
      [false, true].flatMap((legacy) =>
        [false, true].map((changedUrl) => ({ scope, legacy, changedUrl })),
      ),
    ),
  )(
    "keeps revocations across $scope replacement (legacy=$legacy, changedUrl=$changedUrl)",
    ({ scope, legacy, changedUrl }) => {
      const f = revokedFixture(scope, legacy),
        globalBefore = ["mcp.json", "mcp.local.json"].map((name) =>
          readFileSync(path.join(f.home, ".agentkib", name), "utf8"),
        );
      const url = changedUrl ? "https://replacement.example.test/mcp" : f.url;
      expect(f.replace({ url }).results[0]?.status).toBe("saved");
      const current = f.manager.getPrivate("demo", f.project)!;
      expect(current).toMatchObject({ url, enabled: false });
      expect(current.env).toEqual({});
      expect(current.headers).toEqual({});
      expect(current.oauth_credentials).toBeUndefined();
      if (current.transport === "stdio") throw new Error("Expected HTTP fixture");
      expect(oauthProvider(current, f.manager, f.project, 47653).tokens()).toBeUndefined();
      const local = JSON.parse(readFileSync(f.privateFile, "utf8")).servers[0];
      expect(local).toMatchObject({ local_values_only: true, clear_oauth: true });
      expect(local.deleted_env).toEqual(expect.arrayContaining(["TOKEN", "OMITTED"]));
      expect(local.deleted_headers).toEqual(expect.arrayContaining(["Authorization", "X-Omitted"]));
      if (scope === "workspace")
        expect(
          ["mcp.json", "mcp.local.json"].map((name) =>
            readFileSync(path.join(f.home, ".agentkib", name), "utf8"),
          ),
        ).toEqual(globalBefore);
    },
  );

  it.each(["global", "workspace"] as const)(
    "releases only explicitly supplied secret keys during %s replacement",
    (scope) => {
      const f = revokedFixture(scope);
      f.replace({
        env: { TOKEN: "synthetic-new-token" },
        headers: { Authorization: "synthetic-new-header" },
      });
      const current = f.manager.getPrivate("demo", f.project)!;
      expect(current.env).toEqual({ TOKEN: "synthetic-new-token" });
      expect(current.headers).toEqual({ Authorization: "synthetic-new-header" });
      const local = JSON.parse(readFileSync(f.privateFile, "utf8")).servers[0];
      expect(local.deleted_env).toEqual(["OMITTED"]);
      expect(local.deleted_headers).toEqual(["X-Omitted"]);
      expect(local.clear_oauth).toBe(true);
      expect(readFileSync(path.join(f.directory, "mcp.json"), "utf8")).not.toContain(
        "synthetic-new",
      );
    },
  );

  it("does not treat native credential names as explicit replacement values", () => {
    const f = revokedFixture("workspace");
    write(
      path.join(f.project!, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: {
            url: "https://native.example.test/mcp",
            env: { TOKEN: "synthetic-native-token" },
            headers: { Authorization: "synthetic-native-header" },
          },
        },
      }),
    );
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === "demo",
    )!;
    const preview = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: preview.items[0]!.key, action: "replace" }],
    });
    const current = f.manager.getPrivate("demo", f.project)!;
    expect(current.env).toEqual({});
    expect(current.headers).toEqual({});
    expect(current).toMatchObject({
      required_env: ["TOKEN"],
      required_headers: ["Authorization"],
    });
    const local = JSON.parse(readFileSync(f.privateFile, "utf8")).servers[0];
    expect(local.deleted_env).toContain("TOKEN");
    expect(local.deleted_headers).toContain("Authorization");
    expect(readFileSync(f.privateFile, "utf8")).not.toContain("synthetic-native");
  });

  it.each([false, true])(
    "clears previously inherited OAuth without import authorization (changedUrl=%s)",
    (changedUrl) => {
      const f = revokedFixture("workspace"),
        document = JSON.parse(readFileSync(f.privateFile, "utf8"));
      delete document.servers[0].clear_oauth;
      writeFileSync(f.privateFile, JSON.stringify(document));
      expect(f.manager.getPrivate("demo", f.project)?.oauth_credentials).toBeDefined();
      f.replace({ url: changedUrl ? "https://replacement.example.test/mcp" : f.url });
      expect(f.manager.getPrivate("demo", f.project)?.oauth_credentials).toBeUndefined();
    },
  );

  it("preserves revocations without writes when an import is skipped or rejected", () => {
    const f = revokedFixture("workspace"),
      before = ["mcp.json", "mcp.local.json"].map((name) =>
        readFileSync(path.join(f.directory, name), "utf8"),
      );
    for (const action of ["skip", "replace"] as const) {
      const preview = f.management.previewImport({
        project: f.project,
        text: '{"demo":{"url":"https://replacement.example.test/mcp"}}',
      });
      const apply = () =>
        f.management.applyImport({
          project: f.project,
          token: preview.token,
          revision: preview.revision,
          selections: [{ key: preview.items[0]!.key, action, id: "other" }],
        });
      if (action === "skip") expect(apply().results[0]?.status).toBe("skipped");
      else expect(apply).toThrow(/Replacement target/);
      expect(
        ["mcp.json", "mcp.local.json"].map((name) =>
          readFileSync(path.join(f.directory, name), "utf8"),
        ),
      ).toEqual(before);
    }
  });

  it("sends neither revoked headers nor OAuth through the HTTP transport after replacement", async () => {
    const f = revokedFixture("workspace"),
      sent: Array<{ url: string; authorization: string | null; omitted: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET" || request.method === "DELETE")
        return new Response(null, { status: 405 });
      const message = await request.json();
      sent.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        omitted: request.headers.get("x-omitted"),
      });
      if (!("id" in message)) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              serverInfo: { name: "synthetic-fixture", version: "1" },
              capabilities: { tools: {} },
            }
          : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
    cleanups.push(async () => {
      await f.manager.closeAsync();
      vi.unstubAllGlobals();
    });
    f.replace({ url: "https://replacement.example.test/mcp" });
    const state = f.management.state({ project: f.project });
    f.management.save({
      project: f.project,
      revision: state.revision,
      originalId: "demo",
      server: { ...state.servers[0]!.config, enabled: true },
    });
    await f.manager.probe("demo", f.project);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual(
      sent.map(() => ({
        url: "https://replacement.example.test/mcp",
        authorization: null,
        omitted: null,
      })),
    );
  });
});

describe("MCP versioned private/public save", () => {
  function legacyConnection(
    connection: Record<string, unknown>,
    options?: Parameters<typeof fixture>[0],
  ) {
    const f = fixture(options),
      definition = serverSchema.parse({ ...f.config, ...connection }),
      publicFile = path.join(f.project, ".agentkib/mcp.json"),
      privateFile = path.join(f.project, ".agentkib/mcp.local.json");
    write(publicFile, JSON.stringify({ schema_version: 1, servers: [definition] }));
    write(
      privateFile,
      JSON.stringify({
        schema_version: 1,
        servers: [
          {
            ...definition,
            local_values_only: true,
            env: { PRIVATE_KEY: "synthetic-local-private" },
            headers: { "X-Private": "synthetic-header-private" },
            oauth_credentials: { tokens: { access_token: "synthetic-oauth-private" } },
          },
        ],
      }),
    );
    const before = [readFileSync(publicFile, "utf8"), readFileSync(privateFile, "utf8")],
      effective = effectiveMcp(f.project, f.environment),
      state = f.state();
    return {
      ...f,
      definition,
      publicFile,
      config: state.servers[0]!.config,
      assertUnchanged() {
        expect([readFileSync(publicFile, "utf8"), readFileSync(privateFile, "utf8")]).toEqual(
          before,
        );
        expect(effectiveMcp(f.project, f.environment)).toEqual(effective);
        expect(f.state().revision).toBe(state.revision);
      },
    };
  }

  it.each(["prepend", "reorder", "duplicate"])(
    "rejects an unrecoverable redacted argument after %s without changing either file",
    (edit) => {
      const f = legacyConnection({ args: ["--token", "synthetic-private", "--mode", "test"] });
      expect(f.config.transport).toBe("stdio");
      if (f.config.transport !== "stdio") throw new Error("Expected stdio fixture");
      expect(f.config.args).toEqual(["--token", "[redacted]", "--mode", "test"]);
      const args =
        edit === "prepend"
          ? ["--verbose", ...f.config.args]
          : edit === "reorder"
            ? [...f.config.args.slice(2), ...f.config.args.slice(0, 2)]
            : [...f.config.args, "--other-token", "[redacted]"];
      expect(() =>
        f.save(
          { ...f.config, args },
          {
            originalId: "demo",
            secretOperations: { env: { PRIVATE_KEY: { action: "replace", value: "new-private" } } },
          },
        ),
      ).toThrow(/Redacted.*env or headers/);
      f.assertUnchanged();
    },
  );

  it.each([
    {
      edit: "path",
      url: "https://synthetic-user:synthetic-private@one.example.test/mcp",
      marker: "%5Bredacted%5D",
    },
    {
      edit: "host",
      url: "https://synthetic-user:synthetic-private@one.example.test/mcp",
      marker: "%5Bredacted%5D",
    },
    {
      edit: "path",
      url: "https://one.example.test/mcp?token=synthetic-private",
      marker: "[redacted]",
    },
    {
      edit: "host",
      url: "https://one.example.test/mcp?token=synthetic-private",
      marker: "[redacted]",
    },
  ])(
    "rejects a URL $edit edit that retains a $marker redaction placeholder",
    ({ edit, url: originalUrl, marker }) => {
      const f = legacyConnection({
        transport: "streamable-http",
        url: originalUrl,
      });
      if (f.config.transport === "stdio") throw new Error("Expected HTTP fixture");
      expect(f.config.url).toContain(marker);
      const url = new URL(f.config.url);
      if (edit === "path") url.pathname = "/changed";
      else url.hostname = "two.example.test";
      expect(() => f.save({ ...f.config, url: url.toString() }, { originalId: "demo" })).toThrow(
        /Redacted.*env or headers/,
      );
      f.assertUnchanged();
    },
  );

  it.each(["command", "cwd"] as const)(
    "rejects editing a redacted %s without relocating a hidden value",
    (field) => {
      const f = legacyConnection({ [field]: "/synthetic-local-private/tool" });
      if (f.config.transport !== "stdio") throw new Error("Expected stdio fixture");
      expect(f.config[field]).toBe("/[redacted]/tool");
      expect(() =>
        f.save({ ...f.config, [field]: `${f.config[field]}-changed` }, { originalId: "demo" }),
      ).toThrow(/Redacted.*env or headers/);
      f.assertUnchanged();
    },
  );

  it("rejects moving a generated argument placeholder into another connection field", () => {
    // Configuration files are the persistence boundary here. Keep the workspace registry in memory.
    const f = legacyConnection(
      { args: ["--token", "synthetic-private"] },
      { database: ":memory:" },
    );
    expect(() =>
      f.save({ ...f.config, args: [], cwd: "/[redacted]/tool" }, { originalId: "demo" }),
    ).toThrow(/Redacted.*env or headers/);
    f.assertUnchanged();
  });

  it.each([
    { args: ["--token", "synthetic-private", "--output", "[redacted]"] },
    { transport: "streamable-http", url: "https://example.test/mcp?token=synthetic-private" },
    { command: "/synthetic-local-private/tool", cwd: "/synthetic-header-private/work" },
  ])(
    "restores unchanged connection placeholders when switches and targets change: %j",
    (fields) => {
      const f = legacyConnection(fields);
      f.save({ ...f.config, enabled: false, targets: ["cursor"] }, { originalId: "demo" });
      expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
        ...f.definition,
        enabled: false,
        targets: ["cursor"],
        env: { PRIVATE_KEY: "synthetic-local-private" },
        headers: { "X-Private": "synthetic-header-private" },
        oauth_credentials: { tokens: { access_token: "synthetic-oauth-private" } },
      });
      expect(JSON.stringify(f.state())).not.toContain("synthetic-private");
    },
  );

  it("keeps the existing inline-edit rule when a separate literal placeholder is unchanged", () => {
    const f = legacyConnection({
      args: ["--token", "synthetic-private", "--output", "[redacted]", "--mode", "old"],
    });
    if (f.config.transport !== "stdio") throw new Error("Expected stdio fixture");
    expect(() =>
      f.save({ ...f.config, args: [...f.config.args.slice(0, -1), "new"] }, { originalId: "demo" }),
    ).toThrow(/^Inline credentials must be moved to env or headers before saving$/);
    f.assertUnchanged();
  });

  it("allows ordinary argument reordering and literal redacted names", () => {
    const f = legacyConnection({
      command: "redacted-mcp",
      args: ["--mode", "test", "--output", "[redacted]"],
      cwd: "/work/redacted-files",
    });
    const args = ["--output", "[redacted]", "--mode", "test"];
    f.save({ ...f.config, args, cwd: "/work/redacted-archive" }, { originalId: "demo" });
    expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
      command: "redacted-mcp",
      args,
      cwd: "/work/redacted-archive",
    });
  });

  it.each(["[redacted]", "%5Bredacted%5D"])(
    "allows editing a URL whose original credential value is literally %s",
    (literal) => {
      const f = legacyConnection({
        transport: "streamable-http",
        url: `https://example.test/mcp?token=${literal}`,
      });
      if (f.config.transport === "stdio") throw new Error("Expected HTTP fixture");
      const url = f.config.url.replace("/mcp?", "/changed?");
      f.save({ ...f.config, url }, { originalId: "demo" });
      expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({ url });
    },
  );

  it("does not let private snapshots override new public switches, endpoints or targets", () => {
    const f = fixture();
    f.save(f.config, { secretOperations: { env: { KEY: { action: "replace", value: "one" } } } });
    expect(f.state().servers[0]?.config.enabled).toBe(false);
    f.save(
      {
        ...f.state().servers[0]!.config,
        enabled: true,
        command: "new-command",
        targets: ["cursor"],
      },
      { originalId: "demo" },
    );
    expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
      enabled: true,
      command: "new-command",
      targets: ["cursor"],
      env: { KEY: "one" },
    });
    expect(() =>
      f.save({ ...f.state().servers[0]!.config, targets: [] }, { originalId: "demo" }),
    ).toThrow(/at least one/);
  });
  it("rechecks upper-scope revisions and creates/removes only local overrides", () => {
    const f = fixture();
    f.management.save({
      revision: f.management.state({}).revision,
      server: f.config,
      secretOperations: { env: { GLOBAL: { action: "replace", value: "private-global" } } },
    });
    const before = readFileSync(path.join(f.home, ".agentkib/mcp.json"), "utf8");
    const state = f.state();
    expect(state.servers[0]?.inherited).toBe(true);
    expect(() => f.save(f.config, { originalId: "demo" })).toThrow(/override/);
    f.save(f.config, {
      originalId: "demo",
      overrideInherited: true,
      secretOperations: { env: { GLOBAL: { action: "delete" } } },
    });
    expect(effectiveMcp(f.project, f.environment)[0]?.env).toEqual({});
    expect(readFileSync(path.join(f.home, ".agentkib/mcp.json"), "utf8")).toBe(before);
    f.management.remove({ project: f.project, revision: f.state().revision, id: "demo" });
    expect(f.state().servers[0]?.inherited).toBe(true);
    expect(effectiveMcp(f.project, f.environment)[0]?.env).toEqual({ GLOBAL: "private-global" });
    const stale = f.state().revision;
    write(path.join(f.home, ".agentkib/mcp.json"), before + "\n");
    expect(() =>
      f.management.save({
        project: f.project,
        revision: stale,
        server: f.config,
        originalId: "demo",
        overrideInherited: true,
      }),
    ).toThrow(/changed/);
  });
  it("rejects newly entered inline secrets and clears OAuth when the endpoint changes", () => {
    const f = fixture();
    expect(() =>
      f.save({
        id: "demo",
        name: "demo",
        transport: "streamable-http",
        url: "https://example.test?token=private",
      }),
    ).toThrow(/Inline/);
    f.save({
      id: "demo",
      name: "demo",
      transport: "streamable-http",
      url: "https://one.example.test/mcp",
    });
    f.manager.saveOAuthCredentials(
      "demo",
      { tokens: { access_token: "old-private-token" } },
      f.project,
    );
    f.save(
      { ...f.state().servers[0]!.config, url: "https://two.example.test/mcp" },
      { originalId: "demo" },
    );
    expect(effectiveMcp(f.project, f.environment)[0]?.oauth_credentials).toBeUndefined();
    expect(JSON.stringify(f.state())).not.toContain("old-private-token");
  });
  it("validates secret operations before either file changes", () => {
    const f = fixture();
    f.save(f.config);
    const before = f.state().revision;
    expect(() =>
      f.save(
        { ...f.state().servers[0]!.config, name: "changed" },
        { originalId: "demo", secretOperations: { env: { KEY: { action: "replace", value: 5 } } } },
      ),
    ).toThrow();
    expect(f.state().revision).toBe(before);
  });
  it("compensates a failure on the private file and preserves an externally edited first file", () => {
    const f = fixture();
    f.save(f.config);
    const publicFile = path.join(f.project, ".agentkib/mcp.json"),
      privateFile = path.join(f.project, ".agentkib/mcp.local.json");
    const before = readFileSync(publicFile, "utf8"),
      original = nativeFiles.replaceFile;
    const replacement = vi
      .spyOn(nativeFiles, "replaceFile")
      .mockImplementation((source, target) => {
        if (target === privateFile) throw new Error("fixture second-file failure");
        return original(source, target);
      });
    expect(() =>
      f.save({ ...f.state().servers[0]!.config, name: "changed" }, { originalId: "demo" }),
    ).toThrow(/second-file/);
    expect(readFileSync(publicFile, "utf8")).toBe(before);
    replacement.mockImplementation((source, target) => {
      if (target === privateFile) {
        writeFileSync(publicFile, before + "\n");
        throw new Error("fixture second-file failure");
      }
      return original(source, target);
    });
    expect(() =>
      f.save({ ...f.state().servers[0]!.config, name: "changed" }, { originalId: "demo" }),
    ).toThrow(/rollback incomplete.*external content/);
    expect(readFileSync(publicFile, "utf8")).toBe(before + "\n");
  });
});

describe("native stdio working directories", () => {
  it.each([
    { agent: "claude-code", relative: false },
    { agent: "claude-code", relative: true },
    { agent: "opencode", relative: true },
    { agent: "codex", relative: true },
  ] as const)(
    "preserves $agent cwd and relative reads through collection and migration ($relative)",
    async ({ agent, relative }) => {
      const f = fixture(),
        cwd = agent === "codex" ? path.join(f.root, "server-work") : f.project,
        script = path.join(cwd, "cwd-fixture.cjs"),
        native = path.join(
          f.project,
          agent === "claude-code"
            ? ".mcp.json"
            : agent === "opencode"
              ? ".opencode/opencode.json"
              : ".codex/config.toml",
        ),
        start = vi.spyOn(McpStdioTransport.prototype, "start");
      write(path.join(cwd, "relative.txt"), "workspace-relative-content");
      write(
        script,
        String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cwd-fixture',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'read',inputSchema:{type:'object'}}]};else result={content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),file:require('node:fs').readFileSync('relative.txt','utf8')})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');});`,
      );
      const args = [relative ? "./cwd-fixture.cjs" : script],
        before =
          agent === "codex"
            ? `[mcp_servers.tool]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\ncwd = ${JSON.stringify(cwd)}\n`
            : JSON.stringify(
                agent === "opencode"
                  ? { mcp: { tool: { type: "local", command: [process.execPath, ...args] } } }
                  : { mcpServers: { tool: { command: process.execPath, args } } },
              );
      write(native, before);
      const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
        (item) => item.name === "tool",
      )!;
      expect(candidate.supported).toBe(true);
      const preview = f.management.previewImport({
        project: f.project,
        candidateIds: [candidate.id],
      });
      expect(preview.items[0]?.status).toBe("new");
      f.management.applyImport({
        project: f.project,
        revision: preview.revision,
        token: preview.token,
        selections: [{ key: candidate.id, action: "add" }],
      });
      expect(readFileSync(native, "utf8")).toBe(before);
      expect(start).not.toHaveBeenCalled();
      // Check execution as well as persisted configuration: absolute script names still
      // depend on cwd for their own relative file access.
      f.save({ ...f.state().servers[0]!.config, enabled: true }, { originalId: "tool" });
      await f.manager.probe("tool", f.project);
      const result = (await f.manager.callHubTool(f.project, agent, "tool__read", {}, false)) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        cwd,
        file: "workspace-relative-content",
      });
      expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({ cwd });
      write(
        path.join(f.project, ".agentkib/manifest.yaml"),
        "schema_version: 2\nworkspace:\n  id: registered\n  name: fixture\n",
      );
      const hub = { running: true, port: 47653 },
        legacy = await planNativeMcpMigration(
          { project: f.project, candidateIds: [candidate.id], mcpHubStatus: hub },
          f.store,
          f.manager,
          f.environment,
        ),
        migration = await f.management.previewMigration(
          { project: f.project, revision: f.state().revision, candidateIds: [candidate.id] },
          hub,
        );
      expect(
        JSON.parse(
          legacy.changes.find(
            (change) => change.target === path.join(f.project, ".agentkib/mcp.json"),
          )!.after,
        ).servers[0],
      ).toMatchObject({ cwd });
      f.management.applyMigration({ token: migration.token, approveHome: false }, hub);
      expect(readFileSync(native, "utf8")).not.toBe(before);
      expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({ cwd });
      const after = (await f.manager.callHubTool(f.project, agent, "tool__read", {}, false)) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(after.content[0]!.text)).toEqual({
        cwd,
        file: "workspace-relative-content",
      });
    },
  );

  it.each([
    { file: ".codex/config.toml", agent: "codex" },
    { file: ".grok/config.toml", agent: "grok-build" },
    { file: ".claude.json", agent: "claude-code" },
    { file: ".cursor/mcp.json", agent: "cursor" },
    { file: ".gemini/config/mcp_config.json", agent: "antigravity" },
    { file: ".config/opencode/opencode.json", agent: "opencode" },
    { file: ".openclaw/openclaw.json", agent: "open-claw" },
    { file: ".hermes/config.yaml", agent: "hermes" },
  ])(
    "blocks unknown home cwd for $agent even with a selected workspace",
    async ({ file, agent }) => {
      const f = fixture(),
        native = path.join(f.home, file),
        entry = { command: process.execPath, args: ["/absolute/server.cjs"] },
        before = file.endsWith(".toml")
          ? `[mcp_servers.tool]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["/absolute/server.cjs"]\n`
          : JSON.stringify(
              agent === "opencode"
                ? { mcp: { tool: { type: "local", command: [entry.command, ...entry.args] } } }
                : agent === "open-claw"
                  ? { mcp: { servers: { tool: entry } } }
                  : agent === "hermes"
                    ? { mcp_servers: { tool: entry } }
                    : { mcpServers: { tool: entry } },
            ),
        start = vi.spyOn(McpStdioTransport.prototype, "start");
      write(native, before);
      const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
        (item) => item.agent === agent && item.name === "tool",
      )!;
      expect(candidate.supported).toBe(false);
      expect(candidate.warnings.join(" ")).toMatch(/working directory/);
      expect(candidate.warning_messages).toContainEqual({
        key: "mcp.manage.diagnostic.native_working_directory",
      });
      for (const project of [undefined, f.project]) {
        const preview = f.management.previewImport({ project, candidateIds: [candidate.id] });
        expect(preview.items[0]?.status).toBe("blocked");
        expect(() =>
          f.management.applyImport({
            project,
            revision: preview.revision,
            token: preview.token,
            selections: [{ key: candidate.id, action: "add" }],
          }),
        ).toThrow("Blocked import item");
      }
      await expect(
        f.management.previewMigration(
          { project: f.project, revision: f.state().revision, candidateIds: [candidate.id] },
          { running: true, port: 47653 },
        ),
      ).rejects.toThrow("Blocked native definitions cannot be migrated");
      expect(readFileSync(native, "utf8")).toBe(before);
      expect(f.state().servers).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it.each(["project", "home"])(
    "preserves supported absolute cwd and rejects ambiguous relative cwd in %s scope",
    (scope) => {
      const f = fixture(),
        native = path.join(scope === "home" ? f.home : f.project, ".codex/config.toml");
      for (const cwd of [f.project, "./server", "~/server", ""]) {
        write(native, `[mcp_servers.tool]\ncommand = "node"\ncwd = ${JSON.stringify(cwd)}\n`);
        const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
          (item) => item.name === "tool",
        )!;
        expect(candidate.supported).toBe(cwd === f.project);
        const preview = f.management.previewImport({
          project: scope === "project" ? f.project : undefined,
          candidateIds: [candidate.id],
        });
        expect(preview.items[0]?.status).toBe(cwd === f.project ? "new" : "blocked");
        if (cwd === f.project) expect(preview.items[0]?.config).toMatchObject({ cwd });
      }
    },
  );

  it("does not activate Claude cwd fields ignored by the native client", () => {
    const f = fixture();
    write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { tool: { command: "node", cwd: f.project } } }),
    );
    expect(
      scanNativeMcp({ project: f.project }, f.store, f.environment).find(
        (item) => item.name === "tool",
      )?.supported,
    ).toBe(false);
  });

  it.each([
    { agent: "codex", file: ".codex/config.toml" },
    { agent: "grok-build", file: ".grok/config.toml" },
    { agent: "cursor", file: ".cursor/mcp.json" },
    { agent: "antigravity", file: ".agents/mcp_config.json" },
  ])("blocks unknown project default cwd for $agent", ({ agent, file }) => {
    const f = fixture();
    write(
      path.join(f.project, file),
      file.endsWith(".toml")
        ? '[mcp_servers.tool]\ncommand = "node"\n'
        : JSON.stringify({ mcpServers: { tool: { command: "node" } } }),
    );
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.agent === agent && item.name === "tool",
    )!;
    expect(candidate.supported).toBe(false);
    expect(candidate.warnings.join(" ")).toMatch(/working directory/);
    expect(candidate.warning_messages).toContainEqual({
      key: "mcp.manage.diagnostic.native_working_directory",
    });
  });

  it.each([
    { agent: "cursor", file: ".cursor/mcp.json" },
    { agent: "antigravity", file: ".gemini/config/mcp_config.json" },
    { agent: "open-claw", file: ".openclaw/openclaw.json" },
  ])("preserves explicitly supported absolute home cwd for $agent", ({ agent, file }) => {
    const f = fixture(),
      entry = { command: "node", cwd: f.project };
    write(
      path.join(f.home, file),
      JSON.stringify(
        agent === "open-claw"
          ? { mcp: { servers: { tool: entry } } }
          : { mcpServers: { tool: entry } },
      ),
    );
    const candidate = scanNativeMcp({}, f.store, f.environment).find(
      (item) => item.agent === agent && item.name === "tool",
    )!;
    expect(candidate.supported).toBe(true);
    const preview = f.management.previewImport({ candidateIds: [candidate.id] });
    expect(preview.items[0]?.config).toMatchObject({ cwd: f.project });
  });
});

describe("native collection and explicit migration", () => {
  it.each([
    { format: "json", gateway: null },
    { format: "json", gateway: [] },
    { format: "json", gateway: "unmanaged" },
    { format: "json", gateway: false },
    { format: "json", gateway: 42 },
    { format: "toml", gateway: [] },
    { format: "toml", gateway: "unmanaged" },
    { format: "toml", gateway: false },
    { format: "toml", gateway: 42 },
  ])(
    "blocks an existing non-object $format agentkib connection ($gateway) during migration",
    async ({ format, gateway }) => {
      const f = fixture(),
        native = path.join(f.project, format === "json" ? ".mcp.json" : ".codex/config.toml"),
        before =
          format === "json"
            ? JSON.stringify({
                mcpServers: { tool: { command: "must-not-run" }, agentkib: gateway },
              })
            : `[mcp_servers]\nagentkib = ${JSON.stringify(gateway)}\n[mcp_servers.tool]\ncommand = "must-not-run"\ncwd = ${JSON.stringify(f.project)}\n`,
        start = vi.spyOn(McpStdioTransport.prototype, "start");
      write(native, before);
      const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
        (item) => item.name === "tool" && item.source_path === native,
      )!;
      expect(candidate.supported).toBe(true);
      const preview = f.management.previewImport({
        project: f.project,
        candidateIds: [candidate.id],
      });
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: candidate.id, action: "add" }],
      });
      f.save({ ...f.state().servers[0]!.config, enabled: true }, { originalId: "tool" });
      vi.spyOn(f.manager, "hasCurrentProbe").mockReturnValue(true);
      const stateBefore = f.state(),
        files = [
          native,
          path.join(f.project, ".agentkib/mcp.json"),
          path.join(f.project, ".agentkib/mcp.local.json"),
        ],
        snapshots = files.map((file) => readFileSync(file, "utf8"));
      await expect(
        f.management.previewMigration(
          { project: f.project, revision: stateBefore.revision, candidateIds: [candidate.id] },
          { running: true, port: 47653 },
        ),
      ).rejects.toThrow(/explicit connection repair/);
      expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(snapshots);
      expect(f.state()).toEqual(stateBefore);
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("redacts inline credential headers in unrelated migration entries without starting a process", async () => {
    const f = fixture(),
      native = path.join(f.project, ".mcp.json"),
      start = vi.spyOn(McpStdioTransport.prototype, "start"),
      unsafe = {
        command: `curl -H 'Authorization: Custom synthetic-header-private'`,
        args: [
          "--header",
          "X-API-Key: synthetic-header-private",
          "--header=Cookie:session=synthetic-header-private; refresh=synthetic-cookie-private",
          "-c",
          `curl -H 'Authorization: Digest username="synthetic-header-private", response="synthetic-cookie-private"'`,
          "--header",
          "Accept: application/json",
        ],
      },
      before = JSON.stringify({
        mcpServers: { safe: { command: "must-not-run" }, unsafe },
      });
    write(native, before);
    const candidates = scanNativeMcp({ project: f.project }, f.store, f.environment),
      safe = candidates.find((item) => item.name === "safe")!,
      blocked = candidates.find((item) => item.name === "unsafe")!;
    expect(blocked.supported).toBe(false);
    const preview = f.management.previewImport({ project: f.project, candidateIds: [safe.id] });
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: safe.id, action: "add" }],
    });
    f.save({ ...f.state().servers[0]!.config, enabled: true }, { originalId: "safe" });
    vi.spyOn(f.manager, "hasCurrentProbe").mockReturnValue(true);
    const plan = await f.management.previewMigration(
      { project: f.project, revision: f.state().revision, candidateIds: [safe.id] },
      { running: true, port: 47653 },
    );
    expect(JSON.stringify(plan)).not.toMatch(/synthetic-(?:header|cookie)-private/);
    expect(plan.changes[0]!.before).toContain("Accept: application/json");
    expect(plan.changes[0]!.after).toContain("Accept: application/json");
    expect(readFileSync(native, "utf8")).toBe(before);
    expect(readFileSync(path.join(f.project, ".agentkib/mcp.json"), "utf8")).not.toMatch(
      /synthetic-(?:header|cookie)-private/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("reconfirms identical source formatting without replacing runtime or policy state", async () => {
    const f = nativeProvenanceFixture();
    await f.prepare(["tool"]);
    const id = f.candidate("tool").id;
    f.manager.savePolicy(
      {
        revision: f.manager.getPolicy(f.project).revision,
        rules: [{ agent: "claude-code", server_id: "tool", mode: "selected", tools: ["read"] }],
      },
      f.project,
    );
    const before = f.manager.getPrivate("tool", f.project)!,
      catalog = f.manager.cachedTools("tool", f.project),
      privateFile = path.join(f.project, ".agentkib/mcp.local.json"),
      policyFile = path.join(f.project, ".agentkib/mcp-policy.json"),
      privateBefore = readFileSync(privateFile, "utf8"),
      policyBefore = readFileSync(policyFile, "utf8");
    await expect(f.migrate([id])).resolves.toMatchObject({ token: expect.any(String) });
    write(f.native, readFileSync(f.native, "utf8") + "\n");
    await expect(f.migrate([id])).rejects.toThrow("Native source changed since collection");
    const revision = f.state().revision;
    expect(f.collect([id], "skip").result.results[0]?.status).toBe("skipped");
    expect(f.state().revision).toBe(revision);
    const repeated = f.collect([id], "replace");
    expect(repeated.plan.items[0]?.status).toBe("identical");
    expect(repeated.result.results[0]?.status).toBe("skipped");
    const after = f.manager.getPrivate("tool", f.project)!;
    expect(after.native_source?.fingerprint).toBe(f.candidate("tool").fingerprint);
    expect({ ...after, native_source: before.native_source }).toEqual(before);
    expect(readFileSync(privateFile, "utf8")).toBe(privateBefore);
    expect(readFileSync(policyFile, "utf8")).toBe(policyBefore);
    expect(f.manager.hasCurrentProbe("tool", f.project)).toBe(true);
    expect(f.manager.cachedTools("tool", f.project)).toEqual(catalog);
    const plan = await f.migrate([id]);
    f.management.applyMigration({ token: plan.token, approveHome: false }, f.hub);
    const nativeAfter = JSON.parse(readFileSync(f.native, "utf8"));
    expect(nativeAfter.mcpServers.tool).toBeUndefined();
    expect(nativeAfter.mcpServers.other).toEqual(f.definition);
  });

  it("reconfirms changed native credential requirements without copying or replacing secrets", async () => {
    const f = nativeProvenanceFixture();
    await f.prepare(["tool"]);
    const id = f.candidate("tool").id,
      privateFile = path.join(f.project, ".agentkib/mcp.local.json"),
      privateBefore = readFileSync(privateFile, "utf8"),
      original = f.manager.getPrivate("tool", f.project)!,
      start = vi.spyOn(McpStdioTransport.prototype, "start"),
      native = {
        mcpServers: {
          tool: {
            ...f.definition,
            env: { ...f.definition.env, NEW_TOKEN: "native-new-private" },
            headers: { ...f.definition.headers, "X-New-Key": "native-new-header-private" },
          },
        },
      };
    write(f.native, JSON.stringify(native));
    const preview = f.preview([id]);
    expect(preview.items[0]).toMatchObject({
      status: "identical",
      required_env: ["KEY", "NEW_TOKEN"],
      required_headers: ["X-Fixture", "X-New-Key"],
    });
    const beforeSkip = f.state();
    f.collect([id], "skip");
    expect(f.state()).toEqual(beforeSkip);
    f.collect([id], "replace");
    expect(f.state().servers[0]).toMatchObject({
      required_env: ["KEY", "NEW_TOKEN"],
      required_headers: ["X-Fixture", "X-New-Key"],
    });
    const after = f.manager.getPrivate("tool", f.project)!;
    expect({
      ...after,
      native_source: original.native_source,
      required_env: original.required_env,
      required_headers: original.required_headers,
    }).toEqual(original);
    expect(readFileSync(privateFile, "utf8")).toBe(privateBefore);
    expect(f.manager.hasCurrentProbe("tool", f.project)).toBe(true);
    expect(JSON.stringify(f.state())).not.toMatch(/native-new-private|native-new-header-private/);
    await expect(f.migrate([id])).rejects.toThrow(/Enter all required private values/);
    expect(readFileSync(f.native, "utf8")).toBe(JSON.stringify(native));
    // Removed requirements disappear from the hints, while locally entered values stay private.
    delete (native.mcpServers.tool.env as Record<string, string>).KEY;
    delete (native.mcpServers.tool.headers as Record<string, string>)["X-Fixture"];
    write(f.native, JSON.stringify(native));
    f.collect([id], "replace");
    expect(f.state().servers[0]).toMatchObject({
      required_env: ["NEW_TOKEN"],
      required_headers: ["X-New-Key"],
    });
    expect(f.manager.getPrivate("tool", f.project)?.env).toEqual(original.env);
    expect(f.manager.getPrivate("tool", f.project)?.headers).toEqual(original.headers);
    expect(readFileSync(privateFile, "utf8")).toBe(privateBefore);
    expect(start).not.toHaveBeenCalled();
  });

  it("can reconfirm and migrate a remaining service after migrating another from the same file", async () => {
    const f = nativeProvenanceFixture();
    await f.prepare(["tool", "other"]);
    const tool = f.candidate("tool").id,
      other = f.candidate("other").id;
    const first = await f.migrate([tool]);
    f.management.applyMigration({ token: first.token, approveHome: false }, f.hub);
    await expect(f.migrate([other])).rejects.toThrow("Native source changed since collection");
    const repeated = f.collect([other], "replace");
    expect(repeated.plan.items[0]?.status).toBe("identical");
    expect(repeated.result.results[0]?.status).toBe("skipped");
    expect(f.manager.hasCurrentProbe("other", f.project)).toBe(true);
    const second = await f.migrate([other]);
    f.management.applyMigration({ token: second.token, approveHome: false }, f.hub);
    expect(Object.keys(JSON.parse(readFileSync(f.native, "utf8")).mcpServers)).toEqual([
      "agentkib",
    ]);
  });

  it("does not refresh provenance for a changed definition", async () => {
    const f = nativeProvenanceFixture();
    await f.prepare(["tool"]);
    const id = f.candidate("tool").id,
      original = f.manager.getPrivate("tool", f.project),
      revision = f.state().revision;
    const changed = { ...f.definition, args: [...f.definition.args, "changed"] };
    write(f.native, JSON.stringify({ mcpServers: { tool: changed } }));
    expect(f.preview([id]).items[0]?.status).toBe("conflict");
    expect(() => f.collect([id])).toThrow("explicit replace or rename");
    expect(f.state().revision).toBe(revision);
    expect(f.manager.getPrivate("tool", f.project)).toEqual(original);
    await expect(f.migrate([id])).rejects.toThrow("Native source changed since collection");
  });

  it("does not claim provenance of an identical definition from a different source", async () => {
    const f = nativeProvenanceFixture(),
      otherSource = path.join(f.home, ".claude.json"),
      definition = { type: "http", url: "https://example.test/mcp" };
    write(f.native, JSON.stringify({ mcpServers: { tool: definition } }));
    f.collect([f.candidate("tool").id]);
    const original = f.manager.getPrivate("tool", f.project),
      revision = f.state().revision;
    write(otherSource, JSON.stringify({ mcpServers: { tool: definition } }));
    const foreign = f.candidate("tool", otherSource).id,
      repeated = f.collect([foreign], "replace");
    expect(repeated.plan.items[0]?.status).toBe("identical");
    expect(repeated.result.results[0]?.status).toBe("skipped");
    expect(f.state().revision).toBe(revision);
    expect(f.manager.getPrivate("tool", f.project)).toEqual(original);
    await expect(f.migrate([foreign])).rejects.toThrow("Collect this exact native definition");
  });

  it("requires inherited provenance to be reconfirmed in its owning global scope", () => {
    const f = nativeProvenanceFixture(),
      source = path.join(f.home, ".claude.json");
    write(
      source,
      JSON.stringify({ mcpServers: { tool: { type: "http", url: "https://example.test/mcp" } } }),
    );
    const id = f.candidate("tool", source).id;
    const collectGlobal = () => {
      const plan = f.management.previewImport({ candidateIds: [id] });
      return f.management.applyImport({
        token: plan.token,
        revision: plan.revision,
        selections: [{ key: id, action: "replace" }],
      });
    };
    collectGlobal();
    const before = f.management.state({});
    write(source, readFileSync(source, "utf8") + "\n");
    expect(() => f.collect([id], "replace")).toThrow("global scope");
    expect(f.management.state({})).toEqual(before);
    expect(collectGlobal().results[0]?.status).toBe("skipped");
    expect(f.manager.getPrivate("tool", f.project)?.native_source?.fingerprint).toBe(
      f.candidate("tool", source).fingerprint,
    );
  });

  it("reads the selected profiles, strips native secrets, and freezes source bytes", () => {
    const f = fixture();
    const hermes = path.join(f.root, "custom-hermes");
    f.environment.HERMES_HOME = hermes;
    write(path.join(hermes, "active_profile"), "work");
    const file = path.join(hermes, "profiles/work/config.yaml");
    write(
      file,
      "mcp_servers:\n  tool:\n    url: https://example.test/mcp\n    headers:\n      KEY: native-secret\n",
    );
    const candidates = scanNativeMcp({ project: f.project }, f.store, f.environment);
    const candidate = candidates.find((item) => item.agent === "hermes")!;
    expect(candidate.source_path).toBe(file);
    expect(JSON.stringify(candidates)).not.toContain("native-secret");
    const preview = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    expect(preview.items[0]?.required_headers).toEqual(["KEY"]);
    expect(JSON.stringify(preview)).not.toContain("native-secret");
    const before = readFileSync(file, "utf8");
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: candidate.id, action: "add" }],
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(effectiveMcp(f.project, f.environment)[0]).toMatchObject({
      enabled: false,
      headers: {},
      required_headers: ["KEY"],
    });
    const stale = f.management.previewImport({ project: f.project, candidateIds: [candidate.id] });
    write(path.join(hermes, "active_profile"), "other");
    expect(() =>
      f.management.applyImport({
        project: f.project,
        token: stale.token,
        revision: stale.revision,
        selections: [{ key: candidate.id, action: "add" }],
      }),
    ).toThrow(/profile changed/);
  });
  it("isolates an invalid profile and a malformed file from other native sources", () => {
    const f = fixture();
    f.environment.OPENCLAW_PROFILE = "../../invalid";
    write(path.join(f.home, ".hermes/config.yaml"), "[invalid");
    write(path.join(f.project, ".mcp.json"), '{"mcpServers":{"good":{"command":"node"}}}');
    const candidates = scanNativeMcp({ project: f.project }, f.store, f.environment);
    expect(candidates.find((item) => item.name === "good")?.supported).toBe(true);
    expect(candidates.filter((item) => !item.supported)).toHaveLength(2);
  });
  it("only migrates collected, enabled, explicitly probed definitions and keeps private diffs in the host", async () => {
    const f = fixture(),
      script = path.join(f.root, "fixture.cjs");
    writeFileSync(
      script,
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(r.method==='tools/list')result={tools:[]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
    );
    const remoteUrl =
      "https://example.test/mcp?signature=private-signature&sig=private-sig&monkey=public";
    const native = path.join(f.project, ".mcp.json"),
      before = JSON.stringify(
        {
          mcpServers: {
            tool: { command: process.execPath, args: [script], env: { KEY: "native-private" } },
            other: {
              command: "other",
              env: { PASSWORD: "untouched-private" },
              args: ["-c", "curl 'https://shell-user:shell-private@example.test/mcp'"],
            },
            remote: { url: remoteUrl },
          },
        },
        null,
        2,
      );
    write(native, before);
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.name === "tool",
    )!;
    const hub = { running: true, port: 47653 };
    const migration = () =>
      f.management.previewMigration(
        { project: f.project, revision: f.state().revision, candidateIds: [candidate.id] },
        hub,
      );
    await expect(migration()).rejects.toThrow(/Collect/);
    const preview = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: candidate.id, action: "add" }],
    });
    await expect(migration()).rejects.toThrow(/Enable/);
    f.save(
      { ...f.state().servers[0]!.config, enabled: true },
      {
        originalId: "tool",
        secretOperations: { env: { KEY: { action: "replace", value: "entered-private" } } },
      },
    );
    await expect(migration()).rejects.toThrow(/Probe/);
    await f.manager.probe("tool", f.project);
    const plan = await migration();
    expect(plan.changes).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toMatch(
      /native-private|entered-private|untouched-private|private-signature|private-sig|shell-user|shell-private/,
    );
    expect(JSON.stringify(plan)).toContain("monkey=public");
    expect(plan.changes[0]!.after).toContain("/registered/agents/claude-code");
    const configBefore = readFileSync(path.join(f.project, ".agentkib/mcp.json"), "utf8");
    f.management.applyMigration(
      { token: plan.token, approveHome: false },
      { ...hub, runtime_count: 99, error_count: 10 },
    );
    const after = JSON.parse(readFileSync(native, "utf8"));
    expect(after.mcpServers.tool).toBeUndefined();
    expect(after.mcpServers.other.env.PASSWORD).toBe("untouched-private");
    expect(after.mcpServers.other.args[1]).toContain("shell-private");
    expect(after.mcpServers.remote.url).toBe(remoteUrl);
    expect(readFileSync(path.join(f.project, ".agentkib/mcp.json"), "utf8")).toBe(configBefore);
    expect(() =>
      f.management.applyMigration({ token: plan.token, approveHome: false }, hub),
    ).toThrow(/expired/);
  });
  it("refuses changed native sources between collection and apply", () => {
    const f = fixture(),
      file = path.join(f.project, ".mcp.json");
    write(file, '{"mcpServers":{"demo":{"command":"node"}}}');
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment)[0]!;
    const preview = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    write(file, '{"mcpServers":{"demo":{"command":"changed"}}}');
    expect(() =>
      f.management.applyImport({
        project: f.project,
        token: preview.token,
        revision: preview.revision,
        selections: [{ key: candidate.id, action: "add" }],
      }),
    ).toThrow(/changed/);
    expect(f.state().servers).toEqual([]);
  });
  it("does not lose mixed transport fields or claim stdio URLs are equivalent", () => {
    for (const text of [
      '{"id":"x","name":"x","transport":"stdio","command":"node","url":"https://example.test"}',
      '{"id":"x","name":"x","transport":"streamable-http","command":"node","url":"https://example.test"}',
      '{"x":{"type":"stdio","url":"https://example.test"}}',
      '{"x":{"type":"sse","transport":"http","url":"https://example.test"}}',
      '{"x":{"type":"stdio","transport":"http","url":"https://example.test"}}',
      '{"x":{"type":"http","transport":"sse","url":"https://example.test"}}',
      '{"x":{"type":["http"],"url":"https://example.test"}}',
      '{"x":{"transport":null,"url":"https://example.test"}}',
    ])
      expect(parseMcpImport(text)[0]?.server).toBeUndefined();
    expect(
      parseMcpImport(
        '{"x":{"type":"http","transport":"streamable-http","url":"https://example.test"}}',
      )[0]?.server,
    ).toMatchObject({ transport: "streamable-http" });
  });
  it("blocks common native key/auth credentials while retaining ordinary query keys", () => {
    for (const key of ["key", "auth", "signature"]) {
      expect(() =>
        normalizeMcpImport(
          "demo",
          { url: `https://example.test/mcp?${key}=private-native-value` },
          "cursor",
          true,
        ),
      ).toThrow(/Inline/);
      expect(() =>
        normalizeMcpImport(
          "demo",
          { command: "node", args: [`--${key}`, "private-native-value"] },
          "cursor",
          true,
        ),
      ).toThrow(/Inline/);
    }
    expect(
      normalizeMcpImport("demo", { url: "https://example.test/mcp?monkey=public" }, "cursor", true),
    ).toMatchObject({ url: "https://example.test/mcp?monkey=public" });
  });
  it("rejects cyclic unrelated YAML fields without mutating native configuration", async () => {
    const f = fixture(),
      file = path.join(f.home, ".hermes/config.yaml");
    const content =
      "unrelated: &cycle\n  self: *cycle\nmcp_servers:\n  tool:\n    url: https://example.test/mcp\n";
    write(file, content);
    const candidate = scanNativeMcp({ project: f.project }, f.store, f.environment).find(
      (item) => item.agent === "hermes",
    )!;
    const imported = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    f.management.applyImport({
      project: f.project,
      token: imported.token,
      revision: imported.revision,
      selections: [{ key: candidate.id, action: "add" }],
    });
    f.save({ ...f.state().servers[0]!.config, enabled: true }, { originalId: "tool" });
    vi.spyOn(f.manager, "hasCurrentProbe").mockReturnValue(true);
    await expect(
      f.management.previewMigration(
        { project: f.project, revision: f.state().revision, candidateIds: [candidate.id] },
        { running: true, port: 47653 },
      ),
    ).rejects.toThrow(/Cyclic/);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("MCP import diagnostic metadata", () => {
  it("returns safe structured diagnostics for rejected pasted configurations", () => {
    const source = "private-content-must-not-be-a-diagnostic-param";
    const parsed = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          bad: { url: "https://example.invalid", [source]: source },
          sse: { type: "sse", url: "https://example.invalid" },
          typed: { command: "node", env: { TOKEN: { value: source } } },
        },
      }),
    );
    expect(parsed.map((item) => item.error_message)).toEqual([
      { key: "mcp.manage.diagnostic.unsupported_fields" },
      { key: "mcp.manage.diagnostic.transport_unsupported" },
      { key: "mcp.manage.diagnostic.string_map", params: { field: "env" } },
    ]);
    expect(JSON.stringify(parsed.map((item) => item.error_message))).not.toContain(source);
    expect(parsed.every((item) => typeof item.error === "string")).toBe(true);
  });

  it("preserves native warning metadata through collection preview", () => {
    const f = fixture();
    write(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: {
            url: "https://example.invalid",
            headers: { Authorization: "Bearer private-source-value" },
          },
        },
      }),
    );
    const candidates = scanNativeMcp({ project: f.project }, f.store, f.environment);
    const candidate = candidates.find((item) => item.name === "demo")!;
    expect(candidate.warning_messages).toContainEqual({
      key: "mcp.manage.diagnostic.native_secret_required",
    });
    const preview = f.management.previewImport({
      project: f.project,
      candidateIds: [candidate.id],
    });
    expect(preview.items[0]?.warning_messages).toEqual([
      { key: "mcp.manage.diagnostic.native_values_not_copied" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("private-source-value");
  });
});
