import { describe, expect, it } from "vitest";
import type { ConversationIndexStatus } from "@/core/types";
import { sessionSourceNeedsAttention } from "./session-source-status";

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
