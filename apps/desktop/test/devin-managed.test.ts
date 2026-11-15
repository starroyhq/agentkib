import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Commands } from "../../../packages/backend/src/commands";
import {
  devinDesktopExecutables,
  devinExecutables,
} from "../../../packages/backend/src/devin-executable";
import {
  DevinManagedRunner,
  devinChildEnvironment,
  devinRunFailure,
  devinSessionLockedElsewhere,
  type DevinRunnerHost,
} from "../../../packages/backend/src/devin-managed-runner";
import { collectUsage } from "../../../packages/backend/src/usage-providers";

const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-devin-managed-"));
  roots.push(root);
  return root;
}

/** A stand-in `devin`: answers `auth status`, and for `-p` records its arguments and prompt. */
function fakeDevin(root: string, { loggedIn = true, sleep = 0, code = 0, output = "" } = {}) {
  const file = path.join(root, "devin");
  const log = path.join(root, "calls.log");
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "auth" ]; then
  ${loggedIn ? 'echo "Logged in as tester"' : 'echo "Not logged in."'}
  exit 0
fi
prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prompt-file" ]; then prompt="$(cat "$2")"; echo "prompt-file $2" >> "${log}"; shift; fi
  echo "arg $1" >> "${log}"
  shift
done
echo "prompt $prompt" >> "${log}"
${sleep ? `sleep ${sleep}` : ""}
${output ? `echo "${output}" >&2` : ""}
exit ${code}
`,
  );
  chmodSync(file, 0o755);
  return { file, log };
}

function host(
  executable: string,
  sessions: () => Array<{ nativeId: string; createdAt: number }>,
  published: Array<{ type: string; payload: Record<string, unknown> }>,
): DevinRunnerHost {
  return {
    executable: () => executable,
    environment: { ...process.env, DEVIN_SESSIONS_DIR: path.dirname(executable) },
    latestItems: async (nativeId) => [{ id: `${nativeId}:1`, kind: "user-message" }],
    listSessions: async () => sessions(),
    firstUserText: async () => null,
    publish: (type, payload) => published.push({ type, payload }),
  };
}

async function settled(runner: DevinManagedRunner) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (runner.snapshot().sendEnabled === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not settle");
}

describe.runIf(posix)("Devin managed runner", () => {
  it("starts a session with its first message and reports the session Devin stored", async () => {
    const root = temp();
    const devin = fakeDevin(root, { sleep: 1 });
    let listed: Array<{ nativeId: string; createdAt: number }> = [
      { nativeId: "old-session", createdAt: 1 },
    ];
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new DevinManagedRunner(
      root,
      null,
      host(devin.file, () => listed, published),
    );
    let dispatched = false;
    await runner.send(
      "Fix the build",
      0,
      () => {
        dispatched = true;
        listed = [...listed, { nativeId: "new-session", createdAt: Date.now() }];
      },
      { model: "opus", permissionMode: "accept-edits" },
    );
    expect(dispatched).toBe(true);
    expect(runner.snapshot()).toMatchObject({ status: "running", stopEnabled: true });
    await expect(runner.session()).resolves.toBe("new-session");
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({ status: "idle", reason: null, revision: 2 });
    const calls = readFileSync(devin.log, "utf8");
    expect(calls).toContain("arg -p");
    expect(calls).toContain("prompt Fix the build");
    expect(calls).toMatch(/arg --model\narg opus/);
    expect(calls).toMatch(/arg --permission-mode\narg accept-edits/);
    expect(calls).not.toContain("arg -r");
    // The prompt file is removed once the turn ends.
    const promptFile = /prompt-file (.+)/.exec(calls)![1]!;
    expect(existsSync(promptFile)).toBe(false);
    expect(published.some((event) => event.type === "snapshot")).toBe(true);
  });

  it("continues a session by its ID", async () => {
    const root = temp();
    const devin = fakeDevin(root);
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    await runner.send("Next step", 0, () => {});
    await settled(runner);
    expect(readFileSync(devin.log, "utf8")).toMatch(/arg -r\narg known-session/);
  });

  it("refuses before running anything when the CLI has no login", async () => {
    const root = temp();
    const devin = fakeDevin(root, { loggedIn: false });
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    let dispatched = false;
    await expect(
      runner.send("Hello", 0, () => {
        dispatched = true;
      }),
    ).rejects.toThrow("devin-login-required");
    expect(dispatched).toBe(false);
    expect(existsSync(devin.log)).toBe(false);
  });

  it("reports why a turn failed without keeping its output", async () => {
    const root = temp();
    const devin = fakeDevin(root, { code: 1, output: "Error: workspace is not trusted" });
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    await runner.send("Hello", 0, () => {});
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({
      status: "idle",
      reason: "devin-workspace-untrusted",
    });
  });

  it("stops a running turn", async () => {
    const root = temp();
    const devin = fakeDevin(root, { sleep: 30 });
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    await runner.send("Long task", 0, () => {});
    const turnId = String(runner.snapshot().turnId);
    await expect(runner.stop("other-turn", 1, () => {})).rejects.toThrow("session-not-running");
    await runner.stop(turnId, 1, () => {});
    expect(runner.snapshot()).toMatchObject({ cancelling: true, stopEnabled: false });
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({ status: "idle", reason: null, turnId: null });
  });

  it("rejects a stale revision and a second turn while one runs", async () => {
    const root = temp();
    const devin = fakeDevin(root, { sleep: 2 });
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    await expect(runner.send("Hello", 3, () => {})).rejects.toThrow("stale-or-disabled-control");
    await runner.send("Hello", 0, () => {});
    await expect(runner.send("Again", 1, () => {})).rejects.toThrow("session-busy");
    runner.close();
  });
});

describe("Devin child environment", () => {
  it("drops the ACP host marker that makes the CLI refuse its own login", () => {
    expect(devinChildEnvironment({ ACP_BACKEND: "1", HOME: "/home/a", PATH: "/bin" })).toEqual({
      HOME: "/home/a",
      PATH: "/bin",
    });
  });
});

describe("Devin run failures", () => {
  it.each([
    ["Error: Not logged in. Run `devin auth login` to authenticate.", 1, "devin-login-required"],
    ["Error: this workspace is untrusted", 1, "devin-workspace-untrusted"],
    ["Error: session abc is locked by another process", 1, "session-open-elsewhere"],
    ["something else", 2, "devin-run-failed"],
    ["", null, "devin-run-stopped"],
  ])("maps %j", (output, code, reason) => {
    expect(devinRunFailure(output, code)).toBe(reason);
  });
});

describe.runIf(posix)("Devin session locks", () => {
  it("counts only a lock held by a running Devin process", async () => {
    const root = temp();
    const environment = { ...process.env, DEVIN_SESSIONS_DIR: root };
    const locks = path.join(root, "cli", "session_locks");
    mkdirSync(locks, { recursive: true });
    expect(await devinSessionLockedElsewhere(environment, "free-session")).toBe(false);
    // Devin leaves lock files behind; one naming an exited process is free.
    writeFileSync(path.join(locks, "stale-session.lock"), "999999\n");
    expect(await devinSessionLockedElsewhere(environment, "stale-session")).toBe(false);
    // A live process that is not Devin does not hold it either.
    writeFileSync(path.join(locks, "other-session.lock"), `${process.pid}\n`);
    expect(await devinSessionLockedElsewhere(environment, "other-session")).toBe(false);
    const fake = path.join(root, "devin");
    copyFileSync("/bin/sleep", fake);
    chmodSync(fake, 0o755);
    const holder = spawn(fake, ["30"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(locks, "held-session.lock"), `${holder.pid}\n`);
      expect(await devinSessionLockedElsewhere(environment, "held-session")).toBe(true);
      expect(await devinSessionLockedElsewhere(environment, "held-session", holder.pid)).toBe(
        false,
      );
      expect(await devinSessionLockedElsewhere(environment, "../held-session")).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("Devin CLI resolution", () => {
  it.runIf(process.platform === "darwin")(
    "falls back to the CLI Devin Desktop ships after PATH and the installer's folder",
    () => {
      const root = temp();
      const bundled = path.join(
        root,
        "Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
      );
      mkdirSync(path.dirname(bundled), { recursive: true });
      writeFileSync(bundled, "#!/bin/sh\n");
      chmodSync(bundled, 0o755);
      expect(devinDesktopExecutables({}, [root])).toEqual([bundled]);
      const home = temp();
      const installed = path.join(home, ".local/bin/devin");
      mkdirSync(path.dirname(installed), { recursive: true });
      writeFileSync(installed, "#!/bin/sh\n");
      chmodSync(installed, 0o755);
      const found = devinExecutables({ HOME: home, PATH: "" });
      expect(found[0]).toBe(installed);
    },
  );
});

describe("Devin token usage", () => {
  it("counts each reply's tokens once and skips hidden helper sessions", async () => {
    const root = temp();
    mkdirSync(path.join(root, "cli"));
    const db = new DatabaseSync(path.join(root, "cli", "sessions.db"));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        chat_message TEXT NOT NULL);`);
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("visible", "/work/app", 0);
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("helper", "/work/app", 1);
    const reply = (id: string, input: number, output: number) =>
      JSON.stringify({
        role: "assistant",
        message_id: id,
        metadata: {
          generation_model: "opus",
          created_at: "2026-11-14T10:00:00Z",
          metrics: {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 7,
            cache_creation_tokens: 3,
          },
        },
      });
    const insert = db.prepare("INSERT INTO message_nodes (session_id, chat_message) VALUES (?,?)");
    insert.run("visible", reply("m1", 100, 20));
    // A copy Devin made on another chain keeps the message ID.
    insert.run("visible", reply("m1", 100, 20));
    insert.run("visible", reply("m2", 50, 5));
    insert.run("visible", JSON.stringify({ role: "user", message_id: "u1" }));
    insert.run("helper", reply("h1", 999, 999));
    db.close();
    const commands = {
      run: async () => {
        throw new Error("no command in this test");
      },
    } as unknown as Commands;
    const batches = await collectUsage(new Map(), {
      home: root,
      environment: { DEVIN_SESSIONS_DIR: root, HOME: root },
      commands,
    });
    const batch = batches.find((item) => item.agent === "devin")!;
    expect(batch.status.available).toBe(true);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      surface_agent: "devin",
      workspace_path: "/work/app",
      model: "opus",
      input_tokens: 150,
      output_tokens: 25,
      cache_read_tokens: 14,
      cache_write_tokens: 6,
      total_tokens: 175,
      session_count: 1,
      date_precision: "day",
    });
  });
});
