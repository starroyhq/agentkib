import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { Commands } from "../../../packages/backend/src/commands";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  readUnknownManagedCommands,
} from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-delete-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "claude");
  const bin = path.join(root, "bin");
  const project = path.join(config, "projects", "fixture");
  for (const directory of [workspace, bin, project])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(bin, "claude"), "offline fixture must not execute\n", { mode: 0o700 });
  const environment = { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: bin };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  let agents = "[]";
  let processes = "";
  vi.spyOn(commands, "run").mockImplementation(async (program, args) => ({
    success: true,
    bytes: Buffer.from(
      program === "/bin/ps" ? processes : args[0] === "agents" ? agents : "2.1.311 (Claude Code)",
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
    "Offline",
    "healthy",
    "2026-10-01T00:00:00.000Z",
  );
  const sessions = new SessionReaders(store.sessions, commands, environment, {
    profiles: () => [],
  } as unknown as CursorBridge);
  cleanups.push(() => sessions.close());
  const transcriptOf = (nativeId: string) => path.join(project, `${nativeId}.jsonl`);
  const write = (nativeId: string) => {
    const user = randomUUID();
    const rows = [
      {
        type: "user",
        uuid: user,
        sessionId: nativeId,
        cwd: workspace,
        timestamp: "2026-10-01T00:00:00.000Z",
        message: { role: "user", content: "Synthetic request" },
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: user,
        sessionId: nativeId,
        cwd: workspace,
        timestamp: "2026-10-01T00:01:00.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Synthetic reply" }],
        },
      },
    ];
    writeFileSync(transcriptOf(nativeId), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  };
  const nativeId = randomUUID();
  const otherId = randomUUID();
  write(nativeId);
  write(otherId);
  // What Claude Code keeps for a session besides its transcript.
  const artifacts = [
    path.join(project, nativeId, "subagents", "agent-a.jsonl"),
    path.join(project, `${nativeId}.precompact.json`),
    path.join(config, "file-history", nativeId, "backup@v1"),
    path.join(config, "session-env", nativeId, "hook.sh"),
    path.join(config, "tasks", nativeId, "1.json"),
    path.join(config, "debug", `${nativeId}.txt`),
    path.join(config, "usage-data", "session-meta", `${nativeId}.json`),
  ];
  const kept = [
    transcriptOf(otherId),
    path.join(project, otherId, "subagents", "agent-b.jsonl"),
    path.join(config, "file-history", otherId, "backup@v1"),
    path.join(config, "debug", `${otherId}.txt`),
  ];
  for (const file of [...artifacts, ...kept.slice(1)]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "synthetic");
  }
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
  const live = () =>
    owner.request({ operation: "live", sessionId: id, experimentalEnabled: true }) as Promise<
      Record<string, unknown>
    >;
  const capabilities = async () =>
    (
      (await owner.request({
        operation: "capabilities",
        sessionId: id,
        experimentalEnabled: true,
      })) as { features: Record<string, { available: boolean; reason?: string }> }
    ).features;
  const remove = async (requestId = randomUUID()) =>
    owner.request({
      operation: "delete",
      sessionId: id,
      requestId,
      deviceId: "browser-device-a",
      runtimeBootId: owner.bootId,
      expectedRevision: Number((await live()).revision),
      experimentalEnabled: true,
    }) as Promise<Record<string, unknown>>;
  const desktopRecord = (cliSessionId: string, extra: Record<string, unknown> = {}) => {
    const directory = path.join(
      root,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "org",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `local_${randomUUID()}.json`),
      JSON.stringify({ cliSessionId, title: "Synthetic", ...extra }),
    );
  };
  return {
    root,
    config,
    project,
    store,
    owner,
    id,
    nativeId,
    otherId,
    transcript: transcriptOf(nativeId),
    artifacts,
    kept,
    live,
    capabilities,
    remove,
    desktopRecord,
    setOwner: (pid: number) => {
      agents = JSON.stringify([{ sessionId: nativeId, pid, kind: "interactive" }]);
      processes = `${pid} ${pid} Wed Oct 28 21:00:00 2026 claude\n`;
    },
  };
}

describe.skipIf(process.platform === "win32")("Deleting a Claude Code session", () => {
  it("removes its transcript and the files Claude Code keeps for it, and only those", async () => {
    const f = await fixture();
    expect((await f.capabilities()).delete).toEqual({ available: true });
    expect(await f.remove()).toMatchObject({ accepted: true, completed: true, deleted: true });
    expect(existsSync(f.transcript)).toBe(false);
    expect(existsSync(path.join(f.project, f.nativeId))).toBe(false);
    for (const file of f.artifacts) expect(existsSync(file), file).toBe(false);
    for (const file of f.kept) expect(existsSync(file), file).toBe(true);
    expect(f.store.sessions.get(f.id)).toBeNull();
  });

  it("deletes an adopted session and AgentKib's record of it", async () => {
    const f = await fixture();
    await f.owner.request({
      operation: "adopt",
      sessionId: f.id,
      requestId: randomUUID(),
      deviceId: "browser-device-a",
    });
    expect(f.owner.hasManagedSession(f.id)).toBe(true);
    expect(await f.remove()).toMatchObject({ accepted: true, deleted: true });
    expect(f.owner.hasManagedSession(f.id)).toBe(false);
    expect(existsSync(path.join(f.root, "claude-managed", `${f.id}.json`))).toBe(false);
    expect(existsSync(f.transcript)).toBe(false);
  });

  it("refuses while Claude Code has the session open, and keeps every file", async () => {
    const f = await fixture();
    f.setOwner(4242);
    expect((await f.capabilities()).delete).toEqual({
      available: false,
      reason: "claude-owner-busy",
    });
    expect(await f.remove()).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "claude-owner-busy",
    });
    expect(existsSync(f.transcript)).toBe(true);
    for (const file of f.artifacts) expect(existsSync(file), file).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "refuses a session a Claude Desktop record names, archived or not",
    async () => {
      const f = await fixture();
      f.desktopRecord(f.otherId);
      f.desktopRecord(f.nativeId, { isArchived: true });
      expect((await f.capabilities()).delete).toEqual({
        available: false,
        reason: "claude-desktop-session",
      });
      expect(await f.remove()).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "claude-desktop-session",
      });
      expect(existsSync(f.transcript)).toBe(true);

      // Records are read again for the delete itself, whatever the capability last saw.
      const g = await fixture();
      g.desktopRecord(g.otherId);
      expect((await g.capabilities()).delete).toEqual({ available: true });
      g.desktopRecord(g.nativeId);
      expect(await g.remove()).toMatchObject({ reason: "claude-desktop-session" });
      expect(existsSync(g.transcript)).toBe(true);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "keeps the session whole when its transcript cannot be removed",
    async () => {
      const f = await fixture();
      chmodSync(f.project, 0o500);
      cleanups.push(() => chmodSync(f.project, 0o700));
      expect(await f.remove()).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "claude-delete-failed",
      });
      expect(existsSync(f.transcript)).toBe(true);
      // Nothing else went first.
      for (const file of f.artifacts) expect(existsSync(file), file).toBe(true);
      expect(f.store.sessions.get(f.id)).not.toBeNull();
    },
  );

  it("never follows a link out of the Claude folder", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "synthetic");
    const linked = path.join(f.config, "image-cache", f.nativeId);
    mkdirSync(path.dirname(linked), { recursive: true });
    symlinkSync(outside, linked);
    expect(await f.remove()).toMatchObject({ accepted: true, deleted: true });
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
    // A link is not Claude Code's own folder: it is left as it is.
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it("only another delete may follow an unconfirmed one, and it settles that one too", async () => {
    const f = await fixture();
    const send = randomUUID();
    claimManagedCommand(f.root, send, f.id, "synthetic", "browser-device-a", {
      operation: "send",
    });
    dispatchManagedCommand(f.root, send);
    expect((await f.capabilities()).delete).toEqual({
      available: false,
      reason: "control-outcome-unconfirmed",
    });
    expect(await f.remove()).toMatchObject({ reason: "control-outcome-unconfirmed" });
    expect(existsSync(f.transcript)).toBe(true);

    const g = await fixture();
    const earlier = randomUUID();
    claimManagedCommand(g.root, earlier, g.id, "synthetic", "browser-device-a", {
      operation: "delete",
    });
    dispatchManagedCommand(g.root, earlier);
    expect(await g.remove()).toMatchObject({ accepted: true, deleted: true });
    expect(readUnknownManagedCommands(g.root, g.id)).toEqual([]);
    expect(
      readControlReceipt(g.root, { requestId: earlier, deviceId: "browser-device-a" }),
    ).toMatchObject({ status: "accepted" });
  });

  it("replays the answer for a repeated request", async () => {
    const f = await fixture();
    const request = {
      operation: "delete",
      sessionId: f.id,
      requestId: randomUUID(),
      deviceId: "browser-device-a",
      runtimeBootId: f.owner.bootId,
      expectedRevision: Number((await f.live()).revision),
      experimentalEnabled: true,
    };
    const first = await f.owner.request(request);
    expect(first).toMatchObject({ accepted: true, deleted: true });
    expect(await f.owner.request(request)).toEqual(first);
  });
});
