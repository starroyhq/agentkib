import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  files: new Map<number, string>(),
  bytes: new Map<string, number>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const count = (file: unknown, bytes: number) => {
    const name = typeof file === "number" ? io.files.get(file) : String(file);
    if (name) io.bytes.set(name, (io.bytes.get(name) ?? 0) + bytes);
  };
  return {
    ...actual,
    default: actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      io.files.set(fd, String(args[0]));
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: number) => {
      io.files.delete(fd);
      actual.closeSync(fd);
    }) as typeof actual.closeSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const bytes = Reflect.apply(actual.readSync, actual, args) as number;
      count(args[0], bytes);
      return bytes;
    }) as typeof actual.readSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const value = Reflect.apply(actual.readFileSync, actual, args) as Buffer | string;
      count(args[0], Buffer.byteLength(value));
      return value;
    }) as typeof actual.readFileSync,
  };
});

import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import { ClaudeHostStateStore } from "../../../packages/backend/src/agents/claude/claude-host-state";
import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/agents/claude/claude-session-owner";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  io.bytes.clear();
  vi.restoreAllMocks();
});

async function fixture(mebibytes = 0) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-read-cost-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    config = path.join(root, "claude"),
    bin = path.join(root, "bin"),
    project = path.join(config, "projects", "fixture");
  for (const directory of [workspace, bin, project]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(bin, "claude"), "isolated fixture; never run\n", { mode: 0o700 });
  const nativeId = randomUUID(),
    file = path.join(project, `${nativeId}.jsonl`),
    history = path.join(config, "history.jsonl");
  let parent: string | null = null;
  const message = (content: string, role = "user") => {
    const uuid = randomUUID();
    const row = {
      type: role,
      uuid,
      parentUuid: parent,
      sessionId: nativeId,
      cwd: workspace,
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { role, content, ...(role === "assistant" ? { stop_reason: "end_turn" } : {}) },
    };
    parent = uuid;
    return JSON.stringify(row) + "\n";
  };
  const head = message("Synthetic first prompt");
  writeFileSync(file, head);
  // Large older history plus small recent messages models the first paged screen.
  const filler = JSON.stringify({ type: "progress", data: "x".repeat(512 * 1024) }) + "\n";
  for (let index = 0; index < mebibytes * 2; index++) appendFileSync(file, filler);
  for (let index = 0; index < 100; index++)
    appendFileSync(file, message(`Synthetic message ${index}`, index % 2 ? "assistant" : "user"));
  writeFileSync(
    history,
    JSON.stringify({ sessionId: nativeId, timestamp: 1_786_060_800_000 }) + "\n",
  );
  const environment = { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: bin };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  vi.spyOn(commands, "run").mockImplementation(async (program, args) => ({
    success: true,
    bytes: Buffer.from(
      program === "/bin/ps" ? "" : args[0] === "agents" ? "[]" : "2.1.303 (Claude Code)",
    ),
    error: "",
    truncated: false,
    exitCode: 0,
  }));
  const store = new BackendStore(path.join(root, "backend.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Synthetic",
    "healthy",
    "2026-10-01T00:00:00.000Z",
  );
  const sessions = new SessionReaders(store.sessions, commands, environment, {
    profiles: () => [],
  } as unknown as CursorBridge);
  cleanups.push(() => sessions.close());
  store.sessions.sync(
    "workspace",
    "claude-code",
    (await sessions.list("claude-code", workspace)).sessions,
  );
  const id = store.sessions.id("claude-code", nativeId);
  const owner = new ClaudeManagedReadOwner(
    store,
    sessions,
    commands,
    root,
    environment,
    randomUUID(),
  );
  cleanups.push(() => owner.shutdown());
  io.bytes.clear();
  return {
    root,
    workspace,
    config,
    file,
    history,
    nativeId,
    id,
    sessions,
    store,
    owner,
    commands,
    message,
    head,
  };
}

function bridgeWorktree(f: Awaited<ReturnType<typeof fixture>>, name = "orchestrator") {
  const candidate = path.join(f.workspace, ".claude", "worktrees", name),
    common = path.join(f.workspace, ".git"),
    admin = path.join(common, "worktrees", name);
  mkdirSync(candidate, { recursive: true });
  mkdirSync(admin, { recursive: true });
  writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(admin, "HEAD"), `ref: refs/heads/${name}\n`);
  writeFileSync(path.join(admin, "commondir"), "../..\n");
  writeFileSync(path.join(admin, "gitdir"), `${path.join(candidate, ".git")}\n`);
  writeFileSync(path.join(candidate, ".git"), `gitdir: ${admin}\n`);
  const evidence = (extra: Record<string, unknown> = {}) => {
    const row = JSON.parse(f.message("Synthetic worktree evidence", "assistant"));
    appendFileSync(f.file, JSON.stringify({ ...row, cwd: candidate, ...extra }) + "\n");
  };
  return { candidate, common, admin, evidence };
}

describe("Claude bridge native worktree identity", () => {
  it("verifies an EnterWorktree move with bounded main-transcript evidence", async () => {
    const f = await fixture(24),
      worktree = bridgeWorktree(f);
    worktree.evidence();
    io.bytes.clear();
    const header = vi.spyOn(f.sessions, "verifiedClaudeControlTarget");
    expect(() =>
      f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
    ).not.toThrow();
    expect(header).toHaveBeenCalledTimes(2);
    expect(io.bytes.get(f.file) ?? 0).toBeLessThan(4 * 1024 * 1024);
  });

  it.each(["missing", "returned-to-root", "sidechain", "child", "metadata", "foreign", "no-id"])(
    "rejects missing or conflicting main-session worktree evidence: %s",
    async (kind) => {
      const f = await fixture(),
        worktree = bridgeWorktree(f);
      if (kind === "returned-to-root") {
        worktree.evidence();
        appendFileSync(f.file, f.message("Returned to original working directory", "assistant"));
      } else if (kind === "sidechain") worktree.evidence({ isSidechain: true });
      else if (kind === "child") worktree.evidence({ agentId: "synthetic-child" });
      else if (kind === "metadata") worktree.evidence({ isMeta: true });
      else if (kind === "foreign") worktree.evidence({ sessionId: randomUUID() });
      else if (kind === "no-id") worktree.evidence({ sessionId: null });
      expect(() =>
        f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
      ).toThrow("session-workspace-mismatch");
    },
  );

  it("does not scan older history when main evidence is outside its tail budget", async () => {
    const f = await fixture(),
      worktree = bridgeWorktree(f);
    worktree.evidence();
    appendFileSync(
      f.file,
      JSON.stringify({ type: "progress", data: "x".repeat(600 * 1024) }) + "\n",
    );
    expect(() =>
      f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
    ).toThrow("session-workspace-mismatch");
  });

  it("rejects a truncated final native record instead of using stale cwd evidence", async () => {
    const f = await fixture(),
      worktree = bridgeWorktree(f);
    worktree.evidence();
    appendFileSync(f.file, '{"type":"assistant","cwd":');
    expect(() =>
      f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
    ).toThrow("session-workspace-mismatch");
  });

  it.each(["uuid", "cwd", "sidechain"])(
    "keeps the original transcript header proof after entering a worktree: %s",
    async (changed) => {
      const f = await fixture(),
        worktree = bridgeWorktree(f);
      worktree.evidence();
      const rows = readFileSync(f.file, "utf8").split("\n"),
        header = JSON.parse(rows[0]!);
      if (changed === "uuid") header.sessionId = randomUUID();
      else if (changed === "cwd") header.cwd = worktree.candidate;
      else header.isSidechain = true;
      rows[0] = JSON.stringify(header);
      writeFileSync(f.file, rows.join("\n"));
      expect(() =>
        f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
      ).toThrow();
    },
  );

  it.each(["plain-folder", "foreign-repository", "backlink", "nested", "traversal"])(
    "rejects an unverified worktree directory: %s",
    async (kind) => {
      const f = await fixture(),
        worktree = bridgeWorktree(f);
      let candidate = worktree.candidate;
      if (kind === "plain-folder") rmSync(path.join(candidate, ".git"));
      else if (kind === "foreign-repository") {
        const foreign = path.join(f.root, "foreign", ".git", "worktrees", "orchestrator");
        mkdirSync(foreign, { recursive: true });
        writeFileSync(path.join(foreign, "commondir"), "../..\n");
        writeFileSync(path.join(foreign, "gitdir"), `${path.join(candidate, ".git")}\n`);
        writeFileSync(path.join(candidate, ".git"), `gitdir: ${foreign}\n`);
      } else if (kind === "backlink")
        writeFileSync(path.join(worktree.admin, "gitdir"), `${path.join(f.workspace, ".git")}\n`);
      else if (kind === "nested") {
        candidate = path.join(candidate, "child");
        mkdirSync(candidate);
      } else
        candidate = `${path.dirname(candidate)}${path.sep}ignored${path.sep}..${path.sep}orchestrator`;
      if (kind === "traversal") mkdirSync(path.join(path.dirname(worktree.candidate), "ignored"));
      worktree.evidence({ cwd: candidate });
      expect(() =>
        f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, candidate),
      ).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a candidate directory reached through a symlink",
    async () => {
      const f = await fixture(),
        worktree = bridgeWorktree(f),
        actual = `${worktree.candidate}-actual`;
      worktree.evidence();
      renameSync(worktree.candidate, actual);
      symlinkSync(actual, worktree.candidate);
      expect(() =>
        f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
      ).toThrow("session-workspace-mismatch");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink replacing the parent worktrees directory",
    async () => {
      const f = await fixture(),
        worktree = bridgeWorktree(f),
        directory = path.dirname(worktree.candidate),
        actual = `${directory}-actual`;
      worktree.evidence();
      renameSync(directory, actual);
      symlinkSync(actual, directory);
      expect(() =>
        f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
      ).toThrow("session-workspace-mismatch");
    },
  );

  it("revalidates the original header and file version after reading worktree evidence", async () => {
    const f = await fixture(),
      worktree = bridgeWorktree(f);
    worktree.evidence();
    const original = f.sessions.verifiedClaudeControlTarget.bind(f.sessions);
    let calls = 0;
    vi.spyOn(f.sessions, "verifiedClaudeControlTarget").mockImplementation((id, workspace) => {
      if (++calls === 2) appendFileSync(f.file, f.message("Changed after the tail read"));
      return original(id, workspace);
    });
    expect(() =>
      f.sessions.verifyClaudeBridgeWorktree(f.nativeId, f.workspace, worktree.candidate),
    ).toThrow("session-workspace-mismatch");
  });
});

/** Reference of the old #findNative observation path, including its complete document and hash. */
async function legacyNativeObservation(f: Awaited<ReturnType<typeof fixture>>) {
  const listing = await f.sessions.list("claude-code", f.workspace);
  const native = listing.sessions.find((candidate) => candidate.native_ref === f.nativeId)!;
  const document = await f.sessions.document(f.id);
  expect(document.source).toMatchObject({ agent: "claude-code", workspace_id: "workspace" });
  const workspace = f.sessions.claudeControlWorkspace(native.native_ref, f.workspace);
  const file = f.sessions.verifiedClaudeControlTarget(native.native_ref, workspace);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256").update(JSON.stringify([native.native_ref, workspace]));
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(fd);
  }
  expect(f.sessions.verifiedClaudeControlTarget(native.native_ref, workspace)).toBe(file);
  return hash.digest("hex");
}

describe("Claude read observation cost and identity boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "identifies a resumed terminal separately from idle or background Claude history",
    async () => {
      const f = await fixture();
      const run = vi.mocked(f.commands.run);
      await expect(f.owner.hasRunningNativeTerminal(f.id)).resolves.toBe(false);
      await expect(f.owner.hasRunningNativeTerminal("missing")).resolves.toBe(false);

      const response = (output: string) => ({
        success: true,
        bytes: Buffer.from(output),
        error: "",
        truncated: false,
        exitCode: 0,
      });
      let args = "--resume another-session";
      run.mockImplementation(async (program) =>
        response(
          program === "/bin/ps" ? `123 123 Mon Oct 19 00:00:00 2026 claude ${args}\n` : "[]",
        ),
      );
      await expect(f.owner.hasRunningNativeTerminal(f.id)).resolves.toBe(false);
      args = `-p --resume ${f.nativeId}`;
      await expect(f.owner.hasRunningNativeTerminal(f.id)).resolves.toBe(false);
      args = `--resume ${f.nativeId}`;
      await expect(f.owner.hasRunningNativeTerminal(f.id)).resolves.toBe(true);
    },
  );

  it("reads a saved main-session context count while an external terminal owns execution", async () => {
    const f = await fixture();
    appendFileSync(
      f.file,
      JSON.stringify({
        type: "assistant",
        sessionId: f.nativeId,
        cwd: f.workspace,
        uuid: randomUUID(),
        isSidechain: false,
        timestamp: "2026-11-18T02:06:43.033Z",
        message: {
          role: "assistant",
          model: "native-model",
          content: [],
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 738221,
            cache_creation_input_tokens: 184,
          },
        },
      }) + "\n",
    );
    vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockResolvedValue({
      kind: "interactive",
      pid: 12345,
      source: "agents",
    });
    const document = vi.spyOn(f.sessions, "document");
    const fingerprint = vi.spyOn(f.sessions, "verifiedClaudeControlTarget");
    // Ordinary native records can push the last assistant report outside the live read budget.
    appendFileSync(
      f.file,
      JSON.stringify({ type: "progress", data: "x".repeat(600 * 1024) }) + "\n",
    );
    const live = await f.owner.live(f.id, true);
    expect(live).toMatchObject({
      sendEnabled: false,
      ownershipReason: "claude-owner-busy",
      usage: { available: false },
    });
    const usage = await f.owner.request({ operation: "usage", sessionId: f.id });
    expect(usage).toMatchObject({ available: true, historical: true, usedTokens: 738407 });
    expect(usage).not.toHaveProperty("contextWindow");
    expect(usage).not.toHaveProperty("percent");
    const settings = await f.owner.request({ operation: "settings-state", sessionId: f.id });
    expect(settings).toMatchObject({
      current: { model: null },
      selected: { model: null },
      historicalSettings: { model: "native-model" },
    });
    expect(document).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("shows the last native model behind appended metadata without confirming pending settings", async () => {
    const f = await fixture();
    const assistant = JSON.parse(f.message("Synthetic last reply", "assistant"));
    assistant.message.model = "native-model";
    assistant.message.usage = { input_tokens: 24_606 };
    appendFileSync(f.file, JSON.stringify(assistant) + "\n");
    const adapterMetadata = JSON.stringify({ type: "progress", data: "x".repeat(256 * 1024) });
    appendFileSync(f.file, (adapterMetadata + "\n").repeat(9));
    new ClaudeHostStateStore(f.root, f.owner.bootId).update(f.id, (state) => {
      state.settings = { model: "opus", effort: "max" };
    });
    const document = vi.spyOn(f.sessions, "document");

    const settings = await f.owner.request({ operation: "settings-state", sessionId: f.id });
    expect(settings).toMatchObject({
      current: { model: null, effort: null },
      selected: { model: "opus", effort: "max" },
      historicalSettings: { model: "native-model" },
      applicationStatus: "pending",
      models: [],
      writable: { model: { available: false }, effort: { available: false } },
    });
    expect(await f.owner.request({ operation: "usage", sessionId: f.id })).toMatchObject({
      available: false,
    });
    expect(document).not.toHaveBeenCalled();
  });

  it("uses one discovery and no complete document for an unmanaged live read and each history page", async () => {
    const f = await fixture();
    const discoveries = vi.spyOn(ClaudeSessions.prototype, "list");
    const document = vi.spyOn(f.sessions, "document");
    const fingerprint = vi.spyOn(f.sessions, "verifiedClaudeControlTarget");
    await f.owner.live(f.id, true);
    expect(discoveries).toHaveBeenCalledTimes(1);
    expect(document).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
    discoveries.mockClear();
    const page = (await f.owner.events(f.id, null, 50)) as { events: unknown[] };
    expect(page.events).toHaveLength(50);
    expect(discoveries).toHaveBeenCalledTimes(1);
    expect(document).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("reuses history timestamp scans until content, identity or known native sessions change", async () => {
    const f = await fixture();
    await f.sessions.list("claude-code", f.workspace);
    expect(io.bytes.get(f.history) ?? 0).toBe(0);
    const historyTime = lstatSync(f.history).mtime;
    const before = readFileSync(f.history, "utf8");
    const next = before.replace("1786060800000", "1886060800000");
    expect(next.length).toBe(before.length);
    const replacement = `${f.history}.replacement`;
    writeFileSync(replacement, next);
    utimesSync(replacement, historyTime, historyTime);
    renameSync(replacement, f.history);
    io.bytes.clear();
    const changed = await f.sessions.list("claude-code", f.workspace);
    expect(io.bytes.get(f.history)).toBe(Buffer.byteLength(next));
    expect(changed.sessions[0].updated_at).toBe(
      new Date(1_886_060_800_000).toISOString().replace(".000Z", "Z"),
    );
    io.bytes.clear();
    await f.sessions.list("claude-code", f.workspace);
    expect(io.bytes.get(f.history) ?? 0).toBe(0);
    appendFileSync(
      f.history,
      JSON.stringify({ sessionId: f.nativeId, timestamp: 1_986_060_800_000 }) + "\n",
    );
    const appended = await f.sessions.list("claude-code", f.workspace);
    expect(appended.sessions[0].updated_at).toBe(
      new Date(1_986_060_800_000).toISOString().replace(".000Z", "Z"),
    );
    const added = randomUUID();
    appendFileSync(
      f.history,
      JSON.stringify({ sessionId: added, timestamp: 1_986_060_800_000 }) + "\n",
    );
    await f.sessions.list("claude-code", f.workspace);
    writeFileSync(
      path.join(path.dirname(f.file), `${added}.jsonl`),
      f.head.replaceAll(f.nativeId, added),
    );
    io.bytes.clear();
    const discovered = await f.sessions.list("claude-code", f.workspace);
    expect(discovered.sessions.find((row) => row.native_ref === added)?.updated_at).toBe(
      new Date(1_986_060_800_000).toISOString().replace(".000Z", "Z"),
    );
    expect(io.bytes.get(f.history)).toBeGreaterThan(0);
  });

  it("invalidates observation versions for append and same-size replacement with a restored mtime", async () => {
    const f = await fixture();
    const initial = await f.owner.historyVersion(f.id);
    expect(await f.owner.historyVersion(f.id)).toBe(initial);
    appendFileSync(f.file, f.message("Appended record"));
    const appended = await f.owner.historyVersion(f.id);
    expect(appended).not.toBe(initial);
    const stat = lstatSync(f.file),
      replacement = `${f.file}.replacement`;
    writeFileSync(replacement, readFileSync(f.file));
    utimesSync(replacement, stat.atime, stat.mtime);
    renameSync(replacement, f.file);
    expect(await f.owner.historyVersion(f.id)).not.toBe(appended);
  });

  it("never reuses observation identity after an indexed transcript changes owner", async () => {
    const f = await fixture();
    await f.owner.live(f.id, true);
    await f.owner.events(f.id, null, 50);
    const stat = lstatSync(f.file),
      other = randomUUID();
    const replacement = `${f.file}.replacement`;
    writeFileSync(replacement, readFileSync(f.file, "utf8").replaceAll(f.nativeId, other));
    utimesSync(replacement, stat.atime, stat.mtime);
    renameSync(replacement, f.file);
    await expect(f.owner.live(f.id, true)).rejects.toThrow("session-unavailable");
    await expect(f.owner.events(f.id, null, 50)).rejects.toThrow("session-unavailable");
    await expect(f.owner.historyVersion(f.id)).rejects.toThrow("session-unavailable");
  });

  it.each(["workspace", "sidechain"] as const)(
    "rechecks the transcript header despite an unchanged index claiming valid %s",
    async (changed) => {
      const f = await fixture();
      writeFileSync(
        path.join(path.dirname(f.file), "sessions-index.json"),
        JSON.stringify({
          version: 1,
          entries: [
            {
              sessionId: f.nativeId,
              projectPath: f.workspace,
              fullPath: f.file,
              isSidechain: false,
            },
          ],
        }),
      );
      await f.owner.live(f.id, true);
      const rows = readFileSync(f.file, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const row = JSON.parse(line);
          if (changed === "workspace") row.cwd = f.root;
          else row.isSidechain = true;
          return JSON.stringify(row);
        });
      writeFileSync(f.file, rows.join("\n") + "\n");
      const reason =
        changed === "workspace"
          ? "session-workspace-mismatch"
          : "auxiliary-session-not-controllable";
      await expect(f.owner.live(f.id, true)).rejects.toThrow(reason);
      await expect(f.owner.events(f.id, null, 50)).rejects.toThrow(reason);
      await expect(f.owner.historyVersion(f.id)).rejects.toThrow(reason);
    },
  );

  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "keeps fresh control fingerprints and external-owner admission after cached observations",
    async () => {
      const f = await fixture();
      await f.owner.live(f.id, true);
      await f.owner.events(f.id, null, 50);
      appendFileSync(f.file, f.message("Changed after observation"));
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockResolvedValue({
        kind: "interactive",
        pid: 234567,
        source: "ps",
      });
      await expect(
        f.owner.request({
          operation: "send",
          sessionId: f.id,
          requestId: randomUUID(),
          deviceId: "synthetic-device",
          runtimeBootId: f.owner.bootId,
          expectedRevision: (await f.owner.live(f.id, true)).revision,
          experimentalEnabled: true,
          text: "Continue the session",
        }),
      ).resolves.toMatchObject({
        accepted: false,
        error: "claude-owner-busy",
        controlOutcome: "not-dispatched",
      });
    },
  );

  it("bounds first-page and ten unchanged observations independently of a 32 MiB old transcript", async () => {
    const f = await fixture(32);
    const baselineStart = performance.now();
    await legacyNativeObservation(f);
    const baselineMs = performance.now() - baselineStart;
    const baselineBytes = io.bytes.get(f.file) ?? 0;
    expect(baselineBytes).toBeGreaterThan(64 * 1024 * 1024);
    io.bytes.clear();
    const start = performance.now();
    await f.owner.live(f.id, true);
    await f.owner.events(f.id, null, 50);
    const firstPageMs = performance.now() - start,
      firstPageBytes = io.bytes.get(f.file) ?? 0;
    expect(firstPageBytes).toBeLessThan(1024 * 1024);
    io.bytes.clear();
    const unchangedStart = performance.now(),
      version = await f.owner.historyVersion(f.id);
    for (let index = 0; index < 10; index++) {
      expect(await f.owner.historyVersion(f.id)).toBe(version);
      await f.owner.live(f.id, true);
    }
    const unchangedMs = performance.now() - unchangedStart,
      unchangedBytes = io.bytes.get(f.file) ?? 0;
    expect(unchangedBytes).toBeLessThan(6 * 1024 * 1024);
    expect(io.bytes.get(f.history) ?? 0).toBe(0);
    console.info(
      JSON.stringify({
        benchmark: "claude-native-32MiB-synthetic",
        baselineBytes,
        baselineMs,
        firstPageBytes,
        firstPageMs,
        unchangedBytes,
        unchangedMs,
      }),
    );
  });
});
