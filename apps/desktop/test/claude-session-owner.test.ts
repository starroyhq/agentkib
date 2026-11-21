import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands, type CommandOutput } from "../../../packages/backend/src/commands";
import {
  ClaudeSessionOwnerProbe,
  type ClaudeOwnerObservationShare,
} from "../../../packages/backend/src/agents/claude/claude-session-owner";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const childId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const procStart = "Mon Oct 19 04:52:14 2026";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function output(value: unknown): CommandOutput {
  return {
    bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    success: true,
    truncated: false,
    exitCode: 0,
    error: "",
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-owner-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const config = path.join(root, "claude-config");
  const registry = path.join(config, "sessions");
  mkdirSync(bin);
  mkdirSync(registry, { recursive: true });
  const executable = path.join(bin, "claude");
  writeFileSync(executable, "offline fixture must not execute\n");
  chmodSync(executable, 0o700);
  const environment = { HOME: root, PATH: bin, CLAUDE_CONFIG_DIR: config };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  let agents: unknown = [];
  let agentsError = false;
  let psError: Error | null = null;
  const psErrors: Error[] = [];
  const processes = new Map<number, { start: string; command: string; group: number }>();
  const run = vi.spyOn(commands, "run").mockImplementation(async (program, args, options) => {
    if (program === executable) {
      expect(args).toEqual(["agents", "--json"]);
      expect(options?.env).toMatchObject(environment);
      if (agentsError) throw new Error("agents unavailable");
      return output(agents);
    }
    expect(program).toBe("/bin/ps");
    expect(args).toEqual(["-axo", "pid=,pgid=,lstart=,command="]);
    expect(options?.env).toMatchObject({ TZ: "UTC", LC_ALL: "C" });
    const error = psErrors.shift() ?? psError;
    if (error) throw error;
    return output(
      [...processes].map(([pid, p]) => ` ${pid} ${p.group} ${p.start} ${p.command}`).join("\n"),
    );
  });
  const probe = new ClaudeSessionOwnerProbe(commands, environment);
  function process(pid: number, command = "claude claude", start = procStart, group = pid) {
    processes.set(pid, { start, command, group });
  }
  function record(pid: number, extras: Record<string, unknown> = {}) {
    writeFileSync(
      path.join(registry, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: nativeId,
        procStart,
        kind: "interactive",
        pidDomain: globalThis.process.platform,
        ...extras,
      }),
    );
  }
  return {
    probe,
    run,
    processes,
    process,
    record,
    registry,
    executable,
    agents(value: unknown) {
      agents = value;
    },
    failAgents() {
      agentsError = true;
    },
    failPs(error = new Error("ps unavailable")) {
      psError = error;
    },
    failPsOnce(error: Error) {
      psErrors.push(error);
    },
  };
}

describe.skipIf(process.platform === "win32")("Claude session ownership probe", () => {
  it("observes working terminal activity from the native registry without launching Claude", async () => {
    const f = fixture();
    const statusUpdatedAt = Date.now() - 2000;
    const cwd = "/work/verified";
    f.process(101);
    f.process(202);
    f.record(101, { status: "working", statusUpdatedAt, cwd });
    f.record(202, { status: "working", statusUpdatedAt, cwd, procStart: "bad birth time" });
    f.record(303, { status: "working", statusUpdatedAt, cwd });
    await expect(f.probe.activeRegistryTurns()).resolves.toEqual([
      { nativeId, pid: 101, cwd, startedAt: new Date(statusUpdatedAt).toISOString() },
    ]);
    expect(f.run.mock.calls.map(([program]) => program)).toEqual(["/bin/ps"]);
    f.record(101, { status: "shell", statusUpdatedAt, cwd });
    await expect(f.probe.activeRegistryTurns()).resolves.toEqual([]);
  });
  it("reports an idle session without spawning a Claude session", async () => {
    const f = fixture();
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
    expect(f.run.mock.calls.every(([, args]) => !args.some((arg) => /--resume/.test(arg)))).toBe(
      true,
    );
  });

  it.each(["interactive", "background"] as const)(
    "detects %s agents even when the command line has no session ID",
    async (kind) => {
      const f = fixture();
      f.process(101);
      f.agents([{ pid: 101, sessionId: nativeId, kind, status: "idle" }]);
      await expect(f.probe.check(nativeId)).resolves.toEqual({ kind, pid: 101, source: "agents" });
    },
  );

  it("treats an unrecognized live agent kind as occupied", async () => {
    const f = fixture();
    f.process(102);
    f.agents([{ pid: 102, sessionId: nativeId, kind: "ide" }]);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ kind: "interactive", pid: 102 });
  });

  it("ignores a dead agent entry and an unrelated session", async () => {
    const f = fixture();
    f.process(103);
    f.agents([
      { pid: 102, sessionId: nativeId, kind: "interactive" },
      { pid: 103, sessionId: "other-session", kind: "interactive" },
    ]);
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
  });

  it.each(["interactive", "background"] as const)(
    "falls back to a verified %s registry record when agents fails",
    async (kind) => {
      const f = fixture();
      f.failAgents();
      f.process(104);
      f.record(104, { kind });
      await expect(f.probe.check(nativeId)).resolves.toEqual({
        kind,
        pid: 104,
        source: "registry",
      });
    },
  );

  it("still checks the registry when agents returns no entries", async () => {
    const f = fixture();
    f.process(105);
    f.record(105);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "registry", pid: 105 });
  });

  it("ignores dead, reused and foreign PID registry records", async () => {
    const f = fixture();
    f.failAgents();
    f.record(106);
    f.process(107, "unrelated process", "Mon Oct 19 05:52:14 2026");
    f.record(107);
    f.process(108);
    f.record(108, { pidDomain: "foreign" });
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
  });

  it("requires matching filename PID and a verified process start", async () => {
    const f = fixture();
    f.failAgents();
    f.process(109);
    f.record(109, { procStart: undefined });
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    f.record(109, { pid: 110 });
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
  });

  it("does not follow registry record symlinks", async () => {
    const f = fixture();
    f.failAgents();
    f.process(111);
    const outside = path.join(f.registry, "..", "outside.json");
    writeFileSync(outside, JSON.stringify({ pid: 111, sessionId: nativeId, procStart }));
    symlinkSync(outside, path.join(f.registry, "111.json"));
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
  });

  it.each(["--resume", "-r", "--session-id"])(
    "retains the command-line fallback for %s",
    async (flag) => {
      const f = fixture();
      f.failAgents();
      f.process(113, `/usr/local/bin/claude ${flag} ${nativeId}`);
      await expect(f.probe.check(nativeId)).resolves.toEqual({
        kind: "interactive",
        pid: 113,
        source: "ps",
      });
    },
  );

  it("recognizes the resolved native executable even when its filename is a version number", async () => {
    const f = fixture();
    f.failAgents();
    const versions = path.join(f.registry, "..", "versions");
    mkdirSync(versions);
    const nativeExecutable = path.join(versions, "2.1.301");
    writeFileSync(nativeExecutable, "native executable fixture\n", { mode: 0o700 });
    rmSync(f.executable);
    symlinkSync(nativeExecutable, f.executable);
    f.process(142, `${nativeExecutable} --resume=${nativeId}`);
    await expect(f.probe.check(nativeId)).resolves.toEqual({
      kind: "interactive",
      pid: 142,
      source: "ps",
    });
  });

  it.each([
    `/bin/sh -c echo claude --resume ${nativeId}`,
    `/bin/zsh -c printf claude --resume=${nativeId}`,
    `/bin/echo claude --session-id ${nativeId}`,
    `node -e console.log(claude --resume ${nativeId})`,
  ])("does not treat shell or echo text as a Claude process (%s)", async (command) => {
    const f = fixture();
    f.failAgents();
    f.process(139, command);
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
  });

  it.each([
    `/usr/local/bin/node /opt/tools/node_modules/@anthropic-ai/claude-code/cli.js --resume=${nativeId} --print`,
    `node --max-old-space-size=4096 /opt/tools/node_modules/@anthropic-ai/claude-code/cli.js --session-id ${nativeId} -p`,
  ])("recognizes an official Claude Node entry point (%s)", async (command) => {
    const f = fixture();
    f.failAgents();
    f.process(140, command);
    await expect(f.probe.check(nativeId)).resolves.toEqual({
      kind: "background",
      pid: 140,
      source: "ps",
    });
  });

  it.each([
    `"/Applications/Claude Tools/claude" --resume=${nativeId}`,
    `node /opt/unknown/claude-cli.js --resume=${nativeId}`,
    `/bin/sh /opt/unknown/claude --resume=${nativeId}`,
    `/opt/native/versions/2.1.299 --resume=${nativeId}`,
    `node /opt/legacy/cli.js --session-id=${nativeId}`,
  ])(
    "fails closed when flattened command arguments cannot verify the Claude entry (%s)",
    async (command) => {
      const f = fixture();
      f.failAgents();
      f.process(141, command);
      await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    },
  );

  it("classifies --print command-line owners as background", async () => {
    const f = fixture();
    f.process(114, `claude --resume=${nativeId} --print`);
    await expect(f.probe.check(nativeId)).resolves.toEqual({
      kind: "background",
      pid: 114,
      source: "ps",
    });
  });

  it.each([
    ["agents", `--resume=${nativeId} --fork-session --session-id=${childId}`],
    ["agents", `--resume ${nativeId} --fork-session --session-id ${childId}`],
    ["registry", `--resume=${nativeId} --fork-session --session-id=${childId}`],
    ["registry", `-r ${nativeId} --fork-session --session-id ${childId}`],
  ])(
    "treats a fork's resume ID as history with verified %s identity (%s)",
    async (source, args) => {
      const f = fixture();
      f.process(130, `claude ${args} --print`);
      if (source === "agents") f.agents([{ pid: 130, sessionId: childId, kind: "background" }]);
      else {
        f.failAgents();
        f.record(130, { sessionId: childId, kind: "background" });
      }

      await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
      await expect(f.probe.check(childId)).resolves.toEqual({
        kind: "background",
        pid: 130,
        source,
      });
    },
  );

  it("still detects an unregistered fork's child from the command line", async () => {
    const f = fixture();
    f.process(131, `claude --resume=${nativeId} --fork-session --session-id=${childId} --print`);
    await expect(f.probe.check(childId)).resolves.toMatchObject({ pid: 131, source: "ps" });
    // ps flattens argv, so apparent fork flags could also be words inside a user prompt.
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 131, source: "ps" });
  });

  it.each([
    `--resume=${nativeId} --fork-session`,
    `--resume=${nativeId} --fork-session --session-id=`,
    `--resume=${nativeId} --fork-session --session-id --print`,
    `--resume=${nativeId} --fork-session --session-id=invalid`,
    `--resume=${nativeId} --fork-session --session-id=${childId} --session-id=${childId}`,
    `--resume=${nativeId} --fork-session --session-id=${childId} --session-id=${nativeId}`,
    `--resume=${nativeId} --resume=${childId} --fork-session --session-id=${childId}`,
    `--resume=${nativeId} --fork-session --fork-session --session-id=${childId}`,
    `--resume=${nativeId} --fork-session=false --session-id=${childId}`,
    `--resume=${nativeId} --fork-session --session-id=${nativeId}`,
  ])("keeps ambiguous or malformed fork arguments occupied (%s)", async (args) => {
    const f = fixture();
    f.process(132, `claude ${args} --print`);
    f.agents([{ pid: 132, sessionId: childId, kind: "background" }]);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 132, source: "ps" });
  });

  it.each([
    { procStart: "Mon Oct 19 05:52:14 2026" },
    { procStart: undefined },
    { pid: 134 },
    { pidDomain: "foreign" },
  ])(
    "does not use an unverified child registry record to release the source (%j)",
    async (extras) => {
      const f = fixture();
      f.failAgents();
      f.process(133, `claude --resume=${nativeId} --fork-session --session-id=${childId} --print`);
      f.record(133, { sessionId: childId, ...extras });
      await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 133, source: "ps" });
    },
  );

  it("does not use conflicting positive identities to release a fork source", async () => {
    const f = fixture();
    f.process(134, `claude --resume=${nativeId} --fork-session --session-id=${childId} --print`);
    f.agents([
      { pid: 134, sessionId: childId, kind: "background" },
      { pid: 134, sessionId: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", kind: "background" },
    ]);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 134, source: "ps" });
  });

  it("does not release a source when agents and the verified registry disagree on the child", async () => {
    const f = fixture();
    f.process(136, `claude --resume=${nativeId} --fork-session --session-id=${childId} --print`);
    f.agents([{ pid: 136, sessionId: childId, kind: "background" }]);
    f.record(136, { sessionId: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 136, source: "ps" });
  });

  it("does not let a verified fork hide another process writing its source", async () => {
    const f = fixture();
    f.process(137, `claude --resume=${nativeId} --fork-session --session-id=${childId} --print`);
    f.agents([{ pid: 137, sessionId: childId, kind: "background" }]);
    f.process(138, `claude --resume=${nativeId} --print`);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 138, source: "ps" });
  });

  it("does not use fork-looking prompt text to release a normal resume owner", async () => {
    const f = fixture();
    f.process(
      135,
      `claude --resume=${nativeId} --print describe --fork-session --session-id=${childId}`,
    );
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 135, source: "ps" });
  });

  it("excludes only the current owned PID and still detects another owner", async () => {
    const f = fixture();
    f.process(115, `claude --resume=${nativeId} --print`);
    f.record(115, { kind: "background" });
    f.agents([{ pid: 115, sessionId: nativeId, kind: "background" }]);
    await expect(f.probe.check(nativeId, 115)).resolves.toEqual({ kind: "idle" });
    f.process(116);
    f.record(116);
    await expect(f.probe.check(nativeId, 115)).resolves.toMatchObject({ pid: 116 });
    // A retired runner must pass null, so its former PID can never hide a new owner.
    await expect(f.probe.check(nativeId, null)).resolves.toMatchObject({ pid: 115 });
  });

  it("does not let malformed agents output erase a known ps owner", async () => {
    const f = fixture();
    f.agents("invalid JSON");
    f.process(117, `claude --session-id=${nativeId}`);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "ps", pid: 117 });
  });

  it("keeps a positive agents result when the process scan fails", async () => {
    const f = fixture();
    f.failPs();
    f.agents([{ pid: 118, sessionId: nativeId, kind: "interactive" }]);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "agents", pid: 118 });
  });

  it("fails closed when the process scan is unavailable", async () => {
    const f = fixture();
    f.failPs();
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
  });

  it("retries one process scan deadline within the same observation", async () => {
    const f = fixture();
    f.failPsOnce(new Error("/bin/ps command timed out"));
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
    expect(f.run.mock.calls.map(([program]) => program)).toEqual([
      f.executable,
      "/bin/ps",
      "/bin/ps",
    ]);
    // The retry does not turn the successful observation into a startup cache.
    f.process(151, `claude --resume=${nativeId}`);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ pid: 151, source: "ps" });
    expect(f.run).toHaveBeenCalledTimes(5);
  });

  it("uses fresh process identity and ownership after a process scan deadline", async () => {
    const f = fixture();
    f.failPsOnce(new Error("/bin/ps command timed out"));
    f.process(152, `claude --resume=${nativeId} --print`);
    await expect(f.probe.check(nativeId)).resolves.toEqual({
      kind: "background",
      pid: 152,
      source: "ps",
    });
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(2);
  });

  it("keeps a shared observation's timeout retry within its one-read budget", async () => {
    const f = fixture();
    f.failPsOnce(new Error("/bin/ps command timed out"));
    f.process(153, `claude --resume=${childId}`);
    const share: ClaudeOwnerObservationShare = {};
    await expect(f.probe.check(nativeId, null, share)).resolves.toEqual({ kind: "idle" });
    await expect(f.probe.check(childId, null, share)).resolves.toMatchObject({
      pid: 153,
      source: "ps",
    });
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(2);
  });

  it("fails closed after a second process scan deadline", async () => {
    const f = fixture();
    f.failPs(new Error("/bin/ps command timed out"));
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(2);
  });

  it("does not retry a process scan permission failure", async () => {
    const f = fixture();
    f.failPs(new Error("/bin/ps command failed: Operation not permitted"));
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(1);
  });

  it("keeps unverified executable identity unavailable after a process scan deadline", async () => {
    const f = fixture();
    f.failPsOnce(new Error("/bin/ps command timed out"));
    f.process(154, `/opt/unknown/versions/2.1.301 --resume=${nativeId}`);
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(2);
  });

  it("does not retry malformed process table output", async () => {
    const f = fixture();
    f.run.mockImplementation(async (program) =>
      program === "/bin/ps" ? output("unparseable process row") : output([]),
    );
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(1);
  });

  it("does not cache an idle result across later startup checks", async () => {
    const f = fixture();
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
    f.process(119);
    f.agents([{ pid: 119, sessionId: nativeId, kind: "interactive" }]);
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "agents", pid: 119 });
    f.processes.delete(119);
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
  });

  it("keeps a known ps owner when a registry record is incomplete", async () => {
    const f = fixture();
    f.process(120, `claude --resume=${nativeId}`);
    f.record(120, { procStart: undefined });
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "ps", pid: 120 });
  });

  it("does not accept a partial process table as evidence that a session is idle", async () => {
    const f = fixture();
    f.run.mockImplementation(async (program) =>
      program === "/bin/ps" ? { ...output(""), truncated: true } : output([]),
    );
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
    expect(f.run.mock.calls.filter(([program]) => program === "/bin/ps")).toHaveLength(1);
  });

  it("fails closed for a malformed registry record belonging to a live PID", async () => {
    const f = fixture();
    f.process(121);
    writeFileSync(path.join(f.registry, "121.json"), "{incomplete");
    await expect(f.probe.check(nativeId)).rejects.toThrow("claude-owner-check-unavailable");
  });

  it("normalizes padding in UTC process starts", async () => {
    const f = fixture();
    f.process(122, "claude claude", "Mon Oct  9 04:52:14 2026");
    f.record(122, { procStart: "Mon Oct 9 04:52:14 2026" });
    await expect(f.probe.check(nativeId)).resolves.toMatchObject({ source: "registry", pid: 122 });
  });

  it("checks liveness after agents observes a newly opened session", async () => {
    const f = fixture();
    let registered = false;
    f.run.mockImplementation(async (program) => {
      if (program === "/bin/ps")
        return output(registered ? `123 123 ${procStart} claude claude` : "");
      // The official read can observe a process started after an earlier ps snapshot.
      await new Promise<void>((resolve) => setImmediate(resolve));
      registered = true;
      return output([{ pid: 123, sessionId: nativeId, kind: "interactive" }]);
    });
    await expect(f.probe.check(nativeId)).resolves.toEqual({
      kind: "interactive",
      pid: 123,
      source: "agents",
    });
  });

  it.each(["agents", "registry"] as const)(
    "excludes the owned process group when a launcher shim's CLI child registers via %s",
    async (source) => {
      const f = fixture();
      // AgentKib spawned 200, a shim leading its own group; the real CLI runs as its child 201.
      f.process(200, `/home/user/.volta/bin/claude --resume=${nativeId} --print`, procStart, 200);
      f.process(201, `/opt/claude-code/bin/claude --resume=${nativeId} --print`, procStart, 200);
      if (source === "agents") f.agents([{ pid: 201, sessionId: nativeId, kind: "interactive" }]);
      else {
        f.failAgents();
        f.record(201);
      }
      await expect(f.probe.check(nativeId, 200)).resolves.toEqual({ kind: "idle" });
      // Without an owned worker, the same child is an ordinary owner.
      await expect(f.probe.check(nativeId, null)).resolves.toEqual({
        kind: "interactive",
        pid: 201,
        source,
      });
      f.process(202, `claude --resume=${nativeId}`, procStart, 202);
      await expect(f.probe.check(nativeId, 200)).resolves.toEqual({
        kind: "interactive",
        pid: 202,
        source: "ps",
      });
    },
  );

  it("still reports a registered owner outside the owned process group", async () => {
    const f = fixture();
    f.process(200, `claude --session-id=${nativeId} --print`, procStart, 200);
    f.process(203, "claude claude", procStart, 203);
    f.agents([{ pid: 203, sessionId: nativeId, kind: "interactive" }]);
    await expect(f.probe.check(nativeId, 200)).resolves.toEqual({
      kind: "interactive",
      pid: 203,
      source: "agents",
    });
  });

  it("does not report the owned group's command lines from the process scan", async () => {
    const f = fixture();
    f.failAgents();
    f.process(200, `/home/user/.volta/bin/claude --resume=${nativeId} --print`, procStart, 200);
    f.process(201, `/opt/claude-code/bin/claude --resume=${nativeId} --print`, procStart, 200);
    await expect(f.probe.check(nativeId, 200)).resolves.toEqual({ kind: "idle" });
    await expect(f.probe.check(nativeId, 201)).resolves.toMatchObject({ pid: 200, source: "ps" });
  });

  it("excludes only the spawned PID when the process table is unavailable", async () => {
    const f = fixture();
    f.failPs();
    f.agents([
      { pid: 200, sessionId: nativeId, kind: "interactive" },
      { pid: 201, sessionId: nativeId, kind: "interactive" },
    ]);
    await expect(f.probe.check(nativeId, 200)).resolves.toEqual({
      kind: "interactive",
      pid: 201,
      source: "agents",
    });
  });

  it("evaluates several sessions against one shared observation", async () => {
    const f = fixture();
    f.process(140, `claude --resume=${nativeId} --print`);
    f.process(141);
    f.agents([{ pid: 141, sessionId: childId, kind: "interactive" }]);
    const share: ClaudeOwnerObservationShare = {};
    await expect(f.probe.check(nativeId, null, share)).resolves.toMatchObject({
      pid: 140,
      source: "ps",
    });
    // Later changes are invisible to the shared observation but seen by the next fresh check.
    f.processes.delete(140);
    await expect(f.probe.check(childId, null, share)).resolves.toMatchObject({
      pid: 141,
      source: "agents",
    });
    await expect(f.probe.check(nativeId, null, share)).resolves.toMatchObject({ pid: 140 });
    expect(f.run.mock.calls.map(([program]) => program)).toEqual([
      expect.stringMatching(/claude$/),
      "/bin/ps",
    ]);
    await expect(f.probe.check(nativeId)).resolves.toEqual({ kind: "idle" });
    expect(f.run).toHaveBeenCalledTimes(4);
  });

  it.each(["agents", "registry"] as const)(
    "treats Claude Code's bg kind from %s as a background owner",
    async (source) => {
      const f = fixture();
      f.process(150);
      if (source === "agents") f.agents([{ pid: 150, sessionId: nativeId, kind: "bg" }]);
      else {
        f.failAgents();
        f.record(150, { kind: "bg" });
      }
      await expect(f.probe.check(nativeId)).resolves.toEqual({
        kind: "background",
        pid: 150,
        source,
      });
    },
  );
});
