import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { createFakeClaude } from "./fixtures/claude-fake-cli";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function managedRuntime(root: string, workspace: string, environment: NodeJS.ProcessEnv) {
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const commands = new Commands();
  cleanups.push(() => commands.close());
  vi.spyOn(commands, "run").mockImplementation(async (program, args) => ({
    success: true,
    bytes: Buffer.from(
      program === "/bin/ps" ? "" : args[0] === "agents" ? "[]" : "2.1.301 (Claude Code)",
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
  const makeOwner = () => {
    const owner = new ClaudeManagedReadOwner(
      store,
      sessions,
      commands,
      root,
      environment,
      randomUUID(),
    );
    cleanups.push(() => owner.shutdown());
    return owner;
  };
  return { commands, store, sessions, makeOwner };
}

async function fixture(titleKind: "prompt" | "ai" | "custom" = "prompt") {
  const { root, workspace, config, environment } = createFakeClaude("agentkib-claude-catalog-");
  const { commands, store, sessions, makeOwner } = managedRuntime(root, workspace, environment);
  const project = path.join(config, "projects", "fixture");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const nativeId = randomUUID();
  const file = path.join(project, `${nativeId}.jsonl`);
  const user = randomUUID();
  const expectedTitle =
    titleKind === "prompt"
      ? "Original user request"
      : titleKind === "ai"
        ? "Generated native title"
        : "Custom native title";
  const rows = [
    {
      type: "user",
      uuid: user,
      sessionId: nativeId,
      cwd: workspace,
      timestamp: "2026-10-01T00:00:00.000Z",
      message: { role: "user", content: "Original user request" },
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
        content: [{ type: "text", text: "Completed reply" }],
      },
    },
    ...(titleKind === "prompt"
      ? []
      : [
          {
            type: titleKind === "ai" ? "ai-title" : "custom-title",
            sessionId: nativeId,
            ...(titleKind === "ai" ? { aiTitle: expectedTitle } : { customTitle: expectedTitle }),
          },
        ]),
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const originalAt = "2026-10-01T00:02:00Z";
  utimesSync(file, new Date(originalAt), new Date(originalAt));
  store.sessions.sync(
    "workspace",
    "claude-code",
    (await sessions.list("claude-code", workspace)).sessions,
  );
  const id = store.sessions.id("claude-code", nativeId);
  const owner = makeOwner();
  const send = async (target = owner, sessionId = id) => {
    await target.request({
      operation: "send",
      sessionId,
      requestId: randomUUID(),
      deviceId: "browser-device-a",
      runtimeBootId: target.bootId,
      expectedRevision: (await target.live(sessionId, true)).revision,
      experimentalEnabled: true,
      text: "Continue the session",
    });
    await expect.poll(async () => (await target.live(sessionId, true)).status).toBe("idle");
  };
  const control = async (operation: string, sessionId = id, target = owner) =>
    target.request({
      operation,
      sessionId,
      requestId: randomUUID(),
      deviceId: "browser-device-a",
      runtimeBootId: target.bootId,
      expectedRevision: (await target.live(sessionId, true)).revision,
      ...(operation === "release" ? {} : { experimentalEnabled: true }),
    }) as Promise<Record<string, any>>;
  return {
    root,
    store,
    owner,
    makeOwner,
    send,
    control,
    id,
    nativeId,
    file,
    expectedTitle,
    originalAt,
    workspace,
    sessions,
    commands,
  };
}

describe.skipIf(process.platform === "win32")("Claude verified managed catalog metadata", () => {
  it("lists managed sessions before the default Claude config exists and rejects a redirected location", async () => {
    const { root, workspace, environment, frames } = createFakeClaude("agentkib-claude-catalog-");
    const { makeOwner } = managedRuntime(root, workspace, {
      ...environment,
      CLAUDE_CONFIG_DIR: undefined,
    });
    const config = path.join(environment.HOME, ".claude");
    const owner = makeOwner();
    const created = await owner.request({
      operation: "create",
      workspaceId: "workspace",
      requestId: randomUUID(),
      deviceId: "browser-device-a",
    });
    expect(created).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    const { sessionId } = created as { sessionId: string };
    const row = expect.objectContaining({ id: sessionId, executionMode: "claude-managed" });
    expect(owner.catalog()).toEqual([row]);
    expect(existsSync(config)).toBe(false);
    expect(frames()).toEqual([]);

    const redirected = path.join(root, "redirected-config");
    symlinkSync(redirected, config);
    expect(owner.catalog()).toEqual([]);
    mkdirSync(redirected);
    expect(owner.catalog()).toEqual([]);
    rmSync(config);
    mkdirSync(path.join(config, "projects"), { recursive: true });
    expect(owner.catalog()).toEqual([row]);

    const sent = await owner.request({
      operation: "send",
      sessionId,
      requestId: randomUUID(),
      deviceId: "browser-device-a",
      runtimeBootId: owner.bootId,
      expectedRevision: (await owner.live(sessionId, true)).revision,
      experimentalEnabled: true,
      text: "Keep the captured home after the first send",
    });
    expect(sent).toMatchObject({ accepted: true });
    await expect.poll(async () => (await owner.live(sessionId, true)).status).toBe("idle");
    expect(frames().filter((frame) => frame.type === "user")).toHaveLength(1);

    rmSync(config, { recursive: true });
    expect(owner.catalog()).toEqual([row]);
    symlinkSync(redirected, config);
    expect(owner.catalog()).toEqual([]);
  });

  it.each(["prompt", "ai", "custom"] as const)(
    "preserves the native %s title through continuation, release and backend restart",
    async (kind) => {
      const f = await fixture(kind);
      const before = readFileSync(f.file);
      await f.send();
      expect(f.owner.catalog().find((row) => row.id === f.id)?.title).toBe(f.expectedTitle);
      await f.control("release");
      await f.owner.shutdown();
      const next = f.makeOwner();
      await f.send(next);
      expect(next.catalog().find((row) => row.id === f.id)?.title).toBe(f.expectedTitle);
      expect(readFileSync(f.file)).toEqual(before);
    },
  );

  it("gives a lazy native fork its verified source title and opaque source relationship without starting the CLI", async () => {
    const f = await fixture("custom");
    const before = readFileSync(f.file);
    const fork = await f.control("fork");
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)).toMatchObject({
      title: f.expectedTitle,
      forked_from_session_id: f.id,
    });
    await f.owner.shutdown();
    expect(
      f
        .makeOwner()
        .catalog()
        .find((row) => row.id === fork.sessionId),
    ).toMatchObject({ title: f.expectedTitle, forked_from_session_id: f.id });
    expect(readFileSync(f.file)).toEqual(before);
    expect(f.commands.run).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["--print"]),
      expect.anything(),
    );
  });

  it("repairs only the legacy fork placeholder from a verified source without migrating either file", async () => {
    const f = await fixture("custom");
    const fork = await f.control("fork");
    const recordFile = path.join(f.root, "claude-managed", `${fork.sessionId}.json`);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...record, title: "Claude Code (fork)" }));
    const nativeBefore = readFileSync(f.file);
    const managedBefore = readFileSync(recordFile);
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)?.title).toBe(f.expectedTitle);
    expect(readFileSync(f.file)).toEqual(nativeBefore);
    expect(readFileSync(recordFile)).toEqual(managedBefore);
  });

  it("does not repair a legacy fork placeholder from unverified source history", async () => {
    const f = await fixture("custom");
    const fork = await f.control("fork");
    const recordFile = path.join(f.root, "claude-managed", `${fork.sessionId}.json`);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...record, title: "Claude Code (fork)" }));
    writeFileSync(
      f.file,
      JSON.stringify({
        type: "user",
        sessionId: randomUUID(),
        cwd: f.workspace,
        message: { role: "user", content: "Unrelated title" },
      }) + "\n",
    );
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)?.title).toBe(
      "Claude Code (fork)",
    );
  });

  it("keeps an explicit rename and a normal fork title ahead of legacy source-title repair", async () => {
    const f = await fixture("ai");
    const fork = await f.control("fork");
    const recordFile = path.join(f.root, "claude-managed", `${fork.sessionId}.json`);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...record, title: "Ordinary fork title" }));
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)?.title).toBe(
      "Ordinary fork title",
    );
    writeFileSync(recordFile, JSON.stringify({ ...record, title: "Claude Code (fork)" }));
    await f.owner.request({
      operation: "rename",
      sessionId: fork.sessionId,
      name: "Explicit fork title",
      requestId: randomUUID(),
      deviceId: "browser-device-a",
      runtimeBootId: f.owner.bootId,
      expectedRevision: (await f.owner.live(fork.sessionId, true)).revision,
      experimentalEnabled: true,
    });
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)?.title).toBe(
      "Explicit fork title",
    );
  });

  it("keeps every fresh-fork read passive before a first send", async () => {
    const f = await fixture("ai");
    const fork = await f.control("fork");
    const reads = [
      "live",
      "capabilities",
      "inspect",
      "context",
      "events",
      "settings-state",
      "goal",
      "resources",
      "queue-list",
      "usage",
    ];
    for (const operation of reads) {
      await expect(
        f.owner.request({ operation, sessionId: fork.sessionId, experimentalEnabled: true }),
      ).resolves.toBeTruthy();
    }
    expect(await f.owner.settingsState(fork.sessionId)).toMatchObject({
      available: true,
      writable: { permissionMode: { available: true } },
    });
    expect(await f.owner.events(fork.sessionId, undefined, undefined)).toEqual({
      events: [],
      next_cursor: null,
      warnings: [],
    });
    expect(f.commands.run).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["--print"]),
      expect.anything(),
    );
    expect(f.owner.catalog().find((row) => row.id === fork.sessionId)).toMatchObject({
      title: f.expectedTitle,
      forked_from_session_id: f.id,
    });
  });

  it("shares native discovery within a catalog read while verifying each session", async () => {
    const f = await fixture();
    await f.send();
    const secondNativeId = randomUUID();
    writeFileSync(
      path.join(path.dirname(f.file), `${secondNativeId}.jsonl`),
      readFileSync(f.file, "utf8").replaceAll(f.nativeId, secondNativeId),
    );
    // Both active records participate, so a per-record full discovery would be observable.
    const listing = await f.sessions.list("claude-code", f.workspace);
    f.store.sessions.sync("workspace", "claude-code", listing.sessions);
    const secondId = f.sessions.store.id("claude-code", secondNativeId);
    await f.send(f.owner, secondId);
    const discover = vi.spyOn(ClaudeSessions.prototype, "list");
    f.owner.catalog();
    expect(discover).toHaveBeenCalledTimes(1);
    f.owner.catalog();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("checks who owns every open session with one claude agents call per interval", async () => {
    const f = await fixture();
    const secondNativeId = randomUUID();
    writeFileSync(
      path.join(path.dirname(f.file), `${secondNativeId}.jsonl`),
      readFileSync(f.file, "utf8").replaceAll(f.nativeId, secondNativeId),
    );
    const listing = await f.sessions.list("claude-code", f.workspace);
    f.store.sessions.sync("workspace", "claude-code", listing.sessions);
    const secondId = f.sessions.store.id("claude-code", secondNativeId);
    const run = vi.mocked(f.commands.run);
    const agents = () => run.mock.calls.filter(([, args]) => args[0] === "agents").length;
    const processes = () => run.mock.calls.filter(([program]) => program === "/bin/ps").length;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const before = { agents: agents(), processes: processes() };
    // Two open sessions polled several times within one interval share one observation.
    for (let poll = 0; poll < 3; poll++) {
      expect((await f.owner.live(f.id)).ownershipReason).toBeNull();
      expect((await f.owner.live(secondId)).ownershipReason).toBeNull();
    }
    expect(agents() - before.agents).toBe(1);
    expect(processes() - before.processes).toBe(1);
    // The next interval observes again, once for both.
    now.mockReturnValue(1_003_000);
    await f.owner.live(f.id);
    await f.owner.live(secondId);
    expect(agents() - before.agents).toBe(2);
    expect(processes() - before.processes).toBe(2);
  });

  it("projects verified native activity time and never refreshes it just by reading settings or catalog", async () => {
    const f = await fixture();
    await f.send();
    expect(f.owner.catalog().find((row) => row.id === f.id)?.updated_at).toBe(f.originalAt);
    await f.owner.settingsState(f.id);
    expect(f.owner.catalog().find((row) => row.id === f.id)?.updated_at).toBe(f.originalAt);
    const updated = "2026-10-02T00:00:00Z";
    appendFileSync(
      f.file,
      JSON.stringify({
        type: "custom-title",
        sessionId: f.nativeId,
        customTitle: "Changed in terminal",
      }) + "\n",
    );
    utimesSync(f.file, new Date(updated), new Date(updated));
    expect(f.owner.catalog().find((row) => row.id === f.id)).toMatchObject({
      title: "Changed in terminal",
      updated_at: updated,
    });
    expect(f.owner.catalog().find((row) => row.id === f.id)?.updated_at).toBe(updated);
  });

  it("omits unverified native metadata rather than borrowing the timestamp or title of another session", async () => {
    const f = await fixture("ai");
    await f.send();
    writeFileSync(
      f.file,
      JSON.stringify({
        type: "user",
        sessionId: randomUUID(),
        cwd: f.workspace,
        message: { role: "user", content: "Unrelated title" },
      }) + "\n",
    );
    const row = f.owner.catalog().find((item) => item.id === f.id)!;
    expect(row.title).toBe(f.expectedTitle);
    expect(row.updated_at).toBe(row.created_at);
  });
});
