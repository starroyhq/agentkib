import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionPaging } from "../../../packages/backend/src/session-paging";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/claude-managed-runner";
import {
  claudeCommandInvocation,
  claudeCommandOutput,
} from "../../../packages/backend/src/claude-command-records";
import { createFakeClaude } from "./fixtures/claude-fake-cli";

// Rows and frames follow what CLI 2.1.311 wrote and sent for slash commands against the local API
// stub (record types, flags, tag order, uuids); the texts are synthetic and shortened.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
const assistant = (text: string) => ({
  ...base(),
  type: "assistant",
  message: { id: uuid(), role: "assistant", content: [{ type: "text", text }] },
});
const system = (subtype: string, content: string) => ({
  ...base(),
  type: "system",
  subtype,
  content,
  level: "info",
  isMeta: false,
});
const caveat = () =>
  user(
    "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>",
    { isMeta: true },
  );
const invocation = (
  name: string,
  args = "",
  order: "name-first" | "message-first" = "name-first",
) =>
  user(
    order === "name-first"
      ? `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`
      : `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
  );
function read(rows: unknown[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-claude-commands-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return new SessionPaging().read(file, null, 100, "claude-code", context).events;
}

describe("slash commands in Claude Code history", () => {
  it("reads commands as typed and their output as replies, without the CLI's own context", () => {
    const contextOutput = system(
      "local_command",
      "<local-command-stdout>## Context Usage\n\n**Tokens:** 3.4k / 1m (0%)</local-command-stdout>",
    );
    const helpEcho = system("local_command", "/help");
    const compacted = user("<local-command-stdout>Compacted </local-command-stdout>");
    const events = read([
      user([{ type: "text", text: "hi" }]),
      assistant("Stub reply."),
      caveat(),
      invocation("context"),
      contextOutput,
      helpEcho,
      system(
        "local_command",
        "<local-command-stdout>/help isn't available in this environment.</local-command-stdout>",
      ),
      invocation("hello", "world", "message-first"),
      user([{ type: "text", text: "Say hello to world in one word.\n" }], { isMeta: true }),
      assistant("Stub reply."),
      invocation("probe-skill", "tell me", "message-first"),
      user(
        [
          {
            type: "text",
            text: "Base directory for this skill: /tmp/skills/probe-skill\n\nAnswer.",
          },
        ],
        { isMeta: true },
      ),
      assistant("Stub reply."),
      caveat(),
      invocation("model", "claude-haiku-5-5"),
      system(
        "local_command",
        "<local-command-stdout>Set model to `Haiku 5.5` for this session only</local-command-stdout>",
      ),
      system("compact_boundary", "Conversation compacted"),
      user("This session is being continued from a previous conversation.", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      caveat(),
      invocation("compact"),
      compacted,
      user([{ type: "text", text: "after compact" }]),
      assistant("Stub reply."),
    ]);
    expect(events.map(({ kind, content }) => [kind, content])).toEqual([
      ["user-message", "hi"],
      ["agent-message", "Stub reply."],
      ["user-message", "/context"],
      ["agent-message", "## Context Usage\n\n**Tokens:** 3.4k / 1m (0%)"],
      ["user-message", "/help"],
      ["agent-message", "/help isn't available in this environment."],
      ["user-message", "/hello world"],
      ["agent-message", "Stub reply."],
      ["user-message", "/probe-skill tell me"],
      ["agent-message", "Stub reply."],
      ["user-message", "/model claude-haiku-5-5"],
      ["agent-message", "Set model to `Haiku 5.5` for this session only"],
      ["user-message", "/compact"],
      ["agent-message", "Compacted"],
      ["user-message", "after compact"],
      ["agent-message", "Stub reply."],
    ]);
    // The live frame for a local command's output carries the same uuid.
    const byContent = (content: string) => events.find((event) => event.content === content)!;
    expect(byContent("## Context Usage\n\n**Tokens:** 3.4k / 1m (0%)").id).toBe(contextOutput.uuid);
    expect(byContent("/help").id).toBe(helpEcho.uuid);
    expect(byContent("Compacted").id).toBe(compacted.uuid);
    // Only the CLI's own output is marked; clients keep its line breaks.
    expect(events.filter((event) => event.cli_output).map(({ content }) => content)).toEqual([
      "## Context Usage\n\n**Tokens:** 3.4k / 1m (0%)",
      "/help isn't available in this environment.",
      "Set model to `Haiku 5.5` for this session only",
      "Compacted",
    ]);
  });

  it("marks the CLI's own assistant text, such as an API error, and not the model's", () => {
    const synthetic = (content: unknown, id = uuid()) => ({
      ...base(),
      type: "assistant",
      isApiErrorMessage: true,
      message: { id, model: "<synthetic>", role: "assistant", content },
    });
    const events = read([
      user([{ type: "text", text: "hi" }]),
      synthetic([{ type: "text", text: "API Error: 500 Internal server error" }]),
      // Without a native id the row is read as one message.
      { ...synthetic("Prompt is too long", "not-a-uuid"), uuid: "not-a-uuid" },
      assistant("Usage: /model <name>"),
    ]);
    expect(events.map(({ kind, content, cli_output }) => [kind, content, cli_output])).toEqual([
      ["user-message", "hi", undefined],
      ["agent-message", "API Error: 500 Internal server error", true],
      ["agent-message", "Prompt is too long", true],
      ["agent-message", "Usage: /model <name>", undefined],
    ]);
  });

  it("keeps text that only quotes the tags, and drops empty output", () => {
    const events = read([
      user("Explain the literal <local-command-stdout> tag"),
      user("<command-name>/clear</command-name> and some text after it"),
      system("local_command", "<local-command-stdout></local-command-stdout>"),
      system("local_command", "not a command"),
      {
        ...system("local_command", "<local-command-stdout>meta</local-command-stdout>"),
        isMeta: true,
      },
      user("<local-command-stderr>\u001b[31mError: no such style\u001b[39m</local-command-stderr>"),
    ]);
    expect(events.map(({ kind, content }) => [kind, content])).toEqual([
      ["user-message", "Explain the literal <local-command-stdout> tag"],
      ["agent-message", "Error: no such style"],
    ]);
  });
});

describe("reading command records", () => {
  it.each([
    ["<command-name>/context</command-name><command-message>context</command-message>", "/context"],
    ["<command-name>model</command-name>\n<command-args> opus </command-args>", "/model opus"],
    [
      "<command-name>/plugin:deploy</command-name><command-args>staging</command-args>",
      "/plugin:deploy staging",
    ],
  ])("reads %j as %j", (text, expected) => {
    expect(claudeCommandInvocation(text)).toBe(expected);
  });

  it.each([
    "<command-message>context</command-message>",
    "<command-name></command-name>",
    "<command-name>two words</command-name>",
    "text <command-name>/x</command-name>",
    "<command-names>/x</command-names>",
  ])("does not read %j as an invocation", (text) => {
    expect(claudeCommandInvocation(text)).toBeNull();
  });

  it("joins stdout and stderr, and tells empty output apart from none", () => {
    expect(
      claudeCommandOutput(
        "<local-command-stdout>out</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>",
      ),
    ).toBe("out\nerr");
    expect(claudeCommandOutput("<local-command-stdout> </local-command-stdout>")).toBe("");
    expect(
      claudeCommandOutput("<local-command-stdout>x</local-command-stdout> trailing"),
    ).toBeNull();
    expect(claudeCommandOutput("plain")).toBeNull();
  });
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "slash commands in a live managed turn",
  () => {
    it("shows /compact's result as a reply and leaves out its summary", async () => {
      const f = createFakeClaude("agentkib-claude-compact-");
      cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
      const summary = randomUUID();
      const replayed = randomUUID();
      const local = randomUUID();
      f.setPlan({
        onUser: [
          {
            type: "user",
            uuid: summary,
            isSynthetic: true,
            message: {
              role: "user",
              content: "This session is being continued from a previous conversation.",
            },
          },
          {
            type: "assistant",
            uuid: local,
            parent_tool_use_id: null,
            message: {
              id: local,
              model: "<synthetic>",
              role: "assistant",
              content: [{ type: "text", text: "Set model to `Haiku 5.5` for this session only" }],
            },
          },
          {
            type: "user",
            uuid: replayed,
            isReplay: true,
            message: {
              role: "user",
              content: "<local-command-stdout>Compacted </local-command-stdout>",
            },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 12,
            num_turns: 0,
            result: "",
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
            terminal_reason: "completed",
          },
        ],
        noResult: true,
      });
      const events: Array<{ type: string; payload: Record<string, any> }> = [];
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => undefined,
        true,
        (type, payload) => events.push({ type, payload: structuredClone(payload) }),
        {},
      );
      cleanups.push(async () => {
        await runner.shutdown().catch(() => undefined);
      });
      const turnId = randomUUID();
      await runner.send(f.executable, "/compact", turnId, runner.snapshot().revision);
      await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
      // Items arrive one by one, or in a snapshot when an assistant frame finishes text.
      const items = events.flatMap(({ type, payload }) =>
        type === "item-upsert" ? [payload] : type === "snapshot" ? (payload.items ?? []) : [],
      );
      expect(items.some((item) => item.id === summary)).toBe(false);
      expect(items.filter((item) => item.kind === "user-message")).toEqual([]);
      expect(items.find((item) => item.id === replayed)).toMatchObject({
        kind: "agent-message",
        content: "Compacted",
        turn_id: turnId,
        ephemeral: false,
        cli_output: true,
      });
      expect(items.find((item) => item.id === local)).toMatchObject({
        kind: "agent-message",
        content: "Set model to `Haiku 5.5` for this session only",
        cli_output: true,
      });
      // The turn ends on the CLI's last reply.
      expect(items.at(-1)).toMatchObject({
        id: replayed,
        turn_meta: { outcome: "completed", duration_ms: 12 },
      });
      expect(runner.snapshot().lastOutcome).toBe("succeeded");
    }, 30_000);

    it("keeps a reply that was not streamed once when another frame follows it", async () => {
      const f = createFakeClaude("agentkib-claude-local-");
      cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
      const local = randomUUID();
      const text = "Set model to `Haiku 5.5` for this session only";
      // The fake ends the turn with its own assistant frame, which has no text.
      f.setPlan({
        onUser: [
          {
            type: "assistant",
            uuid: local,
            parent_tool_use_id: null,
            message: {
              id: local,
              model: "<synthetic>",
              role: "assistant",
              content: [{ type: "text", text }],
            },
          },
        ],
      });
      const contents: string[] = [];
      const marks: unknown[] = [];
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => undefined,
        true,
        (type, payload) => {
          const items =
            type === "item-upsert" ? [payload] : type === "snapshot" ? (payload.items ?? []) : [];
          for (const item of items as Array<Record<string, unknown>>)
            if (item.id === local) {
              contents.push(String(item.content));
              marks.push(item.cli_output);
            }
        },
        {},
      );
      cleanups.push(async () => {
        await runner.shutdown().catch(() => undefined);
      });
      await runner.send(
        f.executable,
        "/model claude-haiku-5-5",
        randomUUID(),
        runner.snapshot().revision,
      );
      await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
      expect(contents.length).toBeGreaterThan(1);
      expect(new Set(contents)).toEqual(new Set([text]));
      // Every copy says the CLI wrote it, including the one re-sent after the next frame.
      expect(new Set(marks)).toEqual(new Set([true]));
    }, 30_000);

    it("marks the CLI's own replies and not the model's", async () => {
      const f = createFakeClaude("agentkib-claude-cli-output-");
      cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
      const reply = randomUUID();
      const local = randomUUID();
      const frame = (id: string, model: string, text: string) => ({
        type: "assistant",
        uuid: id,
        parent_tool_use_id: null,
        message: { id, model, role: "assistant", content: [{ type: "text", text }] },
      });
      const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event });
      f.setPlan({
        onUser: [
          frame(reply, "claude-haiku-5-5", "A reply from the model.\nIt has two lines."),
          frame(local, "<synthetic>", "Usage: /rename <name>"),
          // Text the model streams afterwards; the fake's closing frame re-sends it without text.
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Streamed" },
          }),
        ],
      });
      const streamed: Array<Record<string, unknown>> = [];
      const items = new Map<string, Record<string, unknown>>();
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => undefined,
        true,
        (type, payload) => {
          const emitted =
            type === "item-upsert" ? [payload] : type === "snapshot" ? (payload.items ?? []) : [];
          for (const item of emitted as Array<Record<string, unknown>>) {
            if (item.id === reply || item.id === local) items.set(String(item.id), item);
            if (item.content === "Streamed") streamed.push(item);
          }
        },
        {},
      );
      cleanups.push(async () => {
        await runner.shutdown().catch(() => undefined);
      });
      await runner.send(f.executable, "/rename", randomUUID(), runner.snapshot().revision);
      await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
      expect(items.get(reply)).not.toHaveProperty("cli_output");
      expect(items.get(local)).toMatchObject({
        content: "Usage: /rename <name>",
        cli_output: true,
      });
      expect(streamed.length).toBeGreaterThan(0);
      for (const item of streamed) expect(item).not.toHaveProperty("cli_output");
    }, 30_000);
  },
);
