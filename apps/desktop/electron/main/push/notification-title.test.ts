// @vitest-environment node
import type { HomeSession } from "@agentkib/session-catalog";
import { describe, expect, it } from "vitest";
import { notificationTitle } from "./notification-title";

const session: HomeSession = {
  id: "conversation",
  agent: "claude-code",
  workspace_id: "project",
  availability: "readable",
  title: "Synthetic private first user message",
  workspaceName: "Project",
};

describe("notification titles", () => {
  it("uses the agent and registered workspace instead of an unverified catalog title", () => {
    expect(notificationTitle(session)).toBe("Claude Code · Project");
    expect(notificationTitle({ ...session, workspaceName: undefined })).toBe("Claude Code");
    expect(
      notificationTitle({ ...session, agent: "", workspaceName: undefined }, "未命名会话"),
    ).toBe("未命名会话");
  });

  it("uses only a matching explicitly assigned name and normalizes its whitespace", () => {
    const name = "  Release\n checklist  ";
    const named = { ...session, title: name, notificationTitle: name };
    expect(notificationTitle(named)).toBe("Release checklist");
    expect(notificationTitle({ ...named, title: session.title })).toBe("Claude Code · Project");
  });
});
