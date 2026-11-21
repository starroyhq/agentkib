import * as nativeTimers from "node:timers";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Live } from "@agentkib/web-client";
import type { SessionStreamEvent } from "../../../../../packages/runtime-protocol/src";
import { ManagedCodexState } from "../../../../../packages/backend/src/agents/codex/managed-codex-state";
import { SessionStreamHub } from "../../../../../packages/backend/src/session-stream";
import { useObservedContextUsage } from "@/features/conversation/features/sessions/context-usage";

const nativeId = "01234567-89ab-cdef-0123-456789abcdef";
const raw = (used: number) => ({
  last: { totalTokens: used },
  total: { totalTokens: 9000 },
  modelContextWindow: 100,
});
const notify = (state: ManagedCodexState, method: string, params: Record<string, unknown>) =>
  state.apply({ method, params: { threadId: nativeId, ...params } });
const scopeOf = (event: SessionStreamEvent) =>
  `managed\0${JSON.stringify([event.runtimeBootId, event.epoch])}`;
const liveOf = (event: SessionStreamEvent): Live =>
  (event.type === "snapshot" ? event.payload.live : event.payload) as unknown as Live;
const propsOf = (event: SessionStreamEvent) => ({
  selected: "managed",
  scope: scopeOf(event),
  online: true,
  authorized: true,
  live: liveOf(event),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("updates both subscribed endpoints after a runner rebuild within a retained transport epoch", async () => {
  // The actual backend hub needs Node timers while the UI hooks run in jsdom.
  vi.stubGlobal("setInterval", nativeTimers.setInterval);
  vi.stubGlobal("clearInterval", nativeTimers.clearInterval);
  const record = {
    id: "managed",
    workspace_id: "workspace",
    workspace: "/fixture",
    native_id: nativeId,
  };
  const original = new ManagedCodexState(record);
  notify(original, "turn/started", { turn: { id: "turn-a", status: "inProgress" } });
  notify(original, "thread/tokenUsage/updated", { turnId: "turn-a", tokenUsage: raw(60) });
  notify(original, "thread/tokenUsage/updated", { turnId: "turn-a", tokenUsage: raw(80) });
  notify(original, "turn/completed", { turn: { id: "turn-a", status: "completed" } });
  let snapshot = original.snapshot("same-backend-boot", true);
  const events: SessionStreamEvent[] = [];
  const hub = new SessionStreamHub(
    "same-backend-boot",
    async () => ({ live: snapshot, items: [], completeItems: false }),
    (event) => events.push(event),
  );
  const latest = (subscriptionId: string) => {
    const event = events.filter((candidate) => candidate.subscriptionId === subscriptionId).at(-1);
    expect(event).toBeDefined();
    return event!;
  };
  try {
    const desktop = await hub.subscribe("managed");
    const remote = await hub.subscribe("managed");
    const baseline = desktop.events[0];
    const initialGeneration = liveOf(baseline).usage!.reportGeneration!;
    expect(liveOf(baseline).usage).toMatchObject({ reportId: 2, state: "ready", percent: 80 });
    const desktopView = renderHook(useObservedContextUsage, {
      initialProps: propsOf(baseline),
    });
    const remoteView = renderHook(useObservedContextUsage, {
      initialProps: propsOf(remote.events[0]),
    });
    expect(desktopView.result.current.percent).toBe(80);
    expect(remoteView.result.current.percent).toBe(80);

    original.fail("codex-disconnected");
    snapshot = original.snapshot("same-backend-boot", false);
    hub.publish("managed", "state", snapshot, snapshot);
    desktopView.rerender(propsOf(latest(desktop.subscriptionId)));
    remoteView.rerender(propsOf(latest(remote.subscriptionId)));
    expect(desktopView.result.current.state).toBe("stale");
    expect(remoteView.result.current.state).toBe("stale");

    const rebuilt = new ManagedCodexState(
      { ...record, token_usage: raw(80), snapshot },
      original.revision,
    );
    rebuilt.hydrate({ id: nativeId, turns: [{ id: "turn-a", status: "completed", items: [] }] });
    snapshot = rebuilt.snapshot("same-backend-boot", true);
    hub.publish("managed", "state", snapshot, snapshot);
    remoteView.rerender(propsOf(latest(remote.subscriptionId)));
    expect(remoteView.result.current.usage).toMatchObject({ state: "stale", reportId: 0 });
    expect(remoteView.result.current.usage!.reportGeneration).toBeGreaterThan(initialGeneration);

    // Desktop refresh reopens its subscription while Remote keeps the same source alive.
    hub.unsubscribe(desktop.subscriptionId);
    const refreshedDesktop = await hub.subscribe("managed");
    const recovered = refreshedDesktop.events[0];
    expect(recovered.epoch).toBe(baseline.epoch);
    expect(scopeOf(recovered)).toBe(scopeOf(baseline));
    desktopView.rerender(propsOf(recovered));
    expect(desktopView.result.current.usage).toMatchObject({ state: "stale", reportId: 0 });
    expect(desktopView.result.current.usage!.reportGeneration).toBeGreaterThan(initialGeneration);

    notify(rebuilt, "turn/started", { turn: { id: "turn-b", status: "inProgress" } });
    notify(rebuilt, "thread/tokenUsage/updated", { turnId: "turn-b", tokenUsage: raw(5) });
    snapshot = rebuilt.snapshot("same-backend-boot", true);
    hub.publish("managed", "state", snapshot, snapshot);
    const delivered = latest(refreshedDesktop.subscriptionId);
    expect(delivered.epoch).toBe(baseline.epoch);
    desktopView.rerender(propsOf(delivered));
    remoteView.rerender(propsOf(latest(remote.subscriptionId)));
    for (const view of [desktopView, remoteView]) {
      expect(view.result.current.percent).toBe(5);
      expect(view.result.current.state).toBe("ready");
      expect(view.result.current.usage).toMatchObject({ reportId: 1, usedTokens: 5 });
    }
  } finally {
    hub.close();
  }
});
