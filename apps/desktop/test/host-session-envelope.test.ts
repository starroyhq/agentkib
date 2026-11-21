import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { startBackend } from "./session-baseline/harness";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentkib-host-session-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(workspace)]);
  const backend = await startBackend({
    data: join(root, "data"),
    workspace,
    environment: { HOME: home, PATH: bin },
  });
  cleanups.push(backend.close);
  return backend.rpc;
}

describe("session RPC host envelope", () => {
  it("dispatches the old receivers and host envelopes to the same raw operations", async () => {
    const rpc = await fixture();
    const queue = {
      data: [{ id: "pending", status: "pending", input: [{ type: "text", text: "queued" }] }],
    };
    vi.spyOn(WebReadRequests.prototype, "managedQueueList").mockResolvedValue(queue);
    const codex = { operation: "queue-list", sessionId: "session" };
    const claude = { operation: "usage-limit-auto-continue" };
    const validate = {
      operation: "provider-validate-control",
      call: {
        sessionId: "session",
        executionMode: "codex-managed",
        request: { operation: "queue-add", legacyCodex: false },
        verified: {},
        fullAccess: false,
      },
    };

    for (const [legacy, request, target, expected] of [
      [RUNTIME_METHODS.codexManaged, codex, "codex", queue],
      [RUNTIME_METHODS.claudeManaged, claude, "claude-code", { autoContinue: true }],
      [
        RUNTIME_METHODS.webRequest,
        validate,
        undefined,
        { result: { available: true, inputFormat: "codex" } },
      ],
    ] as const) {
      const raw = await rpc(legacy, request);
      expect(raw).toMatchObject(expected);
      expect(await rpc(RUNTIME_METHODS.sessionRequest, { host: { target, request } })).toEqual(raw);
    }

    await expect(
      rpc(RUNTIME_METHODS.sessionRequest, { host: { target: "codex", request: validate } }),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(rpc(RUNTIME_METHODS.sessionRequest, codex)).resolves.toMatchObject({
      operation: "queue-list",
      result: queue,
    });
  });

  it("rejects malformed envelopes before any flat or raw provider dispatch", async () => {
    const rpc = await fixture();
    const queue = vi.spyOn(WebReadRequests.prototype, "managedQueueList");
    const request = { operation: "queue-list", sessionId: "session" };
    for (const malformed of [
      { host: null, ...request },
      { host: { request }, ...request },
      { host: { target: "web.request", request } },
      { host: { request: [request] } },
    ])
      await expect(rpc(RUNTIME_METHODS.sessionRequest, malformed)).rejects.toMatchObject({
        code: -32602,
      });
    expect(queue).not.toHaveBeenCalled();
  });
});
