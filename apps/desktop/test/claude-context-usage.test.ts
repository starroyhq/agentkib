// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeTranscriptObservation } from "../../../packages/backend/src/claude-context-usage";
import { projectContextUsage } from "../../../packages/backend/src/context-usage";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-context-"));
  roots.push(root);
  const nativeId = randomUUID();
  const file = path.join(root, `${nativeId}.jsonl`);
  const row = (value: Record<string, unknown>) =>
    JSON.stringify({ sessionId: nativeId, ...value }) + "\n";
  const assistant = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    row({
      type: "assistant",
      timestamp: "2026-11-18T02:06:43.033Z",
      message: { model: "native-model", usage },
      ...extra,
    });
  return {
    root,
    file,
    nativeId,
    row,
    assistant,
    read: () => readClaudeTranscriptObservation(file, nativeId).usage,
    observe: () => readClaudeTranscriptObservation(file, nativeId),
  };
}

describe("saved Claude context occupancy", () => {
  it("reads only native last-wins permission markers, never message snapshots, defaults or foreign modes", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.row({ type: "permission-mode", permissionMode: "default" }) +
        f.row({ type: "permission-mode", permissionMode: "auto" }) +
        f.row({
          type: "permission-mode",
          permissionMode: "bypassPermissions",
          sessionId: randomUUID(),
        }) +
        f.row({ type: "permission-mode", permissionMode: "plan", isSidechain: true }) +
        f.row({ type: "permission-mode", permissionMode: "plan", parent_tool_use_id: "child" }) +
        f.row({
          type: "user",
          permissionMode: "plan",
          message: { permission_mode: "acceptEdits" },
        }) +
        f.row({ type: "system", subtype: "compact_boundary" }),
    );
    expect(f.observe()).toMatchObject({ permissionMode: "auto", usage: { available: false } });
    appendFileSync(f.file, f.row({ type: "permission-mode", permissionMode: "new-unknown-mode" }));
    expect(f.observe()).toMatchObject({ permissionMode: null });
    appendFileSync(f.file, f.row({ type: "permission-mode", permissionMode: "manual" }));
    expect(f.observe()).toMatchObject({ permissionMode: "default" });
    writeFileSync(f.file, f.row({ type: "user", permissionMode: "auto" }));
    expect(f.observe()).not.toHaveProperty("permissionMode");
  });

  it("extends the bounded metadata cache when a permission marker is older than the usage tail", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.row({ type: "permission-mode", permissionMode: "auto" }) +
        f.row({ type: "progress", data: "x".repeat(160 * 1024) }) +
        f.assistant({ input_tokens: 4 }),
    );
    expect(f.observe()).toMatchObject({ model: "native-model", usage: { usedTokens: 4 } });
    expect(f.observe()).not.toHaveProperty("permissionMode");
    expect(readClaudeTranscriptObservation(f.file, f.nativeId, true)).toMatchObject({
      permissionMode: "auto",
    });
    expect(f.observe()).toMatchObject({ permissionMode: "auto" });
  });

  it("keeps real input and cache counts without inventing a model capacity or cumulative output", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({
        input_tokens: 2,
        cache_read_input_tokens: 738221,
        cache_creation_input_tokens: 184,
        output_tokens: 999999,
      }),
    );
    const usage = f.read();
    expect(usage).toEqual({
      available: true,
      state: "stale",
      historical: true,
      usedTokens: 738407,
      reason: "model-context-window-unavailable",
      updatedAt: "2026-11-18T02:06:43.033Z",
    });
    expect(
      projectContextUsage({ ...usage, reportId: 7, reportGeneration: 4, revision: 9 }),
    ).toEqual(usage);
  });

  it("uses only a native window reported for the same model and session", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({ input_tokens: 42 }) +
        f.row({ type: "result", modelUsage: { "other-model": { contextWindow: 1000000 } } }) +
        f.row({
          sessionId: randomUUID(),
          type: "result",
          modelUsage: { "native-model": { contextWindow: 1000000 } },
        }),
    );
    expect(f.read()).not.toHaveProperty("contextWindow");
    appendFileSync(
      f.file,
      f.row({ type: "result", modelUsage: { "native-model": { contextWindow: 100 } } }),
    );
    expect(f.read()).toMatchObject({ usedTokens: 42, contextWindow: 100, historical: true });
  });

  it("ignores foreign, sidechain, child and advisor reports and chooses the last ordinary iteration", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({
        input_tokens: 2,
        iterations: [
          { type: "message", input_tokens: 17, cache_read_input_tokens: 3 },
          { type: "advisor_message", input_tokens: 1000000 },
        ],
      }) +
        f.assistant({ input_tokens: 900 }, { isSidechain: true }) +
        f.assistant({ input_tokens: 800 }, { parent_tool_use_id: "child" }) +
        f.assistant({ input_tokens: 700 }, { sessionId: randomUUID() }) +
        f.assistant({ input_tokens: 600 }, { session_id: randomUUID() }),
    );
    expect(f.read()).toMatchObject({ usedTokens: 20 });
  });

  it("invalidates saved counts at a compaction boundary until a new main report arrives", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({ input_tokens: 99 }) + f.row({ type: "system", subtype: "compact_boundary" }),
    );
    expect(f.read()).toEqual({ available: false, state: "unavailable" });
    expect(f.observe().model).toBe("native-model");
    appendFileSync(f.file, f.assistant({ input_tokens: 4 }));
    expect(f.read()).toMatchObject({ usedTokens: 4 });
  });

  it("uses the native post-compaction count, independently of pre-compaction counts and limits", () => {
    const f = fixture();
    const boundary = (postTokens: unknown) =>
      f.row({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-11-18T02:06:43.033Z",
        compactMetadata: { preTokens: 714417, postTokens },
      });
    writeFileSync(
      f.file,
      f.assistant({ input_tokens: 500 }) +
        f.row({ type: "result", modelUsage: { "native-model": { contextWindow: 1000000 } } }) +
        boundary(24606),
    );
    expect(f.read()).toEqual({
      available: true,
      state: "stale",
      historical: true,
      usedTokens: 24606,
      reason: "claude-post-compaction-usage",
      updatedAt: "2026-11-18T02:06:43.033Z",
    });
    appendFileSync(f.file, f.assistant({ input_tokens: 27000 }));
    expect(f.read()).toMatchObject({
      usedTokens: 27000,
      reason: "model-context-window-unavailable",
    });
    appendFileSync(f.file, boundary("900"));
    expect(f.read()).toEqual({ available: false, state: "unavailable" });
    writeFileSync(f.file, boundary(0));
    expect(f.read()).toMatchObject({ available: true, usedTokens: 0 });
    expect(f.read()).not.toHaveProperty("contextWindow");
  });

  it("does not reuse a previous model's counts or capacity across compaction", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({ input_tokens: 99 }) +
        f.row({ type: "result", modelUsage: { "native-model": { contextWindow: 1000 } } }) +
        f.row({ type: "assistant", message: { model: "new-model" } }),
    );
    expect(f.observe()).toEqual({
      model: "new-model",
      usage: { available: false, state: "unavailable" },
    });
    appendFileSync(
      f.file,
      f.row({ type: "system", subtype: "compact_boundary" }) + f.assistant({ input_tokens: 4 }),
    );
    expect(f.read()).toMatchObject({ usedTokens: 4, historical: true });
    expect(f.read()).not.toHaveProperty("contextWindow");
  });

  it("retains the last main model independently of usage and ignores CLI output", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.row({ type: "assistant", message: { model: "real-model" } }) +
        f.row({ type: "assistant", message: { model: "<synthetic>" } }) +
        f.row({ type: "assistant", isSidechain: true, message: { model: "child-model" } }),
    );
    expect(f.observe()).toEqual({
      model: "real-model",
      usage: { available: false, state: "unavailable" },
    });
  });

  it.each([-1, "42", Number.MAX_SAFE_INTEGER])(
    "rejects invalid or overflowing counts %s",
    (input_tokens) => {
      const f = fixture();
      writeFileSync(f.file, f.assistant({ input_tokens, cache_read_input_tokens: 2 }));
      expect(f.read()).toEqual({ available: false, state: "unavailable" });
    },
  );

  it("reads only a bounded tail and never follows a replacement symlink", () => {
    const f = fixture();
    writeFileSync(f.file, f.assistant({ input_tokens: 99 }) + "x".repeat(600 * 1024) + "\n");
    expect(f.read()).toEqual({ available: false, state: "unavailable" });
    appendFileSync(f.file, f.assistant({ input_tokens: 7 }));
    expect(f.read()).toMatchObject({ usedTokens: 7 });
    renameSync(f.file, `${f.file}.original`);
    symlinkSync(`${f.file}.original`, f.file);
    expect(f.read()).toEqual({ available: false, state: "unavailable" });
  });

  it("finds the terminal compaction sample behind appended resume metadata", () => {
    const f = fixture();
    writeFileSync(
      f.file,
      f.assistant({ input_tokens: 100 }) +
        f.row({
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-11-18T02:06:44.000Z",
          compactMetadata: { postTokens: 24_606 },
        }) +
        f.row({ type: "progress", data: "x".repeat(2_200_000) }),
    );
    expect(readClaudeTranscriptObservation(f.file, f.nativeId, true).usage.available).toBe(false);
    expect(readClaudeTranscriptObservation(f.file, f.nativeId, "terminal-usage")).toMatchObject({
      model: "native-model",
      usage: {
        usedTokens: 24_606,
        historical: true,
        reason: "claude-post-compaction-usage",
      },
    });
  });
});
