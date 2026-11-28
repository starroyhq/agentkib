import { expect, it, vi } from "vitest";
import type { HomeSession } from "@agentkib/session-catalog";
import { DesktopNotificationInteractionSource } from "./desktop-notification-interaction-source";

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

const row: HomeSession = {
  id: sessionId,
  workspace_id: "workspace",
  agent: "codex",
  title: "",
  updated_at: "2026-11-28T10:00:00Z",
  availability: "readable",
  continuation: { status: "awaiting-approval" },
};

function deferredResponse() {
  type Response = { status: number; body: unknown };
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("does not let an in-flight fallback replace newer runtime evidence", async () => {
  const read = deferredResponse();
  const remote = { localRequest: vi.fn(() => read.promise) };
  const observe = vi.fn();
  const source = new DesktopNotificationInteractionSource(remote, observe);
  source.update([row]);
  expect(remote.localRequest).toHaveBeenCalledExactlyOnceWith("/live?sessionId=session");
  const newer = { sessionId, approval: ['["turn","b"]'] };
  source.changed(sessionId, newer);
  read.resolve({ status: 200, body: live("awaiting-approval", "approvals") });
  await read.promise;
  expect(observe).toHaveBeenCalledExactlyOnceWith(sessionId, newer, false);
});

it("keeps a held card through metadata-only rows and revalidates when a readable row returns", async () => {
  const remote = {
    localRequest: vi.fn(async () => ({ status: 200, body: live("running") })),
  };
  const observe = vi.fn();
  const source = new DesktopNotificationInteractionSource(remote, observe);
  source.update([]);
  source.changed(sessionId, { sessionId, approval: ["a"] });
  source.update([{ ...row, availability: "metadata-only" }]);
  expect(remote.localRequest).not.toHaveBeenCalled();
  source.update([{ ...row, continuation: { status: "running" } }]);
  expect(remote.localRequest).toHaveBeenCalledExactlyOnceWith("/live?sessionId=session");
  await remote.localRequest.mock.results[0]!.value;
  expect(observe).toHaveBeenLastCalledWith(
    sessionId,
    { sessionId, approval: [], question: [] },
    false,
  );
});

it("does not use a read begun before the transcript became temporarily unreadable", async () => {
  const stale = deferredResponse();
  const current = deferredResponse();
  const remote = {
    localRequest: vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise),
  };
  const observe = vi.fn();
  const source = new DesktopNotificationInteractionSource(remote, observe);
  source.update([row]);
  source.update([{ ...row, availability: "metadata-only" }]);
  source.update([row]);
  stale.resolve({ status: 200, body: live("running") });
  await stale.promise;
  expect(observe).not.toHaveBeenCalled();
  current.resolve({ status: 200, body: live("awaiting-approval", "approvals") });
  await current.promise;
  expect(observe).toHaveBeenCalledExactlyOnceWith(
    sessionId,
    { sessionId, approval: ['["turn","a"]'], question: [] },
    false,
  );
});
