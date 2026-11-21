import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Count every byte the backend reads through readSync so the I/O bound is observable.
const counter = vi.hoisted(() => ({ bytes: 0, byFile: new Map<number, number>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const count = (actual.readSync as (...a: unknown[]) => number)(...args);
      counter.bytes += count;
      return count;
    }) as typeof actual.readSync,
  };
});

import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-title-priority-"));
  roots.push(root);
  const home = path.join(root, "claude"),
    project = path.join(root, "project"),
    directory = path.join(home, "projects", "project"),
    sessionId = randomUUID(),
    file = path.join(directory, `${sessionId}.jsonl`),
    index = path.join(directory, "sessions-index.json");
  mkdirSync(directory, { recursive: true });
  mkdirSync(project);
  const user = (content: string) => ({
    type: "user",
    sessionId,
    cwd: project,
    isSidechain: false,
    message: { role: "user", content },
  });
  const custom = (customTitle: string, extra: Record<string, unknown> = {}) => ({
    type: "custom-title",
    sessionId,
    customTitle,
    ...extra,
  });
  const ai = (aiTitle: string, extra: Record<string, unknown> = {}) => ({
    type: "ai-title",
    sessionId,
    aiTitle,
    ...extra,
  });
  const filler = (bytes: number) => ({ type: "progress", data: "x".repeat(bytes) });
  const write = (rows: unknown[]) =>
    writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const writeIndex = (extra: Record<string, unknown>) =>
    writeFileSync(
      index,
      JSON.stringify({
        version: 1,
        entries: [{ sessionId, projectPath: project, fullPath: file, ...extra }],
      }),
    );
  const list = () => new ClaudeSessions({ CLAUDE_CONFIG_DIR: home }).list(project).sessions;
  const title = () => list()[0].session.title;
  return { user, custom, ai, filler, write, writeIndex, list, title, sessionId };
}

const MiB = 1024 * 1024;

describe("Claude native session title priority and tail window", () => {
  it("prefers custom-title over ai-title regardless of order", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.custom("User title"), f.ai("Generated title")]);
    expect(f.title()).toBe("User title");
    f.write([f.user("Prompt"), f.ai("Generated title"), f.custom("User title")]);
    expect(f.title()).toBe("User title");
  });

  it("uses ai-title when there is no custom-title, ahead of the first prompt", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.ai("Generated title")]);
    expect(f.title()).toBe("Generated title");
  });

  it("takes the latest record of the same kind", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.ai("Old generated"), f.ai("New generated")]);
    expect(f.title()).toBe("New generated");
    f.write([f.user("Prompt"), f.custom("Old"), f.custom("Newest"), f.ai("Generated")]);
    expect(f.title()).toBe("Newest");
  });

  it("lets a rename appended far past the header override the header title", () => {
    const f = fixture();
    f.write([
      f.user("Prompt"),
      f.custom("Header title"),
      f.filler(3 * MiB),
      f.custom("Renamed in tail"),
    ]);
    expect(f.title()).toBe("Renamed in tail");
  });

  it("finds an ai-title that only exists in the tail", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.filler(3 * MiB), f.ai("Tail generated")]);
    expect(f.title()).toBe("Tail generated");
  });

  it("falls back to the first prompt when no title record exists", () => {
    const f = fixture();
    f.write([f.user("Only prompt"), f.filler(3 * MiB)]);
    expect(f.title()).toBe("Only prompt");
  });

  it("ignores title records for another session, internal rows and blank titles", () => {
    const f = fixture();
    f.write([
      f.user("Prompt"),
      f.ai("Wrong", { sessionId: "other" }),
      f.ai("Meta", { isMeta: true }),
      f.ai("Side", { isSidechain: true }),
      f.ai("   "),
      f.custom("Wrong", { sessionId: "other" }),
    ]);
    expect(f.title()).toBe("Prompt");
  });

  it("ranks explicit titles above indexed titles and keeps the index as the next fallback", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.ai("Generated")]);
    f.writeIndex({ summary: "Indexed summary" });
    expect(f.title()).toBe("Generated");
    f.write([f.user("Prompt"), f.ai("Generated"), f.custom("Custom")]);
    expect(f.title()).toBe("Custom");
    f.write([f.user("Prompt")]);
    expect(f.title()).toBe("Indexed summary");
  });

  it("does not reach a title record outside both the header and the tail window", () => {
    const f = fixture();
    f.write([
      f.user("Prompt"),
      f.filler(3 * MiB),
      f.custom("Middle, unreachable"),
      f.filler(512 * 1024),
    ]);
    expect(f.title()).toBe("Prompt");
  });

  it("bounds the bytes read per file and does not read the middle of a large transcript", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.filler(24 * MiB), f.custom("Tail title")]);
    counter.bytes = 0;
    expect(f.title()).toBe("Tail title");
    // 2 MiB header + 256 KiB tail window + one 64 KiB block of slack; never the 24 MiB body.
    expect(counter.bytes).toBeLessThanOrEqual(2 * MiB + 256 * 1024 + 64 * 1024);
  });

  it("caches by mtime and size, then rereads after the file changes", () => {
    const f = fixture();
    f.write([f.user("Prompt"), f.filler(MiB), f.ai("First generated")]);
    expect(f.title()).toBe("First generated");
    counter.bytes = 0;
    expect(f.title()).toBe("First generated");
    expect(counter.bytes).toBe(0);
    f.write([f.user("Prompt"), f.filler(MiB), f.ai("First generated"), f.custom("Renamed")]);
    expect(f.title()).toBe("Renamed");
    expect(counter.bytes).toBeGreaterThan(0);
  });
});
