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
} from "../../../packages/backend/src/agents/devin/devin-executable";
import {
  DevinManagedRunner,
  devinChildEnvironment,
  devinModelCatalog,
  devinModelVariant,
  devinRunFailure,
  devinSessionLockedElsewhere,
  resolveDevinModel,
  type DevinRunnerHost,
} from "../../../packages/backend/src/agents/devin/devin-managed-runner";
import { DevinSessionSettings } from "../../../packages/backend/src/agents/devin/devin-session-settings";
import { fakeDevinAcp } from "./fixtures/fake-devin-acp";
import { devinUsageLimitHit, holdUsageLimit } from "../../../packages/backend/src/usage-limit";
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
/** A stand-in Devin whose ACP turns end as the options say (see `fakeDevinAcp`). */
function fakeDevin(root: string, { loggedIn = true, sleep = 0, code = 0, output = "" } = {}) {
  const devin = fakeDevinAcp(root, { loggedIn, sessionId: "new-session" });
  devin.turn({ sleep, error: code || output ? output || "failed" : null });
  return devin;
}

/**
 * A stand-in Devin whose turns can each end differently: what it said on stderr, or a failure
 * code, fails the turn over ACP; what it answered is its reply and never fails it.
 */
function scriptedDevin(root: string) {
  const devin = fakeDevinAcp(root);
  return {
    file: devin.file,
    turn({ stdout: _reply = "", stderr = "", code = 0, sleep = 0 } = {}) {
      devin.turn({ sleep, error: stderr || (code ? "failed" : null) });
    },
  };
}

// What Devin's service answered when a daily or weekly quota ran out (Devin's own log of the
// session/prompt error -32011, 2026-10), as `devin -p` prints a failed turn: "Error: <message>".
const DAILY_QUOTA =
  "Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
const WEEKLY_QUOTA =
  "Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";

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
  it("anchors an exact ACP user message echo and skips ambiguous native identities", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root);
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    const observed: string[] = [];
    const options = {
      onNativeUserMessage: (id: string) => {
        observed.push(id);
        return true;
      },
    };
    const update = (text: string, id: string) => ({
      sessionUpdate: "user_message_chunk",
      messageId: id,
      content: { type: "text", text },
    });
    try {
      devin.turn({ updates: [update("Report ", "report-id"), update("body", "report-id")] });
      await runner.send("Report body", 0, () => {}, {}, undefined, options);
      await settled(runner);
      expect(observed).toEqual(["report-id"]);

      devin.turn({ updates: [update("Report ", "first-id"), update("body", "second-id")] });
      await runner.send(
        "Report body",
        Number(runner.snapshot().revision),
        () => {},
        {},
        undefined,
        options,
      );
      await settled(runner);
      expect(observed).toEqual(["report-id"]);
    } finally {
      runner.close();
    }
  });

  it("retains the native ACP plan through completion and clears it on the next prompt", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root);
    const update = {
      sessionUpdate: "plan",
      entries: [{ content: "Inspect the test results", priority: "medium", status: "in_progress" }],
    };
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], published),
    );
    try {
      devin.turn({ updates: [update, update] });
      await runner.send("First message", 0, () => {});
      const turnId = runner.snapshot().turnId;
      expect(turnId).toBeTruthy();
      await settled(runner);
      const plan = runner.snapshot().planProgress;
      expect(plan).toMatchObject({
        turnId,
        steps: [{ text: "Inspect the test results", status: "in_progress" }],
        currentStepId: expect.any(String),
      });
      expect(
        published.filter(({ type, payload }) => type === "state" && payload.planProgress),
      ).toHaveLength(2); // one changed plan and the completion state

      devin.turn();
      await runner.send("Second message", Number(runner.snapshot().revision), () => {});
      expect(runner.snapshot().planProgress).toBeNull();
      await settled(runner);
      expect(runner.snapshot().planProgress).toBeNull();
    } finally {
      runner.close();
    }
  });

  it("uses the ACP configuration default when creating with only a model family", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root, { strictConfig: true });
    const runner = new DevinManagedRunner(
      root,
      null,
      host(devin.file, () => [], []),
    );
    try {
      await runner.send("First message", 0, () => {}, { model: "swe-2" });
      await expect(runner.session()).resolves.toBe("fresh-otter");
      await settled(runner);
      expect(readFileSync(devin.log, "utf8").trim().split("\n")).toEqual([
        "new fresh-otter",
        "prompt First message",
      ]);
    } finally {
      runner.close();
    }
  });

  it("sets the separate ACP effort without changing the advertised model", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root, { strictConfig: true });
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    const settings = { model: "swe-2-high", effort: "max" } as const;
    try {
      await runner.send("Next message", 0, () => {}, settings);
      await settled(runner);
      expect(readFileSync(devin.log, "utf8").trim().split("\n")).toEqual([
        "load known-session",
        "config thought_level=max",
        "prompt Next message",
      ]);
    } finally {
      runner.close();
    }
  });

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
    expect(calls).toContain("new new-session");
    expect(calls).toContain("prompt Fix the build");
    expect(calls).toContain("config model=opus");
    // A new session already starts accepting edits; only a different mode is set.
    expect(calls).not.toContain("config mode=");
    expect(calls).not.toContain("load ");
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
    await runner.send("Next step", 0, () => {}, { permissionMode: "auto" });
    await settled(runner);
    const calls = readFileSync(devin.log, "utf8");
    expect(calls).toContain("load known-session");
    // Read only is Devin's ACP "ask" mode, which answers without changing code.
    expect(calls).toContain("config mode=ask");
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

  it("explains a usage limit in Devin's words until the next turn, and arms no continue", async () => {
    const root = temp();
    const devin = scriptedDevin(root);
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], published),
    );
    devin.turn({
      stderr: `Error: ${DAILY_QUOTA} (trace ID: 0123456789abcdef0123456789abcdef)\n`,
      code: 1,
    });
    await runner.send("Hello", 0, () => {});
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({
      status: "idle",
      sendEnabled: true,
      // The limit explains the turn; it is not a failure to run.
      reason: null,
      usageLimit: {
        agent: "devin",
        resetsAt: null,
        kind: null,
        scope: null,
        message: DAILY_QUOTA,
        continueAt: null,
        manual: "reset-unknown",
        autoContinues: 0,
      },
    });
    // The state event is the live state itself, as clients merge it.
    const state = published.filter((event) => event.type === "state").at(-1)!.payload;
    expect(state).toMatchObject({ status: "idle", usageLimit: { agent: "devin" } });
    expect(state).not.toHaveProperty("live");
    devin.turn();
    await runner.send("Again", Number(runner.snapshot().revision), () => {});
    expect(runner.snapshot().usageLimit).toBeNull();
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({ reason: null, usageLimit: null });
  });

  it("reads a limit that ends a turn with exit 0 from stderr, never from Devin's reply", async () => {
    const root = temp();
    const devin = scriptedDevin(root);
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    devin.turn({ stdout: "Partial answer\n", stderr: `Error: ${WEEKLY_QUOTA}\n` });
    await runner.send("Hello", 0, () => {});
    await settled(runner);
    expect(runner.snapshot().usageLimit).toMatchObject({ kind: "weekly", message: WEEKLY_QUOTA });
    // A reply that quotes Devin's words is an answer like any other.
    devin.turn({ stdout: `Devin says "Usage limit reached" when ${DAILY_QUOTA}\n` });
    await runner.send("What does it say?", Number(runner.snapshot().revision), () => {});
    await settled(runner);
    expect(runner.snapshot()).toMatchObject({ reason: null, usageLimit: null });
  });

  it("names a turn whose process was ended without a stop", async () => {
    const root = temp();
    const devin = scriptedDevin(root);
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], []),
    );
    devin.turn({ sleep: 30 });
    await runner.send("Long task", 0, () => {});
    runner.close();
    for (let attempt = 0; attempt < 200 && runner.snapshot().turnId; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.snapshot()).toMatchObject({ turnId: null, reason: "devin-run-stopped" });
  });

  it("tells the host how each turn ended, with its answer, before it shows itself idle", async () => {
    const root = temp();
    const devin = scriptedDevin(root);
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ends: Array<Record<string, unknown>> = [];
    const runner = new DevinManagedRunner(root, "known-session", {
      ...host(devin.file, () => [], published),
      latestItems: async () => [
        { id: "devin-u1", kind: "user-message", turn_id: "devin-u1" },
        { id: "devin-r1", kind: "agent-message", turn_id: "devin-u1", message_phase: "commentary" },
        { id: "devin-tool-1", kind: "tool-summary", turn_id: "devin-u1" },
        {
          id: "devin-r2",
          kind: "agent-message",
          turn_id: "devin-u1",
          message_phase: "final_answer",
        },
      ],
      turnEnded: (end) => {
        // Clients have not been told yet that the turn ended.
        const state = published.filter((event) => event.type === "state").at(-1);
        ends.push({ ...end, published: state?.payload.status });
      },
    });
    devin.turn();
    await runner.send("Hello", 0, () => {});
    const turnId = runner.snapshot().turnId;
    await settled(runner);
    devin.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
    await runner.send("Again", Number(runner.snapshot().revision), () => {});
    await settled(runner);
    devin.turn({ sleep: 30 });
    await runner.send("Long", Number(runner.snapshot().revision), () => {});
    await runner.stop(
      String(runner.snapshot().turnId),
      Number(runner.snapshot().revision),
      () => {},
    );
    await settled(runner);
    expect(ends).toEqual([
      {
        nativeId: "known-session",
        turnId,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        outcome: "completed",
        historyTurnId: "devin-u1",
        answerItemId: "devin-r2",
        usageLimit: null,
        published: "running",
      },
      expect.objectContaining({
        outcome: "failed",
        usageLimit: expect.objectContaining({ message: DAILY_QUOTA }),
      }),
      expect.objectContaining({ outcome: "cancelled", usageLimit: null }),
    ]);
  });

  it("shows the usage limit the host holds, until the next turn", async () => {
    const root = temp();
    const devin = scriptedDevin(root);
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new DevinManagedRunner(
      root,
      "known-session",
      host(devin.file, () => [], published),
    );
    devin.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
    await runner.send("Hello", 0, () => {});
    await settled(runner);
    const revision = runner.snapshot().revision;
    const view = {
      agent: "devin" as const,
      resetsAt: Date.now() + 3_600_000,
      kind: null,
      scope: null,
      message: DAILY_QUOTA,
      continueAt: Date.now() + 3_630_000,
      manual: null,
      autoContinues: 0,
    };
    expect(runner.showUsageLimit(view)).toBe(true);
    expect(runner.showUsageLimit(view)).toBe(false);
    // What the notice says is not something a control was decided on.
    expect(runner.snapshot()).toMatchObject({ revision, usageLimit: view });
    expect(published.at(-1)).toMatchObject({ type: "state", payload: { usageLimit: view } });
    devin.turn();
    await runner.send("Again", Number(revision), () => {});
    expect(runner.showUsageLimit(view)).toBe(false);
    expect(runner.snapshot().usageLimit).toBeNull();
    await settled(runner);
  });
});

describe("Devin usage limits", () => {
  it.each([
    // Recorded: the service's -32011 errors, printed by `devin -p` and as Devin logs them.
    [`Error: ${DAILY_QUOTA} (trace ID: 0123456789abcdef0123456789abcdef)`, null, DAILY_QUOTA],
    [`Error: ${WEEKLY_QUOTA}`, "weekly", WEEKLY_QUOTA],
    [
      `WARN run_acp_server: Sending error response id=Number(84) method=session/prompt error=Error { code: -32011: Unknown error, message: "${DAILY_QUOTA}", data: Some(Object {"cognition.ai/errorKind": String("resource_exhausted")}) }`,
      null,
      DAILY_QUOTA,
    ],
    [
      `{"error":{"code":-32011,"message":"${WEEKLY_QUOTA}","data":{"cognition.ai/errorKind":"resource_exhausted","cognition.ai/retryable":true}}}`,
      "weekly",
      WEEKLY_QUOTA,
    ],
    // The CLI's own words for its errors (3000.12.59).
    ["Error: Quota exhausted: Quota exhausted.", null, "Quota exhausted: Quota exhausted."],
    [
      "Quota exhausted\nPurchase on-demand usage or turn on auto-reload, or wait for your quota to reset.",
      null,
      "Quota exhausted",
    ],
    ["\u001b[31mUsage limit reached\u001b[0m", null, "Usage limit reached"],
    ["Organization usage limit reached", null, "Organization usage limit reached"],
    [
      "You've reached your monthly usage limit. Wait for the limit to reset next month.",
      null,
      "You've reached your monthly usage limit. Wait for the limit to reset next month.",
    ],
    [
      "Your organization has reached its monthly usage limit. Ask an account admin to raise it, or wait for the limit to reset next month.",
      null,
      "Your organization has reached its monthly usage limit. Ask an account admin to raise it, or wait for the limit to reset next month.",
    ],
    [
      "You've reached your ChatGPT subscription usage limit. Resume this session once your limit resets, or turn off ChatGPT token sharing in settings to continue on Devin usage.",
      null,
      "You've reached your ChatGPT subscription usage limit. Resume this session once your limit resets, or turn off ChatGPT token sharing in settings to continue on Devin usage.",
    ],
    ["Error: Rate limited: Too many requests", null, "Rate limited: Too many requests"],
  ])("recognizes %j", (output, kind, message) => {
    expect(devinUsageLimitHit(`warning: something else\n${output}\n`)).toEqual({
      resetsAt: null,
      kind,
      scope: null,
      message,
    });
  });

  it.each([
    "Error: Not logged in. Run `devin auth login` to authenticate.",
    "Error: Failed to load team settings: Connection failed",
    "An admin paused usage on your account. Ask them to resume it to continue.",
    "warning: rejected a tool call that requires confirmation. Running in non-interactive mode.",
    "",
  ])("leaves %j alone", (output) => {
    expect(devinUsageLimitHit(output)).toBeNull();
  });

  it("arms a continue once the reset is known, as for Codex, and none without it", () => {
    const now = Date.now();
    const hit = { resetsAt: null, kind: null, scope: null, message: "Quota exhausted" };
    const context = { deviceId: "phone", bootId: "boot", now, random: () => 0 };
    expect(holdUsageLimit("devin", hit, context)).toMatchObject({
      agent: "devin",
      continueAt: null,
      manual: "reset-unknown",
    });
    expect(holdUsageLimit("devin", { ...hit, resetsAt: now + 3_600_000 }, context)).toMatchObject({
      continueAt: now + 3_600_000 + 30_000,
      manual: null,
    });
    // A weekly reset days away is the person's to continue, as for the other agents.
    expect(
      holdUsageLimit("devin", { ...hit, resetsAt: now + 3 * 86_400_000 }, context),
    ).toMatchObject({ continueAt: null, manual: "reset-too-far" });
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
    // A limit is recognized before this mapping runs; on its own it is a failed turn.
    [`Error: ${DAILY_QUOTA}`, 1, "devin-run-failed"],
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

describe("Devin session settings", () => {
  it("defaults to accepting edits and keeps choices across instances", () => {
    const dataDir = temp();
    const first = new DevinSessionSettings(dataDir);
    expect(first.get("some-session")).toEqual({ permissionMode: "accept-edits" });
    first.set("some-session", { model: "swe-2", permissionMode: "auto" });
    // A restart reads the same file.
    expect(new DevinSessionSettings(dataDir).get("some-session")).toEqual({
      model: "swe-2",
      permissionMode: "auto",
    });
    first.set("some-session", {});
    expect(first.get("some-session")).toEqual({ permissionMode: "accept-edits" });
  });

  it("ignores values it would not pass to the CLI", () => {
    const dataDir = temp();
    writeFileSync(
      path.join(dataDir, "devin-session-settings.json"),
      JSON.stringify({
        bad: { model: "rm -rf /", permissionMode: "yolo", updatedAt: 1 },
        list: [],
      }),
    );
    expect(new DevinSessionSettings(dataDir).get("bad")).toEqual({
      permissionMode: "accept-edits",
    });
  });
});

describe.runIf(posix)("Devin model catalog", () => {
  function listModels(families: unknown[]) {
    const root = temp();
    const file = path.join(root, "devin");
    writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({ families })}\nJSON\n`);
    chmodSync(file, 0o755);
    return devinModelCatalog(file, process.env);
  }

  it("lists families and names the family of each variant a session keeps", async () => {
    const catalog = await listModels([
      {
        slug: "swe-2",
        family_label: "SWE-2",
        variants: [{ model_uid: "swe-2-high" }, { model_uid: "swe-2" }],
      },
      { slug: "bad slug!", family_label: "Bad", variants: [{ model_uid: "bad" }] },
      { slug: "opus", variants: [{ model_uid: "opus-4" }, { model_uid: "x y" }] },
    ]);
    expect(catalog.families).toEqual([{ id: "swe-2", name: "SWE-2" }, { id: "opus" }]);
    expect(catalog.familyOf.get("swe-2-high")).toBe("swe-2");
    expect(catalog.familyOf.get("opus-4")).toBe("opus");
    expect(catalog.familyOf.has("bad")).toBe(false);
    expect(catalog.familyOf.has("x y")).toBe(false);
  });

  it("resolves only listed reasoning and speed combinations and keeps native capacity", async () => {
    const catalog = await listModels([
      {
        slug: "claude-opus-5.5",
        family_uid: "claude-opus-5-5",
        family_label: "Claude Opus 5.5",
        variants: [
          { model_uid: "claude-opus-5-5-low", max_context_tokens: 1_000_000 },
          { model_uid: "claude-opus-5.5-low", max_context_tokens: 1_000_000 },
          { model_uid: "claude-opus-5-5-high", max_context_tokens: 1_000_000 },
          {
            model_uid: "claude-opus-5-5-high-fast",
            label: "Claude Opus 5.5 High Fast",
            max_context_tokens: 1_000_000,
          },
          { model_uid: "claude-opus-5-5-max-fast", max_context_tokens: 1_000_000 },
        ],
      },
      {
        slug: "gpt-6-sol",
        family_uid: "gpt-6-sol",
        variants: [{ model_uid: "gpt-6-sol-none-priority" }],
      },
      {
        slug: "swe-2",
        variants: [{ model_uid: "swe-2-medium-lightning" }],
      },
    ]);
    const modelId = "claude-opus-5.5";
    expect(resolveDevinModel(catalog, { modelId })).toBe(modelId);
    expect(resolveDevinModel(catalog, { modelId, effort: "high" })).toBe("claude-opus-5-5-high");
    expect(resolveDevinModel(catalog, { modelId, effort: "high", serviceTierId: "fast" })).toBe(
      "claude-opus-5-5-high-fast",
    );
    expect(
      resolveDevinModel(catalog, { modelId, effort: "low", serviceTierId: "fast" }),
    ).toBeUndefined();
    expect(resolveDevinModel(catalog, { modelId, serviceTierId: "fast" })).toBeUndefined();
    expect(resolveDevinModel(catalog, { modelId, effort: "low" })).toBeUndefined();
    expect(resolveDevinModel(catalog, { modelId: "claude-opus-5-5-low", effort: "low" })).toBe(
      "claude-opus-5-5-low",
    );
    expect(resolveDevinModel(catalog, { modelId: "gpt-6-sol", serviceTierId: "priority" })).toBe(
      "gpt-6-sol-none-priority",
    );
    expect(devinModelVariant(catalog, "claude-opus-5-5-high-fast")).toEqual({
      id: "claude-opus-5-5-high-fast",
      familyId: modelId,
      name: "Claude Opus 5.5 High Fast",
      effort: "high",
      serviceTierId: "fast",
      maxContextTokens: 1_000_000,
    });
    expect(devinModelVariant(catalog, "gpt-6-sol-none-priority")).toMatchObject({
      effort: "none",
      serviceTierId: "priority",
    });
    expect(devinModelVariant(catalog, "swe-2-medium-lightning")).toMatchObject({
      effort: "medium",
      serviceTierId: "lightning",
    });
  });

  it("keeps irregular variants directly selectable without inventing controls", async () => {
    const catalog = await listModels([
      {
        slug: "glm-5.2",
        family_uid: "glm-5-2",
        family_label: "GLM-5.2",
        variants: [
          { model_uid: "glm-5-2", label: "GLM-5.2 High", max_context_tokens: 200_000 },
          { model_uid: "glm-5-2-high-1m", label: "GLM-5.2 High 1M", max_context_tokens: 1_000_000 },
        ],
      },
      {
        slug: "fusion",
        family_uid: "fusion",
        variants: [
          {
            model_uid: "fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium",
            max_context_tokens: -1,
          },
        ],
      },
    ]);
    expect(resolveDevinModel(catalog, { modelId: "glm-5.2", effort: "high" })).toBe("glm-5-2");
    expect(devinModelVariant(catalog, "glm-5-2-high-1m")).toEqual({
      id: "glm-5-2-high-1m",
      familyId: "glm-5.2",
      name: "GLM-5.2 High 1M",
      maxContextTokens: 1_000_000,
    });
    const modelId = "fusion-claude-opus-5-5-high-fast-sidekick-swe-2-medium";
    expect(resolveDevinModel(catalog, { modelId })).toBe(modelId);
    expect(devinModelVariant(catalog, modelId)).toEqual({ id: modelId, familyId: "fusion" });
  });

  it("is empty when the CLI cannot list them", async () => {
    const root = temp();
    const file = path.join(root, "devin");
    writeFileSync(file, '#!/bin/sh\necho "Error: Not logged in." >&2\nexit 1\n');
    chmodSync(file, 0o755);
    const catalog = await devinModelCatalog(file, process.env);
    expect(catalog.families).toEqual([]);
    expect(catalog.familyOf.size).toBe(0);
    expect(catalog.variantsByFamily.size).toBe(0);
  });
});

describe.runIf(posix)("Devin over ACP", () => {
  const lead = {
    serverName: "agentkib_workers",
    url: "http://127.0.0.1:1/lead/x",
    toolNames: ["worker_list"],
  };
  const permission = (rule: string) => ({
    toolCall: {
      toolCallId: "exec:1",
      title: "Run git push",
      kind: "execute",
      rawInput: { command: "git push" },
      _meta: { "cognition.ai/permissionRule": rule },
    },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "switch_bypass", name: "Switch to bypass", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  });

  it("passes Devin's permission request to the person, with one-time answers only", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root);
    devin.turn({ permission: permission("Exec(git push)") });
    const waiting: string[] = [];
    const runner = new DevinManagedRunner(root, "known-session", {
      ...host(devin.file, () => [], []),
      waiting: (turnId) => waiting.push(turnId),
    });
    await runner.send("Push it", 0, () => {});
    for (
      let attempt = 0;
      attempt < 100 && runner.snapshot().status !== "waiting-approval";
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const live = runner.snapshot();
    const approvals = live.approvals as Array<Record<string, unknown>>;
    expect(live.status).toBe("waiting-approval");
    expect(waiting).toEqual([live.turnId]);
    expect(approvals).toEqual([
      expect.objectContaining({
        method: "session/request_permission",
        presentation: "tool",
        turnId: live.turnId,
        toolCall: expect.objectContaining({ title: "Run git push", kind: "execute" }),
        // Devin's "always" choices would change its config; they are not offered.
        availableDecisions: ["allow_once", "reject_once"],
      }),
    ]);
    const approval = approvals[0]!;
    await expect(
      runner.approve(
        String(approval.requestId),
        String(live.turnId),
        "allow_always",
        Number(live.revision),
      ),
    ).rejects.toThrow("approval-option-unavailable");
    await runner.approve(
      String(approval.requestId),
      String(live.turnId),
      "reject_once",
      Number(live.revision),
    );
    await settled(runner);
    expect(readFileSync(devin.log, "utf8")).toContain("permission reject_once");
    expect(runner.snapshot()).toMatchObject({ status: "idle", approvals: [] });
  });

  it.each([lead.serverName, "session_workers"])(
    "offers a Project Agent its registered MCP server %s and allows its worker tool once",
    async (serverName) => {
      const root = temp();
      const devin = fakeDevinAcp(root);
      devin.turn({ permission: permission(`mcp__${serverName}__worker_list`) });
      const runner = new DevinManagedRunner(root, "known-session", {
        ...host(devin.file, () => [], []),
        leadTools: async () => ({ ...lead, serverName }),
      });
      try {
        await runner.send("List the workers", 0, () => {});
        await expect.poll(() => runner.snapshot().status, { timeout: 3500 }).toBe("idle");
        const calls = readFileSync(devin.log, "utf8");
        expect(calls).toContain(`mcp ${serverName} ${lead.url}`);
        expect(calls).toContain("permission allow_once");
        expect(runner.snapshot()).toMatchObject({ reason: null, sendEnabled: true });
      } finally {
        runner.close();
      }
    },
  );

  it.each([
    ["without a worker registration", "mcp__agentkib_workers__worker_list", null],
    ["from a similarly named server", "mcp__agentkib_workers_x__worker_list", lead],
    ["for an unregistered tool on the same server", "mcp__agentkib_workers__worker_other", lead],
  ] as const)(
    "asks the person to approve an MCP request %s",
    async (_label, rule, registration) => {
      const root = temp();
      const devin = fakeDevinAcp(root);
      devin.turn({ permission: permission(rule) });
      const runner = new DevinManagedRunner(root, "known-session", {
        ...host(devin.file, () => [], []),
        ...(registration && { leadTools: async () => registration }),
      });
      try {
        await runner.send("List the workers", 0, () => {});
        await expect
          .poll(() => runner.snapshot().status, { timeout: 3500 })
          .toBe("waiting-approval");
        expect(runner.snapshot().approvals).toEqual([
          expect.objectContaining({
            presentation: "mcp",
            availableDecisions: ["allow_once", "reject_once"],
          }),
        ]);
        const calls = readFileSync(devin.log, "utf8");
        if (registration) expect(calls).toContain(`mcp ${lead.serverName} ${lead.url}`);
        expect(calls).not.toContain("permission allow_once");
      } finally {
        runner.close();
      }
    },
  );

  it("asks for a newer Devin CLI when ACP refuses its own login", async () => {
    const root = temp();
    const devin = fakeDevinAcp(root, {
      authError:
        "ACP host has not authenticated. Local CLI credentials are intentionally not used in ACP mode",
    });
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
    ).rejects.toThrow("devin-cli-update-required");
    expect(dispatched).toBe(false);
    expect(runner.snapshot()).toMatchObject({ status: "idle", sendEnabled: true });
  });
});
