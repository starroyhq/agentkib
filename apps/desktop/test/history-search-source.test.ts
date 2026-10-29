import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setImmediate as nextIoTurn } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readHistorySearchSource,
  sanitizeHistorySourceText,
  type HistorySourceInput,
  type HistorySourceRecord,
} from "../../../packages/backend/src/history-search-source";
import * as sourceIdentity from "../../../packages/backend/src/history-search-source-identity";
import { HISTORY_SEARCH_SANITIZER_VERSION } from "../../../packages/backend/src/history-search-source-types";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import {
  claudeLineageFields,
  readJsonlSearchSource,
} from "../../../packages/backend/src/history-search-source-jsonl";
import { HistorySearchStore } from "../../../packages/backend/src/history-search-store";
import { sessionIdentity, type NativeSession } from "../../../packages/backend/src/session-store";
import { ClaudeSessions } from "../../../packages/backend/src/claude-sessions";
import { GrokSessions } from "../../../packages/backend/src/grok-sessions";
import { HermesSessions } from "../../../packages/backend/src/hermes-sessions";
import { OpenClawSessions } from "../../../packages/backend/src/openclaw-sessions";
import { OpenCodeSessions } from "../../../packages/backend/src/opencode-sessions";
import { AntigravitySessions } from "../../../packages/backend/src/antigravity-sessions";
import { prepareCursorIdePayload } from "../../../packages/backend/src/cursor-ide-sessions";
import { stableNativeRef } from "../../../packages/backend/src/session-history";
import { canonicalize } from "../../../packages/backend/src/paths";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import {
  assistant,
  boundary,
  duplicateToolUuidSession,
  duplicateUuidSession,
  futureLogicalParentSession,
  heavilyRetainedSession,
  preservedSegmentSession,
  retainedRewriteSession,
  retainedToolRewriteSession,
  specificationSession,
  summary,
  twiceRetainedRewriteSession,
  user,
} from "./fixtures/claude-compaction-session";

const roots: string[] = [];
const close: Array<() => void> = [];
const timestamp = "2026-10-08T00:00:00.000Z";
const longText = "完整文本🙂汉字 e\u0301 ".repeat(18_000) + " END_AFTER_256_KIB";
afterEach(() => {
  vi.restoreAllMocks();
  for (const action of close.splice(0).reverse()) action();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(agent: NativeSession["agent"], nativeRef = "synthetic-native") {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "history-source-")));
  roots.push(root);
  const project = path.join(root, "project");
  mkdirSync(project);
  const native: NativeSession = {
    agent,
    native_ref: nativeRef,
    title: "Synthetic",
    created_at: timestamp,
    updated_at: timestamp,
    message_count: 2,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
    origin: "interactive",
    spawned_by_session_id: null,
    forked_from_session_id: null,
  };
  const identitySalt = "synthetic-history-identity-salt";
  const sessionId = sessionIdentity(identitySalt, agent, nativeRef);
  const input: HistorySourceInput = {
    sessionId,
    summary: {
      ...native,
      id: sessionId,
      workspace_id: "registered",
      spawned_by_session_id: null,
      forked_from_session_id: null,
    },
    workspacePath: project,
    environment: { HOME: root, USERPROFILE: root, PATH: root },
    identitySalt,
    profiles: [],
  };
  const file = path.join(root, "history.jsonl");
  const resolve = () =>
    vi.spyOn(SessionReaders.prototype, "resolve").mockResolvedValue({
      summary: input.summary,
      native,
      workspace: project,
      transcript: file,
    });
  const write = (values: unknown[]) =>
    writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const read = async () => {
    const records: HistorySourceRecord[] = [];
    const result = await readHistorySearchSource(input, (record) => {
      records.push(record);
    });
    return { ...result, records };
  };
  return { root, project, native, input, file, resolve, write, read };
}
const codexText = (type: string, message: string) => ({
  type: "event_msg",
  timestamp,
  payload: { type, message },
});
const codexMirror = (role: string, text: string) => ({
  type: "response_item",
  timestamp,
  payload: { type: "message", role, content: [{ type: "input_text", text }] },
});

describe("complete history search source extraction", () => {
  function hermesFixture() {
    const f = fixture("hermes");
    const home = path.join(f.root, ".hermes");
    mkdirSync(home);
    f.input.environment.HERMES_HOME = home;
    const db = new DatabaseSync(path.join(home, "state.db"));
    close.push(() => db.close());
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT,started_at TEXT,updated_at TEXT);
      CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,timestamp TEXT);`);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "s",
      "Synthetic",
      f.project,
      timestamp,
      timestamp,
    );
    db.prepare("INSERT INTO messages VALUES(?,?,?,?)").run(
      "s",
      "assistant",
      "allowed body",
      timestamp,
    );
    const native = new HermesSessions(f.input.environment).list(f.project).sessions[0]!.session;
    f.input.sessionId = sessionIdentity(f.input.identitySalt, "hermes", native.native_ref);
    f.input.summary = {
      ...native,
      id: f.input.sessionId,
      workspace_id: "registered",
      spawned_by_session_id: null,
      forked_from_session_id: null,
    };
    return { ...f, db };
  }

  it.each(["Renamed native label", null])(
    "binds native WAL-only title changes to %s even while the business summary is unchanged",
    async (title) => {
      const f = hermesFixture();
      const before = await f.read();
      f.db.prepare("UPDATE sessions SET title=?").run(title);
      const after = await f.read();
      expect(f.input.summary.title).toBe("Synthetic");
      expect(after.records).toEqual(before.records);
      expect(after.sourceRevision).not.toBe(before.sourceRevision);
    },
  );

  it("keeps the native linked-JSONL ownership fallback explicit when SQL metadata has no cwd", async () => {
    const f = hermesFixture();
    const sessions = path.join(f.input.environment.HERMES_HOME!, "sessions");
    mkdirSync(sessions);
    writeFileSync(
      path.join(sessions, "s.jsonl"),
      JSON.stringify({ type: "session", id: "s", cwd: f.project, title: "Synthetic" }) + "\n",
    );
    f.db.prepare("UPDATE sessions SET cwd=NULL").run();
    const result = await f.read();
    expect(result.records.map((record) => record.content)).toEqual(["allowed body"]);
    expect(result).toMatchObject({
      status: "partial",
      limitations: ["hermes-workspace-from-linked-history"],
    });
    rmSync(path.join(sessions, "s.jsonl"));
    await expect(f.read()).rejects.toThrow("history-source-unavailable");
  });

  it("rejects ambiguous native SQL metadata before reading messages", async () => {
    const f = hermesFixture();
    f.db.prepare("INSERT INTO sessions SELECT * FROM sessions").run();
    const records: HistorySourceRecord[] = [];
    await expect(
      readHistorySearchSource(f.input, (record) => {
        records.push(record);
      }),
    ).rejects.toThrow("history-source-owner-changed");
    expect(records).toEqual([]);
  });

  it("rejects native ownership changes between lookup and SQL snapshot before emitting foreign records", async () => {
    const f = hermesFixture();
    const other = path.join(f.root, "other");
    mkdirSync(other);
    const resolve = HermesSessions.prototype.resolve;
    vi.spyOn(HermesSessions.prototype, "resolve").mockImplementation(function (ref) {
      const source = resolve.call(this, ref);
      f.db.prepare("UPDATE sessions SET cwd=?").run(other);
      f.db.prepare("UPDATE messages SET content=?").run("FOREIGN_WORKSPACE_BODY");
      return source;
    });
    const records: HistorySourceRecord[] = [];
    await expect(
      readHistorySearchSource(f.input, (record) => {
        records.push(record);
        // A post-read lookup alone must not permit a transient foreign snapshot.
        f.db.prepare("UPDATE sessions SET cwd=?").run(f.project);
      }),
    ).rejects.toThrow("history-source-owner-changed");
    expect(records).toEqual([]);
  });

  it("rejects a source that changes workspace while its safe snapshot is being staged", async () => {
    const f = hermesFixture();
    const other = path.join(f.root, "other");
    mkdirSync(other);
    const records: HistorySourceRecord[] = [];
    await expect(
      readHistorySearchSource(f.input, (record) => {
        records.push(record);
        f.db.prepare("UPDATE sessions SET cwd=?").run(other);
        f.db.prepare("UPDATE messages SET content=?").run("FOREIGN_WORKSPACE_BODY");
      }),
    ).rejects.toThrow("history-source-owner-changed");
    expect(records.map((record) => record.content)).toEqual(["allowed body"]);
  });

  it("rejects native labels changed during a staged read", async () => {
    const f = hermesFixture();
    await expect(
      readHistorySearchSource(f.input, () => {
        f.db.prepare("UPDATE sessions SET title=?").run("Changed during read");
      }),
    ).rejects.toThrow("history-source-changed");
  });

  it("keeps structured redaction and delimiter-prefixed prose distinct", () => {
    expect(
      sanitizeHistorySourceText('{"password":"synthetic-private-value","text":"visible"}'),
    ).toContain('"password": "[REDACTED]"');
    expect(sanitizeHistorySourceText("[ordinary prose without a JSON closing delimiter")).toBe(
      "[ordinary prose without a JSON closing delimiter",
    );
    expect(sanitizeHistorySourceText("{ordinary prose without JSON properties")).toBe(
      "{ordinary prose without JSON properties",
    );
  });

  it("rejects structured redaction failures without emitting unredacted source content", async () => {
    const f = fixture("codex");
    f.resolve();
    const secret = "synthetic-deep-json-password";
    const content = "[".repeat(5_000) + JSON.stringify({ password: secret }) + "]".repeat(5_000);
    expect(Buffer.byteLength(content)).toBeLessThan(16 * 1024);
    expect(() => sanitizeHistorySourceText(content)).toThrow("history-source-redaction-failed");
    f.write([codexText("user_message", "safe body"), codexText("agent_message", content)]);
    const records: HistorySourceRecord[] = [];
    await expect(
      readHistorySearchSource(f.input, (record) => {
        records.push(record);
      }),
    ).rejects.toThrow("history-source-redaction-failed");
    expect(records.map((record) => record.content)).toEqual(["safe body"]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("marks malformed Codex body events and unsupported tool records as partial", async () => {
    const f = fixture("codex");
    f.resolve();
    f.write([
      codexText("user_message", "preserved body"),
      { type: "event_msg", payload: { type: "agent_message", message: 123 } },
      {
        type: "response_item",
        payload: {
          type: "web_search_call",
          id: "search-call",
          status: "completed",
          action: { type: "search", query: "OMITTED_SEARCH_SENTINEL" },
        },
      },
    ]);
    const result = await f.read();
    expect(result).toMatchObject({
      status: "partial",
      limitations: ["damaged-record", "unsupported-tool-record"],
    });
    expect(result.records.map((record) => record.content)).toEqual(["preserved body"]);
  });

  it("reports missing Codex response content without treating metadata or mirrors as omissions", async () => {
    const f = fixture("codex");
    f.resolve();
    f.write([
      { type: "session_meta", payload: { cwd: f.project } },
      { type: "turn_context", payload: { model: "synthetic" } },
      { type: "event_msg", payload: { type: "token_count", info: {} } },
      { type: "response_item", payload: { type: "reasoning", content: "HIDDEN_REASONING" } },
      { type: "response_item", payload: { type: "compaction", summary: "INTERNAL_SUMMARY" } },
      { type: "response_item", payload: { type: "ghost_snapshot", ghost_commit: {} } },
      codexMirror("user", "body"),
      codexText("user_message", "body"),
    ]);
    expect(await f.read()).toMatchObject({ status: "ready", recordCount: 1, limitations: [] });
    appendFileSync(
      f.file,
      [
        { type: "response_item", payload: { type: "message", role: "assistant" } },
        {
          type: "response_item",
          payload: { type: "function_call", name: "read", call_id: "broken-input" },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "broken-output" },
        },
        {
          type: "response_item",
          payload: { type: "future_body_record", content: "UNSUPPORTED_BODY" },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const result = await f.read();
    expect(result).toMatchObject({
      status: "partial",
      recordCount: 1,
      limitations: [
        "damaged-record",
        "damaged-tool-output",
        "unsupported-response-item",
        "unsupported-tool-input",
      ],
    });
    expect(result.records[0].content).toBe("body");
  });

  it("rejects whole snapshot failures with coverage evidence and preserves ownership errors", async () => {
    const f = fixture("opencode");
    f.resolve();
    const snapshot = vi.spyOn(OpenCodeSessions.prototype, "searchSnapshot");
    snapshot.mockRejectedValueOnce(new Error("OpenCode export exceeds the read limit"));
    await expect(f.read()).rejects.toMatchObject({
      message: "history-source-unavailable",
      limitation: "source-byte-limit",
    });
    snapshot.mockRejectedValueOnce(new SyntaxError("synthetic-private-payload"));
    await expect(f.read()).rejects.toMatchObject({
      message: "history-source-unavailable",
      limitation: "damaged-record",
    });
    snapshot.mockRejectedValueOnce(new Error("history-source-owner-changed"));
    await expect(f.read()).rejects.toThrow("history-source-owner-changed");
  });
  it("reads large Codex messages, deduplicates mirrors by occurrence, and keeps Unicode repetitions", async () => {
    const f = fixture("codex");
    f.resolve();
    f.write([
      codexMirror("user", "重复🙂"),
      codexText("user_message", "重复🙂"),
      codexMirror("user", "重复🙂"),
      codexText("user_message", "重复🙂"),
      codexText("agent_message", longText),
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "read",
          arguments: { path: "src/main.ts", password: "synthetic-private-value" },
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: longText },
      },
      { type: "response_item", payload: { type: "reasoning", content: "PRIVATE_REASONING" } },
    ]);
    const first = await f.read();
    expect(first.status).toBe("ready");
    expect(first.records.map((row) => row.kind)).toEqual([
      "user",
      "user",
      "assistant",
      "tool-input",
      "tool-output",
    ]);
    expect(first.records[0].content).toBe("重复🙂");
    expect(first.records[0].recordId).not.toBe(first.records[1].recordId);
    expect(first.records[2].content).toBe(longText);
    expect(first.records[4]).toMatchObject({ content: longText, toolName: "read" });
    expect(first.records[3].content).toContain("[REDACTED]");
    expect(JSON.stringify(first.records)).not.toContain("synthetic-private-value");
    expect(JSON.stringify(first.records)).not.toContain("PRIVATE_REASONING");
    expect((await f.read()).sourceRevision).toBe(first.sourceRevision);
    appendFileSync(f.file, JSON.stringify(codexText("agent_message", "appended")) + "\n");
    const second = await f.read();
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(second.records.slice(0, first.recordCount).map((row) => row.recordId)).toEqual(
      first.records.map((row) => row.recordId),
    );
  });

  it("resolves a Codex source against real workspace ownership before reading", async () => {
    const f = fixture("codex", randomUUID());
    const home = path.join(f.root, "codex"),
      sessions = path.join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    f.input.environment.CODEX_HOME = home;
    const transcript = path.join(sessions, `rollout-${f.native.native_ref}.jsonl`);
    writeFileSync(
      transcript,
      [
        {
          type: "session_meta",
          payload: { id: f.native.native_ref, cwd: f.project, source: "cli", timestamp },
        },
        codexText("user_message", "verified workspace body"),
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const database = new DatabaseSync(path.join(home, "state_5.sqlite"));
    database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT)");
    database
      .prepare("INSERT INTO threads VALUES(?,?,?)")
      .run(f.native.native_ref, f.project, transcript);
    database.close();
    const result = await f.read();
    expect(result.records.map((row) => row.content)).toEqual(["verified workspace body"]);
    f.input.workspacePath = path.join(f.root, "unrelated");
    mkdirSync(f.input.workspacePath);
    await expect(f.read()).rejects.toThrow();
  });

  it.each(["codex", "claude-code"] as const)(
    "distinguishes a moved %s source from temporarily unavailable history",
    async (agent) => {
      const f = fixture(agent, randomUUID());
      const other = path.join(f.root, "other");
      mkdirSync(other);
      let transcript: string;
      let database: DatabaseSync | undefined;
      const values =
        agent === "codex"
          ? [
              {
                type: "session_meta",
                payload: { id: f.native.native_ref, cwd: f.project, source: "cli", timestamp },
              },
              codexText("user_message", "owned body"),
            ]
          : [
              {
                type: "user",
                uuid: randomUUID(),
                sessionId: f.native.native_ref,
                cwd: f.project,
                parentUuid: null,
                timestamp,
                message: { role: "user", content: "owned body" },
              },
            ];
      if (agent === "codex") {
        const home = path.join(f.root, "codex"),
          sessions = path.join(home, "sessions");
        mkdirSync(sessions, { recursive: true });
        f.input.environment.CODEX_HOME = home;
        transcript = path.join(sessions, `rollout-${f.native.native_ref}.jsonl`);
        database = new DatabaseSync(path.join(home, "state_5.sqlite"));
        close.push(() => database!.close());
        database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT)");
        database
          .prepare("INSERT INTO threads VALUES(?,?,?)")
          .run(f.native.native_ref, f.project, transcript);
      } else {
        f.input.environment.CLAUDE_CONFIG_DIR = path.join(f.root, ".claude");
        const sessions = path.join(f.input.environment.CLAUDE_CONFIG_DIR, "projects/synthetic");
        mkdirSync(sessions, { recursive: true });
        transcript = path.join(sessions, `${f.native.native_ref}.jsonl`);
      }
      const write = () =>
        writeFileSync(transcript, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
      write();
      expect((await f.read()).records.map((record) => record.content)).toEqual(["owned body"]);
      if (agent === "codex") {
        (values[0] as { payload: { cwd: string } }).payload.cwd = other;
        database!.prepare("UPDATE threads SET cwd=? WHERE id=?").run(other, f.native.native_ref);
      } else (values[0] as { cwd: string }).cwd = other;
      write();
      await expect(f.read()).rejects.toThrow("history-source-owner-changed");
      rmSync(transcript);
      if (database) {
        // The DB still proves foreign ownership even when the rollout is unavailable.
        await expect(f.read()).rejects.toThrow("history-source-owner-changed");
        database.prepare("UPDATE threads SET cwd=? WHERE id=?").run(f.project, f.native.native_ref);
      }
      await expect(f.read()).rejects.toThrow("history-source-unavailable");
    },
  );

  it("projects Claude's active branch and reads text/tool blocks without attachment bodies", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write([
      {
        type: "user",
        uuid: "u",
        parentUuid: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: longText },
            { type: "image", source: { data: "ATTACHMENT_BODY" } },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "abandoned",
        parentUuid: "u",
        message: { role: "assistant", content: "ABANDONED_BRANCH" },
      },
      {
        type: "assistant",
        uuid: "a",
        parentUuid: "u",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE_REASONING" },
            { type: "tool_use", id: "call", name: "grep", input: { query: "needle" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "result",
        parentUuid: "a",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call",
              content: [
                { type: "text", text: longText },
                { type: "image", data: "ATTACHMENT_BODY" },
              ],
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "side",
        parentUuid: "result",
        isSidechain: true,
        message: { role: "assistant", content: "SIDECHAIN" },
      },
    ]);
    const result = await f.read();
    expect(result.status).toBe("ready");
    expect(result.records.map((row) => row.kind)).toEqual(["user", "tool-input", "tool-output"]);
    expect(result.records[0].content).toBe(longText);
    expect(result.records[2]).toMatchObject({ content: longText, toolName: "grep" });
    expect(JSON.stringify(result.records)).not.toMatch(
      /ATTACHMENT_BODY|ABANDONED_BRANCH|PRIVATE_REASONING|SIDECHAIN/,
    );
  });

  it("reads AgentKib's own print-mode Claude sessions only while the index keeps them", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.native.origin = "execution";
    f.write([
      {
        type: "user",
        uuid: "u",
        parentUuid: null,
        entrypoint: "sdk-cli",
        message: { role: "user", content: "MANAGED_BODY" },
      },
    ]);
    expect((await f.read()).records.map((row) => row.content)).toEqual(["MANAGED_BODY"]);
    f.input.summary.origin = "unknown";
    await expect(f.read()).rejects.toThrow("history-source-owner-changed");
  });

  it("still rejects a Codex exec session behind an interactive index row", async () => {
    const f = fixture("codex");
    f.resolve();
    f.native.origin = "execution";
    f.write([codexText("user_message", "EXEC_BODY")]);
    await expect(f.read()).rejects.toThrow("history-source-owner-changed");
  });

  it("excludes Claude string and rich-text command echoes from native discovery, search and locations", async () => {
    const f = fixture("claude-code", randomUUID());
    f.input.environment.CLAUDE_CONFIG_DIR = path.join(f.root, ".claude");
    const sessions = path.join(f.input.environment.CLAUDE_CONFIG_DIR, "projects/synthetic");
    mkdirSync(sessions, { recursive: true });
    const echoes = [
      "<local-command-caveat>INTERNAL_STRING_ECHO</local-command-caveat>",
      " \n<local-command-stdout>INTERNAL_RICH_ECHO</local-command-stdout>",
      "<command-name>INTERNAL_NAME_ECHO</command-name>",
      "<command-message>INTERNAL_MESSAGE_ECHO</command-message>",
    ];
    const bodies = [
      "Actual user question",
      "Explain the literal <local-command-stdout> tag",
      "<local-command> Similar ordinary tag",
      "<command-names> Similar plural tag",
      "<Local-command-stdout> Case-sensitive ordinary tag",
    ];
    const toolInput = { query: "<command-name>TOOL_INPUT_LITERAL</command-name>" };
    const toolOutput = "<local-command-stdout>TOOL_OUTPUT_LITERAL</local-command-stdout>";
    const messages = [
      { role: "user", content: echoes[0] },
      { role: "user", content: echoes.slice(1).map((text) => ({ type: "text", text })) },
      { role: "user", content: bodies.map((text) => ({ type: "text", text })) },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Actual assistant reply" },
          { type: "tool_use", id: "read-call", name: "read", input: toolInput },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-call",
            content: [{ type: "text", text: toolOutput }],
          },
        ],
      },
    ];
    const ids = messages.map(() => randomUUID());
    writeFileSync(
      path.join(sessions, `${f.native.native_ref}.jsonl`),
      messages
        .map((message, index) =>
          JSON.stringify({
            type: message.role,
            uuid: ids[index],
            parentUuid: ids[index - 1] ?? null,
            sessionId: f.native.native_ref,
            cwd: f.project,
            timestamp,
            message,
          }),
        )
        .join("\n") + "\n",
    );
    const discovered = new ClaudeSessions(f.input.environment).list(f.project).sessions;
    expect(discovered).toHaveLength(1);
    f.input.summary = {
      ...discovered[0].session,
      id: f.input.sessionId,
      workspace_id: "registered",
    };
    const result = await f.read();
    expect(result.status).toBe("ready");
    expect(result.records.map((record) => record.content)).toEqual([
      ...bodies,
      "Actual assistant reply",
      JSON.stringify(toolInput, null, 2),
      toolOutput,
    ]);
    expect(result.records.slice(-2).map((record) => record.kind)).toEqual([
      "tool-input",
      "tool-output",
    ]);

    const db = new HistorySearchStore(path.join(f.root, "search.sqlite"), true);
    close.push(() => db.close());
    const generation = db.begin({
      sessionId: f.input.sessionId,
      workspaceId: f.input.summary.workspace_id,
      agent: "claude-code",
      title: f.input.summary.title,
      updatedAt: f.input.summary.updated_at,
      archived: false,
      ownerKey: "synthetic-claude-owner",
    });
    for (const record of result.records) db.append(f.input.sessionId, generation, record, () => {});
    db.finish(
      f.input.sessionId,
      generation,
      result.sourceRevision,
      result.status,
      result.limitations,
    );
    const allowed = [f.input.sessionId];
    expect(db.query({ query: "INTERNAL_" }, allowed, () => {}).hits).toEqual([]);
    const hit = db.query({ query: "Actual user question" }, allowed, () => {}).hits[0]!;
    expect(db.locate(hit.location, allowed).content).toBe(bodies[0]);
    // Reference resolution uses the same locator: an excluded row has no selectable body.
    for (const recordId of [`${ids[0]}:text`, `${ids[1]}:text:0`])
      expect(() => db.locate({ ...hit.location, recordId }, allowed)).toThrow(
        "history-source-stale",
      );
    const tool = db.query({ query: "TOOL_OUTPUT_LITERAL" }, allowed, () => {}).hits[0]!;
    expect(db.locate(tool.location, allowed)).toMatchObject({
      kind: "tool-output",
      toolName: "read",
      content: toolOutput,
    });
  });

  it.each(
    ["object", "array"].flatMap((shape) =>
      ["text", "input_text", "output_text"].map((type) => ({ shape, type })),
    ),
  )(
    "reports damaged $shape $type tool text without reducing native Claude body coverage",
    async ({ shape, type }) => {
      const f = fixture("claude-code", randomUUID());
      f.input.environment.CLAUDE_CONFIG_DIR = path.join(f.root, ".claude");
      const sessions = path.join(f.input.environment.CLAUDE_CONFIG_DIR, "projects/synthetic");
      mkdirSync(sessions, { recursive: true });
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const wrap = (part: Record<string, unknown>) => (shape === "array" ? [part] : part);
      const validOutputs = [
        "plain tool output",
        wrap({ type, text: "typed tool output" }),
        "",
        wrap({ type, text: "" }),
        undefined,
        null,
        wrap({ type: "image", data: "ATTACHMENT_BODY" }),
        wrap({ type: "reasoning", text: "HIDDEN_REASONING" }),
      ];
      const damagedOutputs = [undefined, null, 42, false, {}, []].map((text) => {
        const part = { type, text };
        return shape === "array"
          ? [{ type, text: "readable neighboring tool output" }, part]
          : part;
      });
      const cache = new HistorySearchStore(path.join(f.root, "session-search.sqlite"), true);
      close.push(() => cache.close());
      const index = async (outputs: unknown[]) => {
        const messages = [
          { role: "user", content: longText },
          {
            role: "assistant",
            content: [
              { type: "text", text: "valid assistant body" },
              ...outputs.map((_, index) => ({
                type: "tool_use",
                id: `call-${index}`,
                name: "read",
                input: { path: "synthetic.txt" },
              })),
            ],
          },
          {
            role: "user",
            content: outputs.map((content, index) => ({
              type: "tool_result",
              tool_use_id: `call-${index}`,
              content,
            })),
          },
        ];
        writeFileSync(
          path.join(sessions, `${f.native.native_ref}.jsonl`),
          messages
            .map((message, index) =>
              JSON.stringify({
                type: message.role,
                uuid: ids[index],
                parentUuid: ids[index - 1] ?? null,
                sessionId: f.native.native_ref,
                cwd: f.project,
                timestamp,
                message,
              }),
            )
            .join("\n") + "\n",
        );
        const discovered = new ClaudeSessions(f.input.environment).list(f.project).sessions;
        expect(discovered).toHaveLength(1);
        f.input.summary = {
          ...discovered[0].session,
          id: f.input.sessionId,
          workspace_id: "registered",
        };
        const result = await f.read();
        const generation = cache.begin({
          sessionId: f.input.sessionId,
          workspaceId: f.input.summary.workspace_id,
          agent: "claude-code",
          title: f.input.summary.title,
          updatedAt: f.input.summary.updated_at,
          archived: false,
          ownerKey: "synthetic-claude-owner",
        });
        for (const row of result.records)
          cache.append(f.input.sessionId, generation, row, () => {});
        cache.finish(
          f.input.sessionId,
          generation,
          result.sourceRevision,
          result.status,
          result.limitations,
        );
        expect(result.records.slice(0, 2).map((row) => row.content)).toEqual([
          longText,
          "valid assistant body",
        ]);
        expect(JSON.stringify(result.records)).not.toMatch(/ATTACHMENT_BODY|HIDDEN_REASONING/);
        const hits = cache.query({ query: "END_AFTER_256_KIB" }, [f.input.sessionId], () => {});
        expect(hits.hits).toHaveLength(1);
        expect(cache.locate(hits.hits[0]!.location, [f.input.sessionId]).content).toContain(
          "END_AFTER_256_KIB",
        );
        return { result, status: hits.status };
      };
      const complete = await index(validOutputs);
      expect(complete.result).toMatchObject({ status: "ready", limitations: [] });
      expect(complete.status.sources).toMatchObject([
        { agent: "claude-code", body: "supported", tools: "supported" },
      ]);
      const partial = await index([...validOutputs, ...damagedOutputs]);
      expect(
        partial.result.records
          .filter((row) => row.kind === "tool-output")
          .map((row) => row.content),
      ).toEqual([
        "plain tool output",
        "typed tool output",
        ...(shape === "array" ? damagedOutputs.map(() => "readable neighboring tool output") : []),
      ]);
      expect(partial.result).toMatchObject({
        status: "partial",
        limitations: ["damaged-tool-output"],
      });
      expect(partial.status.sources).toMatchObject([
        {
          agent: "claude-code",
          body: "supported",
          tools: "partial",
          coverage: { total: 1, ready: 0, partial: 1, limitations: ["damaged-tool-output"] },
        },
      ]);
    },
  );

  it.each(["hermes", "open-claw", "grok-build", "codex"])(
    "retains %s string and rich-text literals resembling Claude command echoes",
    async (format) => {
      const f = fixture("codex");
      const bodies = [
        "<local-command-stdout>Ordinary source text</local-command-stdout>",
        "<command-name>Ordinary source name</command-name>",
        "<command-message>Ordinary source message</command-message>",
      ];
      const expected = bodies.flatMap((body) => [body, body]);
      f.write(
        bodies.flatMap((body) =>
          [body, [{ type: "text", text: body }]].map((content) => {
            const message = { role: "user", content };
            return format === "codex"
              ? { type: "response_item", payload: { type: "message", ...message } }
              : { type: "message", message };
          }),
        ),
      );
      const contents: string[] = [];
      await readJsonlSearchSource(f.file, format, {
        emit: async (record) => {
          contents.push(record.content);
        },
        checkpoint: () => {},
        fingerprint: () => {},
        limit: () => {},
      });
      expect(contents).toEqual(expected);
    },
  );

  it("retains literal command-like bodies through Hermes native SQL discovery and complete source reading", async () => {
    const f = hermesFixture();
    const body = "<local-command-stdout>Ordinary Hermes conversation</local-command-stdout>";
    f.db.prepare("UPDATE messages SET content=?").run(body);
    f.db
      .prepare("INSERT INTO messages VALUES(?,?,?,?)")
      .run("s", "user", JSON.stringify([{ type: "text", text: body }]), timestamp);
    const result = await f.read();
    expect(result.status).toBe("ready");
    expect(result.records.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "assistant", content: body },
      { kind: "user", content: body },
    ]);
  });

  const messageFormats = ["claude-code", "hermes", "open-claw", "grok-build"] as const;
  function sourceMessage(
    format: (typeof messageFormats)[number],
    role: string,
    fields: Record<string, unknown>,
  ) {
    if (format === "claude-code")
      return { type: role === "assistant" ? "assistant" : "user", message: { role, ...fields } };
    if (format === "open-claw") return { type: "message", message: { role, ...fields } };
    return { type: role, role, ...fields };
  }

  it.each(messageFormats)(
    "reports missing message bodies in %s JSONL while retaining readable neighbors",
    async (format) => {
      const f = fixture(format);
      f.write([
        sourceMessage(format, "user", { content: "before" }),
        sourceMessage(format, "user", { content: null }),
        sourceMessage(format, "user", {}),
        sourceMessage(format, "assistant", { content: null, tool_calls: [] }),
        sourceMessage(format, "assistant", {}),
        sourceMessage(format, "assistant", { content: null, images: [] }),
        sourceMessage(format, "assistant", { content: null, reasoning_content: null }),
        sourceMessage(format, "assistant", { content: "after" }),
      ]);
      const records: Array<Omit<HistorySourceRecord, "ordinal">> = [],
        limitations: string[] = [];
      await readJsonlSearchSource(f.file, format, {
        emit: async (record) => {
          records.push(record);
        },
        fingerprint: () => {},
        limit: (code) => limitations.push(code),
        checkpoint: () => {},
      });
      expect(records.map((record) => record.content)).toEqual(["before", "after"]);
      expect(limitations).toEqual(Array(6).fill("damaged-record"));
    },
  );

  it.each(messageFormats)(
    "keeps %s tool-only, attachment-only, internal and explicitly empty messages complete",
    async (format) => {
      const f = fixture(format);
      const toolCall = (id: string) => ({
        id,
        function: { name: "read", arguments: { path: "synthetic.txt" } },
      });
      f.write([
        sourceMessage(format, "assistant", { content: null, tool_calls: [toolCall("null")] }),
        sourceMessage(format, "assistant", { tool_calls: [toolCall("absent")] }),
        sourceMessage(format, "assistant", {
          content: null,
          images: [{ type: "image", source: { data: "ATTACHMENT_BODY" } }],
        }),
        ...["reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items"].map(
          (field) =>
            sourceMessage(format, "assistant", { content: null, [field]: "HIDDEN_REASONING" }),
        ),
        sourceMessage(format, "user", {
          content: [
            { type: "image", source: { data: "ATTACHMENT_BODY" } },
            { type: "input_audio", data: "AUDIO_BODY" },
          ],
        }),
        sourceMessage(format, "assistant", {
          content: [
            { type: "thinking", thinking: "HIDDEN_REASONING" },
            { type: "reasoning", text: "HIDDEN_REASONING" },
            { type: "redacted_thinking", data: "HIDDEN_REASONING" },
          ],
        }),
        ...["system", "internal", "thinking", "reasoning", "session_meta"].map((role) =>
          sourceMessage(format, role, { content: null }),
        ),
        sourceMessage(format, "user", { active: false }),
        sourceMessage(format, "user", { content: "" }),
        sourceMessage(format, "assistant", { content: [] }),
        sourceMessage(format, "tool", { content: "" }),
        sourceMessage(format, "user", { content: null, text: "fallback body" }),
      ]);
      const records: Array<Omit<HistorySourceRecord, "ordinal">> = [],
        limitations: string[] = [];
      await readJsonlSearchSource(f.file, format, {
        emit: async (record) => {
          records.push(record);
        },
        fingerprint: () => {},
        limit: (code) => limitations.push(code),
        checkpoint: () => {},
      });
      expect(limitations).toEqual([]);
      expect(records.map((record) => record.kind)).toEqual(["tool-input", "tool-input", "user"]);
      expect(records.slice(0, 2).map((record) => record.toolName)).toEqual(["read", "read"]);
      expect(records[2].content).toBe("fallback body");
      expect(JSON.stringify(records)).not.toMatch(/ATTACHMENT_BODY|AUDIO_BODY|HIDDEN_REASONING/);
    },
  );

  it.each([null, undefined])(
    "reports Claude's %s user body as partial through native discovery and source reading",
    async (content) => {
      const f = fixture("claude-code", randomUUID());
      f.input.environment.CLAUDE_CONFIG_DIR = path.join(f.root, ".claude");
      const sessions = path.join(f.input.environment.CLAUDE_CONFIG_DIR, "projects/synthetic");
      mkdirSync(sessions, { recursive: true });
      const userId = randomUUID();
      writeFileSync(
        path.join(sessions, `${f.native.native_ref}.jsonl`),
        [
          {
            type: "user",
            uuid: userId,
            parentUuid: null,
            sessionId: f.native.native_ref,
            cwd: f.project,
            timestamp,
            message: { role: "user", content },
          },
          {
            type: "assistant",
            uuid: randomUUID(),
            parentUuid: userId,
            sessionId: f.native.native_ref,
            cwd: f.project,
            timestamp,
            message: { role: "assistant", content: [{ type: "text", text: "valid body" }] },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n",
      );
      const discovered = new ClaudeSessions(f.input.environment).list(f.project).sessions;
      expect(discovered).toHaveLength(1);
      f.input.summary = {
        ...discovered[0].session,
        id: f.input.sessionId,
        workspace_id: "registered",
      };
      const result = await f.read();
      expect(result.records.map((record) => record.content)).toEqual(["valid body"]);
      expect(result).toMatchObject({
        status: "partial",
        recordCount: 1,
        limitations: ["damaged-record"],
      });
    },
  );

  it("keeps readable records but reports malformed and oversized JSONL lines as partial", async () => {
    const f = fixture("codex");
    f.resolve();
    f.write([
      codexText("user_message", "before"),
      codexText("agent_message", "x".repeat(4 * 1024 * 1024)),
    ]);
    appendFileSync(
      f.file,
      "{damaged\n" + JSON.stringify(codexText("agent_message", longText)) + "\n",
    );
    const result = await f.read();
    expect(result.status).toBe("partial");
    expect(result.limitations).toEqual(["damaged-record", "source-record-limit"]);
    expect(result.records.map((row) => row.content)).toEqual(["before", longText]);
  });

  it("preserves repeated cancellation and sink failures without closing reused file descriptors", async () => {
    const f = fixture("codex");
    f.resolve();
    f.write([codexText("user_message", "before")]);
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const mode of ["abort", "sink"] as const) {
        const abort = new AbortController();
        const failure = new Error(mode === "abort" ? "fixture-aborted" : "fixture-sink-failed");
        await expect(
          readHistorySearchSource(
            f.input,
            () => {
              if (mode === "abort") abort.abort(failure);
              else throw failure;
            },
            { signal: abort.signal },
          ),
        ).rejects.toBe(failure);
        // Reopen immediately, then allow any delayed I/O cleanup to run. A stale close
        // must not affect this newly owned descriptor even when the number is reused.
        const probe = openSync(f.file, "r");
        try {
          await nextIoTurn();
          await nextIoTurn();
          const byte = Buffer.alloc(1);
          expect(readSync(probe, byte, 0, 1, 0)).toBe(1);
          expect(byte.toString()).toBe("{");
        } finally {
          closeSync(probe);
        }
      }
    }
    await expect(
      readHistorySearchSource(f.input, () => appendFileSync(f.file, "\n")),
    ).rejects.toThrow("history-source-changed");
  });

  it("reads Grok text and tool results and declares unsupported backend tool records", async () => {
    const f = fixture("grok-build");
    f.resolve();
    vi.spyOn(GrokSessions.prototype, "resolve").mockReturnValue({
      transcript: f.file,
      cwd: f.project,
      session: f.native,
    });
    f.write([
      { type: "user", content: longText },
      {
        type: "assistant",
        content: "answer",
        tool_calls: [{ id: "g", function: { name: "shell", arguments: "pwd" } }],
      },
      { type: "tool_result", tool_call_id: "g", content: longText },
      { type: "backend_tool_call", content: "unsupported" },
    ]);
    const result = await f.read();
    expect(result.records.map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "tool-input",
      "tool-output",
    ]);
    expect(result.records[3]).toMatchObject({ content: longText, toolName: "shell" });
    expect(result.limitations).toEqual(["unsupported-tool-record"]);
  });

  it("reads Hermes JSONL and ignores inactive rows while marking compacted originals", async () => {
    const f = fixture("hermes");
    f.resolve();
    vi.spyOn(HermesSessions.prototype, "resolve").mockReturnValue({
      transcript: f.file,
      cwd: f.project,
      session: f.native,
      source: { type: "jsonl", path: f.file },
    });
    f.write([
      { type: "message", message: { role: "user", content: longText } },
      { role: "assistant", content: "inactive", active: false },
      { role: "assistant", content: "compressed", _compressed_summary: true },
    ]);
    const result = await f.read();
    expect(result.records.map((row) => row.content)).toEqual([longText]);
    expect(result.limitations).toEqual(["compacted-history"]);
  });

  it("reads Hermes committed WAL with stable row IDs and a consistent snapshot", async () => {
    const f = fixture("hermes");
    f.resolve();
    const file = path.join(f.root, "hermes.db"),
      db = new DatabaseSync(file);
    close.push(() => db.close());
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(sessionId TEXT,speaker TEXT,text TEXT,tool_calls TEXT,toolCallId TEXT,created_at TEXT)",
    );
    db.exec("CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT)");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("s", "Synthetic", f.project);
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)");
    insert.run("s", "user", longText, null, null, String(Date.parse(timestamp) / 1000));
    insert.run(
      "s",
      "assistant",
      "",
      JSON.stringify([{ id: "h", function: { name: "shell", arguments: "echo test" } }]),
      null,
      timestamp,
    );
    insert.run("s", "tool", longText, null, "h", timestamp);
    insert.run("other", "user", "OTHER_SESSION", null, null, timestamp);
    vi.spyOn(HermesSessions.prototype, "resolve").mockReturnValue({
      transcript: file,
      cwd: f.project,
      session: f.native,
      source: { type: "sqlite", path: file, sessionId: "s" },
    });
    const records: HistorySourceRecord[] = [];
    const result = await readHistorySearchSource(f.input, (record) => {
      records.push(record);
      if (records.length === 1)
        insert.run("s", "assistant", "CONCURRENT_COMMIT", null, null, timestamp);
    });
    expect(result.status).toBe("ready");
    expect(records.map((row) => row.kind)).toEqual(["user", "tool-input", "tool-output"]);
    expect(records[0].content).toBe(longText);
    expect(records[0].timestamp).toBe(timestamp.replace(".000Z", "Z"));
    expect(records[2]).toMatchObject({ content: longText, toolName: "shell" });
    const next = await f.read();
    expect(next.sourceRevision).not.toBe(result.sourceRevision);
    expect(next.records.slice(0, 3).map((row) => row.recordId)).toEqual(
      records.map((row) => row.recordId),
    );
    expect(next.records[3].content).toBe("CONCURRENT_COMMIT");
  });

  it("reads complete Hermes SQLite text containing NUL without changing numeric row flags", async () => {
    const f = fixture("hermes");
    f.resolve();
    const file = path.join(f.root, "hermes-nul.db"),
      db = new DatabaseSync(file);
    close.push(() => db.close());
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,tool_name TEXT,tool_call_id TEXT,active INTEGER,compacted INTEGER)",
    );
    db.exec("CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT)");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("s", "Synthetic", f.project);
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
    insert.run("s", "user", "before\0AFTER_NUL_TOKEN", null, null, 1, 0);
    insert.run("s", "tool", "output\0AFTER_TOOL_NUL", "read\0suffix", "call", 1, 0);
    insert.run("s", "assistant", "INACTIVE_RECORD", null, null, 0, 0);
    vi.spyOn(HermesSessions.prototype, "resolve").mockReturnValue({
      transcript: file,
      cwd: f.project,
      session: f.native,
      source: { type: "sqlite", path: file, sessionId: "s" },
    });
    const first = await f.read();
    expect(first).toMatchObject({ status: "ready", limitations: [] });
    expect(first.records.map((row) => row.content)).toEqual([
      "before\0AFTER_NUL_TOKEN",
      "output\0AFTER_TOOL_NUL",
    ]);
    expect(first.records[1].toolName).toBe("read\0suffix");
    db.prepare("UPDATE messages SET content=? WHERE rowid=1").run("before\0CHANGED_AFTER_NUL");
    const second = await f.read();
    expect(second.sourceRevision).not.toBe(first.sourceRevision);
    expect(second.records[0].content).toBe("before\0CHANGED_AFTER_NUL");
  });

  it("reads OpenClaw legacy messages but marks ambiguous branch projections partial", async () => {
    const f = fixture("open-claw");
    f.resolve();
    vi.spyOn(OpenClawSessions.prototype, "resolve").mockReturnValue({
      transcript: f.file,
      cwd: f.project,
      session: f.native,
    });
    f.write([
      {
        type: "message",
        id: "u",
        message: { role: "user", content: [{ type: "text", text: longText }] },
      },
    ]);
    expect((await f.read()).records[0].content).toBe(longText);
    appendFileSync(f.file, JSON.stringify({ type: "leaf", targetId: "u" }) + "\n");
    const partial = await f.read();
    expect(partial).toMatchObject({
      status: "partial",
      recordCount: 0,
      limitations: ["legacy-branch-history"],
    });
  });

  it("reads OpenClaw's verified active SQL projection instead of all transcript branches", async () => {
    const f = fixture("open-claw");
    const home = path.join(f.root, ".openclaw"),
      directory = path.join(home, "agents", "main", "agent");
    mkdirSync(directory, { recursive: true });
    f.native.native_ref = stableNativeRef("openclaw-sqlite-v23", [home, "main", "s", f.project]);
    f.input.sessionId = sessionIdentity(f.input.identitySalt, "open-claw", f.native.native_ref);
    f.input.summary.id = f.input.sessionId;
    f.resolve();
    const file = path.join(directory, "openclaw-agent.sqlite"),
      db = new DatabaseSync(file);
    close.push(() => db.close());
    db.exec(`PRAGMA user_version=23; PRAGMA journal_mode=WAL;
      CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','agent',23,'main','2026.9.6');
      CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_utf8_bytes INTEGER);
      CREATE TABLE session_windows(session_id TEXT,session_key TEXT,acp_owned INTEGER,plugin_owner_id TEXT,agent_harness_id TEXT,session_scope TEXT);
      INSERT INTO session_windows VALUES('s','key',0,NULL,'pi','conversation');
      CREATE TABLE session_nodes(session_key TEXT,entry_json TEXT,entry_valid INTEGER);
      INSERT INTO session_nodes VALUES('key','{}',1);
      CREATE TABLE session_transcript_cold_archives(session_id TEXT);
      CREATE TABLE session_transcript_index_state(session_id TEXT,indexed_seq INTEGER,needs_rebuild INTEGER,active_event_count INTEGER,active_message_count INTEGER);
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation INTEGER);
      INSERT INTO transcript_rewrite_watermarks VALUES('s',1);
      CREATE TABLE session_transcript_active_events(session_id TEXT,event_seq INTEGER,active_position INTEGER,message_position INTEGER,context_eligible INTEGER);`);
    const events = [
      { type: "session", version: 4, id: "s", cwd: f.project },
      {
        type: "message",
        id: "u",
        message: { role: "user", content: [{ type: "text", text: longText }] },
      },
      { type: "message", id: "branch", message: { role: "assistant", content: "INACTIVE_BRANCH" } },
      {
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "o", name: "read", arguments: { path: "a" } }],
        },
      },
      {
        type: "message",
        id: "t",
        parentId: "a",
        message: {
          role: "toolResult",
          toolCallId: "o",
          toolName: "read",
          content: [{ type: "text", text: longText }],
        },
      },
    ];
    const insert = db.prepare("INSERT INTO transcript_events VALUES('s',?,?,?)");
    events.forEach((event, index) => {
      const json = JSON.stringify(event);
      insert.run(index, json, Buffer.byteLength(json));
    });
    db.exec(
      "INSERT INTO session_transcript_index_state VALUES('s',4,0,3,3); INSERT INTO session_transcript_active_events VALUES('s',1,0,0,1),('s',3,1,1,1),('s',4,2,2,1)",
    );
    vi.spyOn(OpenClawSessions.prototype, "resolve").mockReturnValue({
      transcript: file,
      cwd: f.project,
      session: f.native,
      sqlite: { file, agentId: "main", id: "s", cwd: f.project, session: f.native },
    });
    const result = await f.read();
    expect(result.status).toBe("ready");
    expect(result.records.map((row) => row.kind)).toEqual(["user", "tool-input", "tool-output"]);
    expect(result.records[2].content).toBe(longText);
    expect(JSON.stringify(result.records)).not.toContain("INACTIVE_BRANCH");
  });

  it("reads a complete OpenCode export once, including tool input/output", async () => {
    const f = fixture("opencode");
    f.resolve();
    const snapshot = vi.spyOn(OpenCodeSessions.prototype, "searchSnapshot").mockResolvedValue({
      info: { id: f.native.native_ref, directory: f.project },
      messages: [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: longText }] },
        {
          info: { id: "a", role: "assistant" },
          parts: [
            {
              type: "tool",
              callID: "oc",
              tool: "read",
              state: { status: "completed", input: { path: "a" }, output: longText },
            },
            { type: "reasoning", text: "PRIVATE_REASONING" },
          ],
        },
      ],
    });
    const result = await f.read();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(result.records.map((row) => row.kind)).toEqual(["user", "tool-input", "tool-output"]);
    expect(result.records[2].content).toBe(longText);
    expect(result.status).toBe("ready");
  });

  it("replays ACP updates with full merged messages and tools without resource attachments", async () => {
    const f = fixture("antigravity");
    f.resolve();
    vi.spyOn(AntigravitySessions.prototype, "readReplay").mockResolvedValue({
      session: {
        id: f.native.native_ref,
        workspace: f.project,
        title: null,
        created_at: null,
        updated_at: null,
      },
      updates: [
        {
          sessionUpdate: "user_message_chunk",
          messageId: "u",
          content: { type: "text", text: longText },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "a",
          content: { type: "text", text: "piece " },
        },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "a",
          content: { type: "text", text: "two" },
        },
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "PRIVATE_REASONING" },
        },
        { sessionUpdate: "tool_call", toolCallId: "acp", title: "read", rawInput: { path: "a" } },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "acp",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: longText } },
            {
              type: "content",
              content: {
                type: "resource",
                resource: { uri: "file:///fixture", text: "ATTACHMENT_BODY" },
              },
            },
          ],
        },
      ],
    });
    const result = await f.read();
    expect(result.status).toBe("ready");
    expect(result.records.map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "tool-input",
      "tool-output",
    ]);
    expect(result.records[1].content).toBe("piece two");
    expect(result.records[3].content).toBe(longText);
    expect(JSON.stringify(result.records)).not.toMatch(/ATTACHMENT_BODY|PRIVATE_REASONING/);
  });

  it.each(["user_message_chunk", "agent_message_chunk"])(
    "reports unknown Antigravity %s content as partial body coverage through the search store",
    async (sessionUpdate) => {
      const f = fixture("antigravity");
      f.resolve();
      vi.spyOn(AntigravitySessions.prototype, "readReplay").mockResolvedValue({
        session: {
          id: f.native.native_ref,
          workspace: f.project,
          title: null,
          created_at: null,
          updated_at: null,
        },
        updates: [
          { sessionUpdate: "user_message_chunk", content: "before marker" },
          {
            sessionUpdate,
            content: { type: "future_message_block", text: "OMITTED_BODY_MARKER" },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "after marker" },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "acp",
            title: "read",
            status: "completed",
            rawInput: { path: "synthetic" },
            rawOutput: "tool marker",
          },
        ],
      });
      const result = await f.read();
      expect(result).toMatchObject({
        status: "partial",
        limitations: ["unsupported-text-content"],
      });
      expect(result.records.map((row) => row.kind)).toEqual([
        "user",
        "assistant",
        "tool-input",
        "tool-output",
      ]);
      const cache = new HistorySearchStore(path.join(f.root, "session-search.sqlite"), true);
      close.push(() => cache.close());
      const sessionId = f.input.sessionId;
      const generation = cache.begin({
        sessionId,
        workspaceId: f.input.summary.workspace_id,
        agent: "antigravity",
        title: f.native.title,
        updatedAt: f.native.updated_at,
        archived: false,
        ownerKey: "synthetic-antigravity-owner",
      });
      for (const row of result.records) cache.append(sessionId, generation, row, () => {});
      cache.finish(sessionId, generation, result.sourceRevision, result.status, result.limitations);
      for (const query of ["before marker", "after marker", "tool marker"]) {
        const hits = cache.query({ query }, [sessionId], () => {});
        expect(hits.hits).toHaveLength(1);
        expect(cache.locate(hits.hits[0]!.location, [sessionId]).content).toContain(query);
        expect(hits.status.sources).toMatchObject([
          {
            agent: "antigravity",
            body: "partial",
            tools: "supported",
            coverage: { total: 1, ready: 0, partial: 1, limitations: ["unsupported-text-content"] },
          },
        ]);
        expect(JSON.stringify(hits.status)).not.toContain("OMITTED_BODY_MARKER");
      }
      expect(cache.query({ query: "OMITTED_BODY_MARKER" }, [sessionId], () => {}).hits).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("OMITTED_BODY_MARKER");
    },
  );

  it.each(["user_message_chunk", "agent_message_chunk"])(
    "excludes known Antigravity %s attachments and hidden reasoning without reducing coverage",
    async (sessionUpdate) => {
      const f = fixture("antigravity");
      f.resolve();
      vi.spyOn(AntigravitySessions.prototype, "readReplay").mockResolvedValue({
        session: {
          id: f.native.native_ref,
          workspace: f.project,
          title: null,
          created_at: null,
          updated_at: null,
        },
        updates: [
          { sessionUpdate, content: { type: "text", text: "searchable marker" } },
          ...[
            {
              type: "image",
              data: Buffer.from("ATTACHMENT_MARKER").toString("base64"),
              mimeType: "image/png",
            },
            {
              type: "audio",
              data: Buffer.from("ATTACHMENT_MARKER").toString("base64"),
              mimeType: "audio/wav",
            },
            { type: "resource", resource: { uri: "file:///fixture", text: "ATTACHMENT_MARKER" } },
            { type: "resource_link", uri: "file:///fixture", name: "ATTACHMENT_MARKER" },
            { type: "thinking", text: "PRIVATE_REASONING" },
            { type: "reasoning", text: "PRIVATE_REASONING" },
            { type: "redacted_thinking", data: "PRIVATE_REASONING" },
          ].map((content) => ({ sessionUpdate, content })),
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "PRIVATE_REASONING" },
          },
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "future_reasoning_block", text: "PRIVATE_REASONING" },
          },
        ],
      });
      const result = await f.read();
      expect(result).toMatchObject({ status: "ready", limitations: [] });
      expect(result.records.map((row) => row.content)).toEqual(["searchable marker"]);
      const cache = new HistorySearchStore(path.join(f.root, "session-search.sqlite"), true);
      close.push(() => cache.close());
      const sessionId = f.input.sessionId;
      const generation = cache.begin({
        sessionId,
        workspaceId: f.input.summary.workspace_id,
        agent: "antigravity",
        title: f.native.title,
        updatedAt: f.native.updated_at,
        archived: false,
        ownerKey: "synthetic-antigravity-owner",
      });
      for (const row of result.records) cache.append(sessionId, generation, row, () => {});
      cache.finish(sessionId, generation, result.sourceRevision, result.status, result.limitations);
      const hits = cache.query({ query: "searchable marker" }, [sessionId], () => {});
      expect(hits.hits).toHaveLength(1);
      expect(hits.status.sources).toMatchObject([
        {
          agent: "antigravity",
          body: "supported",
          tools: "supported",
          coverage: { total: 1, ready: 1, partial: 0, limitations: [] },
        },
      ]);
      for (const query of ["ATTACHMENT_MARKER", "PRIVATE_REASONING"])
        expect(cache.query({ query }, [sessionId], () => {}).hits).toEqual([]);
      expect(JSON.stringify({ result, status: hits.status })).not.toMatch(
        /ATTACHMENT_MARKER|PRIVATE_REASONING/,
      );
    },
  );

  it("reads Cursor IDE graph text beyond display limits and states tool coverage is unsupported", async () => {
    const f = fixture("cursor"),
      nativeId = randomUUID();
    const global = path.join(f.root, "User/globalStorage");
    mkdirSync(global, { recursive: true });
    const file = path.join(global, "state.vscdb"),
      db = new DatabaseSync(file);
    close.push(() => db.close());
    db.exec(`PRAGMA user_version=1; CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency REAL,checkpointAt INTEGER,subagentTypeName TEXT,value TEXT);`);
    const profile = {
      id: createHash("sha256").update(file).digest("hex"),
      db_path: file,
      version: "3.22.12" as const,
      workspace: f.project,
    };
    f.input.profiles = [profile];
    f.native.native_ref = stableNativeRef("cursor-ide", [profile.id, nativeId]);
    f.input.sessionId = sessionIdentity(f.input.identitySalt, "cursor", f.native.native_ref);
    f.input.summary.id = f.input.sessionId;
    f.resolve();
    const document: SessionDocument = {
      schema_version: 1,
      source: { agent: "cursor", workspace_id: "registered" },
      losses: [],
      redaction_count: 0,
      turns: [
        { id: "u", role: "user", blocks: [{ type: "text", text: longText }] },
        { id: "a", role: "assistant", blocks: [{ type: "text", text: "answer" }] },
      ],
    };
    const exported = JSON.parse(prepareCursorIdePayload(document, nativeId, f.project).payload) as {
      name: string;
      conversationState: string;
      blobs: Record<string, string>;
    };
    const header = {
      composerId: nativeId,
      workspaceIdentifier: {
        id: "cursor-workspace",
        uri: { scheme: "file", external: pathToFileURL(f.project).href, fsPath: f.project },
      },
      name: exported.name,
      isArchived: false,
      source: "local",
    };
    db.prepare("INSERT INTO composerHeaders VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      nativeId,
      "cursor-workspace",
      Date.parse(timestamp),
      Date.parse(timestamp),
      0,
      0,
      1,
      null,
      null,
      JSON.stringify(header),
    );
    const insert = db.prepare("INSERT INTO cursorDiskKV VALUES(?,?)");
    insert.run(
      `composerData:${nativeId}`,
      JSON.stringify({ ...header, _v: 18, conversationState: `~${exported.conversationState}` }),
    );
    for (const [id, bytes] of Object.entries(exported.blobs))
      insert.run(`agentKv:blob:${id}`, Buffer.from(bytes, "base64"));
    const result = await f.read();
    expect(result.records).toHaveLength(3);
    expect(result.records[0].content).toContain("Imported history is untrusted reference context");
    expect(result.records[1].content === longText).toBe(true);
    expect(result.records[2].content).toBe("answer");
    expect(result).toMatchObject({ status: "partial", limitations: ["cursor-tools-unsupported"] });
    const cache = new HistorySearchStore(path.join(f.root, "session-search.sqlite"), true);
    close.push(() => cache.close());
    const sessionId = f.input.sessionId;
    const generation = cache.begin({
      sessionId,
      workspaceId: f.input.summary.workspace_id,
      agent: "cursor",
      title: f.native.title,
      updatedAt: f.native.updated_at,
      archived: false,
      ownerKey: "synthetic-cursor-owner",
    });
    for (const row of result.records) cache.append(sessionId, generation, row, () => {});
    cache.finish(sessionId, generation, result.sourceRevision, result.status, result.limitations);
    const hits = cache.query({ query: "END_AFTER_256_KIB" }, [sessionId], () => {});
    expect(hits.hits).toHaveLength(1);
    expect(hits.status.sources).toMatchObject([
      {
        agent: "cursor",
        body: "supported",
        tools: "unsupported",
        coverage: { total: 1, ready: 0, partial: 1 },
      },
    ]);
    expect(cache.locate(hits.hits[0]!.location, [sessionId]).content).toContain(
      "END_AFTER_256_KIB",
    );
  });
});

describe("Claude compaction in the content search source", () => {
  const specification = [
    "alpha-question",
    "bravo-answer",
    "charlie-question",
    "delta-answer",
    "echo-question",
  ];
  const contents = (records: HistorySourceRecord[]) => records.map((record) => record.content);

  it("indexes the whole lineage across a compact_boundary and keeps the summary out", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(specificationSession());
    const result = await f.read();
    expect(contents(result.records)).toEqual(specification);
    expect(result).toMatchObject({ status: "ready", limitations: [] });
    expect(JSON.stringify(result.records)).not.toContain("SUMMARY-BODY");
  });

  it("reaches the earlier history through the preserved-segment head without a limitation", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(preservedSegmentSession());
    const result = await f.read();
    expect(contents(result.records)).toEqual([
      "alpha-question",
      "bravo-answer",
      "charlie-question",
      "tail-answer",
      "delta-question",
      "echo-answer",
    ]);
    expect(result.status).toBe("ready");
    expect(result.limitations).not.toContain("compaction-link-unavailable");
    expect(result.limitations).toEqual([]);
  });

  it("indexes every segment of a transcript with repeated uuids and several compactions", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(duplicateUuidSession());
    const result = await f.read();
    expect(contents(result.records)).toEqual([
      "zero-a",
      "zero-b",
      "one-a",
      "one-b",
      "two-a",
      "two-b",
      "three-a",
      "three-b",
    ]);
    expect(result).toMatchObject({ status: "ready", limitations: [] });
  });

  it.each([
    [
      retainedRewriteSession,
      ["alpha-question", "bravo-answer", "charlie-question", "delta-answer", "echo-question"],
    ],
    [
      twiceRetainedRewriteSession,
      [
        "alpha-question",
        "bravo-answer",
        "echo-question",
        "charlie-question",
        "delta-answer",
        "foxtrot-question",
      ],
    ],
    [futureLogicalParentSession, ["alpha-question", "bravo-answer", "latest-answer"]],
  ])(
    "indexes trusted historical versions without later unrelated branches (%#)",
    async (records, expected) => {
      const f = fixture("claude-code");
      f.resolve();
      f.write(records());
      const result = await f.read();
      expect(contents(result.records)).toEqual(expected);
      expect(new Set(result.records.map((record) => record.recordId)).size).toBe(
        result.records.length,
      );
      expect(result).toMatchObject({ status: "ready", limitations: [] });
    },
  );

  it("indexes retained tool records once after tracing their older ancestry", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(retainedToolRewriteSession());
    const result = await f.read();
    expect(result.records.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "Read the original file" },
      { kind: "tool-input", content: JSON.stringify({ file: "original.txt" }, null, 2) },
      { kind: "tool-output", content: "original output" },
      { kind: "assistant", content: "after compaction" },
    ]);
    expect(result).toMatchObject({ status: "ready", limitations: [] });
  });

  it("reports partial search coverage after reaching the shared historical traversal budget", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(heavilyRetainedSession());
    const result = await f.read();
    expect(result).toMatchObject({
      status: "partial",
      limitations: ["compaction-link-unavailable"],
    });
    expect(contents(result.records).sort()).toEqual(
      Array.from({ length: 1000 }, (_, index) => `retained-${index}`).sort(),
    );
    expect(new Set(result.records.map((record) => record.recordId)).size).toBe(1000);
    expect(contents(result.records)).not.toContain("unrecovered-original");
  });

  it.each([null, "future"])(
    "reports incomplete coverage when no pre-boundary head exists (%s)",
    async (head) => {
      const f = fixture("claude-code");
      f.resolve();
      f.write(futureLogicalParentSession(head));
      const result = await f.read();
      expect(contents(result.records)).toEqual(["latest-answer"]);
      expect(result).toMatchObject({
        status: "partial",
        limitations: ["compaction-link-unavailable"],
      });
    },
  );

  it("indexes selected occurrences while keeping repeated text in distinct turns", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write([
      ...duplicateUuidSession(),
      assistant("b3", "a3", "active-replacement"),
      user("a4", "b3", "one-a"),
    ]);
    const result = await f.read();
    expect(contents(result.records)).toEqual([
      "zero-a",
      "zero-b",
      "one-a",
      "one-b",
      "two-a",
      "two-b",
      "three-a",
      "active-replacement",
      "one-a",
    ]);
    expect(new Set(result.records.map((record) => record.recordId)).size).toBe(
      result.records.length,
    );
    expect(result).toMatchObject({ status: "ready", limitations: [] });
  });

  it("indexes only the selected tool call and its original output", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(duplicateToolUuidSession());
    const result = await f.read();
    expect(result.records.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "Read the original file" },
      { kind: "tool-input", content: JSON.stringify({ file: "original.txt" }, null, 2) },
      { kind: "tool-output", content: "original output" },
      { kind: "assistant", content: "after compaction" },
    ]);
    expect(result).toMatchObject({ status: "ready", limitations: [] });
  });

  it.each([0, 1])(
    "marks coverage partial for a missing parent inside an earlier segment (%s)",
    async (index) => {
      const f = fixture("claude-code");
      f.resolve();
      const records = specificationSession();
      records[index] = { ...records[index]!, parentUuid: "missing-parent" };
      f.write(records);
      const result = await f.read();
      expect(contents(result.records)).toEqual(specification.slice(index));
      expect(result).toMatchObject({
        status: "partial",
        limitations: ["compaction-link-unavailable"],
      });
    },
  );

  it("marks coverage partial when a boundary cannot be linked to earlier history", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write([
      user("a", null, "alpha-question"),
      boundary("bd", { logicalParentUuid: "gone", head: "gone-too", trigger: "auto" }),
      summary("sm", "bd", "SUMMARY-BODY"),
      assistant("d", "sm", "delta-answer"),
      user("e", "d", "echo-question"),
    ]);
    const result = await f.read();
    expect(contents(result.records)).toEqual(["delta-answer", "echo-question"]);
    expect(result).toMatchObject({
      status: "partial",
      limitations: ["compaction-link-unavailable"],
    });
  });

  it("reads uncompacted Claude transcripts exactly as before", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write([user("a", null, "alpha-question"), assistant("b", "a", "bravo-answer")]);
    const result = await f.read();
    expect(contents(result.records)).toEqual(["alpha-question", "bravo-answer"]);
    expect(result).toMatchObject({ status: "ready", limitations: [] });
  });

  it("collects boundary pointers in the first pass and nothing else from compactMetadata", () => {
    const marked = boundary("bd", {
      logicalParentUuid: "c",
      head: "h",
      anchor: "sm",
      tail: "t",
      trigger: "auto",
    });
    expect(claudeLineageFields(marked)).toEqual({
      uuid: "bd",
      parentUuid: null,
      leafUuid: undefined,
      type: "system",
      isSidechain: false,
      subtype: "compact_boundary",
      logicalParentUuid: "c",
      compactMetadata: { preservedSegment: { headUuid: "h" } },
    });
    const ordinary = claudeLineageFields({
      ...user("a", null, "alpha-question"),
      compactMetadata: { preservedSegment: { headUuid: "h" }, preTokens: 1 },
    });
    expect(ordinary).not.toHaveProperty("compactMetadata");
    expect(ordinary).toMatchObject({ uuid: "a", type: "user", parentUuid: null });
    // A boundary without a usable head carries no metadata object at all.
    expect(claudeLineageFields(boundary("bd2", { logicalParentUuid: "c" }))).not.toHaveProperty(
      "compactMetadata",
    );
    expect(
      claudeLineageFields({
        ...boundary("bd3"),
        compactMetadata: { preservedSegment: { headUuid: 7 } },
      }),
    ).not.toHaveProperty("compactMetadata");
  });

  it("keeps Claude lineage changes separate from the shared sanitizer version", async () => {
    const identity = vi.spyOn(sourceIdentity, "historySourceIdentity");
    const claude = fixture("claude-code");
    claude.resolve();
    claude.write(specificationSession());
    await claude.read();
    const codex = fixture("codex");
    codex.resolve();
    codex.write([codexText("user_message", "body")]);
    await codex.read();
    const [claudeIdentity, codexIdentity] = identity.mock.results.map(
      (result) => result.value as string,
    );
    expect(JSON.parse(claudeIdentity!)).toMatchObject({
      version: 7,
      sanitizerVersion: HISTORY_SEARCH_SANITIZER_VERSION,
      agent: "claude-code",
      claudeLineage: 3,
    });
    expect(codexIdentity).not.toContain("claudeLineage");
    expect(JSON.parse(codexIdentity!)).toMatchObject({
      version: 7,
      sanitizerVersion: HISTORY_SEARCH_SANITIZER_VERSION,
      agent: "codex",
    });
  });

  it("invalidates every agent's former identity while retaining all ownership evidence", () => {
    const resolved = { workspace: "/workspace", native: { native_ref: "native" } };
    const identity = (agent: string) =>
      sourceIdentity.historySourceIdentity(
        {
          sessionId: "session",
          summary: {
            agent,
            title: "Synthetic",
            workspace_id: "registered",
          } as HistorySourceInput["summary"],
          profiles: [],
        },
        "evidence",
        resolved,
      );
    const former = (agent: string) =>
      JSON.stringify({
        version: 7,
        sanitizerVersion: HISTORY_SEARCH_SANITIZER_VERSION,
        sessionId: "session",
        agent,
        title: "Synthetic",
        nativeEvidence: "evidence",
        workspaceId: "registered",
        workspace: "/workspace",
        native: "native",
        profiles: [],
      });
    for (const agent of [
      "codex",
      "hermes",
      "open-claw",
      "grok-build",
      "opencode",
      "cursor",
      "antigravity",
    ]) {
      expect(identity(agent)).toBe(former(agent));
      const old = JSON.parse(former(agent));
      delete old.sanitizerVersion;
      expect(identity(agent)).not.toBe(JSON.stringify(old));
    }
    expect(identity("claude-code")).toBe(
      former("claude-code").replace(/}$/, ',"claudeLineage":3}'),
    );
  });

  it("invalidates the old Claude source revision without changing the transcript", async () => {
    const f = fixture("claude-code");
    f.resolve();
    f.write(retainedRewriteSession());
    const currentIdentity = sourceIdentity.historySourceIdentity;
    const identity = vi
      .spyOn(sourceIdentity, "historySourceIdentity")
      .mockImplementation((...args) => {
        const former = JSON.parse(currentIdentity(...args));
        former.claudeLineage = 2;
        return JSON.stringify(former);
      });
    const former = await f.read();
    identity.mockRestore();
    const current = await f.read();
    expect(current.records).toEqual(former.records);
    expect(current.sourceRevision).not.toBe(former.sourceRevision);
    const cache = new HistorySearchStore(path.join(f.root, "search.sqlite"), true);
    close.push(() => cache.close());
    const session = {
      sessionId: f.input.sessionId,
      workspaceId: f.input.summary.workspace_id,
      agent: f.input.summary.agent,
      title: f.input.summary.title,
      updatedAt: f.input.summary.updated_at,
      archived: false,
      ownerKey: "synthetic-claude-owner",
    };
    const save = (result: typeof current) => {
      const generation = cache.begin(session);
      for (const record of result.records)
        cache.append(session.sessionId, generation, record, () => {});
      cache.finish(
        session.sessionId,
        generation,
        result.sourceRevision,
        result.status,
        result.limitations,
      );
    };
    save(former);
    const allowed = [session.sessionId];
    const oldLocation = cache.query({ query: "alpha-question" }, allowed, () => {}).hits[0]!
      .location;
    expect(cache.cachedSourceRevision(session)).not.toBe(current.sourceRevision);
    save(current);
    expect(cache.cachedSourceRevision(session)).toBe(current.sourceRevision);
    expect(() => cache.locate(oldLocation, allowed)).toThrow("history-source-stale");
    const newLocation = cache.query({ query: "alpha-question" }, allowed, () => {}).hits[0]!
      .location;
    expect(cache.locate(newLocation, allowed).content).toBe("alpha-question");
  });
});
