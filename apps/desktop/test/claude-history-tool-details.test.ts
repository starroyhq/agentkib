import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { groupConversationEvents, turnFileActivity } from "@agentkib/conversation-state";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

// Synthetic Claude Code transcript rows shaped like CLI 2.1.310 JSONL; no
// real session content is used.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const workspace = "/home/tester/work/project";
const context = { workspace, home: "/home/tester" };
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const at = (second: number) => new Date(Date.UTC(2026, 9, 27, 9, 0, second)).toISOString();
const base = () => ({ uuid: uuid(), timestamp: at(sequence), sessionId: "s", cwd: workspace });
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  ...base(),
  type: "user",
  message: { role: "user", content },
  ...extra,
});
const assistant = (content: unknown[]) => ({
  ...base(),
  type: "assistant",
  message: { id: uuid(), role: "assistant", content },
});
function transcript(rows: unknown[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-claude-tools-"));
  directories.push(directory);
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return file;
}
const read = (file: string) => new SessionPaging().read(file, null, 100, "claude-code", context);

describe("Claude Code history tool details", () => {
  it("keeps each turn's tools together across transcript pages", async () => {
    const file = fileURLToPath(new URL("./fixtures/claude-tool-turns.jsonl", import.meta.url));
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000009";
    const paging = new SessionPaging();
    const pages = [];
    let cursor: string | null = null;
    for (let index = 0; index < 4; index++) {
      const page = await paging.readTranscript(file, cursor, 2, "claude-code", context, true);
      expect(page.events.length).toBe(index < 3 ? 2 : 1);
      pages.unshift(page.events);
      cursor = page.next_cursor;
      if (index < 3) expect(cursor).toBeTruthy();
    }
    expect(cursor).toBeNull();

    const events = pages.flat();
    const identity = events.map(({ id, turn_id }) => [id, turn_id]);
    expect(identity).toEqual(read(file).events.map(({ id, turn_id }) => [id, turn_id]));
    const groups = groupConversationEvents(
      events.map((event) => ({
        ...event,
        timestamp: event.timestamp ?? undefined,
        content: event.content ?? undefined,
        tool_name: event.tool_name ?? undefined,
        tool_status: event.tool_status ?? undefined,
      })),
    );
    expect(
      groups.map(({ turnId, segments }) => [
        turnId,
        segments.filter(({ kind }) => kind === "process").map(({ toolCount }) => toolCount),
      ]),
    ).toEqual([
      [first, [2]],
      [second, [1]],
    ]);
    expect(groups.map((group) => turnFileActivity(group)?.events.map(({ id }) => id))).toEqual([
      ["toolu_fixture_bash", "toolu_fixture_read"],
      ["toolu_fixture_branch"],
    ]);
    expect(events.filter(({ kind }) => kind === "agent-message")).toHaveLength(2);
  });

  it("joins tool_use input with toolUseResult and keeps the turn duration", () => {
    const page = read(
      transcript([
        user("Please fix the test"),
        assistant([
          { type: "text", text: "On it." },
          {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: { command: "npm test", description: "Run tests" },
          },
        ]),
        user(
          [{ type: "tool_result", tool_use_id: "toolu_bash", content: "1 failed", is_error: true }],
          {
            toolUseResult: { stdout: "1 failed\n", stderr: "", interrupted: false, isImage: false },
          },
        ),
        assistant([
          {
            type: "tool_use",
            id: "toolu_edit",
            name: "Edit",
            input: { file_path: `${workspace}/src/a.ts`, old_string: "a", new_string: "b" },
          },
        ]),
        user(
          [
            {
              type: "tool_result",
              tool_use_id: "toolu_edit",
              content: "The file has been updated.",
            },
          ],
          {
            toolUseResult: {
              filePath: `${workspace}/src/a.ts`,
              oldString: "a",
              newString: "b",
              originalFile: "ORIGINAL-FILE-CONTENTS",
              structuredPatch: [
                {
                  oldStart: 3,
                  oldLines: 2,
                  newStart: 3,
                  newLines: 3,
                  lines: [" x", "-a", "+b", "+c"],
                },
              ],
              userModified: false,
              replaceAll: false,
            },
          },
        ),
        assistant([{ type: "text", text: "Done." }]),
        { ...base(), type: "system", subtype: "turn_duration", durationMs: 65_000, isMeta: false },
      ]),
    );
    expect(page.events.map((event) => [event.kind, event.tool_name, event.tool_status])).toEqual([
      ["user-message", null, null],
      ["agent-message", null, null],
      ["tool-summary", "Bash", "failed"],
      ["tool-summary", "Edit", "completed"],
      ["agent-message", null, null],
    ]);
    const [, , bash, edit, done] = page.events;
    expect(bash).toMatchObject({ id: "toolu_bash" });
    expect(bash!.tool).toEqual({
      kind: "execute",
      title: "npm test",
      content: [{ type: "terminal", command: "npm test", output: "1 failed\n" }],
    });
    expect(edit!.tool).toEqual({
      kind: "edit",
      title: "src/a.ts",
      locations: [{ path: "src/a.ts" }],
      content: [
        {
          type: "diff",
          path: "src/a.ts",
          change: "update",
          added: 2,
          removed: 1,
          preview: "@@ -3,2 +3,3 @@\n x\n-a\n+b\n+c",
        },
      ],
    });
    expect(done!.turn_meta).toEqual({
      outcome: "completed",
      duration_ms: 65_000,
      summary: {
        checks: [{ name: "npm test", status: "failed" }],
        files: [{ path: "src/a.ts", added: 2, removed: 1 }],
      },
    });
    expect(JSON.stringify(page)).not.toContain("ORIGINAL-FILE-CONTENTS");
  });

  it("does not read file contents for Read and ignores ambiguous structured results", () => {
    const page = read(
      transcript([
        user("Look at two files"),
        assistant([
          {
            type: "tool_use",
            id: "toolu_r1",
            name: "Read",
            input: { file_path: `${workspace}/a.md` },
          },
          { type: "tool_use", id: "toolu_r2", name: "Bash", input: { command: "cat b.md" } },
        ]),
        user(
          [
            { type: "tool_result", tool_use_id: "toolu_r1", content: "FILE-BODY-A" },
            { type: "tool_result", tool_use_id: "toolu_r2", content: "printed b" },
          ],
          { toolUseResult: { stdout: "STRUCTURED-FOR-ONE-OF-TWO", stderr: "" } },
        ),
      ]),
    );
    const [readRow, bashRow] = page.events.filter((event) => event.kind === "tool-summary");
    expect(readRow!.tool).toEqual({ kind: "read", title: "a.md", locations: [{ path: "a.md" }] });
    expect(bashRow!.tool?.content).toEqual([
      { type: "terminal", command: "cat b.md", output: "printed b" },
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("FILE-BODY-A");
    expect(serialized).not.toContain("STRUCTURED-FOR-ONE-OF-TWO");
  });

  it("drops a turn duration that has no reply after it", () => {
    const page = read(
      transcript([
        assistant([{ type: "text", text: "Earlier answer" }]),
        user("A question with no answer yet"),
        { ...base(), type: "system", subtype: "turn_duration", durationMs: 1_000, isMeta: false },
      ]),
    );
    expect(page.events.some((event) => event.turn_meta)).toBe(false);
  });

  it("does not use an older turn's opener for a tool with no proven opener", () => {
    const opener = user("Previous prompt");
    const call = (id: string) =>
      assistant([{ type: "tool_use", id, name: "Bash", input: { command: "true" } }]);
    const file = transcript([
      opener,
      call("toolu_previous"),
      assistant([{ type: "text", text: "Previous reply" }]),
      { ...base(), type: "system", subtype: "turn_duration", durationMs: 1000 },
      call("toolu_unattributed"),
    ]);
    const paging = new SessionPaging();
    const newest = paging.read(file, null, 1, "claude-code");
    expect(newest.events[0]).toMatchObject({ id: "toolu_unattributed" });
    expect(newest.events[0]).not.toHaveProperty("turn_id");
    expect(newest.next_cursor).toBeTruthy();
    const older = paging.read(file, newest.next_cursor, 10, "claude-code");
    expect(older.events.map(({ turn_id }) => turn_id)).toEqual([
      opener.uuid,
      opener.uuid,
      opener.uuid,
    ]);
  });

  it("leaves sidechain tools without a main-thread turn ID", () => {
    const opener = user("Main prompt");
    const call = (id: string) =>
      assistant([{ type: "tool_use", id, name: "Bash", input: { command: "true" } }]);
    const { events } = read(
      transcript([
        opener,
        call("toolu_main"),
        user("Sidechain prompt", { isSidechain: true }),
        { ...call("toolu_sidechain"), isSidechain: true },
      ]),
    );
    expect(events.find(({ id }) => id === "toolu_main")?.turn_id).toBe(opener.uuid);
    const sidechain = events.find(({ id }) => id === "toolu_sidechain");
    expect(sidechain).toBeDefined();
    expect(sidechain).not.toHaveProperty("turn_id");
  });
});
