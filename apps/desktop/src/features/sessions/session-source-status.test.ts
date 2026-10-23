import { describe, expect, it } from "vitest";
import type { ConversationIndexStatus, ConversationSessionSummary } from "@/core/types";
import { sessionSourceNeedsAttention, sessionSourceWasUsed } from "./session-source-status";

const status: ConversationIndexStatus = {
  workspace_id: "workspace",
  agent: "claude-code",
  freshness: "unavailable",
  session_count: 0,
};
describe("session source attention", () => {
  it("does not turn a missing or aging source into an error", () => {
    expect(sessionSourceNeedsAttention(status, [])).toBe(false);
    expect(sessionSourceNeedsAttention({ ...status, freshness: "stale" }, ["claude-code"])).toBe(
      false,
    );
  });
  it("ignores an uninstalled Agent's source error", () => {
    expect(
      sessionSourceNeedsAttention({ ...status, error_key: "source-not-found" }, ["codex"]),
    ).toBe(false);
  });
  it("retains actual errors from installed sources", () => {
    expect(
      sessionSourceNeedsAttention({ ...status, error_key: "permission-denied" }, ["claude-code"]),
    ).toBe(true);
  });
});

it("only warns for this workspace and Agent's previous session records", () => {
  expect(sessionSourceWasUsed({ ...status, session_count: 1 }, [])).toBe(true);
  expect(sessionSourceWasUsed({ ...status, last_success_at: "2026-10-23T00:00:00Z" }, [])).toBe(
    false,
  );
  const session = {
    workspace_id: status.workspace_id,
    agent: status.agent,
  } as ConversationSessionSummary;
  expect(sessionSourceWasUsed(status, [session])).toBe(true);
  expect(sessionSourceWasUsed(status, [{ ...session, workspace_id: "other" }])).toBe(false);
  expect(sessionSourceWasUsed(status, [{ ...session, agent: "codex" }])).toBe(false);
});
