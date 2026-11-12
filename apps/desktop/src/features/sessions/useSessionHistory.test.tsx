// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureHistoryScrollAnchor } from "@agentkib/session-ui";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type {
  ConversationEvent,
  ConversationEventPage,
  ConversationSessionSummary,
} from "@/core/types";
import { useSessionHistory } from "./useSessionHistory";

vi.mock("@/core/api", () => ({ api: { sessionEvents: vi.fn() } }));

const first: ConversationSessionSummary = {
  id: "first",
  workspace_id: "workspace",
  agent: "codex",
  archived: false,
  sidechain: false,
  availability: "readable",
};
const second = { ...first, id: "second" };

function event(id: string): ConversationEvent {
  return { id, kind: "user-message", content: id, attachment_count: 0, truncated: false };
}

function page(id: string, next_cursor?: string): ConversationEventPage {
  return { events: [event(id)], warnings: [], next_cursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it("anchors a process disclosure when the preceding history row becomes hidden", () => {
  const viewport = document.createElement("div");
  const detail = document.createElement("div");
  const disclosure = document.createElement("button");
  detail.dataset.eventId = "same-id";
  disclosure.dataset.historyAnchor = "same-id";
  viewport.append(detail, disclosure);
  viewport.scrollTop = 100;
  vi.spyOn(detail, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 100, 10));
  const disclosureRect = vi
    .spyOn(disclosure, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 20, 100, 10));
  const restore = captureHistoryScrollAnchor(viewport);
  detail.hidden = true;
  disclosureRect.mockReturnValue(new DOMRect(0, 80, 100, 10));
  restore();
  expect(viewport.scrollTop).toBe(160);
});

describe("useSessionHistory", () => {
  it("translates a stored failure without requesting history again", async () => {
    vi.mocked(api.sessionEvents).mockRejectedValue({ key: "errors.generic" });
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(result.current.error).toBe(tr("errors.generic"));
      }
      expect(api.sessionEvents).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.mocked(api.sessionEvents).mockReset().mockResolvedValue(page("initial"));
  });
  afterEach(cleanup);

  it("ignores an earlier selection resolving after the new selection", async () => {
    const earlier = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents)
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce(page("second content"));
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true), {
      initialProps: { session: first },
    });

    rerender({ session: second });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("second content"));
    await act(async () => earlier.resolve(page("first content")));
    expect(result.current.events.map(({ id }) => id)).toEqual(["second content"]);
    expect(result.current.loading).toBe(false);
  });

  it("hides existing messages immediately when switching selections", async () => {
    const next = deferred<ConversationEventPage>();
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true), {
      initialProps: { session: first },
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    vi.mocked(api.sessionEvents).mockReturnValueOnce(next.promise);

    rerender({ session: second });
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => next.resolve(page("second content")));
  });

  it("rereads the same session after a refresh revision and ignores its old page", async () => {
    const oldPage = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce(page("cached history", "cursor"))
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page("refreshed history"));
    const { result, rerender } = renderHook(
      ({ revision }) => useSessionHistory(first, true, revision),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.nextCursor).toBe("cursor"));
    act(() => void result.current.loadEarlier());
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("refreshed history"));
    await act(async () => oldPage.resolve(page("obsolete page")));
    expect(result.current.events.map(({ id }) => id)).toEqual(["refreshed history"]);
    expect(api.sessionEvents).toHaveBeenLastCalledWith(first.id);
  });

  it("does not backfill a previous session's pending earlier page", async () => {
    const earlierPage = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce(page("first recent", "cursor"))
      .mockReturnValueOnce(earlierPage.promise)
      .mockResolvedValueOnce(page("second recent"));
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true), {
      initialProps: { session: first },
    });
    await waitFor(() => expect(result.current.nextCursor).toBe("cursor"));
    act(() => void result.current.loadEarlier());
    rerender({ session: second });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("second recent"));
    await act(async () => earlierPage.resolve(page("first earlier", "older")));

    expect(result.current.events.map(({ id }) => id)).toEqual(["second recent"]);
    expect(result.current.nextCursor).toBeUndefined();
    expect(result.current.loadingEarlier).toBe(false);
  });

  it("synchronously locks paging and deduplicates overlapping events and warnings", async () => {
    const earlierPage = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce({ ...page("recent", "cursor"), warnings: ["partial"] })
      .mockReturnValueOnce(earlierPage.promise);
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.nextCursor).toBe("cursor"));

    act(() => {
      void result.current.loadEarlier();
      void result.current.loadEarlier();
    });
    expect(api.sessionEvents).toHaveBeenCalledTimes(2);
    expect(api.sessionEvents).toHaveBeenLastCalledWith("first", "cursor");
    expect(result.current.loadingEarlier).toBe(true);
    await act(async () =>
      earlierPage.resolve({ events: [event("earlier"), event("recent")], warnings: ["partial"] }),
    );
    expect(result.current.events.map(({ id }) => id)).toEqual(["earlier", "recent"]);
    expect(result.current.warnings).toEqual(["partial"]);
    expect(result.current.loadingEarlier).toBe(false);
    expect(result.current.nextCursor).toBeUndefined();
  });

  it("continues across empty bounded windows without dropping the next cursor", async () => {
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce({
        events: [],
        warnings: ["TRANSCRIPT_SCAN_BUDGET"],
        next_cursor: "earlier-1",
      })
      .mockResolvedValueOnce({
        events: [],
        warnings: ["TRANSCRIPT_SCAN_BUDGET"],
        next_cursor: "earlier-2",
      })
      .mockResolvedValueOnce(page("older message"));
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.nextCursor).toBe("earlier-1"));
    await act(() => result.current.loadEarlier());
    expect(result.current.events.map((item) => item.id)).toEqual(["older message"]);
    expect(result.current.warnings).not.toContain("TRANSCRIPT_SCAN_BUDGET");
    expect(result.current.nextCursor).toBeUndefined();
    expect(api.sessionEvents).toHaveBeenLastCalledWith(first.id, "earlier-2");
  });

  it("keeps the first loaded window and its continuation when the next window fails", async () => {
    const tool = { ...event("tool"), kind: "tool-summary" as const, turn_id: "current" };
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce(page("recent", "page-1"))
      .mockResolvedValueOnce({ events: [tool], warnings: [], next_cursor: "page-2" })
      .mockRejectedValueOnce(new Error("Page failed"))
      .mockResolvedValueOnce(page("earlier"));
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.nextCursor).toBe("page-1"));
    await act(() => result.current.loadEarlier());
    expect(result.current.events.map(({ id }) => id)).toEqual(["tool", "recent"]);
    expect(result.current.nextCursor).toBe("page-2");
    expect(result.current.error).toContain("Page failed");
    await act(() => result.current.loadEarlier());
    expect(result.current.events.map(({ id }) => id)).toEqual(["earlier", "tool", "recent"]);
  });

  it("does not read disabled or metadata-only sessions", async () => {
    const { result, rerender } = renderHook(
      ({ session, enabled }) => useSessionHistory(session, enabled),
      { initialProps: { session: first, enabled: false } },
    );
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ session: { ...first, availability: "metadata-only" }, enabled: true });
    await act(async () => result.current.retry());
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
  });

  it("does not reuse a completed cursor from a stale paging callback", async () => {
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce(page("recent", "cursor"))
      .mockResolvedValueOnce(page("earlier"));
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.nextCursor).toBe("cursor"));
    const loadEarlier = result.current.loadEarlier;
    await act(async () => {
      await loadEarlier();
      await loadEarlier();
    });
    expect(api.sessionEvents).toHaveBeenCalledTimes(2);
    expect(result.current.events.map(({ id }) => id)).toEqual(["earlier", "recent"]);
  });

  it("invalidates pending reads on disable and reads afresh after re-enabling", async () => {
    const read = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents).mockReturnValueOnce(read.promise);
    const { result, rerender } = renderHook(({ enabled }) => useSessionHistory(first, enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    await act(async () => read.resolve(page("private content")));
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.events[0]?.id).toBe("initial"));
    expect(api.sessionEvents).toHaveBeenCalledTimes(2);
  });

  it("rejects stale callbacks and results after unmount", async () => {
    const read = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents).mockReturnValueOnce(read.promise);
    const { result, unmount } = renderHook(() => useSessionHistory(first, true));
    const retry = result.current.retry;
    unmount();
    await act(async () => {
      read.resolve(page("late"));
      await retry();
    });
    expect(api.sessionEvents).toHaveBeenCalledOnce();
  });

  it("allows retry after a failed read without duplicate initial requests", async () => {
    const retryPage = deferred<ConversationEventPage>();
    vi.mocked(api.sessionEvents)
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockReturnValueOnce(retryPage.promise);
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.error).toContain("Read failed"));
    expect(result.current.loading).toBe(false);

    act(() => {
      void result.current.retry();
      void result.current.retry();
    });
    expect(api.sessionEvents).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe("");
    await act(async () => retryPage.resolve(page("retried")));
    expect(result.current.events[0]?.id).toBe("retried");
  });

  it("preserves loaded history and cursor when paging fails so paging can retry", async () => {
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce(page("recent", "cursor"))
      .mockRejectedValueOnce(new Error("Page failed"))
      .mockResolvedValueOnce(page("earlier"));
    const { result } = renderHook(() => useSessionHistory(first, true));
    await waitFor(() => expect(result.current.nextCursor).toBe("cursor"));
    await act(async () => result.current.loadEarlier());
    expect(result.current.events[0]?.id).toBe("recent");
    expect(result.current.error).toContain("Page failed");
    expect(result.current.nextCursor).toBe("cursor");
    await act(async () => result.current.loadEarlier());
    expect(result.current.error).toBe("");
    expect(result.current.events.map(({ id }) => id)).toEqual(["earlier", "recent"]);
  });
});
