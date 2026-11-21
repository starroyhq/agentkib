import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const discoveryFault = vi.hoisted(() => ({ operation: "", path: "", code: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (operation: string, file: unknown) => {
    if (discoveryFault.operation === operation && String(file) === discoveryFault.path)
      throw Object.assign(new Error("Synthetic session discovery failure"), {
        code: discoveryFault.code,
      });
  };
  return {
    ...actual,
    default: actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      fail("readdir", args[0]);
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      fail("lstat", args[0]);
      return actual.lstatSync(...args);
    }) as typeof actual.lstatSync,
  };
});

import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { nativeImportCapability } from "../../../packages/backend/src/session-continuation";
import {
  PROBE_MAX_BYTES,
  PROBE_MAX_RECORDS,
  probeClaudeSessionFormat,
} from "../../../packages/backend/src/agents/claude/claude-session-probe";
import {
  assistantRecord,
  jsonl,
  metadataRecords,
  userRecord,
  writeTranscript,
} from "./fixtures/claude-native-session";

const roots: string[] = [];
afterEach(() => {
  discoveryFault.operation = "";
  discoveryFault.path = "";
  discoveryFault.code = "";
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-session-probe-")));
  roots.push(root);
  const projects = path.join(root, "projects");
  const directory = path.join(projects, "-synthetic-project");
  mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  /** A main session: `<project>/<uuid>.jsonl`. */
  const session = (content: string | Buffer, modified?: number) =>
    writeTranscript(directory, content, { modified });
  return { root, projects, directory, id, session };
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
/** A valid metadata record of a chosen serialized size, to fill the window without a message. */
const filler = (bytes: number) =>
  line({ type: "attachment", attachment: { type: "synthetic", text: "x".repeat(bytes - 80) } });

describe("probeClaudeSessionFormat: transcripts it accepts", () => {
  it("passes a current transcript that opens with mode and permission-mode records", () => {
    const f = fixture();
    const user = userRecord(f.id);
    const file = f.session(
      jsonl([
        { type: "mode", mode: "normal", sessionId: f.id },
        { type: "permission-mode", permissionMode: "default", sessionId: f.id },
        user,
        assistantRecord(f.id, user.uuid),
      ]),
    );
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("passes an older transcript whose first record is a user record", () => {
    const f = fixture();
    const user = userRecord(f.id);
    const file = f.session(jsonl([user, assistantRecord(f.id, user.uuid)]));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("passes an assistant record as the first message", () => {
    const f = fixture();
    const file = f.session(jsonl([...metadataRecords(f.id), assistantRecord(f.id, null)]));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("skips every known metadata record type ahead of the first message", () => {
    const f = fixture();
    const file = f.session(jsonl([...metadataRecords(f.id), userRecord(f.id)]));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("does not need to know a record type to skip it", () => {
    const f = fixture();
    const file = f.session(
      jsonl([
        { type: "record-kind-from-a-future-release", sessionId: f.id, payload: { nested: [1] } },
        { sessionId: f.id, note: "no type at all" },
        { type: 7 },
        userRecord(f.id),
      ]),
    );
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("accepts blank lines, CRLF line endings and a last record without a newline", () => {
    const f = fixture();
    const text = [
      JSON.stringify({ type: "mode", mode: "normal", sessionId: f.id }),
      "",
      JSON.stringify(userRecord(f.id)),
    ].join("\r\n");
    const file = f.session(text);
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("skips subagent records embedded in the main file", () => {
    const f = fixture();
    const file = f.session(
      jsonl([
        userRecord(f.id, { isSidechain: true }),
        assistantRecord(f.id, null, { isSidechain: true }),
        userRecord(f.id),
      ]),
    );
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("passes when the first message sits on the last line of the record window", () => {
    const f = fixture();
    const padding = Array.from({ length: PROBE_MAX_RECORDS - 1 }, () => ({
      type: "queue-operation",
      operation: "enqueue",
      sessionId: f.id,
    }));
    const file = f.session(jsonl([...padding, userRecord(f.id)]));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });

  it("passes a first message that follows a large record inside the byte window", () => {
    const f = fixture();
    const file = f.session(filler(PROBE_MAX_BYTES - 64 * 1024) + line(userRecord(f.id)));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file });
  });
});

describe("probeClaudeSessionFormat: which file is judged", () => {
  it("judges the main session when a newer subagent transcript exists", () => {
    const f = fixture();
    const main = f.session(jsonl([...metadataRecords(f.id), userRecord(f.id)]), 1_700_000_000);
    writeTranscript(
      path.join(f.directory, path.basename(main, ".jsonl"), "subagents"),
      "not even json\n",
      { name: "agent-a1b2c3.jsonl", modified: 1_800_000_000 },
    );
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: main });
  });

  it("does not let a valid subagent transcript vouch for an unreadable main session", () => {
    const f = fixture();
    const main = f.session(jsonl(metadataRecords(f.id)), 1_700_000_000);
    writeTranscript(
      path.join(f.directory, path.basename(main, ".jsonl"), "subagents"),
      jsonl([userRecord(f.id, { isSidechain: true })]),
      { name: "agent-a1b2c3.jsonl", modified: 1_800_000_000 },
    );
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file: main,
      reason: "no-conforming-record",
    });
  });

  it("ignores agent-* and other non-session names beside the main session", () => {
    const f = fixture();
    const main = f.session(jsonl([userRecord(f.id)]), 1_700_000_000);
    writeTranscript(f.directory, "garbage\n", {
      name: "agent-a1b2c3.jsonl",
      modified: 1_800_000_000,
    });
    writeTranscript(f.directory, "garbage\n", { name: "notes.jsonl", modified: 1_800_000_000 });
    writeTranscript(f.directory, "garbage\n", {
      name: `${randomUUID()}.json`,
      modified: 1_800_000_000,
    });
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: main });
  });

  it("judges the most recently modified main session across projects", () => {
    const f = fixture();
    const other = path.join(f.projects, "-another-project");
    f.session(jsonl(metadataRecords(f.id)), 1_700_000_000);
    const valid = writeTranscript(other, jsonl([userRecord(f.id)]), { modified: 1_800_000_000 });
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: valid });
    const newest = f.session(jsonl(metadataRecords(f.id)), 1_900_000_000);
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file: newest,
      reason: "no-conforming-record",
    });
  });

  it("passes when no main session exists yet", () => {
    const f = fixture();
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: null });
    expect(probeClaudeSessionFormat(path.join(f.root, "missing"))).toEqual({
      ok: true,
      file: null,
    });
  });

  it("passes when the only transcripts belong to subagents", () => {
    const f = fixture();
    writeTranscript(path.join(f.directory, randomUUID(), "subagents"), "not a main transcript\n", {
      name: "agent-example.jsonl",
    });
    writeTranscript(f.directory, "not a main transcript\n", { name: "agent-example.jsonl" });
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: null });
  });

  it.skipIf(process.platform === "win32")("does not follow symbolic links", () => {
    const f = fixture();
    const outside = path.join(f.root, "outside");
    const target = writeTranscript(outside, jsonl(metadataRecords(f.id)));
    symlinkSync(outside, path.join(f.projects, "-linked-project"), "dir");
    symlinkSync(target, path.join(f.directory, `${randomUUID()}.jsonl`));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: null });
  });
});

describe("Claude native import session discovery failures", () => {
  const capability = async (f: ReturnType<typeof fixture>) => {
    vi.spyOn(commandResolution, "resolveCommand").mockReturnValue(path.join(f.root, "bin/claude"));
    const commands = new Commands();
    const run = vi.spyOn(commands, "run").mockResolvedValue({
      bytes: Buffer.from("2.1.299 (Claude Code)\n"),
      success: true,
      error: "",
      exitCode: 0,
      truncated: false,
    });
    try {
      const result = await nativeImportCapability(
        "claude-code",
        commands,
        { HOME: f.root, USERPROFILE: f.root, CLAUDE_CONFIG_DIR: f.root, PATH: "" },
        f.root,
      );
      expect(run).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        ["--version"],
        expect.any(Object),
      );
      return result;
    } finally {
      commands.close();
    }
  };

  it.each([
    ["projects", "lstat", "EACCES"],
    ["projects", "readdir", "EACCES"],
    ["projects", "readdir", "ENOENT"],
    ["project", "readdir", "EACCES"],
    ["project", "readdir", "ENOENT"],
    ["project", "lstat", "EACCES"],
    ["project", "lstat", "ENOENT"],
    ["candidate", "lstat", "EACCES"],
    ["candidate", "lstat", "ENOENT"],
  ])(
    "closes capability for %s %s failure %s instead of accepting an older readable session",
    async (subject, operation, code) => {
      const f = fixture();
      writeTranscript(path.join(f.projects, "-readable-project"), jsonl([userRecord(f.id)]), {
        modified: 1_700_000_000,
      });
      const incompatible = f.session("incompatible native format\n", 1_800_000_000);
      const file =
        subject === "projects" ? f.projects : subject === "project" ? f.directory : incompatible;
      Object.assign(discoveryFault, { operation, path: file, code });
      expect(probeClaudeSessionFormat(f.projects)).toEqual({
        ok: false,
        file,
        reason: "unreadable",
      });
      expect(await capability(f)).toMatchObject({
        supported: false,
        reason: "session-format-unverified",
      });
    },
  );

  it.each(["fresh-install", "empty", "subagent-only"])(
    "retains native import support for %s",
    async (state) => {
      const f = fixture();
      if (state === "fresh-install") rmSync(f.projects, { recursive: true });
      if (state === "subagent-only")
        writeTranscript(
          path.join(f.directory, randomUUID(), "subagents"),
          "not a main transcript\n",
          { name: "agent-example.jsonl" },
        );
      expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: true, file: null });
      expect(await capability(f)).toEqual({ supported: true, beta: true });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["project", "projects"])(
    "rejects a real unlistable %s directory",
    async (subject) => {
      const f = fixture();
      f.session("incompatible native format\n");
      const directory = subject === "projects" ? f.projects : f.directory;
      chmodSync(directory, 0o300);
      try {
        expect(probeClaudeSessionFormat(f.projects)).toEqual({
          ok: false,
          file: directory,
          reason: "unreadable",
        });
        expect(await capability(f)).toMatchObject({
          supported: false,
          reason: "session-format-unverified",
        });
      } finally {
        chmodSync(directory, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")("does not follow a linked projects root", async () => {
    const f = fixture();
    const linked = path.join(f.root, "linked-projects");
    symlinkSync(f.projects, linked, "dir");
    expect(probeClaudeSessionFormat(linked)).toEqual({
      ok: false,
      file: linked,
      reason: "unreadable",
    });
  });
});

describe("probeClaudeSessionFormat: failing closed", () => {
  it("fails when the window holds only metadata records", () => {
    const f = fixture();
    const file = f.session(jsonl(metadataRecords(f.id)));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "no-conforming-record",
    });
  });

  it("fails when only subagent messages are present", () => {
    const f = fixture();
    const file = f.session(jsonl([userRecord(f.id, { isSidechain: true })]));
    expect(probeClaudeSessionFormat(f.projects)).toMatchObject({
      ok: false,
      file,
      reason: "no-conforming-record",
    });
  });

  it("fails on an empty file", () => {
    const f = fixture();
    const file = f.session("");
    expect(probeClaudeSessionFormat(f.projects)).toEqual({ ok: false, file, reason: "empty" });
  });

  it.each([
    ["text that is not JSON", "this is not a transcript\n"],
    ["a truncated JSON object", '{"type":"user","sessionId":"x"\n'],
    ["a JSON array", "[1,2,3]\n"],
    ["a JSON string", '"just text"\n'],
    ["a JSON null", "null\n"],
    ["bytes that are not UTF-8", Buffer.from([0xff, 0xfe, 0x7b, 0x7d, 0x0a])],
  ])("fails on corrupted content: %s", (_name, content) => {
    const f = fixture();
    const file = f.session(content);
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "malformed-record",
    });
  });

  it("fails on a corrupted line even when a valid message follows it", () => {
    const f = fixture();
    const file = f.session(`{broken\n${line(userRecord(f.id))}`);
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "malformed-record",
    });
  });

  it("fails on an over-long first line without reading it all", () => {
    const f = fixture();
    const huge = line({ type: "attachment", text: "x".repeat(PROBE_MAX_BYTES) });
    const file = f.session(huge + line(userRecord(f.id)));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "record-too-large",
    });
  });

  it("fails when the first message would end beyond the byte window", () => {
    const f = fixture();
    const third = 1_600_000;
    const file = f.session(filler(third) + filler(third) + filler(third) + line(userRecord(f.id)));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "record-too-large",
    });
  });

  it("fails when the first message is beyond the record window", () => {
    const f = fixture();
    const padding = Array.from({ length: PROBE_MAX_RECORDS }, () => ({
      type: "queue-operation",
      operation: "enqueue",
      sessionId: f.id,
    }));
    const file = f.session(jsonl([...padding, userRecord(f.id)]));
    expect(probeClaudeSessionFormat(f.projects)).toEqual({
      ok: false,
      file,
      reason: "no-conforming-record",
    });
  });

  describe("a message record with an unexpected structure", () => {
    const broken = (id: string, role: "user" | "assistant", change: Record<string, unknown>) =>
      role === "user" ? userRecord(id, change) : assistantRecord(id, null, change);

    it.each([
      ["no sessionId", { sessionId: undefined }],
      ["an empty sessionId", { sessionId: "" }],
      ["a numeric sessionId", { sessionId: 7 }],
      ["no uuid", { uuid: undefined }],
      ["an empty uuid", { uuid: "" }],
      ["no message", { message: undefined }],
      ["a null message", { message: null }],
      ["a string message", { message: "text" }],
      ["an array message", { message: [] }],
    ])("fails for a user record with %s", (_name, change) => {
      const f = fixture();
      const file = f.session(
        jsonl([{ type: "mode", sessionId: f.id }, broken(f.id, "user", change)]),
      );
      expect(probeClaudeSessionFormat(f.projects)).toEqual({
        ok: false,
        file,
        reason: "unexpected-record-shape",
      });
    });

    it("fails for an assistant record with no message", () => {
      const f = fixture();
      const file = f.session(jsonl([broken(f.id, "assistant", { message: undefined })]));
      expect(probeClaudeSessionFormat(f.projects)).toEqual({
        ok: false,
        file,
        reason: "unexpected-record-shape",
      });
    });

    it("does not let a later valid message vouch for an earlier malformed one", () => {
      const f = fixture();
      const file = f.session(
        jsonl([broken(f.id, "user", { sessionId: undefined }), userRecord(f.id)]),
      );
      expect(probeClaudeSessionFormat(f.projects)).toEqual({
        ok: false,
        file,
        reason: "unexpected-record-shape",
      });
    });
  });
});
