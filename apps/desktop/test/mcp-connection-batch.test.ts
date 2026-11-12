import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import { McpConnectionBatch } from "../../../packages/backend/src/mcp-connection-batch";
import {
  MCP_CONNECTION_AGENTS,
  mcpConnectionInfo,
  verifyMcpConnection,
  type McpConnectionAgent,
} from "../../../packages/backend/src/mcp-connection";
import { hash } from "../../../packages/backend/src/doctor-files";
import * as nativeFiles from "../../../packages/backend/src/native-files";
import { Commands } from "../../../packages/backend/src/commands";
import { Context } from "../../../packages/backend/src/context";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpBuiltins } from "../../../packages/backend/src/mcp-builtin";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { McpOAuth } from "../../../packages/backend/src/mcp-oauth";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(agents: readonly McpConnectionAgent[] = MCP_CONNECTION_AGENTS) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-batch-"))),
    project = path.join(root, "project"),
    home = path.join(root, "home"),
    data = path.join(root, "data");
  mkdirSync(project);
  mkdirSync(home);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanup.push(() => store.close());
  const register = (id: string, alias: string, directory: string = project) => {
    mkdirSync(directory, { recursive: true });
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      id,
      directory,
      "Fixture",
      alias,
      "healthy",
      "2026-10-09T00:00:00Z",
    );
  };
  register("registry-id", "legacy-id");
  const environment = { HOME: home, USERPROFILE: home, PATH: path.join(root, "empty-bin") },
    hub = { running: true, port: 47653 },
    installed = new Set(agents),
    batch = new McpConnectionBatch(
      store,
      data,
      environment,
      () => hub,
      () => MCP_CONNECTION_AGENTS.map((agent) => ({ agent, installed: installed.has(agent) })),
    ),
    info = (targetAgent: McpConnectionAgent) =>
      mcpConnectionInfo({ workspaceId: "registry-id", targetAgent }, store, hub, environment),
    request = (targetAgents: McpConnectionAgent[]) => ({
      workspaceId: "registry-id",
      targetAgents,
    });
  return {
    root,
    project,
    home,
    data,
    store,
    register,
    environment,
    hub,
    installed,
    batch,
    info,
    request,
  };
}
function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("MCP batch connection preparation", () => {
  it("requires an explicit registered workspace and Agent selection", () => {
    const f = fixture();
    for (const request of [
      {},
      { workspaceId: "legacy-id", all: true },
      { workspaceId: "registry-id" },
      { workspaceId: "registry-id", all: true, targetAgents: ["codex"] },
      { ...f.request(["codex"]), rebindAgents: ["cursor"] },
    ])
      expect(() => f.batch.plan(request)).toThrow();
  });

  it("collects all installed targets without creating files, then applies once", () => {
    const f = fixture(["codex", "claude-code"]),
      request = { workspaceId: "registry-id", all: true },
      preview = f.batch.plan(request);
    expect(preview.targets).toHaveLength(9);
    expect(
      preview.targets.filter((target) => target.status === "missing").map((target) => target.agent),
    ).toEqual(["codex", "claude-code"]);
    expect(preview.targets.filter((target) => target.status === "uninstalled")).toHaveLength(7);
    expect(existsSync(f.info("codex").target)).toBe(false);
    expect(existsSync(path.join(f.home, ".hermes"))).toBe(false);
    expect(existsSync(path.join(f.home, ".openclaw"))).toBe(false);
    const result = f.batch.apply({ token: preview.token, approveHome: false });
    expect(result.success).toBe(true);
    expect(result.targets.filter((target) => target.status === "applied")).toHaveLength(2);
    expect(f.batch.apply({ token: preview.token, approveHome: false })).toEqual(result);
    expect(f.batch.plan(request).changes).toEqual([]);
  });

  it.each(MCP_CONNECTION_AGENTS)("supports %s without changing other native servers", (agent) => {
    const f = fixture([agent]),
      preview = f.batch.plan(f.request([agent]));
    expect(preview.targets[0]?.status).toBe("missing");
    if (agent === "hermes" || agent === "open-claw") {
      expect(() => f.batch.apply({ token: preview.token, approveHome: false })).toThrow(
        /confirmation/,
      );
      expect(existsSync(f.info(agent).target)).toBe(false);
    }
    expect(f.batch.apply({ token: preview.token, approveHome: true }).success).toBe(true);
    expect(f.batch.check(f.request([agent])).targets[0]?.status).toBe("correct");
    expect(f.batch.plan(f.request([agent])).changes).toEqual([]);
  });

  it.each([
    ["claude-code", "type", "http"],
    ["opencode", "type", "remote"],
    ["open-claw", "transport", "streamable-http"],
  ] as const)(
    "repairs a missing %s connection field even when its URL is current",
    (agent, field, required) => {
      const f = fixture([agent]),
        info = f.info(agent),
        root = JSON.parse(info.config),
        servers =
          agent === "opencode"
            ? root.mcp
            : agent === "open-claw"
              ? root.mcp.servers
              : root.mcpServers,
        entry = servers.agentkib;
      delete entry[field];
      entry.enabled = false;
      entry.headers = { Authorization: "Bearer private-test-secret" };
      servers.other = { command: "own", env: { SECRET: "other-secret" } };
      root.unrelated = { apiKey: "unrelated-secret" };
      write(info.target, JSON.stringify(root));

      const preview = f.batch.plan(f.request([agent]));
      expect(preview.targets[0]).toMatchObject({
        status: "repair",
        selected: true,
        disabled: true,
      });
      expect(preview.changes).toHaveLength(1);
      expect(JSON.stringify(preview)).not.toMatch(
        /private-test-secret|other-secret|unrelated-secret/,
      );
      expect(f.batch.apply({ token: preview.token, approveHome: true }).success).toBe(true);
      entry[field] = required;
      const after = readFileSync(info.target, "utf8");
      expect(JSON.parse(after)).toEqual(root);

      const repeated = f.batch.plan(f.request([agent]));
      expect(repeated.targets[0]).toMatchObject({
        status: "correct",
        selected: false,
        disabled: true,
      });
      expect(repeated.changes).toEqual([]);
      expect(f.batch.apply({ token: repeated.token, approveHome: false }).targets[0]?.status).toBe(
        "unchanged",
      );
      expect(readFileSync(info.target, "utf8")).toBe(after);
    },
  );

  it.each(
    MCP_CONNECTION_AGENTS.flatMap((agent) =>
      [false, true].map((disabled) => ({ agent, disabled })),
    ),
  )(
    "keeps correct $agent configuration byte for byte with custom formatting and disabled=$disabled",
    ({ agent, disabled }) => {
      const f = fixture([agent]),
        info = f.info(agent);
      let before: string;
      if (info.format === "toml") {
        before = `# custom layout\nmodel = 'fixture'\n[mcp_servers.agentkib]\nheaders = { fixture = 'keep' }\nenabled = ${!disabled}\nurl = '${info.url}'\n[mcp_servers.other]\ncommand = 'own'\n`;
      } else if (info.format === "yaml") {
        before = `# custom layout\nmodel: fixture\nmcp_servers: { agentkib: { headers: { fixture: keep }, enabled: ${!disabled}, url: '${info.url}' }, other: { command: own } }\n`;
      } else {
        const root = JSON.parse(info.config),
          servers =
            agent === "opencode"
              ? root.mcp
              : agent === "open-claw"
                ? root.mcp.servers
                : root.mcpServers;
        servers.agentkib = {
          headers: { fixture: "keep" },
          ...Object.fromEntries(Object.entries(servers.agentkib).reverse()),
          [agent === "antigravity" ? "disabled" : "enabled"]:
            agent === "antigravity" ? disabled : !disabled,
        };
        servers.other = { command: "own" };
        root.unrelated = { fixture: "keep" };
        before = JSON.stringify(root, null, "\t");
        if (agent === "open-claw") before = before.replace("{", "{ // custom JSON5 layout");
      }
      write(info.target, before);
      for (let repeat = 0; repeat < 2; repeat++) {
        const preview = f.batch.plan(f.request([agent]));
        expect(preview.targets[0]).toMatchObject({ status: "correct", selected: false, disabled });
        expect(preview.changes).toEqual([]);
        const result = f.batch.apply({ token: preview.token, approveHome: false });
        expect(result.targets[0]?.status).toBe("unchanged");
        expect(result.backup_dir).toBeUndefined();
        expect(readFileSync(info.target, "utf8")).toBe(before);
      }
    },
  );

  it("repairs a unique legacy alias and old port while retaining secrets outside preview", () => {
    const f = fixture(["cursor"]),
      target = f.info("cursor").target;
    write(
      target,
      JSON.stringify({
        unrelated: { apiKey: "unrelated-secret" },
        mcpServers: {
          other: { command: "other", env: { SECRET: "other-secret" } },
          agentkib: {
            url: "http://localhost:1234/mcp/v1/workspaces/legacy-id/agents/cursor",
            headers: { Authorization: "Bearer private-test-secret" },
            enabled: false,
          },
        },
      }),
    );
    const preview = f.batch.plan(f.request(["cursor"]));
    expect(preview.targets[0]).toMatchObject({ status: "repair", selected: true, disabled: true });
    expect(JSON.stringify(preview)).not.toMatch(
      /private-test-secret|unrelated-secret|other-secret/,
    );
    expect(f.batch.apply({ token: preview.token, approveHome: false }).success).toBe(true);
    const after = JSON.parse(readFileSync(target, "utf8"));
    expect(after.mcpServers.agentkib).toMatchObject({
      url: f.info("cursor").url,
      enabled: false,
      headers: { Authorization: "Bearer private-test-secret" },
    });
    expect(after.mcpServers.other).toEqual({ command: "other", env: { SECRET: "other-secret" } });
    expect(after.unrelated).toEqual({ apiKey: "unrelated-secret" });
  });

  it.each(["opencode", "antigravity"] as const)(
    "preserves %s disabled flag during repair",
    (agent) => {
      const f = fixture([agent]),
        info = f.info(agent),
        root = JSON.parse(info.config);
      const entry = agent === "opencode" ? root.mcp.agentkib : root.mcpServers.agentkib;
      entry[agent === "opencode" ? "enabled" : "disabled"] = agent !== "opencode";
      entry[agent === "opencode" ? "url" : "serverUrl"] = info.url.replace(":47653", ":1234");
      write(info.target, JSON.stringify(root));
      const preview = f.batch.plan(f.request([agent]));
      expect(preview.targets[0]?.disabled).toBe(true);
      f.batch.apply({ token: preview.token, approveHome: false });
      const result = JSON.parse(readFileSync(info.target, "utf8"));
      expect(
        agent === "opencode" ? result.mcp.agentkib.enabled : result.mcpServers.agentkib.disabled,
      ).toBe(agent !== "opencode");
    },
  );

  it("skips other workspaces until explicitly selected for rebinding", () => {
    const f = fixture(["cursor"]),
      target = f.info("cursor").target;
    f.register("another", "another-manifest", path.join(f.root, "another"));
    const before = JSON.stringify({
      mcpServers: {
        agentkib: {
          url: "http://127.0.0.1:1234/mcp/v1/workspaces/another/agents/cursor",
        },
      },
    });
    write(target, before);
    const skipped = f.batch.plan(f.request(["cursor"]));
    expect(skipped.targets[0]).toMatchObject({ status: "other-workspace", selected: false });
    expect(skipped.changes).toEqual([]);
    expect(f.batch.apply({ token: skipped.token, approveHome: false }).targets[0]?.status).toBe(
      "skipped",
    );
    expect(readFileSync(target, "utf8")).toBe(before);
    const rebound = f.batch.plan({ ...f.request(["cursor"]), rebindAgents: ["cursor"] });
    expect(rebound.targets[0]).toMatchObject({ status: "other-workspace", selected: true });
    f.batch.apply({ token: rebound.token, approveHome: false });
    expect(f.batch.check(f.request(["cursor"])).targets[0]?.status).toBe("correct");
  });

  it.each([
    { command: "unmanaged" },
    { url: "https://private.example/mcp" },
    { url: "http://127.0.0.1:1234/mcp/v1/workspaces/missing/agents/cursor" },
    { url: "http://127.0.0.1:1234/mcp/v1/workspaces/legacy-id/agents/codex" },
    { url: "http://127.0.0.1:1234/mcp/v1/workspaces/legacy-id/agents/cursor", type: "sse" },
    { url: "http://127.0.0.1:1234/mcp/v1/workspaces/legacy-id/agents/cursor", enabled: "no" },
  ])("blocks unsafe ownership instead of overwriting: %j", (entry) => {
    const f = fixture(["cursor", "codex"]),
      target = f.info("cursor").target;
    const before = JSON.stringify({ mcpServers: { agentkib: entry } });
    write(target, before);
    const preview = f.batch.plan(f.request(["cursor", "codex"]));
    expect(preview.targets.find((target) => target.agent === "cursor")?.status).toBe("blocked");
    expect(preview.targets.find((target) => target.agent === "codex")?.status).toBe("missing");
    f.batch.apply({ token: preview.token, approveHome: false });
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("blocks ambiguous legacy aliases but keeps exact registry identities usable", () => {
    const f = fixture(["cursor"]),
      target = f.info("cursor").target;
    f.register("clone", "legacy-id", path.join(f.root, "clone"));
    write(
      target,
      JSON.stringify({
        mcpServers: {
          agentkib: {
            url: "http://127.0.0.1:1234/mcp/v1/workspaces/legacy-id/agents/cursor",
          },
        },
      }),
    );
    expect(f.batch.check(f.request(["cursor"])).targets[0]?.status).toBe("blocked");
    write(target, f.info("cursor").config);
    expect(f.batch.check(f.request(["cursor"])).targets[0]?.status).toBe("correct");
  });

  it("does not reveal malformed native input in a check failure", () => {
    const f = fixture(["cursor"]);
    write(f.info("cursor").target, "secret-malformed-config: not-json");
    const result = f.batch.check(f.request(["cursor"]));
    expect(result.targets[0]?.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("secret-malformed-config");
  });

  it("rejects ambiguous Hermes aliases even when both URLs already match", () => {
    const f = fixture(["hermes"]),
      info = f.info("hermes"),
      before = `endpoint_key: &endpoint_key url\nmcp_servers:\n  agentkib:\n    ? *endpoint_key\n    : ${info.url}\n    url: ${info.url}\n`;
    write(info.target, before);
    const preview = f.batch.plan(f.request(["hermes"]));
    expect(preview.targets[0]?.status).toBe("blocked");
    expect(preview.changes).toEqual([]);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it("rejects cyclic Hermes aliases without traversing them indefinitely", () => {
    const f = fixture(["hermes"]),
      info = f.info("hermes");
    write(
      info.target,
      `cycle: &loop {next: *loop}\nmcp_servers:\n  agentkib: {url: ${info.url}}\n`,
    );
    expect(f.batch.check(f.request(["hermes"])).targets[0]?.status).toBe("blocked");
  });

  it("merges two manifest hash updates into a single snapshot", () => {
    const f = fixture(["codex", "cursor"]),
      manifest = path.join(f.project, ".agentkib/manifest.yaml");
    write(
      manifest,
      `schema_version: 2\nworkspace: {id: legacy-id, name: Fixture}\nadapters:\n  codex:\n    enabled: true\n    generated_hashes: { .codex/config.toml: old-codex }\n  cursor:\n    enabled: true\n    generated_hashes: { .cursor/mcp.json: old-cursor }\n`,
    );
    const preview = f.batch.plan(f.request(["codex", "cursor"]));
    expect(preview.changes.filter((change) => change.target === manifest)).toHaveLength(1);
    expect(new Set(preview.changes.map((change) => change.target)).size).toBe(
      preview.changes.length,
    );
    f.batch.apply({ token: preview.token, approveHome: false });
    const output = parseYaml(readFileSync(manifest, "utf8"));
    expect(output.adapters.codex.generated_hashes[".codex/config.toml"]).toBe(
      hash(readFileSync(f.info("codex").target, "utf8")),
    );
    expect(output.adapters.cursor.generated_hashes[".cursor/mcp.json"]).toBe(
      hash(readFileSync(f.info("cursor").target, "utf8")),
    );
    expect(f.batch.plan(f.request(["codex", "cursor"])).changes).toEqual([]);
  });

  it.each(["file", "hub", "profile", "uninstalled", "identity", "alias"])(
    "rejects a stale %s preview",
    (changed) => {
      const f = fixture(["cursor", "hermes"]);
      const preview = f.batch.plan(f.request(["cursor", "hermes"]));
      if (changed === "file") write(f.info("cursor").target, "{}");
      if (changed === "hub") f.hub.port++;
      if (changed === "profile") write(path.join(f.home, ".hermes/active_profile"), "changed");
      if (changed === "uninstalled") f.installed.delete("cursor");
      if (changed === "identity") {
        const moved = path.join(f.root, "new-project");
        mkdirSync(moved);
        f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id=?", moved, "registry-id");
      }
      if (changed === "alias")
        f.store.sql.run(
          "UPDATE workspaces SET manifest_workspace_id='new-alias' WHERE id='registry-id'",
        );
      expect(() => f.batch.apply({ token: preview.token, approveHome: true })).toThrow(/changed/);
      expect(existsSync(path.join(f.home, ".hermes/config.yaml"))).toBe(false);
    },
  );

  it("rejects a newly ambiguous alias after the preview", () => {
    const f = fixture(["cursor"]);
    write(
      f.info("cursor").target,
      JSON.stringify({
        mcpServers: {
          agentkib: {
            url: "http://127.0.0.1:1234/mcp/v1/workspaces/legacy-id/agents/cursor",
          },
        },
      }),
    );
    const preview = f.batch.plan(f.request(["cursor"]));
    f.register("clone", "legacy-id", path.join(f.root, "clone"));
    expect(() => f.batch.apply({ token: preview.token, approveHome: false })).toThrow(/changed/);
  });

  it("keeps a preview valid when unrelated Hub runtime counters change", () => {
    const f = fixture(["cursor"]);
    Object.assign(f.hub, { runtime_count: 1, error_count: 0, last_error: null });
    const preview = f.batch.plan(f.request(["cursor"]));
    Object.assign(f.hub, { runtime_count: 2, error_count: 1, last_error: "unrelated failure" });
    expect(f.batch.apply({ token: preview.token, approveHome: false }).success).toBe(true);
  });

  it.each([false, true])("reports compensation accurately, external change = %s", (external) => {
    const f = fixture(["codex", "claude-code"]),
      first = f.info("codex").target,
      second = f.info("claude-code").target;
    write(first, "# original codex\n");
    write(second, "{}");
    const preview = f.batch.plan(f.request(["codex", "claude-code"])),
      replace = nativeFiles.replaceFile;
    vi.spyOn(nativeFiles, "replaceFile").mockImplementation((source, target) => {
      if (target === second) {
        if (external) writeFileSync(first, "# external edit\n");
        throw new Error("synthetic write failure");
      }
      return replace(source, target);
    });
    const result = f.batch.apply({ token: preview.token, approveHome: false });
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([
      { key: "mcp.manage.diagnostic.write_failed" },
      { key: `mcp.manage.diagnostic.${external ? "recovery_incomplete" : "recovery_complete"}` },
    ]);
    expect(result.targets[0]?.reason_message).toEqual({
      key: `mcp.manage.diagnostic.${external ? "connection_recovery_incomplete" : "connection_rolled_back"}`,
    });
    expect(result.targets[0]?.status).toBe(external ? "recovery-incomplete" : "rolled-back");
    expect(result.targets[1]?.status).toBe("rolled-back");
    expect(readFileSync(first, "utf8")).toBe(external ? "# external edit\n" : "# original codex\n");
    expect(readFileSync(second, "utf8")).toBe("{}");
    expect(f.batch.apply({ token: preview.token, approveHome: false })).toEqual(result);
    expect(existsSync(result.backup_dir!)).toBe(true);
    expect(result.recovery).toHaveLength(2);
    expect(result.recovery?.[0]?.status).toBe(external ? "unconfirmed" : "restored");
  });

  it("applies two Agents and verifies the actual Hub protocol without starting any upstream", async () => {
    const f = fixture(["codex", "claude-code"]),
      reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Fixture port missing");
    f.hub.port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const commands = new Commands();
    cleanup.push(() => commands.close());
    const manager = new McpManager(f.store.sql, f.environment, f.data, commands);
    cleanup.push(() => manager.closeAsync());
    const builtins = new McpBuiltins(
        f.store,
        new Context(f.store.catalog, commands, f.environment),
        f.data,
      ),
      hub = new McpHub(manager, f.store, builtins, new McpOAuth(manager, () => f.hub.port), {
        port: f.hub.port,
        lan_enabled: false,
        lan_risk_accepted: false,
      });
    cleanup.push(() => hub.close());
    const run = vi.spyOn(commands, "run").mockRejectedValue(new Error("Unexpected process")),
      probe = vi.spyOn(manager, "probe").mockRejectedValue(new Error("Unexpected upstream probe")),
      call = vi
        .spyOn(manager, "callHubTool")
        .mockRejectedValue(new Error("Unexpected tool execution"));
    await hub.start();
    const preview = f.batch.plan(f.request(["codex", "claude-code"]));
    expect(f.batch.apply({ token: preview.token, approveHome: false }).success).toBe(true);
    for (const targetAgent of ["codex", "claude-code"] as const) {
      const result = await verifyMcpConnection(
        { workspaceId: "registry-id", targetAgent },
        f.store,
        () => hub.status(),
        f.environment,
      );
      expect(result.builtin_tools).toBeGreaterThan(0);
      expect(result.builtin_tool_names).toContain("workspace_get_context");
      expect(result.builtin_tool_names).toHaveLength(result.builtin_tools);
      expect(result.external_tools).toEqual([]);
    }
    expect(run).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("MCP connection diagnostic metadata", () => {
  it("retains legacy text and emits stable keys for unavailable and damaged targets", () => {
    const f = fixture(["codex"]);
    write(f.info("codex").target, "invalid = [");
    const checked = f.batch.check(f.request(["codex", "claude-code"]));
    expect(checked.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "codex",
          status: "blocked",
          reason: expect.any(String),
          reason_message: { key: "mcp.manage.diagnostic.connection_blocked" },
        }),
        expect.objectContaining({
          agent: "claude-code",
          status: "uninstalled",
          reason: expect.any(String),
          reason_message: { key: "mcp.manage.diagnostic.connection_uninstalled" },
        }),
      ]),
    );
  });

  it("returns the same localized receipt for repeated successful apply", () => {
    const f = fixture(["claude-code"]);
    const plan = f.batch.plan(f.request(["claude-code"]));
    const result = f.batch.apply({ token: plan.token, approveHome: false });
    expect(result.targets[0]).toMatchObject({
      status: "applied",
      reason_message: { key: "mcp.manage.diagnostic.connection_written" },
    });
    expect(f.batch.apply({ token: plan.token, approveHome: false })).toEqual(result);
  });
});
