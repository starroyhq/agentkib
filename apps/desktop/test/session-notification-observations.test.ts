import { expect, it, vi } from "vitest";
import {
  parseSessionNotificationInteractions,
  SESSION_NOTIFICATION_INTERACTIONS_CHANGED,
} from "@agentkib/runtime-protocol";
import { SessionNotificationObservations } from "../../../packages/backend/src/session-notification-observations";

const sessionId = "session";
const live = (status: string, field?: "approvals" | "questions", id = "a") => ({
  sessionId,
  workspaceId: "workspace",
  runtimeBootId: "runtime",
  status,
  turnId: "turn",
  approvals: [],
  questions: [],
  ...(field && { [field]: [{ requestId: id, input: "synthetic body" }] }),
});

it.each([
  ["awaiting-approval", "approvals", "approval"],
  ["waiting-input", "questions", "question"],
] as const)(
  "notifies when a %s request is replaced inside one catalog batch",
  (status, field, kind) => {
    const notify = vi.fn();
    const observations = new SessionNotificationObservations(notify);
    observations.update(sessionId, live(status, field, "a"));
    observations.update(sessionId, live(status, field, "a"));
    observations.update(sessionId, live(status, field, "b"));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(
      1,
      SESSION_NOTIFICATION_INTERACTIONS_CHANGED,
      expect.objectContaining({ sessionId, [kind]: ['["turn","a"]'] }),
    );
    expect(notify).toHaveBeenNthCalledWith(
      2,
      SESSION_NOTIFICATION_INTERACTIONS_CHANGED,
      expect.objectContaining({ sessionId, [kind]: ['["turn","b"]'] }),
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("synthetic body");
  },
);

it("retains pending identities through disconnected and incomplete observations", () => {
  const notify = vi.fn();
  const observations = new SessionNotificationObservations(notify);
  observations.update(sessionId, live("awaiting-approval", "approvals"));
  observations.update(sessionId, { ...live("idle"), reason: "claude-bridge-disconnected" });
  observations.update(sessionId, {
    ...live("unsupported"),
    reason: "session-workspace-unavailable",
  });
  observations.update(sessionId, live("awaiting-approval"));
  expect(notify).toHaveBeenCalledOnce();
  observations.update(sessionId, live("running"));
  expect(notify).toHaveBeenLastCalledWith(SESSION_NOTIFICATION_INTERACTIONS_CHANGED, {
    sessionId,
    approval: [],
    question: [],
  });
  expect(notify).toHaveBeenCalledTimes(2);
});

it("decodes only bounded identity arrays and leaves unavailable evidence absent", () => {
  expect(parseSessionNotificationInteractions({ sessionId, approval: [] })).toEqual({
    sessionId,
    approval: [],
  });
  expect(parseSessionNotificationInteractions({ sessionId, approval: [12] })).toBeUndefined();
});
