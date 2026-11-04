import { describe, expect, it } from "vitest";
import { sessionContinuationCopy, sessionContinuationListState } from "@agentkib/session-ui";

describe("runtime-only session list presentation", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"])(
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
    expect(state({ status: "running" })).toEqual({ label: copy.running, active: true, dot: true });
    expect(state({ status: "awaiting-approval", reason: "dsh-approval-pending" })).toEqual({
      label: copy.waiting,
      waiting: true,
      dot: true,
    });
    expect(state({ status: "idle" })).toBeUndefined();
    // Without a running DSH the session can only be read.
    expect(
      sessionContinuationListState({ ...session, availability: "metadata-only" }, "en-US"),
    ).toEqual({ label: copy.viewOnly });
  });
});
