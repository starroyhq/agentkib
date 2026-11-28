import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeTerminalDisplay } from "../../../packages/backend/src/agents/claude/claude-terminal-display";
import type { ClaudeBridgeSnapshot } from "@agentkib/runtime-protocol";
import { readClaudeTerminalTurnEvidence } from "../../../packages/backend/src/agents/claude/claude-terminal-turn-evidence";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-terminal-turn-"));
  roots.push(root);
  const sessionId = randomUUID();
  const transcript = path.join(root, "transcript.jsonl");
  const record = (type: string, parentUuid: string | null, fields: Record<string, unknown>) => ({
    type,
    parentUuid,
    uuid: randomUUID(),
    sessionId,
    isSidechain: false,
    ...fields,
  });
  const prompt = (parent: string | null = null) =>
    record("user", parent, {
      message: { role: "user", content: [{ type: "text", text: "Read the title" }] },
    });
  const answer = (parent: string, message: Record<string, unknown> = {}) =>
    record("assistant", parent, {
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The title is Example." }],
        ...message,
      },
    });
  const end = (parent: string) =>
    record("system", parent, { subtype: "turn_duration", durationMs: 4, isMeta: false });
  const lines = (...rows: object[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");
  const write = (...rows: object[]) => writeFileSync(transcript, lines(...rows));
  const append = (...rows: object[]) => appendFileSync(transcript, lines(...rows));
  const read = () => readClaudeTerminalTurnEvidence(transcript, sessionId);
  return { sessionId, transcript, record, prompt, answer, end, write, append, read };
}

it("matches the native reply and explicit end across attachments and a block boundary", async () => {
  const { record, prompt, answer, end, write, append, read } = fixture();
  const user = prompt();
  const reminder = record("attachment", user.uuid, {
    attachment: { type: "total_tokens_reminder", details: "A".repeat(66_000) },
  });
  write(user, reminder);
  const open = await read();
  expect(open).toEqual({
    transcriptIdentity: expect.any(String),
    promptId: user.uuid,
    completed: false,
  });
  const reply = answer(reminder.uuid);
  const snapshot = record("attachment", reply.uuid, { attachment: { type: "prompt_snapshot" } });
  append(reply, snapshot);
  expect(await read()).toEqual(open);
  append(end(snapshot.uuid));
  expect(await read()).toEqual({ ...open, completed: true });
});

it("keeps the latest prompt open when an older end arrives after it", async () => {
  const { prompt, answer, end, write, append, read } = fixture();
  const first = prompt();
  const firstAnswer = answer(first.uuid);
  const second = prompt(firstAnswer.uuid);
  write(first, firstAnswer, second, end(firstAnswer.uuid));
  expect(await read()).toMatchObject({ promptId: second.uuid, completed: false });
  const secondAnswer = answer(second.uuid);
  append(secondAnswer, end(secondAnswer.uuid));
  expect(await read()).toMatchObject({ promptId: second.uuid, completed: true });
});

it.each([
  "synthetic assistant",
  "intermediate assistant",
  "metadata marker",
  "sidechain marker",
  "another session",
  "missing parent",
  "newer response",
])("does not accept %s as completion evidence", async (example) => {
  const { prompt, answer, end, write, read } = fixture();
  const user = prompt();
  const reply = answer(
    user.uuid,
    example === "synthetic assistant"
      ? { model: "<synthetic>" }
      : example === "intermediate assistant"
        ? { stop_reason: "tool_use" }
        : {},
  );
  const marker = end(example === "missing parent" ? randomUUID() : reply.uuid);
  write(
    user,
    reply,
    {
      ...marker,
      ...(example === "metadata marker" && { isMeta: true }),
      ...(example === "sidechain marker" && { isSidechain: true }),
      ...(example === "another session" && { sessionId: randomUUID() }),
    },
    ...(example === "newer response" ? [answer(reply.uuid, { stop_reason: null })] : []),
  );
  expect(await read()).toMatchObject({ promptId: user.uuid, completed: false });
});

it.each(['{"type":"user"', "{malformed}\n"])(
  "rejects an older completion if subsequent bytes are incomplete or malformed",
  async (unfinished) => {
    const { transcript, prompt, answer, end, write, read } = fixture();
    const user = prompt();
    const reply = answer(user.uuid);
    write(user, reply, end(reply.uuid));
    appendFileSync(transcript, unfinished);
    expect(await read()).toBeUndefined();
  },
);

it("invalidates cached evidence after a same-size edit on the same file", async () => {
  const { transcript, prompt, answer, end, write, read } = fixture();
  const user = prompt();
  const reply = answer(user.uuid);
  const marker = end(reply.uuid);
  write(user, reply, marker);
  const completed = await read();
  expect(completed).toMatchObject({ completed: true });

  const interrupted = answer(user.uuid, { stop_reason: "tool_use" });
  write(user, { ...interrupted, uuid: reply.uuid }, marker);
  // Set mtime explicitly so the test does not depend on the filesystem clock's resolution.
  const changedAt = new Date(statSync(transcript).mtimeMs + 60_000);
  utimesSync(transcript, changedAt, changedAt);
  expect(await read()).toEqual({ ...completed, completed: false });
});

it("identifies a replacement as a different transcript even when the prompt is copied", async () => {
  const { transcript, prompt, answer, end, write, read } = fixture();
  const user = prompt();
  write(user);
  const open = await read();
  const reply = answer(user.uuid);
  renameSync(transcript, transcript + ".previous");
  write(user, reply, end(reply.uuid));
  const replacement = await read();
  expect(replacement).toMatchObject({ promptId: user.uuid, completed: true });
  expect(replacement?.transcriptIdentity).not.toBe(open?.transcriptIdentity);
});

it("binds the display preview to the witnessed prompt in this lease and file generation", async () => {
  const { sessionId, transcript, prompt, write } = fixture();
  const user = prompt();
  write(user);
  const display = new ClaudeTerminalDisplay();
  const snapshot = {
    status: "running",
    currentTurnId: "bridge-turn",
    compacting: false,
    waiting: null,
  } as ClaudeBridgeSnapshot;
  const lease = {
    identity: { nativeId: sessionId, instanceId: "instance" },
    leaseId: "lease",
    snapshot,
    gap: false,
  } as Parameters<typeof display.observe>[0];
  const live = { connectionGeneration: "lease", status: "running", turnId: "bridge-turn" };
  const observe = () =>
    display.observe(
      lease,
      () => transcript,
      () => true,
    );
  expect(display.live(lease, live)).toMatchObject({ ...live, transcriptTurnId: null });
  await observe();
  expect(display.live(lease, live)).toMatchObject({ ...live, transcriptTurnId: user.uuid });
  snapshot.waiting = "question";
  expect(display.live(lease, live)).toMatchObject({ ...live, transcriptTurnId: user.uuid });
  snapshot.waiting = null;
  expect(display.live(lease, { ...live, connectionGeneration: "other-lease" })).toMatchObject({
    transcriptTurnId: null,
  });

  renameSync(transcript, transcript + ".previous");
  write(user);
  await observe();
  expect(display.live(lease, live)).toMatchObject({ transcriptTurnId: null });
  snapshot.currentTurnId = "next-bridge-turn";
  const next = prompt(user.uuid);
  write(user, next);
  await observe();
  expect(display.live(lease, { ...live, turnId: snapshot.currentTurnId })).toMatchObject({
    transcriptTurnId: next.uuid,
  });
});

it("keeps an independent command unconfirmed when the witnessed native turn finishes", async () => {
  const { sessionId, transcript, prompt, answer, end, write, append } = fixture();
  const input = prompt();
  const reply = answer(input.uuid);
  const display = new ClaudeTerminalDisplay();
  const lease = {
    identity: { nativeId: sessionId, instanceId: "instance" },
    leaseId: "lease",
    gap: false,
    snapshot: { status: "running", currentTurnId: "bridge-turn", compacting: false, waiting: null },
  } as NonNullable<Parameters<typeof display.observe>[0]>;
  const observe = () =>
    display.observe(
      lease,
      () => transcript,
      () => true,
    );
  write(input);
  await observe();
  append(reply, end(reply.uuid));
  await observe();

  const live = { connectionGeneration: lease.leaseId, status: "running", turnId: "bridge-turn" };
  expect(display.live(lease, live)).toMatchObject({ status: "idle", turnId: null });
  const unconfirmed = {
    ...live,
    status: "outcome-unknown",
    reason: "control-outcome-unconfirmed",
    sendEnabled: false,
    steerEnabled: false,
    stopEnabled: false,
  };
  expect(display.live(lease, unconfirmed)).toEqual({
    ...unconfirmed,
    transcriptTurnId: input.uuid,
  });
});
