import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import type {
  Access,
  ConversationEvent,
  ConversationEventPage,
  Live,
  SessionStreamHandlers,
  WebClient,
} from "@agentkib/web-client";
import { dictionaries } from "@/features/conversation/i18n";
import {
  mergeNativeCoverage,
  type NativeCoverage,
} from "@/features/conversation/features/sessions/session-model";
import { useSessionLive } from "@/features/conversation/features/sessions/use-session-live";
import { SessionReader } from "@/features/conversation/features/sessions/session-reader";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));
vi.mock("@/features/conversation/features/sessions/session-operations", () => ({
  SessionOperations: () => null,
}));
vi.mock("@/features/conversation/features/sessions/artifact-browser", () => ({
  ArtifactBrowser: () => null,
}));

const access: Access = {
  protocolVersion: 2,
  status: "approved",
  csrfToken: "",
  bootId: "boot",
  experimentalEnabled: false,
};
const live: Live = {
  sessionId: "s",
  revision: 10,
  status: "idle",
  sendEnabled: true,
  approvals: [],
};
function message(id: string, turn = "turn", content = id): ConversationEvent {
  return {
    id,
    turn_id: turn,
    kind: "agent-message",
    content,
    attachment_count: 0,
    truncated: false,
  };
}
type Baseline = Extract<SessionStreamEvent<Live>, { type: "snapshot" }>;
function baseline(
  items: ConversationEvent[],
  payload: Partial<Baseline["payload"]> = {},
  epoch = "hydrated",
): Baseline {
  return {
    protocolVersion: 2,
    subscriptionId: "sub",
    sessionId: "s",
    runtimeBootId: "runtime",
    epoch,
    seq: 0,
    cursor: `${epoch}:0`,
    type: "snapshot",
    payload: {
      live,
      items,
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      authoritativeTurnIds: [...new Set(items.map((item) => item.turn_id!))],
      ...payload,
    },
  };
}
function applyBaseline(history: ConversationEvent[], event: Baseline) {
  const store = createConversationStore<Live>("s");
  store.dispatch(baseline(history, {}, "before"));
  const state = store.dispatch(event);
  return {
    store,
    items: mergeNativeCoverage(history, {
      items: state.items,
      authoritativeTurnIds: event.payload.authoritativeTurnIds ?? [],
      removedTurnIds: event.payload.removedTurnIds ?? [],
      removedItemIds: event.payload.removedItemIds,
      preserveItemsOutsideCoverage: event.payload.preserveItemsOutsideCoverage,
    }),
  };
}
function setup(initial: ConversationEvent[]) {
  let handlers: SessionStreamHandlers;
  const client = {
    connection: { type: "same-origin" },
    stream: vi.fn((_id: string, listener: SessionStreamHandlers) => {
      handlers = listener;
      return vi.fn();
    }),
    events: vi.fn(),
    live: vi.fn().mockResolvedValue(live),
  } as unknown as WebClient;
  const nativeCoverage = {
    current: { items: [], authoritativeTurnIds: [], removedTurnIds: [] } as NativeCoverage,
  };
  const fixed = {
    streamReady: { current: false },
    controlReconciliationPending: { current: false },
    nativeCoverage,
    streamEpoch: 0,
    liveDelivery: { current: 0 },
    access,
    selected: "s",
    selection: { current: "s" },
    generation: { current: 0 },
    client,
    fail: vi.fn(),
    readBusy: vi.fn(),
    refreshWake: { current: 0 },
    clear: vi.fn(),
    accessRef: { current: access },
    setError: vi.fn(),
    hasDurablePending: () => false,
    readinessEpoch: { current: 0 },
    refreshRequired: { current: false },
    setControlReady: vi.fn(),
    setAccess: vi.fn(),
  };
  const view = renderHook(() => {
    const [currentLive, setLive] = useState<Live>();
    const [page, setPage] = useState<ConversationEventPage | undefined>({
      events: initial,
      warnings: ["retained-warning"],
      next_cursor: "older-page",
    });
    const [, setOnline] = useState(false);
    const [liveContentVersion, setLiveContentVersion] = useState(0);
    useSessionLive({
      ...fixed,
      setLive,
      setPage,
      setOnline,
      setLiveContentVersion,
    });
    return { page, live: currentLive, liveContentVersion };
  });
  const emit = (event: SessionStreamEvent<Live>) =>
    act(() => handlers.event("session-event", JSON.stringify(event)));
  emit(baseline([initial.at(-1)!], {}, "before"));
  return { ...view, emit, client, nativeCoverage };
}
const ids = (items: ConversationEvent[]) => items.map((item) => item.id);
afterEach(cleanup);

describe("Codex hydration baselines", () => {
  it("replaces reducer order and restores a native baseline before an already loaded latest item", () => {
    const event = baseline([message("older"), message("newer")]);
    const result = applyBaseline([message("newer")], event);
    expect(ids(result.store.getSnapshot().items)).toEqual(["older", "newer"]);
    expect(ids(result.items)).toEqual(["older", "newer"]);
    expect(result.store.getSnapshot().epoch).toBe("hydrated");
  });

  it("preserves older pages, their cursor and warnings when the live hook hydrates", () => {
    const view = setup([message("paged", "older-turn"), message("newer")]);
    view.emit(baseline([message("older"), message("newer")]));
    expect(ids(view.result.current.page!.events)).toEqual(["paged", "older", "newer"]);
    expect(view.result.current.page).toMatchObject({
      next_cursor: "older-page",
      warnings: ["retained-warning"],
    });
    expect(view.client.events).not.toHaveBeenCalled();
  });

  it("uses snapshot item order even when a truncated turn has no complete coverage", () => {
    const view = setup([message("newer")]);
    view.emit(
      baseline([{ ...message("older"), truncated: true }, message("newer")], {
        authoritativeTurnIds: [],
      }),
    );
    expect(ids(view.result.current.page!.events)).toEqual(["older", "newer"]);
  });

  it("keeps a fuller loaded item when the hydrated native preview is truncated", () => {
    const view = setup([message("newer", "turn", "complete history text")]);
    view.emit(
      baseline([{ ...message("newer", "turn", "complete"), truncated: true }], {
        authoritativeTurnIds: [],
      }),
    );
    expect(view.result.current.page!.events[0]).toMatchObject({
      content: "complete history text",
      truncated: false,
    });
  });

  it("does not duplicate items when the same baseline is delivered twice", () => {
    const view = setup([message("paged", "older-turn"), message("newer")]);
    const event = baseline([message("older"), message("newer")]);
    view.emit(event);
    view.emit(event);
    expect(ids(view.result.current.page!.events)).toEqual(["paged", "older", "newer"]);
  });

  it("honors explicit item and turn deletions without dropping unrelated older history", () => {
    const view = setup([
      message("retained", "oldest-turn"),
      message("removed-item", "older-turn"),
      message("removed-turn-item", "removed-turn"),
      message("newer"),
    ]);
    view.emit(
      baseline([message("older"), message("newer")], {
        removedItemIds: ["removed-item"],
        removedTurnIds: ["removed-turn"],
      }),
    );
    expect(ids(view.result.current.page!.events)).toEqual(["retained", "older", "newer"]);
  });

  it("retires ephemeral copies covered by a stable native baseline", () => {
    const view = setup([{ ...message("live:old"), ephemeral: true }]);
    view.emit(baseline([message("older"), message("newer")]));
    expect(ids(view.result.current.page!.events)).toEqual(["older", "newer"]);
  });

  it("appends genuinely new native items after the hydrated history", () => {
    const view = setup([message("newer")]);
    const event = baseline([message("older"), message("newer")]);
    view.emit(event);
    view.emit({
      ...event,
      seq: 1,
      cursor: "hydrated:1",
      type: "item-upsert",
      payload: message("new-live", "next-turn"),
    });
    expect(ids(view.result.current.page!.events)).toEqual(["older", "newer", "new-live"]);
  });

  it("does not announce replayed history text as a new reply, but still announces later live output", () => {
    const view = setup([message("newer", "turn", "partial")]);
    const scroll = { current: null as HTMLElement | null };
    vi.mocked(useSession).mockImplementation(
      () =>
        ({
          selected: "s",
          access,
          current: { id: "s", agent: "codex" },
          t: dictionaries["zh-CN"],
          locale: "zh-CN",
          page: view.result.current.page,
          live: view.result.current.live,
          liveContentVersion: view.result.current.liveContentVersion,
          scroll,
          earlier: vi.fn(),
          setModal: vi.fn(),
        }) as unknown as ReturnType<typeof useSession>,
    );
    const reader = render(createElement(SessionReader));
    const viewport = scroll.current!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1200, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    fireEvent.wheel(viewport, { deltaY: -800 });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    const event = baseline([message("older"), message("newer", "turn", "partial completed")]);
    view.emit(event);
    reader.rerender(createElement(SessionReader));
    expect(viewport.scrollTop).toBe(100);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["zh-CN"].newMessages }),
    ).not.toBeInTheDocument();
    view.emit({
      ...event,
      seq: 1,
      cursor: "hydrated:1",
      type: "item-upsert",
      payload: message("new-live", "next-turn"),
    });
    reader.rerender(createElement(SessionReader));
    expect(screen.getByRole("button", { name: webLayoutCopy["zh-CN"].newMessages })).toBeVisible();
  });
});
