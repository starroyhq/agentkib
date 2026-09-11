import { describe, expect, it } from "vitest";

import { isValidMessage, mergeLatestPage } from "./session-model";

describe("session model", () => {
  it("validates both text and UTF-8 byte limits", () => {
    expect(isValidMessage("hello")).toBe(true);
    expect(isValidMessage(" ")).toBe(false);
    expect(isValidMessage("文".repeat(6000))).toBe(false);
  });

  it("merges refreshed events without losing paged history", () => {
    const merged = mergeLatestPage(
      {
        events: [
          { id: "old", kind: "agent-message", content: "old", attachment_count: 0, truncated: false },
          { id: "current", kind: "agent-message", content: "current", attachment_count: 0, truncated: false },
        ],
        warnings: ["older warning"],
        next_cursor: "cursor",
      },
      {
        events: [
          { id: "current", kind: "agent-message", content: "updated", attachment_count: 0, truncated: false },
          { id: "new", kind: "agent-message", content: "new", attachment_count: 0, truncated: false },
        ],
        warnings: ["latest warning"],
      },
    );

    expect(merged.events.map((event) => event.id)).toEqual(["old", "current", "new"]);
    expect(merged.events[1].content).toBe("updated");
    expect(merged.warnings).toEqual(["older warning", "latest warning"]);
    expect(merged.next_cursor).toBe("cursor");
  });
});
