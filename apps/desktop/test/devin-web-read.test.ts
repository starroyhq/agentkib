// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeSessionGroups, workStoppedByQuit, type HomeSession } from "@agentkib/session-catalog";
import { Commands } from "../../../packages/backend/src/commands";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { readManagedUsageLimit } from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { ConversationEvent } from "../../../packages/backend/src/session-events";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";
import { AUTO_CONTINUE_TEXT } from "../../../packages/backend/src/usage-limit";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Event = { sessionId: string; type: string; payload: Record<string, unknown> };

// What Devin's service answers when a quota runs out, as `devin -p` prints it (3000.12.59).
const DAILY_QUOTA =
  "Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
const WEEKLY_QUOTA =
  "Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";

/** A whole minute, as `/usage` prints times; `ms` from now at the least. */
const minuteAfter = (ms: number) => Math.ceil((Date.now() + ms) / 60_000) * 60_000;
/** `/usage`'s line for a window, the time in UTC as Devin prints it (`%b %-d, %-I:%M %p`). */
function usageLine(label: string, used: number, resetsAt: number) {
  const at = new Date(resetsAt);
  const month = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hour = at.getUTCHours() % 12 || 12;
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  const meridiem = at.getUTCHours() < 12 ? "AM" : "PM";
  return ` ${label}  ■■■■■■■■  ${used}% used  · resets ${month} ${at.getUTCDate()}, ${hour}:${minute} ${meridiem} (UTC+0)\n`;
}

/**
 * A Devin session in a registered workspace, run by a stand-in `devin` on PATH: its `-p` turn
 * sleeps, prints and exits as the files beside it say and logs its prompt, and its interactive
 * REPL answers `/usage` with the panel in `usage-panel`, or says it has no data.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-devin-web-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    bin = path.join(root, "bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  const executable = path.join(bin, "devin");
  writeFileSync(
    executable,
    `#!/bin/sh
dir="$(dirname "$0")"
if [ "$1" = "auth" ]; then echo "Logged in as tester"; exit 0; fi
if [ $# -eq 0 ]; then echo start >> "$dir/usage.log"; exec "${process.execPath}" "$dir/repl.mjs"; fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--prompt-file" ]; then cat "$2" >> "$dir/prompts.log"; echo >> "$dir/prompts.log"; shift; fi
  shift
done
[ -f "$dir/turn-sleep" ] && sleep "$(cat "$dir/turn-sleep")"
[ -f "$dir/turn-stderr" ] && cat "$dir/turn-stderr" >&2
exit "$(cat "$dir/turn-code" 2>/dev/null || echo 0)"
`,
  );
  chmodSync(executable, 0o755);
  writeFileSync(
    path.join(bin, "repl.mjs"),
    `import { existsSync, readFileSync } from "node:fs";
const panel = ${JSON.stringify(path.join(bin, "usage-panel"))};
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\\u001b]7501;state=idle:app=devin\\u001b\\\\");
let typed = "";
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  if (text !== "\\r") return void (typed += text);
  if (typed === "/usage")
    process.stdout.write(existsSync(panel) ? readFileSync(panel, "utf8") : " No quota data available.\\n");
  typed = "";
});
process.on("SIGHUP", () => process.exit(0));
`,
  );
  const turn = ({ sleep = 0, stderr = "", code = 0 } = {}) => {
    writeFileSync(path.join(bin, "turn-sleep"), String(sleep));
    writeFileSync(path.join(bin, "turn-stderr"), stderr);
    writeFileSync(path.join(bin, "turn-code"), String(code));
  };
  const usage = (...lines: string[]) =>
    writeFileSync(path.join(bin, "usage-panel"), ` Usage\n${lines.join("")}\n`);
  const log = (name: string) =>
    existsSync(path.join(bin, name)) ? readFileSync(path.join(bin, name), "utf8") : "";
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-16T00:00:00Z",
  );
  const native: NativeSession = {
    native_ref: "brisk-otter",
    agent: "devin",
    title: "Fix the build",
    origin: "interactive",
    created_at: "2026-11-16T00:00:00.000Z",
    updated_at: "2026-11-16T00:00:00.000Z",
    message_count: null,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
  };
  store.sessions.sync("workspace", "devin", [native]);
  const id = store.sessions.id("devin", native.native_ref);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    DEVIN_SESSIONS_DIR: path.join(root, "devin"),
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, { profiles: () => [] });
  cleanups.push(() => readers.close());
  vi.spyOn(readers, "resolve").mockResolvedValue({
    summary: store.sessions.get(id)!,
    native,
    workspace,
  });
  // What Devin stored for the session: the prompt, and the answer that ended its turn.
  const history: ConversationEvent[] = [
    { id: "devin-m1", kind: "user-message", turn_id: "devin-m1", content: "Hello" },
    {
      id: "devin-m2",
      kind: "agent-message",
      turn_id: "devin-m1",
      message_phase: "final_answer",
      content: "Done.",
    },
  ].map((event) => ({
    timestamp: null,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
    ...(event as Partial<ConversationEvent>),
  })) as ConversationEvent[];
  vi.spyOn(readers, "eventsForNative").mockResolvedValue({
    events: history,
    next_cursor: null,
    warnings: [],
  });
  const events: Event[] = [];
  const open = () => {
    const web = new WebReadRequests(
      store,
      readers,
      root,
      () => 0n,
      environment,
      (sessionId, type, payload) => events.push({ sessionId, type, payload }),
    );
    cleanups.push(() => web.closeAsync());
    return web;
  };
  const f = {
    root,
    id,
    workspace,
    environment,
    store,
    readers,
    events,
    turn,
    usage,
    log,
    web: open(),
    /** AgentKib quits and starts again on the same data. */
    async restart() {
      await f.web.closeAsync();
      f.web = open();
    },
    live: () =>
      f.web.request({ operation: "live", sessionId: id, experimentalEnabled: true }) as Promise<
        Record<string, unknown> & { usageLimit?: Record<string, unknown> | null }
      >,
    async row() {
      return (
        (await f.web.request({ operation: "catalog" })) as {
          sessions: Array<HomeSession & { continuation?: Record<string, unknown> }>;
        }
      ).sessions.find((session) => session.id === id)!;
    },
    async control(operation: string, extra: Record<string, unknown> = {}) {
      const state = await f.live();
      return f.web.managedControl({
        operation,
        sessionId: id,
        requestId: randomUUID(),
        deviceId: "phone",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        ...extra,
      }) as Promise<Record<string, unknown>>;
    },
    send: (text: string) => f.control("send", { text }),
    async features() {
      return (
        (await f.web.managedQuery({
          operation: "capabilities",
          sessionId: id,
          experimentalEnabled: true,
        })) as { features: Record<string, { available: boolean; reason?: string }> }
      ).features;
    },
    async ended() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await f.live();
        if (state.sendEnabled === true) return state;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the turn did not end");
    },
  };
  return f;
}

describe.runIf(process.platform !== "win32")("Devin sessions run by AgentKib", () => {
  it("names the session's workspace in its live state and in what it publishes", async () => {
    const f = fixture();
    expect(await f.live()).toMatchObject({
      executionMode: "devin-print",
      status: "idle",
      workspaceId: "workspace",
    });
    f.turn();
    expect(await f.send("Hello")).toMatchObject({ accepted: true });
    await f.ended();
    const states = f.events.filter((event) => event.type === "state");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.sessionId).toBe(f.id);
      // Clients merge a state event into the live state: its fields are at the top.
      expect(state.payload).toMatchObject({
        executionMode: "devin-print",
        workspaceId: "workspace",
      });
      expect(state.payload).not.toHaveProperty("live");
    }
    expect(states.map((state) => state.payload.status)).toContain("running");
    expect(states.at(-1)!.payload).toMatchObject({ status: "idle", sendEnabled: true });
  });

  it("lists a running turn in the catalog, so the home and the quit confirmation count it", async () => {
    const f = fixture();
    // Before AgentKib holds a runner the row says nothing about a turn.
    expect((await f.row()).continuation).toBeUndefined();
    f.turn({ sleep: 2 });
    await f.send("Long task");
    const running = await f.row();
    expect(running.continuation).toMatchObject({
      status: "running",
      executionLocation: "agentkib",
    });
    expect(workStoppedByQuit([running]).map((session) => session.id)).toEqual([f.id]);
    await f.ended();
    const idle = await f.row();
    expect(idle.continuation).toMatchObject({ status: "idle", reason: null });
    expect(workStoppedByQuit([idle])).toEqual([]);
  });

  it("explains a usage limit whose reset Devin's /usage does not tell, with no continue", async () => {
    const f = fixture();
    f.turn({ stderr: `Error: ${WEEKLY_QUOTA}\n`, code: 1 });
    await f.send("Hello");
    expect(await f.ended()).toMatchObject({
      status: "idle",
      reason: null,
      usageLimit: {
        agent: "devin",
        kind: "weekly",
        resetsAt: null,
        continueAt: null,
        manual: "reset-unknown",
      },
    });
    // `/usage` was asked once, in a terminal of its own, and said it has no data.
    await vi.waitFor(() => expect(f.log("usage.log")).toBe("start\n"));
    const features = await f.features();
    expect(features["usage-limit-continue"]?.available).toBe(false);
    expect(features["usage-limit-cancel"]?.available).toBe(false);
  });
});

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "a Devin turn that meets the usage limit",
  { timeout: 30_000 },
  () => {
    it("says when the limit resets, from Devin's /usage, and continues on its own after it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
      vi.spyOn(Math, "random").mockReturnValue(0);
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Daily", 100, resetsAt), usageLine("Weekly", 64, resetsAt + 86_400_000));
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      // The notice says so at once, and when it resets once /usage has answered.
      expect((await f.ended()).usageLimit).toMatchObject({ manual: "reset-unknown" });
      await vi.waitFor(
        async () =>
          expect((await f.live()).usageLimit).toEqual({
            agent: "devin",
            resetsAt,
            kind: null,
            scope: null,
            message: DAILY_QUOTA,
            continueAt: resetsAt + 30_000,
            manual: null,
            autoContinues: 0,
          }),
        { timeout: 15_000 },
      );
      expect(f.log("usage.log")).toBe("start\n");
      expect((await f.features())["usage-limit-cancel"]).toEqual({ available: true });
      f.turn();
      await vi.advanceTimersByTimeAsync(resetsAt + 30_000 - Date.now() + 1_000);
      await vi.waitFor(() => expect(f.log("prompts.log")).toContain(AUTO_CONTINUE_TEXT.devin), {
        timeout: 10_000,
      });
      // The continue went through: the limit is over, also for a later run of AgentKib.
      await vi.waitFor(async () => expect((await f.live()).usageLimit ?? null).toBeNull(), {
        timeout: 10_000,
      });
      expect((await f.ended()).usageLimit ?? null).toBeNull();
      expect(readManagedUsageLimit(f.root, f.id)).toBeNull();
    });

    it("gives way to the person's message, and can be turned off and on again", async () => {
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Weekly", 100, resetsAt));
      f.turn({ stderr: `Error: ${WEEKLY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await vi.waitFor(
        async () =>
          expect((await f.live()).usageLimit).toMatchObject({
            kind: "weekly",
            resetsAt,
            manual: null,
          }),
        { timeout: 15_000 },
      );
      expect(await f.control("usage-limit-cancel")).toMatchObject({
        accepted: true,
        completed: true,
      });
      expect((await f.live()).usageLimit).toMatchObject({ continueAt: null, manual: "cancelled" });
      const features = await f.features();
      expect(features["usage-limit-cancel"]?.available).toBe(false);
      expect(features["usage-limit-continue"]).toEqual({ available: true });
      expect(await f.control("usage-limit-continue")).toMatchObject({ accepted: true });
      expect((await f.live()).usageLimit).toMatchObject({ manual: null, autoContinues: 0 });
      expect(typeof (await f.live()).usageLimit?.continueAt).toBe("number");
      // A message the person sends takes over; nothing is kept for a later run either.
      f.turn({ sleep: 1 });
      await f.send("Carry on");
      expect((await f.live()).usageLimit ?? null).toBeNull();
      expect(readManagedUsageLimit(f.root, f.id)).toBeNull();
      await f.ended();
      expect(f.log("prompts.log")).not.toContain(AUTO_CONTINUE_TEXT.devin);
    });

    it("keeps the notice through a restart, for the person to continue", async () => {
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Daily", 100, resetsAt));
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await vi.waitFor(
        async () => expect((await f.live()).usageLimit).toMatchObject({ manual: null }),
        { timeout: 15_000 },
      );
      await f.restart();
      // AgentKib's continue ended with the run that armed it; the notice stays.
      expect((await f.live()).usageLimit).toMatchObject({
        agent: "devin",
        resetsAt,
        message: DAILY_QUOTA,
        continueAt: null,
        manual: "restarted",
      });
      const features = await f.features();
      expect(features["usage-limit-cancel"]?.available).toBe(false);
      expect(features["usage-limit-continue"]).toEqual({ available: true });
      // The next turn ends it.
      f.turn();
      await f.send("Carry on");
      await f.ended();
      await f.restart();
      expect((await f.live()).usageLimit ?? null).toBeNull();
    });

    it("keeps a notice without a reset time through a restart as it was", async () => {
      const f = fixture();
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await f.ended();
      await vi.waitFor(() => expect(f.log("usage.log")).toBe("start\n"));
      await f.restart();
      expect((await f.live()).usageLimit).toMatchObject({
        message: DAILY_QUOTA,
        continueAt: null,
        manual: "reset-unknown",
      });
    });
  },
);

describe.runIf(process.platform !== "win32")("a Devin turn's result", () => {
  it("is recorded as each turn AgentKib ran ends: answered, failed or stopped", async () => {
    const f = fixture();
    const results: Array<{ target: Record<string, unknown>; result: Record<string, unknown> }> = [];
    f.web.observeResults((target, result) => results.push({ target, result }));
    f.turn();
    await f.send("Hello");
    await f.ended();
    f.turn({ stderr: "Error: something broke\n", code: 2 });
    await f.send("Again");
    await f.ended();
    f.turn({ sleep: 30 });
    await f.send("Long task");
    const running = await f.live();
    await f.control("stop", { turnId: running.turnId });
    await f.ended();
    expect(results.map(({ result }) => result.outcome)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const { target, result } of results) {
      expect(target).toEqual({
        provider: "devin",
        home: path.join(f.root, "devin", "cli"),
        nativeId: "brisk-otter",
        workspace: f.workspace,
      });
      // The answer in the session's history is what reading it means.
      expect(result).toMatchObject({ turnId: "devin-m1", itemId: "devin-m2" });
      expect(result.id).toMatch(/^turn:/);
    }
  });

  it("is unread on the home until read, which the phone's alerts follow", async () => {
    const f = fixture();
    const reads = new ConversationReadStates(
      f.store,
      f.readers,
      f.root,
      f.environment,
      () => null,
      () => undefined,
      () => false,
    );
    cleanups.push(() => reads.close());
    f.web.observeResults((target, result) => reads.recordTerminal(target, result));
    // A session none of whose turns AgentKib ran has nothing to read.
    expect(await reads.get(f.id, "desktop")).toMatchObject({
      source: "agentkib",
      status: "read",
      freshness: "current",
    });
    f.turn({ sleep: 1 });
    await f.send("Hello");
    expect(homeSessionGroups([await f.row()]).running).toHaveLength(1);
    await f.ended();
    const unread = await reads.get(f.id, "desktop");
    expect(unread).toMatchObject({
      source: "agentkib",
      status: "unread",
      freshness: "current",
      firstUnread: { type: "result", turnId: "devin-m1" },
      latestResult: { outcome: "completed", turnId: "devin-m1", itemId: "devin-m2" },
    });
    const [row] = reads.project([await f.row()], "desktop");
    expect(homeSessionGroups([row!]).review).toEqual([{ session: row, result: "completed" }]);
    const read = await reads.update(f.id, "desktop", unread.version!, unread.latestResult!.id);
    expect(read).toMatchObject({ status: "read", freshness: "current" });
    expect(homeSessionGroups(reads.project([await f.row()], "desktop")).review).toEqual([]);
    // Each reader keeps its own place: the phone's has not read it yet.
    expect(await reads.get(f.id, "local")).toMatchObject({ status: "unread" });
  });
});
