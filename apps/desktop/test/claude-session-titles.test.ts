import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-session-titles-"));
  roots.push(root);
  const home = path.join(root, "claude"),
    project = path.join(root, "project"),
    directory = path.join(home, "projects", "project"),
    sessionId = randomUUID(),
    file = path.join(directory, `${sessionId}.jsonl`),
    index = path.join(directory, "sessions-index.json");
  mkdirSync(directory, { recursive: true });
  mkdirSync(project);
  const row = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: "user",
    sessionId,
    cwd: project,
    isSidechain: false,
    message: { role: "user", content },
    ...extra,
  });
  const write = (rows: unknown[]) => {
    writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  };
  const writeIndex = (extra: Record<string, unknown> = {}) => {
    writeFileSync(
      index,
      JSON.stringify({
        version: 1,
        entries: [{ sessionId, projectPath: project, fullPath: file, ...extra }],
      }),
    );
  };
  const list = () => new ClaudeSessions({ CLAUDE_CONFIG_DIR: home }).list(project).sessions;
  return { row, write, writeIndex, list, sessionId, project, directory, file, index };
}

describe("Claude native session title discovery", () => {
  it("derives the first user title without an index and leaves native bytes unchanged", () => {
    const f = fixture();
    f.write([f.row("  你好\n 请检查项目  "), f.row("Later question")]);
    const before = readFileSync(f.file);
    expect(f.list()[0].session.title).toBe("你好 请检查项目");
    expect(f.list()[0].session.title).toBe("你好 请检查项目");
    expect(readFileSync(f.file)).toEqual(before);
    expect(readdirSync(f.directory)).toEqual([path.basename(f.file)]);
  });

  it("uses only ordinary text blocks and never tool output or attachment bodies", () => {
    const f = fixture();
    f.write([
      f.row([{ type: "tool_result", content: "Private tool output" }]),
      f.row([
        { type: "image", source: { data: "Image body" }, text: "Attachment title" },
        { type: "document", source: { data: "Document body" } },
      ]),
      f.row([
        { type: "text", text: "第一部分" },
        { type: "tool_result", content: "Another tool output" },
        { type: "text", text: "第二部分" },
      ]),
    ]);
    expect(f.list()[0].session.title).toBe("第一部分 第二部分");
  });

  it("excludes metadata, compact summaries, auxiliary content and command echoes", () => {
    const f = fixture();
    f.write([
      f.row("Metadata", { isMeta: true }),
      f.row("Compaction", { isCompactSummary: true }),
      f.row("Sidechain", { isSidechain: true }),
      f.row("  <local-command-caveat>Internal echo</local-command-caveat>"),
      f.row([{ type: "text", text: "<local-command-stdout>Output</local-command-stdout>" }]),
      f.row("<command-name>/clear</command-name>"),
      f.row("<command-message>Internal message</command-message>"),
      f.row("# AGENTS.md instructions for /project"),
      f.row("<environment_context>Internal context</environment_context>"),
      f.row("Ignored assistant text", { type: "assistant" }),
      f.row("Role mismatch", { message: { role: "assistant", content: "Role mismatch" } }),
      f.row("Actual user question"),
    ]);
    expect(f.list()[0].session.title).toBe("Actual user question");
  });

  it("keeps useful text beside internal text blocks and literal non-prefix tags", () => {
    const f = fixture();
    f.write([
      f.row([
        { type: "text", text: "<command-name>/help</command-name>" },
        { type: "text", text: "Explain the literal <local-command-stdout> tag" },
      ]),
    ]);
    expect(f.list()[0].session.title).toBe("Explain the literal <local-command-stdout> tag");
  });

  it("does not derive titles for auxiliary-only sessions", () => {
    const f = fixture();
    f.write([
      f.row("Hidden task", { isSidechain: true }),
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Hidden title" },
    ]);
    expect(f.list()[0].session).toMatchObject({ sidechain: true, title: null });
  });

  it("selects the last valid matching explicit title without changing the native identity", () => {
    const f = fixture();
    f.write([
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Early title" },
      f.row("Fallback prompt"),
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Chosen title" },
      { type: "custom-title", sessionId: f.sessionId, customTitle: " \n " },
      { type: "custom-title", customTitle: "No identity" },
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Internal", isMeta: true },
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Side", isSidechain: true },
      { type: "custom-title", sessionId: "another-session", customTitle: "Wrong identity" },
    ]);
    expect(f.list()[0].session).toMatchObject({
      native_ref: f.sessionId,
      title: "Chosen title",
    });
  });

  it("matches title candidates against the final parsed session identity", () => {
    const f = fixture();
    const finalId = randomUUID();
    f.write([
      f.row("Wrong identity prompt"),
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Wrong identity title" },
      f.row("Final identity prompt", { sessionId: finalId }),
    ]);
    expect(f.list()[0].session).toMatchObject({
      native_ref: finalId,
      title: "Final identity prompt",
    });
  });

  it.each([
    [{ summary: "Indexed summary", firstPrompt: "Indexed prompt" }, "Indexed summary"],
    [{ summary: "", firstPrompt: "Indexed prompt" }, "Indexed prompt"],
  ])("preserves valid indexed titles (%j)", (entry, expected) => {
    const f = fixture();
    f.write([f.row("Native prompt")]);
    f.writeIndex(entry);
    const before = readFileSync(f.index);
    expect(f.list()[0].session.title).toBe(expected);
    expect(readFileSync(f.index)).toEqual(before);
  });

  it.each([{}, { summary: "  ", firstPrompt: "\n" }])(
    "fills a missing indexed title on a normal scan (%j)",
    (entry) => {
      const f = fixture();
      f.write([f.row("Fallback title")]);
      f.writeIndex(entry);
      const before = readFileSync(f.index);
      expect(f.list()[0].session.title).toBe("Fallback title");
      f.write([
        f.row("Fallback title"),
        { type: "custom-title", sessionId: f.sessionId, customTitle: "Renamed in header" },
      ]);
      expect(f.list()[0].session.title).toBe("Renamed in header");
      expect(readFileSync(f.index)).toEqual(before);
    },
  );

  it("does not fill an indexed title from a mismatched native session", () => {
    const f = fixture();
    f.write([f.row("Wrong session title", { sessionId: randomUUID() })]);
    f.writeIndex();
    expect(f.list()[0].session.title).toBeNull();
  });

  it("does not fill an auxiliary index entry with transcript text", () => {
    const f = fixture();
    f.write([f.row("Transcript text")]);
    f.writeIndex({ isSidechain: true });
    expect(f.list()[0].session.title).toBeNull();
  });

  it("cleans whitespace and limits titles to 200 Unicode code points", () => {
    const f = fixture();
    f.write([f.row(" \t🙂中文\u0000" + "🙂".repeat(210))]);
    const title = f.list()[0].session.title!;
    expect([...title]).toHaveLength(200);
    expect(title).toBe("🙂中文 " + "🙂".repeat(196));
  });

  it("skips malformed lines and invalid content without manufacturing a title", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      ["{broken", "null", "42", JSON.stringify(f.row(null)), JSON.stringify(f.row("Valid"))].join(
        "\n",
      ) + "\n",
    );
    expect(f.list()[0].session.title).toBe("Valid");
    f.write([
      f.row([
        { type: "text", text: 123 },
        { type: "unknown", text: "Ignored" },
      ]),
    ]);
    expect(f.list()[0].session.title).toBeNull();
  });

  it("reads a late title through the tail window but never prompts beyond the 256-line header", () => {
    const f = fixture();
    f.write([
      f.row("First prompt"),
      ...Array.from({ length: 255 }, () => ({ type: "progress" })),
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Outside header" },
    ]);
    expect(f.list()[0].session.title).toBe("Outside header");
    f.write([
      f.row("Ignored", { isMeta: true }),
      ...Array.from({ length: 255 }, () => ({ type: "progress" })),
      f.row("Outside header"),
    ]);
    expect(f.list()[0].session.title).toBeNull();
  });

  it("reads a title past the 2 MiB header budget when it sits in the tail window", () => {
    const f = fixture();
    f.write([
      f.row("First prompt"),
      { type: "progress", data: "x".repeat(2 * 1024 * 1024) },
      { type: "custom-title", sessionId: f.sessionId, customTitle: "Outside byte budget" },
    ]);
    expect(f.list()[0].session.title).toBe("Outside byte budget");
  });
});
