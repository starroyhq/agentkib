// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DshBridgeDocumentRecord } from "../../../packages/runtime-protocol/src/dsh-bridge";
import { Commands } from "../../../packages/backend/src/commands";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import {
  dshSearchRecords,
  dshSessionDocument,
  type DshDocumentImage,
} from "../../../packages/backend/src/dsh-document";

const source = {
  agent: "deepseek-harness" as const,
  workspace_id: "workspace",
  title: "DSH session",
  created_at: null,
  updated_at: null,
  git_branch: null,
};
const IMAGE = "sha256:" + "a".repeat(64);

/**
 * A conversation DSH compacted once, as DSH 0.2.2-rc.1 does it: the summary takes the place of the
 * history it replaced on the model surface, ahead of the last reply it left there.
 */
function compacted(): DshBridgeDocumentRecord[] {
  const base = { time: 1_700_000_000_000, truncated: false };
  const off = { current: false, position: null };
  const at = (position: number) => ({ current: true, position });
  return [
    { ...base, ...off, seq: 1, kind: "user", text: "Old question", images: [], files: 0 },
    {
      ...base,
      ...off,
      seq: 2,
      kind: "assistant",
      text: "Old answer",
      calls: [{ id: "call-old", name: "read_file", arguments: '{"path":"a.ts"}', truncated: false }],
      reasoning: true,
    },
    {
      ...base,
      ...off,
      seq: 3,
      kind: "tool-result",
      callId: "call-old",
      isError: false,
      text: "file a",
      images: 0,
    },
    // Left on the surface by the compaction, which then put its summary ahead of it.
    {
      ...base,
      ...at(1),
      seq: 4,
      kind: "assistant",
      text: "Kept answer",
      calls: [],
      reasoning: false,
    },
    { ...base, ...at(0), seq: 5, kind: "summary", text: "Earlier: the user asked about a.ts." },
    {
      ...base,
      ...at(2),
      seq: 6,
      kind: "user",
      text: "New question",
      images: [{ attachmentId: IMAGE, mediaType: "image/png", name: "shot.png" }],
      files: 0,
    },
    {
      ...base,
      ...at(3),
      seq: 7,
      kind: "assistant",
      text: "",
      calls: [{ id: "call-new", name: "bash", arguments: '{"cmd":"ls"}', truncated: false }],
      reasoning: false,
    },
    // A shorter replacement of a tool result, as DSH's tool result pruner makes one.
    {
      ...base,
      ...off,
      seq: 8,
      kind: "tool-result",
      callId: "call-new",
      isError: false,
      text: "full listing",
      images: 0,
    },
    {
      ...base,
      ...at(4),
      seq: 9,
      kind: "tool-result",
      callId: "call-new",
      isError: false,
      text: "pruned listing",
      images: 0,
    },
  ];
}

describe("reading a DeepSeek Harness session for a handoff", () => {
  it("asks the running DSH, with the choice about compacted history", async () => {
    const summary = {
      id: "ak-session-1",
      agent: "deepseek-harness" as const,
      native_ref: "session-1",
      workspace_id: "workspace",
      title: "DSH session",
      created_at: null,
      updated_at: null,
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable" as const,
      origin: "interactive" as const,
      spawned_by_session_id: null,
      forked_from_session_id: null,
    };
    const store = {
      get: (id: string) => (id === summary.id ? summary : null),
      id: (_agent: string, ref: string) => `ak-${ref}`,
      workspacePath: () => "/workspace",
      identitySalt: () => "salt",
    };
    const document = dshSessionDocument(source, compacted(), new Map());
    const dsh = {
      list: () => ({ sessions: [summary], incomplete: false }),
      events: vi.fn(),
      image: vi.fn(),
      document: vi.fn(async () => document),
    };
    const commands = new Commands();
    const readers = new SessionReaders(
      store as never,
      commands,
      {},
      { profiles: () => [] },
      dsh as never,
    );
    try {
      await expect(
        readers.document(summary.id, { includePreCompactionHistory: true }),
      ).resolves.toBe(document);
      expect(dsh.document).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ agent: "deepseek-harness", workspace_id: "workspace" }),
        { includePreCompactionHistory: true },
      );
    } finally {
      readers.close();
      commands.close();
    }
  });
});

describe("DeepSeek Harness session documents", () => {
  it("hands over what DSH's model sees now and counts what a compaction replaced", () => {
    const images = new Map<string, DshDocumentImage | null>([
      [IMAGE, { mediaType: "image/png", base64: "iVBORw0KGgo=" }],
    ]);
    const document = dshSessionDocument(source, compacted(), images);
    // In the order DSH's model sees them: the summary, the reply it kept, then what followed.
    expect(document.turns.map((turn) => [turn.role, turn.kind ?? null])).toEqual([
      ["user", "context-summary"],
      ["assistant", null],
      ["user", null],
      ["assistant", null],
      ["tool", null],
    ]);
    expect(document.turns[1]!.blocks).toEqual([{ type: "text", text: "Kept answer" }]);
    expect(document.turns[0]!.blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(
        /^\[AgentKib: context summary generated by DeepSeek Harness[^\n]*\n\nEarlier: the user asked/,
      ),
    });
    expect(document.turns[2]!.blocks).toEqual([
      { type: "text", text: "New question" },
      {
        type: "attachment",
        kind: "image",
        media_type: "image/png",
        filename: "shot.png",
        inline_base64: "iVBORw0KGgo=",
      },
    ]);
    expect(document.turns[4]!.blocks).toEqual([
      { type: "tool-result", call_id: "call-new", output: "pruned listing", is_error: false },
    ]);
    // The old user message, answer and tool result, and the full tool output that was pruned.
    expect(document.losses).toEqual([{ code: "compacted-history", count: 4 }]);
  });

  it("keeps the whole log in order with a marker where DSH compacted", () => {
    const document = dshSessionDocument(source, compacted(), new Map(), {
      includePreCompactionHistory: true,
    });
    expect(document.turns.map((turn) => turn.kind ?? turn.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "compaction-boundary",
      "context-summary",
      "user",
      "assistant",
      "tool",
    ]);
    expect(document.turns[1]!.blocks).toEqual([
      { type: "text", text: "Old answer" },
      { type: "tool-call", call_id: "call-old", name: "read_file", input: '{"path":"a.ts"}' },
    ]);
    // The original tool output, not the pruned copy.
    expect(document.turns[8]!.blocks).toEqual([
      { type: "tool-result", call_id: "call-new", output: "full listing", is_error: false },
    ]);
    expect(document.turns[4]!.blocks[0]).toMatchObject({
      text: expect.stringContaining("compacted the conversation here (compaction 1 of 1)"),
    });
    expect(document.losses).toEqual(
      expect.arrayContaining([
        { code: "reasoning-excluded", count: 1 },
        { code: "external-attachment", count: 1 },
      ]),
    );
    expect(document.losses.some((loss) => loss.code === "compacted-history")).toBe(false);
  });

  it("names truncated text, orphan results and redacts secrets", () => {
    const document = dshSessionDocument(
      source,
      [
        {
          seq: 1,
          time: null,
          current: true,
          position: 0,
          kind: "user",
          text: "token sk-ant-api03-" + "x".repeat(40),
          truncated: true,
          images: [],
          files: 1,
        },
        {
          seq: 2,
          time: null,
          current: true,
          position: 1,
          truncated: false,
          kind: "tool-result",
          callId: "missing",
          isError: true,
          text: "boom",
          images: 2,
        },
      ],
      new Map(),
    );
    expect(document.redaction_count).toBeGreaterThan(0);
    expect(JSON.stringify(document.turns)).not.toContain("x".repeat(40));
    expect(document.losses).toEqual(
      expect.arrayContaining([
        { code: "source-content-truncated", count: 1 },
        { code: "external-attachment", count: 3 },
        { code: "orphan-tool-result", count: 1 },
      ]),
    );
  });

  it("refuses a session with nothing to hand over", () => {
    expect(() => dshSessionDocument(source, [], new Map())).toThrow(
      "Conversation does not contain readable original records",
    );
  });

  it("searches every message and tool in the log but not DSH's summaries", () => {
    expect(dshSearchRecords(compacted())).toEqual([
      expect.objectContaining({ recordId: "dsh:1:text", kind: "user", content: "Old question" }),
      expect.objectContaining({ recordId: "dsh:2:text", kind: "assistant", content: "Old answer" }),
      expect.objectContaining({
        recordId: "call:call-old:input",
        kind: "tool-input",
        toolName: "read_file",
      }),
      expect.objectContaining({
        recordId: "call:call-old:output",
        kind: "tool-output",
        toolName: "read_file",
        content: "file a",
      }),
      expect.objectContaining({ recordId: "dsh:4:text", kind: "assistant", content: "Kept answer" }),
      expect.objectContaining({ recordId: "dsh:6:text", kind: "user", content: "New question" }),
      expect.objectContaining({ recordId: "call:call-new:input", toolName: "bash" }),
      expect.objectContaining({ recordId: "call:call-new:output", content: "full listing" }),
      expect.objectContaining({ recordId: "call:call-new:output", content: "pruned listing" }),
    ]);
  });
});
