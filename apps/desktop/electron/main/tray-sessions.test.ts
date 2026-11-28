import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationCatalogPatch } from "@agentkib/web-client";
import type { HomeSession } from "@agentkib/session-catalog";
import {
  CONVERSATION_PROTOCOL_VERSION,
  type SessionStreamEvent,
} from "../generated/runtime-protocol";
import { TraySessionWatcher, traySessionSource, type TraySessionSource } from "./tray-sessions";

function session(id: string, status?: string): HomeSession {
  return {
    id,
    agent: "codex",
    title: id,
    availability: "readable",
    workspace_id: "w",
    updated_at: "2026-11-11T10:00:00.000Z",
    ...(status ? { continuation: { status } } : {}),
  } as HomeSession;
}

function source(initial: readonly HomeSession[] | undefined) {
  let sessions = initial;
  const stops: ReturnType<typeof vi.fn>[] = [];
  const changes: ((patch?: ConversationCatalogPatch) => void)[] = [];
  const value: TraySessionSource & {
    set(next: readonly HomeSession[] | undefined): void;
    stops: typeof stops;
    changes: typeof changes;
  } = {
    readSessions: vi.fn(async () => (sessions ? { sessions } : undefined)),
    follow: vi.fn(async (onChange: (patch?: ConversationCatalogPatch) => void) => {
      changes.push(onChange);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
    set: (next) => {
      sessions = next;
    },
    stops,
    changes,
  };
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("tray session watcher", () => {
  it("counts what waits for the person and what runs, as the home groups them", async () => {
    const statuses: unknown[] = [];
    const watcher = new TraySessionWatcher(
      source([
        session("a", "awaiting-approval"),
        session("b", "waiting-input"),
        session("c", "running"),
        session("d"),
      ]),
      (status) => statuses.push(status),
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([{ needsYou: 2, running: 1 }]);
    expect(watcher.status).toEqual({ needsYou: 2, running: 1 });
    watcher.stop();
  });

  it("hands every snapshot it reads to the phone notifications", async () => {
    const value = source([session("a", "running")]);
    const snapshots: unknown[] = [];
    const watcher = new TraySessionWatcher(value, () => undefined, {
      onSessions: (sessions) => snapshots.push(sessions?.map((entry) => entry.id)),
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    value.set(undefined);
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual([["a"], undefined]);
    watcher.stop();
  });

  it("keeps verified session activity while orchestration is unavailable", async () => {
    const sessions = [session("running", "running"), session("waiting", "waiting-input")];
    let orchestrationUnavailable = false;
    let listener: ((event: SessionStreamEvent) => void) | undefined;
    const localRequest = vi.fn(async () => ({
      status: 200,
      body: { sessions, ...(orchestrationUnavailable && { orchestrationUnavailable: true }) },
    }));
    const localSubscribe = vi.fn(
      async (
        _sessionId: string,
        _cursor: string | undefined,
        onEvent: (event: SessionStreamEvent) => void,
      ) => {
        listener = onEvent;
        return {
          protocolVersion: CONVERSATION_PROTOCOL_VERSION,
          subscriptionId: "catalog",
          cursor: "1",
          events: [],
        };
      },
    );
    const change = (patch: unknown) =>
      listener?.({
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        type: "invalidate",
        subscriptionId: "catalog",
        sessionId: "",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 2,
        cursor: "2",
        payload: { domains: ["catalog"], catalogPatch: patch },
      });
    const unsubscribe = vi.fn(async () => undefined);
    const snapshots = vi.fn();
    const watcher = new TraySessionWatcher(
      traySessionSource({ localRequest, localSubscribe }, { unsubscribe }, async () => true),
      () => undefined,
      { onSessions: snapshots },
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveBeenLastCalledWith(sessions);

    orchestrationUnavailable = true;
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.status).toEqual({ needsYou: 1, running: 1 });
    expect(snapshots).toHaveBeenLastCalledWith(undefined);
    expect(localSubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    change({
      updates: [{ sessionId: "waiting", workspaceId: "w", continuation: { status: "idle" } }],
    });
    expect(watcher.status).toEqual({ needsYou: 0, running: 1 });
    expect(snapshots).toHaveBeenLastCalledWith(undefined);

    let finishRecovery!: (reply: Awaited<ReturnType<typeof localRequest>>) => void;
    localRequest.mockReturnValueOnce(new Promise((resolve) => (finishRecovery = resolve)));
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    // The stream can still deliver a row projected during the outage while the full read recovers.
    change({
      updates: [
        {
          sessionId: "running",
          workspaceId: "w",
          auxiliary: false,
          row: { ...sessions[0], archived: false, sidechain: false },
        },
      ],
    });
    expect(snapshots).toHaveBeenLastCalledWith(undefined);
    const recovered: HomeSession[] = [
      { ...sessions[0]!, orchestration: { role: "worker", leadId: "lead" } },
      sessions[1]!,
    ];
    finishRecovery({ status: 200, body: { sessions: recovered } });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveBeenLastCalledWith(recovered);
    expect(localSubscribe).toHaveBeenCalledOnce();

    // Verify any counts that the skipped whole row might actually have changed.
    const latest = [recovered[0]!];
    localRequest.mockResolvedValueOnce({ status: 200, body: { sessions: latest } });
    await vi.advanceTimersByTimeAsync(750);
    expect(localRequest).toHaveBeenCalledTimes(4);
    expect(snapshots).toHaveBeenLastCalledWith(latest);
    watcher.stop();
  });

  it("keeps the last notification snapshot while a catalog invalidation refreshes", async () => {
    const running = session("running", "running");
    const waiting = session("waiting", "waiting-input");
    const value = source([running, waiting]);
    const snapshots = vi.fn();
    const watcher = new TraySessionWatcher(value, () => undefined, { onSessions: snapshots });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveBeenCalledExactlyOnceWith([running, waiting]);

    let finishRead!: (snapshot: Awaited<ReturnType<typeof value.readSessions>>) => void;
    vi.mocked(value.readSessions).mockReturnValueOnce(
      new Promise((resolve) => (finishRead = resolve)),
    );
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    value.changes[0]();
    value.changes[0]({
      updates: [{ sessionId: waiting.id, workspaceId: "w", continuation: { status: "idle" } }],
    });
    expect(watcher.status).toEqual({ needsYou: 0, running: 1 });
    expect(snapshots).toHaveBeenCalledTimes(1);

    finishRead({ sessions: [running, waiting] });
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.status).toEqual({ needsYou: 0, running: 1 });
    expect(snapshots).toHaveBeenCalledTimes(1);

    value.set([running, session(waiting.id, "idle")]);
    await vi.advanceTimersByTimeAsync(750);
    expect(snapshots).toHaveBeenLastCalledWith([running, session(waiting.id, "idle")]);
    expect(snapshots).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("reads once a minute while nothing runs, without following the catalog", async () => {
    const value = source([session("a", "awaiting-approval")]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.readSessions).toHaveBeenCalledTimes(1);
    expect(value.follow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(value.readSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.readSessions).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("follows the catalog only while a session runs", async () => {
    const value = source([session("a", "running")]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.follow).toHaveBeenCalledTimes(1);
    // A change in the followed catalog reads it again after the settle delay.
    value.set([session("a")]);
    value.changes[0]();
    await vi.advanceTimersByTimeAsync(750);
    expect(value.readSessions).toHaveBeenCalledTimes(2);
    expect(value.stops[0]).toHaveBeenCalledTimes(1);
    expect(watcher.status).toEqual({ needsYou: 0, running: 0 });
    watcher.stop();
  });

  it("uses pushed running and waiting status without reading the full catalog", async () => {
    const value = source([session("a", "running")]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    value.changes[0]({
      updates: [{ sessionId: "a", workspaceId: "w", continuation: { status: "waiting-input" } }],
    });
    expect(watcher.status).toEqual({ needsYou: 1, running: 0 });
    expect(value.readSessions).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(value.stops[0]).toHaveBeenCalledOnce();
    watcher.stop();
  });

  it("reads changes that arrive together once", async () => {
    const value = source([]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.refresh();
    watcher.refresh();
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(750);
    expect(value.readSessions).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("shows nothing while the session index is off or the catalog cannot be read", async () => {
    const value = source([session("a", "running")]);
    const statuses: unknown[] = [];
    const watcher = new TraySessionWatcher(value, (status) => statuses.push(status));
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    value.set(undefined);
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ needsYou: 0, running: 0 });
    expect(value.stops[0]).toHaveBeenCalledTimes(1);
    vi.mocked(value.readSessions).mockRejectedValueOnce(new Error("runtime_unavailable"));
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.status).toEqual({ needsYou: 0, running: 0 });
    watcher.stop();
  });

  it("follows again after the runtime dropped its followers", async () => {
    const value = source([session("a", "running")]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.restart();
    await vi.advanceTimersByTimeAsync(750);
    expect(value.follow).toHaveBeenCalledTimes(2);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.stops[1]).toHaveBeenCalledTimes(1);
  });

  it("does nothing after it stops", async () => {
    const value = source([session("a", "running")]);
    const watcher = new TraySessionWatcher(value, () => undefined);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();
    watcher.refresh(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(value.readSessions).toHaveBeenCalledTimes(1);
    expect(value.stops[0]).toHaveBeenCalledTimes(1);
  });
});
