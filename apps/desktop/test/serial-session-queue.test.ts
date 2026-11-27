import { REMOTE_ERROR_CODES, sessionProviderDeclaration } from "@agentkib/runtime-protocol";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeHostStateStore } from "../../../packages/backend/src/agents/claude/claude-host-state";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  SerialSessionQueue,
  type SerialQueueTarget,
} from "../../../packages/backend/src/sessions/serial-session-queue";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(agent: SerialQueueTarget["agent"] = "devin") {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-serial-queue-"));
  directories.push(directory);
  const sessionId = "indexed-session";
  let target: SerialQueueTarget = { agent, workspaceId: "workspace", nativeId: "native" };
  let state: Record<string, unknown> = {
    sessionId,
    workspaceId: target.workspaceId,
    revision: 4,
    status: "idle",
    sendEnabled: true,
  };
  const requests: Record<string, unknown>[] = [];
  const send = vi.fn(async (request: Record<string, unknown>, beforeNativeDispatch: () => void) => {
    beforeNativeDispatch();
    requests.push(request);
    return { accepted: true };
  });
  const changed = vi.fn();
  const open = (bootId: string) =>
    new SerialSessionQueue(
      directory,
      bootId,
      () => target,
      async () => ({ ...state, runtimeBootId: bootId }),
      send,
      changed,
    );
  const queue = open("boot");
  const control =
    (owner = queue) =>
    (operation: string, fields = {}) =>
      owner.control({
        operation,
        sessionId,
        requestId: randomUUID(),
        deviceId: "device-a",
        expectedRevision: state.revision,
        runtimeBootId: owner.bootId,
        experimentalEnabled: true,
        ...fields,
      });
  const prepare = async (owner = queue) => {
    const [session] = await owner.scheduleList();
    const next = session!.next!;
    const fields = {
      sessionId,
      requestId: next.requestId,
      deviceId: next.deviceId,
      runtimeBootId: owner.bootId,
      expectedRevision: session!.revision,
      itemId: next.itemId,
    };
    const permit = await owner.schedule({ operation: "schedule-prepare", ...fields });
    return { operation: "schedule-dispatch", ...fields, permitId: permit.permitId };
  };
  return {
    directory,
    sessionId,
    queue,
    open,
    control,
    prepare,
    send,
    requests,
    changed,
    scope: (next: SerialQueueTarget) => {
      target = next;
    },
    live: (next: Record<string, unknown>) => {
      state = { ...state, ...next };
    },
  };
}

describe("host-scheduled text for Devin and Antigravity", () => {
  it.each([
    ["devin", "devin-print"],
    ["antigravity", "antigravity-acp-managed"],
  ] as const)(
    "keeps %s queue admissions and receipts scoped to the real session",
    async (agent, mode) => {
      const f = await fixture(agent);
      expect(sessionProviderDeclaration(agent)?.queue?.actions).toEqual([
        "list",
        "add",
        "update",
        "delete",
        "reorder",
        "pause",
        "resume",
      ]);
      const control = f.control();
      const requestId = randomUUID();
      const publicInputHash = "a".repeat(64);
      f.live({ status: "running", sendEnabled: false });
      const first = await control("queue-add", { text: "First", requestId, publicInputHash });
      f.live({ revision: 5 });
      expect(
        await control("queue-add", {
          text: "First",
          requestId,
          publicInputHash,
          expectedRevision: 4,
        }),
      ).toEqual(first);
      await expect(control("queue-add", { text: "Changed", requestId })).rejects.toThrow(
        "request-id-reused",
      );
      expect(f.changed).toHaveBeenCalledTimes(1);
      expect(readControlReceipt(f.directory, { requestId, deviceId: "device-a" })).toMatchObject({
        found: true,
        sessionId: f.sessionId,
        executionMode: mode,
        workspaceId: "workspace",
        operation: "queue-add",
        publicInputHash,
        ack: { publicInputHash },
      });
      expect(readControlReceipt(f.directory, { requestId, deviceId: "device-b" })).toMatchObject({
        found: false,
      });
      expect(new ClaudeHostStateStore(f.directory, "boot").peek(f.sessionId)).toBeNull();
      await control("queue-add", { text: "Second" });
      const firstId = f.queue.list(f.sessionId).data[0]!.id;
      await control("queue-update", {
        queuedSubmissionId: firstId,
        text: "Edited",
        deviceId: "device-b",
      });
      expect(await f.queue.scheduleList()).toMatchObject([{ agent, next: null }]);
      f.live({ status: "idle", sendEnabled: true });
      const dispatch = await f.prepare();
      expect(dispatch.deviceId).toBe("device-a");
      expect(await control("queue-delete", { queuedSubmissionId: firstId })).toMatchObject({
        controlOutcome: "not-dispatched",
        reason: REMOTE_ERROR_CODES.queueItemUnavailableDetail,
      });
      expect(await f.queue.schedule(dispatch)).toMatchObject({ accepted: true });
      await expect(f.queue.schedule(dispatch)).rejects.toThrow("schedule-permit-unavailable");
      expect(f.requests).toEqual([
        expect.objectContaining({ text: "Edited", deviceId: "device-a" }),
      ]);
      expect(f.queue.list(f.sessionId).data).toMatchObject([{ text: "Second", status: "pending" }]);
      const restarted = f.open("replacement-boot");
      expect(restarted.list(f.sessionId)).toMatchObject({
        paused: true,
        reason: "restart-confirmation-required",
      });
      expect(await restarted.scheduleList()).toMatchObject([{ paused: true, next: null }]);
      await f.control(restarted)("queue-resume");
      const next = await f.prepare(restarted);
      expect(await restarted.schedule(next)).toMatchObject({ accepted: true });
      expect(f.requests[1]).toMatchObject({ text: "Second", deviceId: "device-a" });
      f.scope({ agent, workspaceId: "elsewhere", nativeId: "native" });
      expect(restarted.list(f.sessionId).data).toEqual([]);
      expect(await restarted.scheduleList()).toEqual([]);
    },
  );

  it.each(["devin", "antigravity"] as const)(
    "persists the %s order while retaining existing items, device ownership and receipts",
    async (agent) => {
      const f = await fixture(agent);
      const control = f.control();
      await control("queue-add", { text: "First" });
      await control("queue-add", { text: "Second", deviceId: "device-b" });
      const [first, second] = f.queue.list(f.sessionId).data;

      for (const ids of [[first!.id], [first!.id, first!.id], [first!.id, randomUUID()]]) {
        expect(await control("queue-reorder", { queuedSubmissionIds: ids })).toMatchObject({
          controlOutcome: "not-dispatched",
          reason: REMOTE_ERROR_CODES.staleQueueOrder,
        });
      }
      expect(f.queue.list(f.sessionId).data).toEqual([first, second]);
      const requestId = randomUUID();
      const reverse = { requestId, queuedSubmissionIds: [second!.id, first!.id] };
      const reordered = await control("queue-reorder", reverse);
      expect(reordered).toMatchObject({ accepted: true, completed: true });
      expect(f.queue.list(f.sessionId).data).toEqual([second, first]);
      expect(await control("queue-reorder", reverse)).toEqual(reordered);
      await expect(
        control("queue-reorder", { requestId, queuedSubmissionIds: [first!.id, second!.id] }),
      ).rejects.toThrow("request-id-reused");
      expect(f.changed).toHaveBeenCalledTimes(3);
      expect(readControlReceipt(f.directory, { requestId, deviceId: "device-a" })).toMatchObject({
        found: true,
        sessionId: f.sessionId,
        operation: "queue-reorder",
      });

      const restarted = f.open("replacement-boot");
      expect(restarted.list(f.sessionId)).toMatchObject({
        paused: true,
        reason: "restart-confirmation-required",
        data: [second, first],
      });
      expect(await restarted.scheduleList()).toMatchObject([{ next: null }]);
      await f.control(restarted)("queue-resume");
      const next = await f.prepare(restarted);
      expect(next).toMatchObject({ itemId: second!.id, deviceId: "device-b" });
      expect(await restarted.schedule(next)).toMatchObject({ accepted: true });
      await expect(restarted.schedule(next)).rejects.toThrow("schedule-permit-unavailable");
      expect(f.requests).toEqual([
        expect.objectContaining({ text: "Second", deviceId: "device-b" }),
      ]);
      expect(restarted.list(f.sessionId).data).toEqual([first]);
    },
  );

  it("reorders only pending rows and leaves a claimed head's one-time permit intact", async () => {
    const f = await fixture();
    const control = f.control();
    for (const text of ["Claimed", "Second", "Third"]) await control("queue-add", { text });
    const [first, second, third] = f.queue.list(f.sessionId).data;
    const prepared = await f.prepare();

    expect(
      await control("queue-reorder", { queuedSubmissionIds: [third!.id, second!.id, first!.id] }),
    ).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: REMOTE_ERROR_CODES.staleQueueOrder,
    });
    await control("queue-reorder", { queuedSubmissionIds: [third!.id, second!.id] });
    expect(f.queue.list(f.sessionId).data.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: first!.id, status: "claimed" },
      { id: third!.id, status: "pending" },
      { id: second!.id, status: "pending" },
    ]);
    expect(await f.queue.scheduleList()).toMatchObject([{ next: null }]);
    expect(await f.queue.schedule(prepared)).toMatchObject({ accepted: true });
    await expect(f.queue.schedule(prepared)).rejects.toThrow("schedule-permit-unavailable");
    const next = await f.prepare();
    expect(next.itemId).toBe(third!.id);
    await f.queue.schedule(next);
    expect(f.requests.map(({ text }) => text)).toEqual(["Claimed", "Third"]);
  });

  it("replays queue refusals from SQLite after a restart makes the operations valid", async () => {
    const f = await fixture();
    const control = f.control();
    await control("queue-add", { text: "First" });
    await control("queue-add", { text: "Second" });
    const [first, second] = f.queue.list(f.sessionId).data;
    await f.prepare();
    const before = f.queue.list(f.sessionId);
    const store = new ClaudeHostStateStore(f.directory, "boot");
    const [stateKey] = store.keysWithPrefix("serial-session-queue:");
    const revision = store.peek(stateKey!)!.revision;
    const changes = f.changed.mock.calls.length;
    const refusals = [
      {
        operation: "queue-reorder",
        fields: { queuedSubmissionIds: [second!.id, first!.id] },
        changedFields: { queuedSubmissionIds: [first!.id, second!.id] },
        reason: REMOTE_ERROR_CODES.staleQueueOrder,
      },
      {
        operation: "queue-update",
        fields: { queuedSubmissionId: first!.id, text: "Edited" },
        changedFields: { text: "Different" },
        reason: REMOTE_ERROR_CODES.queueItemUnavailableDetail,
      },
    ];
    const receipts = [];
    for (const { operation, fields, changedFields, reason } of refusals) {
      const request = { ...fields, requestId: randomUUID(), publicInputHash: "a".repeat(64) };
      const ack = await control(operation, request);
      expect(ack).toMatchObject({
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        reason,
        requestId: request.requestId,
        sessionId: f.sessionId,
        runtimeBootId: "boot",
      });
      receipts.push({ operation, request, changedFields, ack });
    }
    expect(f.queue.list(f.sessionId)).toEqual(before);
    expect(store.peek(stateKey!)?.revision).toBe(revision);
    expect(f.changed).toHaveBeenCalledTimes(changes);

    const restarted = f.open("replacement-boot");
    const after = restarted.list(f.sessionId);
    const restartedRevision = store.peek(stateKey!)!.revision;
    expect(after.data).toMatchObject([
      { id: first!.id, status: "pending", text: "First" },
      { id: second!.id, status: "pending", text: "Second" },
    ]);
    const replay = f.control(restarted);
    for (const { operation, request, changedFields, ack } of receipts) {
      const { requestId, publicInputHash } = request;
      expect(readControlReceipt(f.directory, { requestId, deviceId: "device-a" })).toMatchObject({
        found: true,
        status: "not-dispatched",
        sessionId: f.sessionId,
        operation,
        publicInputHash,
        ack,
      });
      expect(readControlReceipt(f.directory, { requestId, deviceId: "device-b" })).toMatchObject({
        found: false,
      });
      expect(await replay(operation, request)).toEqual(ack);
      await expect(replay(operation, { ...request, ...changedFields })).rejects.toThrow(
        "request-id-reused",
      );
    }
    expect(restarted.list(f.sessionId)).toEqual(after);
    expect(store.peek(stateKey!)?.revision).toBe(restartedRevision);
    expect(f.changed).toHaveBeenCalledTimes(changes);

    for (const { operation, fields } of refusals)
      expect(await replay(operation, fields)).toMatchObject({ accepted: true });
    expect(restarted.list(f.sessionId).data).toMatchObject([
      { id: second!.id, text: "Second" },
      { id: first!.id, text: "Edited" },
    ]);
    expect(f.requests).toEqual([]);
  });

  it("revokes a permit during native preflight before any side effect can run", async () => {
    const f = await fixture();
    const control = f.control();
    await control("queue-add", { text: "Waiting" });
    const prepared = await f.prepare();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.send.mockImplementationOnce(async (_request, beforeNativeDispatch) => {
      enter();
      await blocked;
      beforeNativeDispatch();
      throw new Error("unexpected provider dispatch");
    });
    const result = f.queue.schedule(prepared);
    await entered;
    f.queue.invalidate("device-a");
    unblock();
    expect(await result).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
    expect(f.requests).toEqual([]);
    expect(f.queue.list(f.sessionId)).toMatchObject({
      paused: true,
      reason: "authorization-changed",
      data: [{ status: "pending" }],
    });
    await control("queue-resume", { deviceId: "device-b" });
    const fresh = await f.prepare();
    expect(fresh.requestId).not.toBe(prepared.requestId);
    expect(fresh.deviceId).toBe("device-a");
    expect(await f.queue.schedule(fresh)).toMatchObject({ accepted: true });
  });

  it("keeps known refusals pending with a new send receipt and replays an old pause safely", async () => {
    const f = await fixture();
    const control = f.control();
    await control("queue-add", { text: "Retry only on explicit resume" });
    const pauseRequest = randomUUID();
    const paused = await control("queue-pause", { requestId: pauseRequest });
    await control("queue-resume");
    const initial = await f.prepare();
    expect(await control("queue-pause", { requestId: pauseRequest })).toEqual(paused);
    f.send.mockImplementationOnce(async (_request, beforeNativeDispatch) => {
      beforeNativeDispatch();
      return { accepted: false, controlOutcome: "not-dispatched", reason: "session-busy" };
    });
    expect(await f.queue.schedule(initial)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(f.queue.list(f.sessionId)).toMatchObject({
      paused: true,
      reason: "scheduled-dispatch-refused",
      data: [{ status: "pending" }],
    });
    await control("queue-resume");
    const retry = await f.prepare();
    expect(retry.requestId).not.toBe(initial.requestId);
    expect(await f.queue.schedule(retry)).toMatchObject({ accepted: true });
    expect(f.requests).toHaveLength(1);
  });

  it.each(["lost response after dispatch", "unknown earlier receipt"])(
    "retains %s across restart and only deletes the item explicitly",
    async (failure) => {
      const f = await fixture();
      const control = f.control();
      await control("queue-add", { text: "Potentially sent" });
      await control("queue-add", { text: "Next" });
      const prepared = await f.prepare();
      f.send.mockImplementationOnce(async (_request, beforeNativeDispatch) => {
        if (failure === "unknown earlier receipt")
          return { accepted: false, controlOutcome: "unknown" };
        beforeNativeDispatch();
        throw new Error("synthetic lost response");
      });
      expect(await f.queue.schedule(prepared)).toMatchObject({
        accepted: false,
        controlOutcome: "unknown",
      });
      const restarted = f.open("new-boot");
      const resume = f.control(restarted);
      expect(restarted.list(f.sessionId)).toMatchObject({
        paused: true,
        data: [
          {
            status: "unknown",
            actions: { update: { available: false }, delete: { available: true } },
          },
          { status: "pending" },
        ],
      });
      await expect(resume("queue-resume")).rejects.toThrow("control-outcome-unconfirmed");
      const unknown = restarted.list(f.sessionId).data[0]!;
      expect(
        await resume("queue-update", { queuedSubmissionId: unknown.id, text: "Changed" }),
      ).toMatchObject({
        controlOutcome: "not-dispatched",
        reason: REMOTE_ERROR_CODES.queueItemUnavailableDetail,
      });
      await resume("queue-delete", { queuedSubmissionId: unknown.id });
      await resume("queue-resume");
      expect(await restarted.schedule(await f.prepare(restarted))).toMatchObject({
        accepted: true,
      });
      expect(f.requests).toEqual([expect.objectContaining({ text: "Next" })]);
    },
  );

  it("persists a full-queue refusal without changing queue state or revealing it to other devices", async () => {
    const f = await fixture();
    const control = f.control();
    for (let i = 0; i < 100; i++) await control("queue-add", { text: `Existing ${i}` });
    const before = f.queue.list(f.sessionId);
    const requestId = randomUUID();
    const fields = { text: "Overflow", requestId, publicInputHash: "a".repeat(64) };
    const refused = await control("queue-add", fields);
    expect(refused).toMatchObject({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: REMOTE_ERROR_CODES.queueLimit,
      requestId,
      sessionId: f.sessionId,
      runtimeBootId: "boot",
    });
    expect(f.queue.list(f.sessionId)).toEqual(before);
    expect(f.changed).toHaveBeenCalledTimes(100);
    expect(readControlReceipt(f.directory, { requestId, deviceId: "device-a" })).toMatchObject({
      found: true,
      status: "not-dispatched",
      operation: "queue-add",
      publicInputHash: fields.publicInputHash,
      ack: refused,
    });
    expect(readControlReceipt(f.directory, { requestId, deviceId: "device-b" })).toMatchObject({
      found: false,
    });
    await control("queue-delete", { queuedSubmissionId: before.data[0]!.id });
    expect(await control("queue-add", fields)).toEqual(refused);
    expect(f.queue.list(f.sessionId).data).toHaveLength(99);
    expect((await control("queue-add", { text: "Fresh request" })).accepted).toBe(true);
  });
});
