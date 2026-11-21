// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "../../../packages/backend/src/agents/claude/claude-bridge";
import { finishClaudeBridgeNative } from "./fixtures/claude-bridge-native-cleanup";
import { createClaudeBridgeNativeEvidence } from "./fixtures/claude-bridge-native-evidence";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-native-cleanup-")));
  const root = path.join(base, "run");
  const evidence = path.join(base, "evidence");
  mkdirSync(root);
  mkdirSync(evidence);
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const terminal = {
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    },
  };
  const held = new Set<ServerResponse>();
  let resolveHeldClosed!: () => void;
  const heldClosed = new Promise<void>((resolve) => {
    resolveHeldClosed = resolve;
  });
  const provider = createServer((_request, response) => {
    held.add(response);
    response.once("close", () => {
      held.delete(response);
      resolveHeldClosed();
    });
    response.writeHead(200);
    response.flushHeaders();
  });
  const bridge = new ClaudeBridge({
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    platform: "darwin",
    pluginDirectory: path.join(root, "plugin"),
    target: async () => ({
      sessionId: "synthetic-session",
      nativeId: randomUUID(),
      workspaceId: "synthetic-workspace",
      workspace: root,
      registeredWorkspace: root,
    }),
    validate: () => undefined,
    publish: () => undefined,
  });
  const resources = { terminal, bridge, provider, held, root };
  cleanups.push(async () => {
    await finishClaudeBridgeNative({ ...resources, saveEvidence() {} });
    rmSync(base, { recursive: true, force: true });
  });
  await once(child.stdout!, "data");
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      { hostname: "127.0.0.1", port: (provider.address() as { port: number }).port, path: "/held" },
      resolve,
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  // Cleanup deliberately closes this unfinished synthetic response.
  response.on("error", () => undefined);
  const responseClosed = new Promise<void>((resolve) => response.once("close", resolve));
  response.resume();
  const challenge = (await bridge.management({
    operation: "bridge-challenge",
    sessionId: "synthetic-session",
    deviceId: "agentkib-local-owner",
  })) as { challenge: string };
  const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
  expect(existsSync(ticket.socketPath)).toBe(true);
  expect(held.size).toBe(1);
  return {
    resources,
    child,
    evidence,
    socket: ticket.socketPath as string,
    responseClosed,
    heldClosed,
  };
}

async function expectReleased(f: Awaited<ReturnType<typeof fixture>>) {
  await Promise.all([f.responseClosed, f.heldClosed]);
  expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  expect(f.resources.provider.listening).toBe(false);
  expect(f.resources.held.size).toBe(0);
  expect(existsSync(f.socket)).toBe(false);
  expect(existsSync(f.resources.root)).toBe(false);
}

function evidenceWriter(f: Awaited<ReturnType<typeof fixture>>) {
  const executable = path.join(f.resources.root, "synthetic-claude");
  writeFileSync(executable, "synthetic executable bytes; never executed");
  return createClaudeBridgeNativeEvidence({
    evidenceDirectory: f.evidence,
    executable,
    root: f.resources.root,
    plugin: path.join(f.resources.root, "plugin"),
    repository: path.resolve(import.meta.dirname, "../../.."),
    home: path.dirname(f.resources.root),
    challenge: "synthetic-pairing-ticket",
  });
}

describe.skipIf(process.platform === "win32")("isolated native bridge evidence cleanup", () => {
  it("preserves an EEXIST evidence error and releases the owned process, broker and provider", async () => {
    const f = await fixture();
    const evidenceFile = path.join(f.evidence, "terminal.txt");
    writeFileSync(evidenceFile, "existing evidence", { flag: "wx" });
    const evidence = evidenceWriter(f);
    let evidenceError: unknown;
    const finished = finishClaudeBridgeNative({
      ...f.resources,
      saveEvidence() {
        try {
          evidence.save({ terminalText: "new evidence", summary: {}, runningReload: {} });
        } catch (error) {
          evidenceError = error;
          throw error;
        }
      },
    });
    expect(evidenceError).toMatchObject({ code: "EEXIST" });
    expect((evidenceError as Error).stack).not.toContain(f.evidence);
    await expect(finished).rejects.toBe(evidenceError);
    expect(readFileSync(evidenceFile, "utf8")).toBe("existing evidence");
    await expectReleased(f);
  });

  it("continues cleanup after one close fails and retains the original evidence failure", async () => {
    const f = await fixture();
    const evidenceError = Object.assign(new Error("synthetic evidence denied"), { code: "EACCES" });
    const closeError = new Error("synthetic terminal close failure");
    const finished = finishClaudeBridgeNative({
      ...f.resources,
      terminal: {
        async close() {
          await f.resources.terminal.close();
          throw closeError;
        },
      },
      saveEvidence() {
        throw evidenceError;
      },
    });
    await expect(finished).rejects.toMatchObject({
      cause: evidenceError,
      errors: [evidenceError, closeError],
    });
    await expectReleased(f);
  });

  it("saves evidence before closing and removing owned resources", async () => {
    const f = await fixture();
    const evidenceFile = path.join(f.evidence, "terminal.txt");
    const evidence = evidenceWriter(f);
    await finishClaudeBridgeNative({
      ...f.resources,
      saveEvidence() {
        expect(f.child.exitCode).toBeNull();
        expect(existsSync(f.resources.root)).toBe(true);
        evidence.save({ terminalText: "saved evidence", summary: {}, runningReload: {} });
      },
    });
    expect(readFileSync(evidenceFile, "utf8")).toBe("saved evidence");
    await expectReleased(f);
  });

  it("preserves a native acceptance failure while evidence and cleanup also fail", async () => {
    const f = await fixture();
    const evidence = evidenceWriter(f);
    writeFileSync(path.join(f.evidence, "terminal.txt"), "original evidence", { flag: "wx" });
    const primary = Object.assign(
      new Error("native assertion at " + f.resources.root + "/history.jsonl"),
      { code: "NATIVE_ASSERT" },
    );
    const closeError = Object.assign(new Error("terminal close at " + f.resources.root), {
      code: "CLOSE_FAILED",
    });
    const finished = finishClaudeBridgeNative({
      ...f.resources,
      failure: { error: primary },
      terminal: {
        async close() {
          await f.resources.terminal.close();
          throw closeError;
        },
      },
      saveEvidence() {
        evidence.save({ terminalText: "new evidence", summary: {}, runningReload: {} });
      },
    }).catch((error) => {
      throw evidence.error(error);
    });
    await expect(finished).rejects.toMatchObject({
      cause: { code: "NATIVE_ASSERT", message: "native assertion at $ISOLATED_ROOT/history.jsonl" },
      errors: [
        { code: "NATIVE_ASSERT", message: "native assertion at $ISOLATED_ROOT/history.jsonl" },
        { code: "EEXIST", path: "$EVIDENCE_DIR/terminal.txt" },
        { code: "CLOSE_FAILED", message: "terminal close at $ISOLATED_ROOT" },
      ],
    });
    expect(readFileSync(path.join(f.evidence, "terminal.txt"), "utf8")).toBe("original evidence");
    await expectReleased(f);
  });

  it("retains the primary failure when evidence and cleanup succeed", async () => {
    const f = await fixture();
    const evidence = evidenceWriter(f);
    const primary = new Error("synthetic native acceptance failure");
    await expect(
      finishClaudeBridgeNative({
        ...f.resources,
        failure: { error: primary },
        saveEvidence() {
          evidence.save({
            terminalText: "failed native case evidence",
            summary: {},
            runningReload: {},
          });
        },
      }),
    ).rejects.toBe(primary);
    expect(readFileSync(path.join(f.evidence, "terminal.txt"), "utf8")).toBe(
      "failed native case evidence",
    );
    await expectReleased(f);
  });
});
