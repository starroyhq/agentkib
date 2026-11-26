// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DETAIL_LIMITS } from "../../../packages/backend/src/conversation-tools";
import { SessionPaging } from "../../../packages/backend/src/session-paging";
import { assistantRecord, jsonl, userRecord } from "./fixtures/claude-native-session";

describe("Claude tool details from native history", () => {
  it("pairs terminal records across pages by tool ID and keeps result-only metadata out of the chat", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agentkib-claude-tool-history-"));
    const file = path.join(directory, "fixture.jsonl");
    const session = randomUUID();
    const prompt = userRecord(session);
    const calls = assistantRecord(session, prompt.uuid, {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: { command: "printf complete" },
          },
          {
            type: "tool_use",
            id: "toolu_mcp",
            name: "mcp__agentkib-bridge__worker_send",
            input: { worker: "fixture", message: "Review the checks" },
          },
        ],
      },
    });
    const results = [
      userRecord(session, {
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_mcp", content: [] }],
        },
        toolUseResult: [{ type: "text", text: "Worker accepted the request" }],
      }),
      userRecord(session, {
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: [] }],
        },
        tool_use_result: {
          stdout: "结果 ".repeat(18_000) + "Complete",
          stderr: "",
          originalFile: "secret-file-content",
        },
      }),
      userRecord(session, {
        isMeta: true,
        message: { role: "user", content: "Private synthetic context" },
      }),
    ];
    try {
      writeFileSync(file, jsonl([prompt, calls, ...results]));
      const paging = new SessionPaging();
      const recent = paging.read(file, null, 1, "claude-code");
      expect(recent.events).toMatchObject([
        {
          id: "toolu_mcp",
          kind: "tool-summary",
          tool_status: "completed",
          tool: {
            mcp: { server: "agentkib-bridge", tool: "worker_send" },
            content: [
              { type: "text", label: "input", text: expect.stringContaining("Review the checks") },
              { type: "text", label: "output", text: "Worker accepted the request" },
            ],
          },
        },
      ]);
      expect(recent.next_cursor).toBeTruthy();
      const older = paging.read(file, recent.next_cursor, 3, "claude-code");
      expect(older.events).toMatchObject([
        { id: prompt.uuid, kind: "user-message", content: "synthetic prompt" },
        {
          id: "toolu_bash",
          kind: "tool-summary",
          tool_status: "completed",
          tool: {
            content: [
              {
                type: "terminal",
                command: "printf complete",
                output: expect.stringMatching(/Complete$/),
                truncated: true,
              },
            ],
          },
        },
      ]);
      const terminal = older.events[1]?.tool?.content?.[0];
      expect(terminal?.type).toBe("terminal");
      if (terminal?.type !== "terminal") throw new Error("Expected a Bash terminal preview");
      expect(Buffer.byteLength(terminal.output ?? "")).toBeLessThanOrEqual(
        TOOL_DETAIL_LIMITS.outputBytes,
      );
      expect(terminal.output).not.toContain("\uFFFD");
      expect(JSON.stringify(older)).not.toContain("secret-file-content");
      expect(older.warnings).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
