import { describe, expect, it } from "vitest";
import {
  TOOL_DETAIL_LIMITS,
  claudeToolDetail,
  claudeToolResult,
  codexItemTool,
  countUnifiedDiff,
  displayToolPath,
  jsonBytes,
  lineCount,
} from "../../../packages/backend/src/conversation-tools";
import type { ConversationToolContent } from "@agentkib/runtime-protocol";

// Synthetic fixtures only: field names follow Codex CLI 0.163 rollouts and
// app-server definitions; no content is taken from real sessions.
const context = { workspace: "/home/tester/work/project", home: "/home/tester" };
const diffOf = (content: ConversationToolContent[] | undefined) =>
  (content ?? []).filter(
    (entry): entry is Extract<ConversationToolContent, { type: "diff" }> => entry.type === "diff",
  );
const terminalOf = (content: ConversationToolContent[] | undefined) =>
  (content ?? []).find(
    (entry): entry is Extract<ConversationToolContent, { type: "terminal" }> =>
      entry.type === "terminal",
  );

describe("Codex item normalization", () => {
  it("shows the script of a shell wrapper with its output tail, exit code and duration", () => {
    const tool = codexItemTool(
      {
        type: "CommandExecution",
        id: "cmd-1",
        command: ["/bin/zsh", "-lc", "pnpm test --filter web"],
        cwd: "/home/tester/work/project",
        parsed_cmd: [{ type: "unknown", cmd: "pnpm test --filter web" }],
        source: "unified_exec_startup",
        status: "failed",
        aggregated_output: "\u001b[31mFAIL\u001b[0m src/app.test.ts\n1 failed\n",
        exit_code: 1,
        duration: { secs: 2, nanos: 500_000_000 },
      },
      context,
    )!;
    expect(tool).toMatchObject({ name: "shell", status: "failed", durationMs: 2500 });
    expect(tool.detail).toMatchObject({ kind: "execute", title: "pnpm test --filter web" });
    expect(terminalOf(tool.detail.content)).toEqual({
      type: "terminal",
      command: "pnpm test --filter web",
      output: "FAIL src/app.test.ts\n1 failed\n",
      exit_code: 1,
    });
  });

  it("reads the live camelCase shape the same way", () => {
    const tool = codexItemTool(
      {
        type: "commandExecution",
        id: "cmd-2",
        command: "/bin/zsh -lc 'git status --short'",
        cwd: "/home/tester/work/project",
        commandActions: [{ type: "unknown", command: "git status --short" }],
        status: "completed",
        aggregatedOutput: " M src/app.ts\n",
        exitCode: 0,
        durationMs: 40,
      },
      context,
    )!;
    expect(tool).toMatchObject({ status: "completed", durationMs: 40 });
    expect(tool.detail.title).toBe("git status --short");
    expect(terminalOf(tool.detail.content)).toMatchObject({ exit_code: 0 });
  });

  it("turns read and search commands into paths and queries without file contents", () => {
    const read = codexItemTool(
      {
        type: "CommandExecution",
        id: "read-1",
        command: ["/bin/zsh", "-lc", "sed -n '1,80p' src/app.ts"],
        cwd: "/home/tester/work/project",
        parsed_cmd: [
          {
            type: "read",
            cmd: "sed",
            name: "app.ts",
            path: "/home/tester/work/project/src/app.ts",
          },
        ],
        status: "completed",
        aggregated_output: "export const secretFileContents = 1;\n",
        exit_code: 0,
        duration: { secs: 0, nanos: 0 },
      },
      context,
    )!;
    expect(read.detail).toEqual({
      kind: "read",
      title: "src/app.ts",
      locations: [{ path: "src/app.ts" }],
    });
    expect(JSON.stringify(read)).not.toContain("secretFileContents");

    const search = codexItemTool(
      {
        type: "commandExecution",
        id: "search-1",
        command: "rg -n TODO src",
        cwd: "/home/tester/work/project",
        commandActions: [{ type: "search", command: "rg -n TODO src", query: "TODO", path: "src" }],
        status: "completed",
        aggregatedOutput: "src/app.ts:3: TODO\n",
        exitCode: 0,
        durationMs: 5,
      },
      context,
    )!;
    expect(search.detail).toMatchObject({ kind: "search", title: "TODO · src" });
    expect(search.detail.content).toBeUndefined();
  });

  it("counts persisted file changes per file and keeps workspace-relative paths", () => {
    const tool = codexItemTool(
      {
        type: "FileChange",
        id: "patch-1",
        changes: {
          "/home/tester/work/project/src/app.ts": {
            type: "update",
            unified_diff: "@@ -1,3 +1,3 @@\n import a\n-const x = 1;\n+const x = 2;\n export {}\n",
            move_path: null,
          },
          "/home/tester/work/project/docs/new.md": { type: "add", content: "# New\n\nText\n" },
        },
        status: "completed",
        stdout: "",
        stderr: "",
      },
      context,
    )!;
    expect(tool).toMatchObject({ name: "apply_patch", status: "completed" });
    expect(tool.detail.kind).toBe("edit");
    expect(tool.detail.title).toBeUndefined();
    const diffs = diffOf(tool.detail.content);
    expect(
      diffs.map(({ path, change, added, removed }) => ({ path, change, added, removed })),
    ).toEqual([
      { path: "src/app.ts", change: "update", added: 1, removed: 1 },
      { path: "docs/new.md", change: "add", added: 3, removed: 0 },
    ]);
    expect(diffs[0]!.preview).toContain("+const x = 2;");
    expect(diffs[1]!.preview).toBe("@@ -0,0 +1,3 @@\n+# New\n+\n+Text");
  });

  it("maps live file changes, including moves and deletes", () => {
    const moved = codexItemTool(
      {
        type: "fileChange",
        id: "patch-2",
        changes: [
          {
            path: "/home/tester/work/project/a.ts",
            kind: { type: "update", move_path: "/home/tester/work/project/b.ts" },
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
        status: "completed",
      },
      context,
    )!;
    expect(moved.detail).toMatchObject({ kind: "move", title: "a.ts" });
    expect(diffOf(moved.detail.content)[0]).toMatchObject({ change: "move", move_path: "b.ts" });

    const deleted = codexItemTool(
      {
        type: "fileChange",
        id: "patch-3",
        changes: [
          { path: "/home/tester/work/project/old.txt", kind: { type: "delete" }, diff: "a\nb\n" },
        ],
        status: "declined",
      },
      context,
    )!;
    expect(deleted.status).toBe("declined");
    expect(deleted.detail.kind).toBe("delete");
    expect(diffOf(deleted.detail.content)[0]).toMatchObject({ added: 0, removed: 2 });
  });

  it("redacts commands, outputs, MCP values and diff previews but counts before redaction", () => {
    const command = codexItemTool(
      {
        type: "CommandExecution",
        id: "cmd-3",
        command: [
          "/bin/zsh",
          "-lc",
          "curl -H 'Authorization: Bearer abc.def.ghi' https://x.test/?token=t0k3n",
        ],
        parsed_cmd: [{ type: "unknown", cmd: "curl" }],
        status: "completed",
        aggregated_output: "key sk-abcdefghijklmnopqrstuvwx\n",
        exit_code: 0,
        duration: { secs: 0, nanos: 0 },
      },
      context,
    )!;
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("t0k3n");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwx");

    const patch = codexItemTool(
      {
        type: "FileChange",
        id: "patch-4",
        changes: {
          "/home/tester/work/project/.env.example": {
            type: "update",
            unified_diff:
              "@@ -1,1 +1,5 @@\n API_URL=x\n+API_KEY=supersecretvalue\n+-----BEGIN PRIVATE KEY-----\n+MIIEvgIBADANBgkq\n+-----END PRIVATE KEY-----\n",
            move_path: null,
          },
        },
        status: "completed",
      },
      context,
    )!;
    const diff = diffOf(patch.detail.content)[0]!;
    expect(diff).toMatchObject({ added: 4, removed: 0 });
    expect(diff.preview).toContain("+API_KEY=[REDACTED]");
    expect(diff.preview).toContain("+[REDACTED PRIVATE KEY]");
    expect(diff.preview).not.toContain("supersecretvalue");
    expect(diff.preview).not.toContain("MIIEvgIBADANBgkq");

    const mcp = codexItemTool({
      type: "McpToolCall",
      id: "mcp-1",
      server: "docs",
      tool: "search",
      arguments: JSON.stringify({ query: "release", api_key: "k-123456" }),
      status: "completed",
      result: { content: [{ type: "text", text: "found 2" }], isError: true },
      duration: { secs: 1, nanos: 0 },
    })!;
    expect(mcp).toMatchObject({ name: "search", status: "failed", durationMs: 1000 });
    expect(mcp.detail).toMatchObject({
      kind: "other",
      title: "docs · search",
      mcp: { server: "docs", tool: "search" },
    });
    expect(JSON.stringify(mcp)).not.toContain("k-123456");
    expect(JSON.stringify(mcp)).toContain("found 2");
  });

  it("keeps output tails bounded and never cuts a long single line before redaction", () => {
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
    const tool = codexItemTool({
      type: "CommandExecution",
      id: "cmd-4",
      command: ["ls"],
      parsed_cmd: [{ type: "unknown", cmd: "ls" }],
      status: "completed",
      aggregated_output: long,
      exit_code: 0,
      duration: { secs: 0, nanos: 0 },
    })!;
    const output = terminalOf(tool.detail.content)!;
    expect(Buffer.byteLength(output.output!)).toBeLessThanOrEqual(TOOL_DETAIL_LIMITS.outputBytes);
    expect(output.output!.endsWith("line 2999")).toBe(true);
    expect(output.truncated).toBe(true);

    const single = codexItemTool({
      type: "CommandExecution",
      id: "cmd-5",
      command: ["cat"],
      parsed_cmd: [{ type: "unknown", cmd: "cat" }],
      status: "completed",
      aggregated_output: `password=${"x".repeat(2 * 1024 * 1024)}`,
      exit_code: 0,
      duration: { secs: 0, nanos: 0 },
    })!;
    expect(terminalOf(single.detail.content)).toEqual({
      type: "terminal",
      command: "cat",
      exit_code: 0,
      truncated: true,
    });
  });

  it("keeps a many-file change within the per-item budget", () => {
    const changes: Record<string, unknown> = {};
    for (let index = 0; index < 260; index++)
      changes[`/home/tester/work/project/src/file-${index}.ts`] = {
        type: "update",
        unified_diff: `@@ -1,1 +1,40 @@\n-a\n${Array.from({ length: 40 }, (_, line) => `+line ${line} ${"y".repeat(60)}`).join("\n")}\n`,
        move_path: null,
      };
    const tool = codexItemTool(
      { type: "FileChange", id: "big", changes, status: "completed" },
      context,
    )!;
    expect(jsonBytes(tool.detail)).toBeLessThanOrEqual(TOOL_DETAIL_LIMITS.detailBytes);
    const diffs = diffOf(tool.detail.content);
    expect(diffs.length).toBeLessThanOrEqual(TOOL_DETAIL_LIMITS.diffFiles);
    expect(diffs.filter((entry) => entry.preview).length).toBeLessThanOrEqual(
      TOOL_DETAIL_LIMITS.diffPreviewFiles,
    );
    expect(diffs[0]).toMatchObject({ added: 40, removed: 1 });
  });

  it("maps web search, sub-agents, waits and image views", () => {
    expect(
      codexItemTool({
        type: "Extension",
        kind: "web.search",
        id: "w",
        query: "codex app-server",
        action: { type: "search", query: "codex app-server" },
        results: "",
      })!.detail,
    ).toEqual({ kind: "fetch", title: "codex app-server" });
    expect(
      codexItemTool({
        type: "webSearch",
        id: "w2",
        query: "",
        action: { type: "openPage", url: "https://example.test/docs" },
        results: null,
      })!.detail,
    ).toEqual({ kind: "fetch", title: "https://example.test/docs" });
    expect(
      codexItemTool({
        type: "SubAgentActivity",
        id: "s",
        kind: "started",
        agent_thread_id: "t",
        agent_path: "/root/reviewer",
        model: "m",
        reasoning_effort: "high",
      })!.detail,
    ).toEqual({ kind: "other", agent: { action: "spawn", name: "reviewer" } });
    expect(
      codexItemTool({
        type: "CollabAgentToolCall",
        id: "c",
        tool: "wait",
        status: "completed",
        sender_thread_id: "a",
        receiver_thread_ids: [],
        receiver_agents: [],
        agents_states: {},
      })!.detail,
    ).toEqual({ kind: "other", agent: { action: "wait" } });
    expect(
      codexItemTool(
        { type: "ImageView", id: "i", path: "/home/tester/work/project/shot.png" },
        context,
      )!.detail,
    ).toEqual({ kind: "read", title: "shot.png", locations: [{ path: "shot.png" }] });
    expect(
      codexItemTool({ type: "Reasoning", id: "r", summary_text: "x", raw_content: "y" }),
    ).toBeNull();
    expect(codexItemTool({ type: "AgentMessage", id: "m", content: "x" })).toBeNull();
  });
});

describe("diff and path helpers", () => {
  it("counts hunks, ignores headers and the no-newline marker", () => {
    expect(
      countUnifiedDiff(
        "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n",
      ),
    ).toEqual({
      added: 1,
      removed: 1,
    });
    expect(countUnifiedDiff("+++ b/x\n+one\n-two\n")).toEqual({ added: 1, removed: 1 });
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("")).toBe(0);
  });

  it("shows workspace paths relative, home paths with ~ and others as recorded", () => {
    expect(displayToolPath("/home/tester/work/project/src/a.ts", context)).toBe("src/a.ts");
    expect(displayToolPath("/home/tester/work/project", context)).toBe(".");
    expect(displayToolPath("/home/tester/.codex/config.toml", context)).toBe(
      "~/.codex/config.toml",
    );
    expect(displayToolPath("/opt/tools/bin", context)).toBe("/opt/tools/bin");
    expect(displayToolPath("/home/tester/work/project-other/a.ts", context)).toBe(
      "~/work/project-other/a.ts",
    );
  });
});

describe("Claude Code tool normalization", () => {
  it("keeps the structured patch and never the original file", () => {
    const result = claudeToolResult(
      {
        filePath: "/home/tester/work/project/src/app.ts",
        oldString: "a",
        newString: "b",
        originalFile: "ORIGINAL-FILE-CONTENTS",
        structuredPatch: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" keep", "-a", "+b"] },
        ],
        userModified: false,
        replaceAll: false,
      },
      "The file has been updated.",
    );
    expect(JSON.stringify(result)).not.toContain("ORIGINAL-FILE-CONTENTS");
    const detail = claudeToolDetail(
      "Edit",
      { file_path: "/home/tester/work/project/src/app.ts", old_string: "a", new_string: "b" },
      result,
      context,
    )!;
    expect(detail).toMatchObject({ kind: "edit", title: "src/app.ts" });
    expect(diffOf(detail.content)[0]).toMatchObject({
      path: "src/app.ts",
      change: "update",
      added: 1,
      removed: 1,
      preview: "@@ -1,2 +1,2 @@\n keep\n-a\n+b",
    });
  });

  it("builds Bash, Read, Write, Grep and MCP details", () => {
    const bash = claudeToolDetail(
      "Bash",
      { command: "npm test", description: "Run tests" },
      claudeToolResult({ stdout: "ok\n", stderr: "", interrupted: false, isImage: false }, "ok"),
      context,
    )!;
    expect(bash).toEqual({
      kind: "execute",
      title: "npm test",
      content: [{ type: "terminal", command: "npm test", output: "ok\n" }],
    });

    const read = claudeToolDetail(
      "Read",
      { file_path: "/home/tester/work/project/README.md", offset: 10, limit: 20 },
      claudeToolResult(
        { type: "text", file: { filePath: "x", content: "FILE-BODY", numLines: 20 } },
        "FILE-BODY",
      ),
      context,
    )!;
    expect(read).toEqual({
      kind: "read",
      title: "README.md",
      locations: [{ path: "README.md", line: 10 }],
    });
    expect(JSON.stringify(read)).not.toContain("FILE-BODY");

    const write = claudeToolDetail(
      "Write",
      { file_path: "/home/tester/work/project/new.txt", content: "one\ntwo\n" },
      claudeToolResult(
        {
          type: "create",
          filePath: "x",
          content: "one\ntwo\n",
          structuredPatch: [],
          originalFile: null,
        },
        "File created",
      ),
      context,
    )!;
    expect(diffOf(write.content)[0]).toMatchObject({ change: "add", added: 2, removed: 0 });

    const edit = claudeToolDetail(
      "Edit",
      { file_path: "/home/tester/work/project/a.ts", old_string: "x\ny\nz", new_string: "x\nY\nz" },
      undefined,
      context,
    )!;
    expect(diffOf(edit.content)[0]).toMatchObject({ added: 1, removed: 1 });

    expect(
      claudeToolDetail(
        "Grep",
        { pattern: "TODO", path: "/home/tester/work/project/src" },
        undefined,
        context,
      ),
    ).toEqual({ kind: "search", title: "TODO · src", locations: [{ path: "src" }] });

    const mcp = claudeToolDetail(
      "mcp__pencil__execute",
      { code: "draw()", token: "secret-token" },
      claudeToolResult(undefined, [{ type: "text", text: "done" }]),
      context,
    )!;
    expect(mcp).toMatchObject({
      kind: "other",
      title: "pencil · execute",
      mcp: { server: "pencil", tool: "execute" },
    });
    expect(JSON.stringify(mcp)).not.toContain("secret-token");
    expect(claudeToolDetail("UnknownTool", {}, undefined, context)).toBeUndefined();
  });
});
