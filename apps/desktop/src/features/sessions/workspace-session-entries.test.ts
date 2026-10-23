import { describe, expect, it } from "vitest";
import type { ConversationSessionSummary } from "@/core/types";
import { workspaceSessionEntries } from "./session-catalog";

function session(
  id: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  return {
    id,
    workspace_id: "workspace",
    agent: "codex",
    title: id,
    archived: false,
    sidechain: false,
    origin: "interactive",
    availability: "readable",
    ...extra,
  };
}
describe("workspace session entries", () => {
  it("includes only the requested workspace's newly managed sessions", () => {
    expect(
      workspaceSessionEntries(
        "workspace",
        [],
        [session("new"), session("other", { workspace_id: "other" })],
      ).map((s) => s.id),
    ).toEqual(["new"]);
  });
  it("keeps a native identity once when its managed owner publishes verified aliases", () => {
    const indexed = session("native", { origin: "unknown" });
    const owner = session("managed", { indexedSessionIds: ["native"] });
    expect(workspaceSessionEntries("workspace", [indexed], [owner]).map((s) => s.id)).toEqual([
      "native",
    ]);
    expect(workspaceSessionEntries("workspace", [owner], [owner]).map((s) => s.id)).toEqual([
      "managed",
    ]);
  });
  it("does not merge identical IDs across Agents or workspaces", () => {
    expect(
      workspaceSessionEntries(
        "workspace",
        [session("same", { agent: "claude-code" }), session("foreign", { workspace_id: "other" })],
        [session("same")],
      ).map((s) => s.agent),
    ).toEqual(["claude-code", "codex"]);
  });
});
