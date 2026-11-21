import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeProjectKey } from "../../../packages/backend/src/agents/claude/claude-project-path";
import { verifyClaudeTranscript } from "../../../packages/backend/src/agents/claude/claude-native-verify";
import * as claudeSessionProbe from "../../../packages/backend/src/agents/claude/claude-session-probe";
import {
  launchPreparedHandoff,
  verifyNativeSession,
  type PreparedHandoffLaunch,
} from "../../../packages/backend/src/session-handoff-launch";
import {
  CLAUDE_RECORD_SCHEMA_VERSION,
  renderNative,
} from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";

vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    throw new Error("terminal dispatch reached");
  }),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const document = {
  turns: [
    { role: "user", timestamp: "2026-10-13T00:00:00.000Z", blocks: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      timestamp: "2026-10-13T00:00:01.000Z",
      blocks: [{ type: "text", text: "hello" }],
    },
    { role: "user", timestamp: "2026-10-13T00:00:02.000Z", blocks: [{ type: "text", text: "go" }] },
  ],
} as unknown as SessionDocument;

type Record_ = Record<string, unknown>;

/** A session written by the real renderer into a synthetic projects directory. */
function written(source = document) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-readback-")));
  roots.push(root);
  const workspace = path.join(root, "work space");
  const projects = path.join(root, "claude", "projects");
  const key = claudeProjectKey(workspace);
  if (!key.ok) throw new Error("key");
  const directory = path.join(projects, key.key);
  const sessionId = randomUUID();
  const file = path.join(directory, `${sessionId}.jsonl`);
  const records = renderNative(
    source,
    "claude-code",
    sessionId,
    workspace,
    "2026-10-13T00:00:00.000Z",
    "notice",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
  const put = (rows: Record_[], target = file) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return target;
  };
  const expected = { sessionId, workspace, directory };
  return { root, workspace, projects, directory, sessionId, file, records, put, expected };
}

describe("Claude native import read-back", () => {
  it("accepts what the renderer wrote and stamps the documented schema version", () => {
    const w = written();
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code", w.expected)).not.toThrow();
    const messages = w.records.filter((record) => record.type !== "last-prompt");
    expect(messages).toHaveLength(4);
    expect(messages.every((record) => record.version === CLAUDE_RECORD_SCHEMA_VERSION)).toBe(true);
  });

  it("refuses to judge a Claude session without the launch's expectation", () => {
    const w = written();
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code")).toThrow(/expectation is missing/);
  });

  it("round-trips Unicode, consecutive roles, tools and inline attachments", () => {
    const w = written({
      ...document,
      turns: [
        {
          id: "user",
          role: "user",
          blocks: [{ type: "text", text: "中文🙂 e\u0301\n/path/项目" }],
        },
        {
          id: "tool-call",
          role: "assistant",
          blocks: [
            { type: "text", text: "读取合成内容" },
            { type: "tool-call", call_id: "call-1", name: "Read", input: '{"path":"测试"}' },
          ],
        },
        {
          id: "assistant",
          role: "assistant",
          blocks: [{ type: "text", text: "同角色的下一条" }],
        },
        {
          id: "tool-result",
          role: "tool",
          blocks: [
            { type: "tool-result", call_id: "call-1", output: "合成输出", is_error: false },
            {
              type: "attachment",
              kind: "document",
              media_type: "text/plain",
              filename: "记录.txt",
              inline_base64: Buffer.from("合成附件").toString("base64"),
            },
            {
              type: "attachment",
              kind: "image",
              media_type: "image/png",
              inline_base64: Buffer.from("synthetic binary fixture").toString("base64"),
            },
          ],
        },
      ],
    });
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code", w.expected)).not.toThrow();
  });

  it("accepts a complete string message without dropping its whitespace or Unicode", () => {
    const w = written();
    (w.records[2]!.message as Record_).content = "  完整正文🙂\n下一行  ";
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code", w.expected)).not.toThrow();
  });

  it("rejects a disk snapshot whose role differs from the strictly checked text", () => {
    const w = written();
    w.put(w.records);
    const checkedText = readFileSync(w.file, "utf8");
    // Same byte length as "assistant": comparing size alone must not pass.
    (w.records[2]!.message as Record_).role = "developer";
    w.put(w.records);
    // The tolerant history reader derives the role from record.type, not message.role.
    expect(() => verifyClaudeTranscript(w.file, checkedText, w.expected)).toThrow(
      /transcript changed during read-back/,
    );
  });

  const message = (records: Record_[], index = 1) => records[index]!;
  const corruptions: Array<[string, RegExp, (w: ReturnType<typeof written>) => string]> = [
    [
      "a repeated uuid",
      /repeats a uuid/,
      (w) => {
        message(w.records, 2).uuid = message(w.records, 1).uuid;
        return w.put(w.records);
      },
    ],
    [
      "a dangling parentUuid",
      /dangling or out-of-order parentUuid/,
      (w) => {
        message(w.records, 2).parentUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a parentUuid on the first message",
      /dangling or out-of-order parentUuid/,
      (w) => {
        message(w.records, 0).parentUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a different sessionId",
      /different sessionId/,
      (w) => {
        message(w.records, 2).sessionId = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a different cwd",
      /different cwd/,
      (w) => {
        message(w.records, 2).cwd = path.join(w.root, "elsewhere");
        return w.put(w.records);
      },
    ],
    [
      "a file outside the derived project directory",
      /project directory/,
      (w) => w.put(w.records, path.join(w.projects, "-other", `${w.sessionId}.jsonl`)),
    ],
    [
      "a file name that differs from the session id",
      /file name/,
      (w) => w.put(w.records, path.join(w.directory, `${randomUUID()}.jsonl`)),
    ],
    [
      "a malformed JSON line",
      /not valid JSON/,
      (w) => {
        w.put(w.records);
        const text = JSON.stringify(w.records[0]) + "\n{not json\n";
        writeFileSync(w.file, text);
        return w.file;
      },
    ],
    [
      "an unexpected record type",
      /unexpected record type/,
      (w) => {
        w.records.splice(2, 0, { type: "mystery", sessionId: w.sessionId });
        return w.put(w.records);
      },
    ],
    [
      "a malformed first record",
      /no valid message/,
      (w) => {
        // The chain and identity stay valid; only the record shape the CLI expects is gone.
        delete message(w.records, 0).message;
        return w.put(w.records);
      },
    ],
    ...[1, 2, 3].map((index): (typeof corruptions)[number] => [
      `a missing message on record ${index + 1}`,
      /no valid message/,
      (w) => {
        delete message(w.records, index).message;
        return w.put(w.records);
      },
    ]),
    [
      "a later null message",
      /no valid message/,
      (w) => {
        message(w.records, 2).message = null;
        return w.put(w.records);
      },
    ],
    [
      "a later message without content",
      /no valid message content/,
      (w) => {
        delete (message(w.records, 2).message as Record_).content;
        return w.put(w.records);
      },
    ],
    [
      "a later message role mismatch",
      /mismatched message role/,
      (w) => {
        (message(w.records, 2).message as Record_).role = "user";
        return w.put(w.records);
      },
    ],
    [
      "a later message with a missing text field",
      /invalid text/,
      (w) => {
        (message(w.records, 2).message as Record_).content = [{ type: "text" }];
        return w.put(w.records);
      },
    ],
    [
      "a later message with an unsupported block",
      /unsupported content block/,
      (w) => {
        (message(w.records, 2).message as Record_).content = [
          { type: "text", text: "retained" },
          { type: "unknown", text: "would be silently dropped" },
        ];
        return w.put(w.records);
      },
    ],
    [
      "a later message hidden as a sidechain",
      /not an ordinary main-session message/,
      (w) => {
        message(w.records, 2).isSidechain = true;
        return w.put(w.records);
      },
    ],
    [
      "a later message hidden as a compaction summary",
      /not an ordinary main-session message/,
      (w) => {
        message(w.records, 3).isCompactSummary = true;
        return w.put(w.records);
      },
    ],
    [
      "a later text block hidden as CLI echo",
      /loses message content/,
      (w) => {
        (message(w.records, 2).message as Record_).content = [
          { type: "text", text: "retained" },
          { type: "text", text: "<command-name>hidden</command-name>" },
        ];
        return w.put(w.records);
      },
    ],
    [
      "a later record beyond the full reader's line limit",
      /complete history reader changed or omitted/,
      (w) => {
        (message(w.records, 2).message as Record_).content = "x".repeat(4 * 1024 * 1024);
        return w.put(w.records);
      },
    ],
    [
      "a last-prompt that points elsewhere",
      /last-prompt/,
      (w) => {
        w.records.at(-1)!.leafUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "an empty file",
      /empty/,
      (w) => {
        mkdirSync(w.directory, { recursive: true });
        writeFileSync(w.file, "");
        return w.file;
      },
    ],
  ];

  it.each(corruptions)("fails on %s", (_name, reason, corrupt) => {
    const w = written();
    const file = corrupt(w);
    expect(() => verifyNativeSession(file, "claude-code", w.expected)).toThrow(reason);
  });

  describe("at launch", () => {
    function launch(w: ReturnType<typeof written>) {
      const home = path.join(w.root, "home");
      const environment = {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(w.root, "claude"),
      } as NodeJS.ProcessEnv;
      const prepared = {
        request: {
          mode: "native-session",
          workspace_id: "workspace",
          target_agent: "claude-code",
          target_session_id: w.sessionId,
          target_path: w.file,
        },
        terminal: { kind: "macos", executable: "/nonexistent-terminal" },
        command: { executable: "/nonexistent-claude", arguments: [], cwd: w.workspace },
        workspace: w.workspace,
        validateOwnership: () => {},
      } as PreparedHandoffLaunch;
      return launchPreparedHandoff(prepared, path.join(w.root, "data"), environment);
    }

    it("reaches the terminal step for a sound session", async () => {
      const w = written();
      w.put(w.records);
      // The stub records dispatch without starting a terminal or CLI.
      await expect(launch(w)).rejects.toThrow(/terminal dispatch reached/);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("stops before any terminal is opened when the read-back fails", async () => {
      const w = written();
      w.records[2]!.parentUuid = randomUUID();
      w.put(w.records);
      await expect(launch(w)).rejects.toThrow(/Claude session read-back failed/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("rejects a role change between the probe and full reader before dispatching", async () => {
      const w = written();
      w.put(w.records);
      const probe = claudeSessionProbe.probeClaudeSessionFile;
      vi.spyOn(claudeSessionProbe, "probeClaudeSessionFile").mockImplementationOnce((file) => {
        const result = probe(file);
        (w.records[2]!.message as Record_).role = "user";
        w.put(w.records);
        return result;
      });
      await expect(launch(w)).rejects.toThrow(/transcript changed during read-back/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it.each([
      [
        "missing message",
        /no valid message/,
        (row: Record_) => {
          delete row.message;
        },
      ],
      [
        "null message",
        /no valid message/,
        (row: Record_) => {
          row.message = null;
        },
      ],
      [
        "missing content",
        /no valid message content/,
        (row: Record_) => {
          delete (row.message as Record_).content;
        },
      ],
      [
        "mismatched role",
        /mismatched message role/,
        (row: Record_) => {
          (row.message as Record_).role = "user";
        },
      ],
      [
        "incomplete full read-back",
        /complete history reader changed or omitted/,
        (row: Record_) => {
          (row.message as Record_).content = "x".repeat(4 * 1024 * 1024);
        },
      ],
    ] as const)(
      "refuses %s on reopen before dispatching any process",
      async (_name, reason, corrupt) => {
        const w = written();
        w.put(w.records);
        await expect(launch(w)).rejects.toThrow(/terminal dispatch reached/);
        expect(spawn).toHaveBeenCalledTimes(1);
        vi.mocked(spawn).mockClear();

        // Reopen does not apply a ChangeSet again. The completed import must be re-read fully.
        corrupt(w.records[2]!);
        w.put(w.records);
        await expect(launch(w)).rejects.toThrow(reason);
        expect(spawn).not.toHaveBeenCalled();
      },
    );

    it("stops when the workspace's project directory cannot be derived", async () => {
      const w = written();
      w.put(w.records);
      const long = { ...w, workspace: path.join(w.root, "x".repeat(300)) };
      await expect(launch(long)).rejects.toThrow(/project directory cannot be determined/);
    });
  });
});
