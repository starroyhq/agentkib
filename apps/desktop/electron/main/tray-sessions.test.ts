import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSession } from "@agentkib/session-catalog";
import { TraySessionWatcher, type TraySessionSource } from "./tray-sessions";

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
  const changes: (() => void)[] = [];
  const value: TraySessionSource & {
    set(next: readonly HomeSession[] | undefined): void;
    stops: typeof stops;
    changes: typeof changes;
  } = {
    readSessions: vi.fn(async () => sessions),
    follow: vi.fn(async (onChange: () => void) => {
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
