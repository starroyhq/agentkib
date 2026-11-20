import { describe, expect, it } from "vitest";
import {
  readStateCopy,
  sessionContinuationCopy,
  sessionContinuationListState,
} from "@agentkib/session-ui";
import type { Live } from "@agentkib/web-client";
import type { ConversationSessionSummary } from "@/core/types";
import { sessionWithObservedActivity } from "./session-labels";

describe("runtime-only session list presentation", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"])(
    "does not invent a runtime owner or expose a dot for view-only sources in %s",
    (locale) => {
      const session = { agent: "claude-code", availability: "readable" };
      expect(sessionContinuationListState(session, locale)).toBeUndefined();
      expect(
        sessionContinuationListState(
          { ...session, continuation: { status: "idle", executionLocation: null } },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          {
            ...session,
            remote: { host_id: "another" },
            continuation: { status: "running", executionLocation: "agentkib" },
          },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          {
            ...session,
            continuation: { status: "outcome-unknown", executionLocation: "agentkib" },
          },
          locale,
        ),
      ).toBeUndefined();
      expect(
        sessionContinuationListState(
          { ...session, continuation: { status: "unsupported", reason: "claude-cli-unavailable" } },
          locale,
        ),
      ).toEqual({ label: sessionContinuationCopy(locale).viewOnly });
      expect(
        sessionContinuationListState({ ...session, availability: "metadata-only" }, locale),
      ).toEqual({ label: sessionContinuationCopy(locale).viewOnly });
      // Use elsewhere is confirmed after opening a session; a short-lived observation would flicker.
      for (const continuation of [
        { status: "idle", executionLocation: "external", ownershipReason: "claude-owner-busy" },
        {
          status: "idle",
          executionLocation: null,
          ownershipReason: "owner-opened-elsewhere",
          reason: "owner-opened-elsewhere",
        },
      ])
        expect(sessionContinuationListState({ ...session, continuation }, locale)).toBeUndefined();
    },
  );

  it("marks a DSH session only while the running DSH works on it or waits for an answer", () => {
    const session = { agent: "deepseek-harness", availability: "readable" };
    const copy = sessionContinuationCopy("en-US");
    const state = (continuation: { status: string; reason?: string }) =>
      sessionContinuationListState(
        { ...session, continuation: { executionLocation: "external", ...continuation } },
        "en-US",
      );
    expect(state({ status: "running" })).toEqual({
      label: copy.runningIn("DeepSeek Harness"),
      active: true,
      dot: true,
    });
    expect(state({ status: "running", reason: "dsh-native-turn-observed" })).toEqual({
      label: `${copy.runningIn("DeepSeek Harness")} · ${copy.dshTurnObservation}`,
      active: true,
      dot: true,
    });
    expect(state({ status: "awaiting-approval", reason: "dsh-approval-pending" })).toEqual({
      label: copy.waiting,
      waiting: true,
      dot: true,
    });
    expect(state({ status: "idle" })).toBeUndefined();
    expect(state({ status: "unsupported", reason: "dsh-native-status-unknown" })).toEqual({
      label: copy.dshStatusUnknown,
    });
    expect(
      sessionContinuationListState(
        {
          ...session,
          continuation: { status: "unsupported", reason: "dsh-native-status-unknown" },
          externalTurn: { status: "running" },
        },
        "zh-CN",
      ),
    ).toEqual({ label: "实时状态未知" });
    // Without a running DSH the session can only be read.
    expect(
      sessionContinuationListState({ ...session, availability: "metadata-only" }, "en-US"),
    ).toEqual({ label: copy.viewOnly });
  });

  it("marks a managed Claude session whose background tasks run after their turn", () => {
    const session = { agent: "claude-code", availability: "readable" };
    const state = (continuation: Record<string, unknown>, locale = "en-US") =>
      sessionContinuationListState(
        { ...session, continuation: { status: "idle", ...continuation } },
        locale,
      );
    expect(state({ executionLocation: "agentkib", backgroundTasks: 1 })).toEqual({
      label: "1 background task running",
      dot: true,
    });
    expect(state({ executionLocation: "agentkib", backgroundTasks: 2 }, "zh-CN")).toEqual({
      label: "2 个后台任务运行中",
      dot: true,
    });
    // A running turn says more; no process, no tasks.
    expect(state({ status: "running", executionLocation: "agentkib", backgroundTasks: 1 })).toEqual(
      { label: "Running in AgentKib", active: true, dot: true },
    );
    expect(state({ executionLocation: null, backgroundTasks: 1 })).toBeUndefined();
    expect(state({ executionLocation: "agentkib" })).toBeUndefined();
  });

  it("uses the selected live turn instead of stale directory activity and preserves unread", () => {
    const session: ConversationSessionSummary = {
      agent: "claude-code",
      id: "thread",
      workspace_id: "workspace",
      availability: "readable",
      archived: false,
      sidechain: false,
      continuation: { status: "running", executionLocation: "terminal" },
      externalTurn: { status: "running", startedAt: null },
      readState: {
        source: "agentkib",
        status: "unread",
        freshness: "current",
        version: "version",
        firstUnread: { type: "threadStart" },
        latestResult: null,
      },
    };
    const idle: Live = {
      sessionId: session.id,
      status: "idle",
      revision: 10,
      sendEnabled: false,
      approvals: [],
    };
    const state = (live: Live) =>
      sessionContinuationListState(sessionWithObservedActivity(session, live), "en-US");
    const unread = readStateCopy("en-US").manualUnread;
    const copy = sessionContinuationCopy("en-US");
    expect(state(idle)).toEqual({ label: unread, unread: true, dot: true });
    expect(state({ ...idle, status: "awaiting-input" })).toMatchObject({
      label: `${copy.waiting} · ${unread}`,
      waiting: true,
      unread: true,
    });
    expect(state({ ...idle, ownershipReason: "claude-owner-busy" })).toMatchObject({
      label: `${copy.runningIn("Claude Code")} · ${unread}`,
      active: true,
      unread: true,
    });
    expect(sessionWithObservedActivity(session, { ...idle, sessionId: "other" })).toBe(session);
  });

  it("describes a running Codex follower as work in Codex", () => {
    const session = { agent: "codex", availability: "readable" };
    const continuation = { status: "running", executionLocation: "external" };
    expect(sessionContinuationListState({ ...session, continuation }, "en-US")).toMatchObject({
      label: sessionContinuationCopy("en-US").runningIn("Codex"),
      active: true,
    });
  });
});
