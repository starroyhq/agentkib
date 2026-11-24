// @vitest-environment node
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravitySessions } from "../../../packages/backend/src/agents/antigravity/antigravity-sessions";
import {
  AntigravityAcp,
  verifyAcpControlIdentity,
} from "../../../packages/backend/src/agents/antigravity/antigravity-acp";
import { parseAcpJson, stringifyAcpJson } from "../../../packages/backend/src/acp-json";
import * as commands from "../../../packages/backend/src/command-resolution";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function fixture(name: "agy" | "agy_acp_server.par" = "agy", mode = "ready") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-acp-read-")));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const executable = path.join(root, name);
  const log = path.join(root, "requests.jsonl");
  const sessionsList: Record<string, unknown>[] = [
    {
      sessionId: "synthetic-session",
      cwd: workspace,
      title: "Synthetic history",
      updatedAt: "2026-11-10T00:00:00Z",
    },
  ];
  if (mode === "partial-list") {
    const workspaceAlias = path.join(root, "workspace-alias");
    symlinkSync(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    sessionsList.push(
      { cwd: workspaceAlias },
      { sessionId: "unattributed", cwd: "relative" },
      { sessionId: "removed-workspace", cwd: path.join(root, "removed-workspace") },
    );
  }
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const mode = ${JSON.stringify(mode)};
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2)})+'\\n');
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', (line) => {
 const r = JSON.parse(line);
 fs.appendFileSync(log, JSON.stringify({method:r.method})+'\\n');
 if(r.method==='initialize') {
  if(mode==='hang') return;
  send({jsonrpc:'2.0',id:r.id,result:{
   protocolVersion:mode==='bad-protocol'?2:1,
   agentInfo:{name:mode==='wrong-identity'?'other':${JSON.stringify(name === "agy" ? "Antigravity ACP Server" : "antigravity-acp")},version:${JSON.stringify(name === "agy" ? "1.5.0" : "agy_acp_server_1.2.0")}},
   agentCapabilities:{loadSession:mode!=='metadata-only',sessionCapabilities:mode==='no-list'?{}:{list:{}}}
  }});
 }
 if(r.method==='session/list') {
  if(mode==='list-failed') { send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Authentication required'}}); return; }
  send({jsonrpc:'2.0',id:r.id,result:{sessions:${JSON.stringify(sessionsList)}}});
 }
 if(r.method==='session/load') {
  for(const [sessionUpdate,text] of [['user_message_chunk','Synthetic question'],['agent_message_chunk','Synthetic answer']])
   send({jsonrpc:'2.0',method:'session/update',params:{sessionId:r.params.sessionId,update:{sessionUpdate,content:{type:'text',text}}}});
  send({jsonrpc:'2.0',id:r.id,result:{}});
 }
});
`,
  );
  chmodSync(executable, 0o755);
  const executableByName = new Map<string, string>([
    [name, executable],
    [executable, executable],
  ]);
  vi.spyOn(commands, "resolveCommand").mockImplementation(
    (value) => executableByName.get(value) ?? null,
  );
  const environment: NodeJS.ProcessEnv = { HOME: root, PATH: root };
  const recorded: { args?: string[]; method?: string }[] = [];
  // Windows cannot execute a shebang fixture. Keep the same framed protocol
  // coverage there, while macOS/Linux additionally exercise real child startup.
  if (process.platform === "win32")
    vi.spyOn(AntigravityAcp, "spawn").mockImplementation((_exe, args, _cwd, _env, options) => {
      recorded.push({ args });
      const reader = new PassThrough(),
        writer = new PassThrough(),
        client = new AntigravityAcp(reader, writer, options);
      const send = (frame: Record<string, unknown>) => reader.write(`${stringifyAcpJson(frame)}\n`);
      writer.on("data", (buffer: Buffer) => {
        const request = parseAcpJson(buffer) as Record<string, unknown>;
        const method = String(request.method);
        recorded.push({ method });
        if (method === "initialize" && mode !== "hang")
          send({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: mode === "bad-protocol" ? 2n : 1n,
              agentInfo: {
                name:
                  mode === "wrong-identity"
                    ? "other"
                    : name === "agy"
                      ? "Antigravity ACP Server"
                      : "antigravity-acp",
                version: name === "agy" ? "1.5.0" : "agy_acp_server_1.2.0",
              },
              agentCapabilities: {
                loadSession: mode !== "metadata-only",
                sessionCapabilities: mode === "no-list" ? {} : { list: {} },
              },
            },
          });
        if (method === "session/list")
          send(
            mode === "list-failed"
              ? {
                  jsonrpc: "2.0",
                  id: request.id,
                  error: { code: -32000n, message: "Authentication required" },
                }
              : {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { sessions: sessionsList },
                },
          );
        if (method === "session/load") {
          for (const [sessionUpdate, text] of [
            ["user_message_chunk", "Synthetic question"],
            ["agent_message_chunk", "Synthetic answer"],
          ])
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "synthetic-session",
                update: { sessionUpdate, content: { type: "text", text } },
              },
            });
          send({ jsonrpc: "2.0", id: request.id, result: {} });
        }
      });
      return client;
    });
  const sessions = new AntigravitySessions(environment);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => sessions.close());
  return {
    sessions,
    environment,
    workspace,
    otherWorkspace,
    executable,
    executableByName,
    requests: () =>
      process.platform === "win32"
        ? recorded
        : readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args?: string[]; method?: string }),
  };
}

describe("Antigravity optional ACP history", () => {
  it("treats a missing optional server as an empty complete source without spawning a process", async () => {
    const f = fixture();
    f.executableByName.clear();
    expect(f.sessions.optionalExecutable()).toBeNull();
    await expect(f.sessions.list(f.workspace)).resolves.toEqual({
      sessions: [],
      incomplete: false,
    });
    expect(() => f.sessions.controlExecutable()).toThrow("unavailable");
  });

  it("launches the modern CLI with acp and reads history without prompt or resume", async () => {
    const f = fixture();
    expect(f.sessions.optionalReadCommand()).toEqual({ executable: f.executable, args: ["acp"] });
    const listing = await f.sessions.list(f.workspace);
    expect(listing).toMatchObject({
      incomplete: false,
      sessions: [
        { native_ref: "synthetic-session", availability: "readable", title: "Synthetic history" },
      ],
    });
    const events = await f.sessions.readEvents("synthetic-session", null, 50);
    expect(events.events.map((event) => event.content)).toEqual([
      "Synthetic question",
      "Synthetic answer",
    ]);
    const requests = f.requests();
    expect(requests.filter((value) => value.args)).toHaveLength(3);
    expect(
      requests
        .filter((value) => value.args)
        .every((value) => JSON.stringify(value.args) === '["acp"]'),
    ).toBe(true);
    expect([...new Set(requests.flatMap((value) => (value.method ? [value.method] : [])))]).toEqual(
      ["initialize", "session/list", "session/load"],
    );
    // The CLI serves control too; its identity is checked when a control connection starts.
    expect(f.sessions.controlExecutable()).toBe(f.executable);
    expect(() =>
      verifyAcpControlIdentity({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.0" } }),
    ).toThrow("Unverified");
    expect(() =>
      verifyAcpControlIdentity({
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
      }),
    ).not.toThrow();
    expect(() =>
      verifyAcpControlIdentity({
        agentInfo: { name: "Antigravity ACP Server", version: "1.6.0-beta" },
      }),
    ).toThrow("Unverified");
  });

  it("keeps standalone legacy startup and control resolution unchanged", async () => {
    const f = fixture("agy_acp_server.par");
    expect(f.sessions.controlExecutable()).toBe(f.executable);
    await expect(f.sessions.list(f.workspace)).resolves.toMatchObject({
      incomplete: false,
      sessions: [{ availability: "readable" }],
    });
    expect(f.requests()[0].args).toEqual([]);
  });

  it("supports an explicit absolute CLI path with acp arguments", async () => {
    const f = fixture();
    f.environment.AGENTKIB_ANTIGRAVITY_ACP_BIN = f.executable;
    await f.sessions.list(f.workspace);
    expect(f.requests()[0].args).toEqual(["acp"]);
  });

  it("honors a legacy explicit override before automatic CLI discovery", async () => {
    const f = fixture("agy_acp_server.par");
    f.environment.AGENTKIB_ANTIGRAVITY_ACP_BIN = f.executable;
    f.executableByName.set("agy", f.executable);
    expect(f.sessions.optionalReadCommand()).toEqual({ executable: f.executable, args: [] });
    await f.sessions.list(f.workspace);
    expect(f.requests()[0].args).toEqual([]);
  });

  it.each(["relative/agy", "/missing/agy"])(
    "reports invalid explicit server %s instead of silently ignoring it",
    async (value) => {
      const f = fixture();
      f.environment.AGENTKIB_ANTIGRAVITY_ACP_BIN = value;
      await expect(f.sessions.list(f.workspace)).rejects.toThrow(/absolute|runnable/);
    },
  );

  it.each([
    ["wrong-identity", "Unverified"],
    ["bad-protocol", "ACP v1"],
    ["no-list", "session/list"],
    ["list-failed", "Authentication required"],
  ])("preserves real failure for a discovered CLI: %s", async (mode, message) => {
    const f = fixture("agy", mode);
    await expect(f.sessions.list(f.workspace)).rejects.toThrow(message);
  });

  it("keeps metadata-only sessions visible when replay capability is absent", async () => {
    const f = fixture("agy", "metadata-only");
    await expect(f.sessions.list(f.workspace)).resolves.toMatchObject({
      incomplete: false,
      sessions: [{ availability: "metadata-only" }],
    });
    await expect(f.sessions.readEvents("synthetic-session", null, 50)).rejects.toThrow(
      "session/load",
    );
  });

  it("retains valid ACP records and reports malformed rows only in the matching workspace", async () => {
    const f = fixture("agy", "partial-list");
    await expect(f.sessions.list(f.workspace)).resolves.toMatchObject({
      incomplete: true,
      sessions: [{ native_ref: "synthetic-session" }],
      issues: [
        { code: "antigravity-acp-record", scope: "workspace" },
        { code: "antigravity-acp-record", scope: "unattributed", id: "unattributed" },
        {
          code: "antigravity-acp-workspace-unavailable",
          scope: "unattributed",
          id: "removed-workspace",
        },
      ],
    });
  });

  it("leaves an unrelated ACP workspace complete and keeps unknown ownership diagnostic-only", async () => {
    const f = fixture("agy", "partial-list");
    await expect(f.sessions.list(f.otherWorkspace)).resolves.toEqual({
      incomplete: false,
      sessions: [],
      issues: [
        { code: "antigravity-acp-record", scope: "unattributed", id: "unattributed" },
        {
          code: "antigravity-acp-workspace-unavailable",
          scope: "unattributed",
          id: "removed-workspace",
        },
      ],
    });
  });

  it("bounds an unresponsive CLI by the caller's deadline", async () => {
    const f = fixture("agy", "hang");
    await expect(f.sessions.list(f.workspace, performance.now() + 200)).rejects.toThrow(
      /timed out/,
    );
  });
});
