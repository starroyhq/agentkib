import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeHostControlPreflightError,
  ClaudeManagedReadOwner,
} from "../../../packages/backend/src/claude-managed-read";
import { ClaudeHostStateStore } from "../../../packages/backend/src/claude-host-state";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { createFakeClaude, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// Slash commands in managed sessions, against the scripted fake CLI. The catalog entries follow
// what CLI 2.1.311 reported at initialize against the local API stub (descriptions shortened);
// `fixture-new` stands for a built-in of a newer CLI that only the reported catalog knows.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const catalog = [
  { name: "probe-skill", description: "A probe skill (project)", argumentHint: "" },
  {
    name: "config",
    description: "Set a setting by key",
    argumentHint: "key=value",
    builtin: true,
    aliases: ["settings"],
  },
  { name: "compact", description: "Free up context", builtin: true },
  { name: "fixture-new", description: "A newer built-in", builtin: true },
];
const REMOTE = "browser-device-a";
const OWNER = "agentkib-local-owner";

function setup(plan: FakeClaudePlan = {}) {
  const f = createFakeClaude("agentkib-claude-commands-");
  f.setPlan({ commands: catalog, ...plan });
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  const commands = {
    run: vi.fn(async (command: string, args: string[]) => {
      if (command === "/bin/ps") return { success: true, bytes: Buffer.from("") };
      if (args[0] === "agents") return { success: true, bytes: Buffer.from("[]\n") };
      return { success: true, bytes: Buffer.from("2.1.311 (Claude Code)\n") };
    }),
  } as unknown as Commands;
  const store = {
    workspacePath: () => f.workspace,
    sessions: { id: (_agent: string, id: string) => id, get: () => undefined },
  } as unknown as BackendStore;
  const sessions = {
    verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
  } as unknown as SessionReaders;
  const makeOwner = () => {
    const owner = new ClaudeManagedReadOwner(
      store,
      sessions,
      commands,
      f.root,
      f.environment,
      randomUUID(),
    );
    cleanups.push(() => owner.shutdown());
    return owner;
  };
  return { f, owner: makeOwner(), makeOwner };
}
async function create(owner: ClaudeManagedReadOwner) {
  const created = (await owner.request({
    operation: "create",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId: REMOTE,
  })) as Record<string, any>;
  return created.sessionId as string;
}
async function control(
  owner: ClaudeManagedReadOwner,
  id: string,
  operation: string,
  deviceId: string,
  fields: Record<string, unknown> = {},
) {
  const live = await owner.live(id, true);
  return (await owner.request({
    operation,
    sessionId: id,
    deviceId,
    requestId: randomUUID(),
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    ...fields,
  })) as Record<string, any>;
}
/** A host mutation refused before it changed anything, and its durable receipt. */
async function preflight(pending: Promise<unknown>) {
  const error = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ClaudeHostControlPreflightError);
  return (error as ClaudeHostControlPreflightError).result;
}
const idle = (owner: ClaudeManagedReadOwner, id: string) =>
  expect.poll(async () => (await owner.live(id, true)).status, { timeout: 15_000 }).toBe("idle");
const userTexts = (f: ReturnType<typeof createFakeClaude>) =>
  f
    .frames()
    .filter((frame) => frame.type === "user")
    .map((frame) => frame.message?.content);
const refused = (error: string) => ({
  accepted: false,
  completed: false,
  controlOutcome: "not-dispatched",
  error,
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "slash commands in a managed Claude session",
  () => {
    it("refuses /clear for every device before anything reaches the CLI, durably", async () => {
      const { f, owner } = setup();
      const id = await create(owner);
      const value = {
        operation: "send",
        sessionId: id,
        deviceId: OWNER,
        requestId: randomUUID(),
        runtimeBootId: owner.bootId,
        expectedRevision: (await owner.live(id, true)).revision,
        experimentalEnabled: true,
        text: "/clear",
      };
      const result = await owner.request(value);
      expect(result).toMatchObject({
        ...refused("claude-command-clear"),
        requestId: value.requestId,
      });
      // The same request replays its recorded result.
      expect(await owner.request(value)).toEqual(result);
      expect(await control(owner, id, "send", REMOTE, { text: "  /reset" })).toMatchObject(
        refused("claude-command-clear"),
      );
      // No worker was started for either.
      expect(f.frames()).toEqual([]);
      expect(await owner.live(id, true)).toMatchObject({ status: "idle", sendEnabled: true });
      expect(await control(owner, id, "send", REMOTE, { text: "hello" })).toMatchObject({
        accepted: true,
      });
      await idle(owner, id);
      expect(userTexts(f)).toEqual(["hello"]);
    }, 30_000);

    it("lets the desktop change Claude Code settings but not a remote device", async () => {
      const { f, owner } = setup();
      const id = await create(owner);
      // Before any worker has reported a catalog, the built-in list decides.
      expect(
        await control(owner, id, "send", REMOTE, { text: "/config permissionMode=auto" }),
      ).toMatchObject(refused("claude-command-owner-only"));
      expect(f.frames()).toEqual([]);
      expect(await control(owner, id, "send", REMOTE, { text: "/probe-skill go" })).toMatchObject({
        accepted: true,
      });
      await idle(owner, id);
      expect(
        await control(owner, id, "send", REMOTE, { text: "/settings permissionMode=auto" }),
      ).toMatchObject(refused("claude-command-owner-only"));
      expect(
        await control(owner, id, "send", OWNER, { text: "/config autoScroll=false" }),
      ).toMatchObject({ accepted: true });
      await idle(owner, id);
      expect(userTexts(f)).toEqual(["/probe-skill go", "/config autoScroll=false"]);
    }, 30_000);

    it("checks again with the catalog a new worker reports, then keeps the session usable", async () => {
      const { f, owner } = setup();
      const id = await create(owner);
      // Accepted up front: nothing knows `fixture-new` yet. The worker it starts does.
      expect(await control(owner, id, "send", REMOTE, { text: "/fixture-new" })).toMatchObject(
        refused("claude-command-owner-only"),
      );
      expect(
        f
          .frames()
          .some(
            (frame) => frame.type === "control_request" && frame.request?.subtype === "initialize",
          ),
      ).toBe(true);
      expect(userTexts(f)).toEqual([]);
      expect(await owner.live(id, true)).toMatchObject({ status: "idle", sendEnabled: true });
      // The catalog is known now, so the check up front refuses it too.
      expect(await control(owner, id, "send", REMOTE, { text: "/fixture-new" })).toMatchObject(
        refused("claude-command-owner-only"),
      );
      expect(await control(owner, id, "send", OWNER, { text: "/fixture-new" })).toMatchObject({
        accepted: true,
      });
      await idle(owner, id);
      expect(userTexts(f)).toEqual(["/fixture-new"]);
    }, 30_000);

    it("checks text steered into a running turn", async () => {
      const { f, owner } = setup({ noResult: true });
      const id = await create(owner);
      const turnId = randomUUID();
      await control(owner, id, "send", REMOTE, { requestId: turnId, text: "a long task" });
      await expect.poll(async () => (await owner.live(id, true)).status).toBe("running");
      expect(
        await control(owner, id, "steer", REMOTE, { turnId, text: "/heapdump" }),
      ).toMatchObject(refused("claude-command-owner-only"));
      expect(await control(owner, id, "steer", OWNER, { turnId, text: "/clear" })).toMatchObject(
        refused("claude-command-clear"),
      );
      expect(userTexts(f)).toEqual(["a long task"]);
    }, 30_000);

    it("checks queued messages and goals when they are added or edited", async () => {
      const { f, owner } = setup();
      const id = await create(owner);
      expect(
        await preflight(
          control(owner, id, "queue-add", REMOTE, { text: "/config permissionMode=auto" }),
        ),
      ).toMatchObject(refused("claude-command-owner-only"));
      expect(
        await preflight(control(owner, id, "queue-add", OWNER, { text: "/loop 5m check CI" })),
      ).toMatchObject(refused("claude-command-background"));
      const queued = await control(owner, id, "queue-add", REMOTE, { text: "later" });
      const queuedSubmissionId = queued.queuedSubmission.id as string;
      // The item is sent as the device that queued it, whoever edits it.
      expect(
        await preflight(
          control(owner, id, "queue-update", OWNER, { queuedSubmissionId, text: "/heapdump" }),
        ),
      ).toMatchObject(refused("claude-command-owner-only"));
      expect(
        await control(owner, id, "queue-update", OWNER, { queuedSubmissionId, text: "/compact" }),
      ).toMatchObject({ accepted: true });
      expect(
        await preflight(
          control(owner, id, "goal-set", REMOTE, {
            goal: { objective: "/config permissionMode=auto" },
          }),
        ),
      ).toMatchObject(refused("claude-command-owner-only"));
      // Every goal step adds instructions after the objective, so `/model` gets an argument.
      expect(
        await preflight(control(owner, id, "goal-set", OWNER, { goal: { objective: "/model" } })),
      ).toMatchObject(refused("claude-command-settings"));
      expect(
        await control(owner, id, "goal-set", OWNER, { goal: { objective: "Ship the fix" } }),
      ).toMatchObject({ accepted: true });
      const state = new ClaudeHostStateStore(f.root, owner.bootId).read(id);
      expect(state.work.filter((item) => item.kind === "queue").map((item) => item.input)).toEqual([
        "/compact",
      ]);
      expect(state.goal?.objective).toBe("Ship the fix");
      expect(f.frames()).toEqual([]);
    }, 30_000);

    it("does not send a queued message that the reported catalog refuses", async () => {
      const { f, owner } = setup();
      const id = await create(owner);
      // Accepted when queued: no catalog yet, and the built-in list does not know it.
      await control(owner, id, "queue-add", REMOTE, { text: "/fixture-new" });
      const list = (await owner.request({ operation: "schedule-list", sessionId: id })) as {
        sessions: Array<Record<string, any>>;
      };
      const next = list.sessions[0]!;
      const permit = (await owner.request({
        operation: "schedule-prepare",
        sessionId: id,
        itemId: next.next.itemId,
        requestId: next.next.requestId,
        deviceId: next.next.deviceId,
        runtimeBootId: owner.bootId,
        expectedRevision: next.revision,
      })) as Record<string, any>;
      const { accepted: _accepted, expiresAt: _expiresAt, ...dispatch } = permit;
      expect(await owner.request({ operation: "schedule-dispatch", ...dispatch })).toMatchObject(
        refused("claude-command-owner-only"),
      );
      expect(userTexts(f)).toEqual([]);
    }, 30_000);

    it("reports the catalog with built-in flags and aliases, and keeps it for the next host", async () => {
      const { owner, makeOwner } = setup();
      const id = await create(owner);
      expect((await owner.capabilities(id, true)).commands).toEqual([]);
      await control(owner, id, "send", REMOTE, { text: "hello" });
      await idle(owner, id);
      const expected = [
        { name: "probe-skill", description: "A probe skill (project)" },
        {
          name: "config",
          description: "Set a setting by key",
          argumentHint: "key=value",
          builtin: true,
          aliases: ["settings"],
        },
        { name: "compact", description: "Free up context", builtin: true },
        { name: "fixture-new", description: "A newer built-in", builtin: true },
      ];
      expect((await owner.capabilities(id, true)).commands).toEqual(expected);
      await owner.shutdown();
      // A later host reads the cached catalog without starting a worker.
      const next = makeOwner();
      expect((await next.capabilities(id, true)).commands).toEqual(expected);
      expect(await control(next, id, "send", REMOTE, { text: "/fixture-new now" })).toMatchObject(
        refused("claude-command-owner-only"),
      );
    }, 30_000);
  },
);
