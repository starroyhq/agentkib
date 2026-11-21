// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityManagedRunner } from "../../../packages/backend/src/agents/antigravity/antigravity-managed-runner";
import { Commands } from "../../../packages/backend/src/commands";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { readUnknownManagedCommands } from "../../../packages/backend/src/managed-ledger";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture(nativeRef: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-antigravity-readonly-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-10T00:00:00Z",
  );
  const native: NativeSession = {
    native_ref: nativeRef,
    agent: "antigravity",
    title: "Synthetic local history",
    origin: "interactive",
    created_at: null,
    updated_at: null,
    message_count: 2,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
  };
  store.sessions.sync("workspace", "antigravity", [native]);
  const id = store.sessions.id("antigravity", nativeRef);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    PATH: root,
  };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, { profiles: () => [] });
  cleanups.push(() => readers.close());
  vi.spyOn(readers, "resolve").mockResolvedValue({
    summary: store.sessions.get(id)!,
    native,
    workspace,
  });
  const executable = vi
    .spyOn(readers, "antigravityControlExecutable")
    .mockReturnValue("/synthetic/acp");
  const connect = vi
    .spyOn(AntigravityManagedRunner, "connect")
    .mockRejectedValue(new Error("synthetic-acp-connect"));
  const web = new WebReadRequests(store, readers, root, () => 0n, environment);
  cleanups.push(() => web.closeAsync());
  return { web, root, id, executable, connect };
}

describe("local Antigravity sessions remain browse-only", () => {
  it.each(["app", "ide"])(
    "publishes disabled capabilities and live state without opening ACP for %s",
    async (surface) => {
      const f = fixture(`antigravity-local-v1-${surface}-synthetic`);
      const capabilities = (await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.id,
        experimentalEnabled: true,
      })) as Record<string, unknown>;
      expect(capabilities).toMatchObject({ status: "unsupported", reason: "session-read-only" });
      for (const feature of Object.values(capabilities.features as Record<string, unknown>))
        expect(feature).toMatchObject({ available: false, reason: "session-read-only" });
      await expect(
        f.web.request({ operation: "live", sessionId: f.id, experimentalEnabled: true }),
      ).resolves.toMatchObject({
        status: "unsupported",
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        reason: "session-read-only",
      });
      expect(f.executable).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    },
  );

  it.each(["send", "stop", "approve", "answer", "settings", "archive", "rename"])(
    "rejects %s before connecting or recording a control command",
    async (operation) => {
      const f = fixture("antigravity-local-v1-app-synthetic");
      const capabilities = (await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.id,
      })) as { runtimeBootId: string };
      await expect(
        f.web.managedControl({
          operation,
          sessionId: f.id,
          requestId: randomUUID(),
          runtimeBootId: capabilities.runtimeBootId,
          expectedRevision: 0,
          experimentalEnabled: true,
        }),
      ).rejects.toThrow("session-read-only");
      expect(f.executable).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
      expect(readUnknownManagedCommands(f.root, f.id)).toEqual([]);
    },
  );

  it("reads ACP state and usage without connecting, then prepares execution only for send", async () => {
    const f = fixture("synthetic-acp-session");
    const capabilities = (await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.id,
      experimentalEnabled: true,
    })) as { runtimeBootId: string };
    expect(capabilities).toMatchObject({
      status: "idle",
      features: { send: { available: true }, stop: { available: false } },
    });
    await expect(f.web.request({ operation: "usage", sessionId: f.id })).resolves.toMatchObject({
      available: false,
    });
    await expect(
      f.web.request({ operation: "live", sessionId: f.id, experimentalEnabled: true }),
    ).resolves.toMatchObject({ status: "idle", revision: 0, sendEnabled: true });
    expect(f.connect).not.toHaveBeenCalled();
    await expect(
      f.web.managedControl({
        operation: "send",
        sessionId: f.id,
        requestId: randomUUID(),
        runtimeBootId: capabilities.runtimeBootId,
        expectedRevision: 0,
        experimentalEnabled: true,
        text: "Continue",
      }),
    ).rejects.toThrow("synthetic-acp-connect");
    expect(f.connect).toHaveBeenCalledOnce();
    expect(readUnknownManagedCommands(f.root, f.id)).toEqual([]);
  });
});
