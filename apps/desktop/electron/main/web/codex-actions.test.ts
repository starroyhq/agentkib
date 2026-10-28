// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebAccessService, type WebAdminRequest } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
let service: WebAccessService;
let dir: string;
let port: number;
let cookie = "";
let csrf = "";
let bootId = "";
let executionMode = "codex-managed";
let status = "running";
const runtimeHandler = async (input: unknown): Promise<unknown> => {
  const p = input as { operation: string; requestId?: string };
  if (p.operation === "catalog")
    return { sessions: [{ id: "session", agent: "codex", workspace_id: "workspace" }] };
  if (p.operation === "capabilities")
    return {
      sessionId: "session",
      executionMode,
      status,
      features: Object.fromEntries(
        [
          "steer",
          "queue-add",
          "queue-update",
          "rename",
          "attachments",
          "inspect",
          "resume",
          "fork",
          "delete",
        ].map((name) => [name, { available: true }]),
      ),
    };
  if (p.operation === "live")
    return {
      revision: 1,
      runtimeBootId: "runtime",
      status,
      sendEnabled: true,
      executionMode,
      workspaceId: "workspace",
      executionLocation: null,
      ownershipReason: null,
    };
  if (p.operation === "queue-list")
    return {
      data: [
        {
          id: "q",
          input: [
            { type: "localImage", path: "/private/secret" },
            { type: "text", text: "User attached file x: /private/secret" },
            { type: "text", text: "keep" },
          ],
        },
      ],
    };
  return { accepted: true, requestId: p.requestId };
};
const runtime = vi.fn(runtimeHandler);
async function http(path: string, data?: unknown, raw = false) {
  return new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/web/v1" + path,
        method: data === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          "X-CSRF-Token": csrf,
          "X-AgentKib-Protocol": "2",
          "Content-Type": raw ? "application/octet-stream" : "application/json",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(body),
            cookie: res.headers["set-cookie"]?.[0].split(";")[0],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data === undefined ? undefined : raw ? String(data) : JSON.stringify(data));
  });
}
async function pair(flags: Partial<Extract<WebAdminRequest, { operation: "approve" }>> = {}) {
  return approveLegacyBrowser(service, cookie, { send: true, ...flags });
}
beforeEach(async () => {
  runtime.mockClear();
  runtime.mockImplementation(runtimeHandler);
  executionMode = "codex-managed";
  status = "running";
  cookie = "";
  dir = await mkdtemp(join(tmpdir(), "ak-actions-"));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  service = new WebAccessService({
    dataDir: dir,
    staticDir: dir,
    runtimeRequest: runtime,
    managedRequest: async () => ({ available: true, models: [{ id: "model", efforts: ["high"] }] }),
    verifiedCodex: true,
    verifiedExperimental: true,
    workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: dir }],
  });
  await service.initialize();
  await service.request({
    operation: "configure",
    enabled: true,
    port,
    externalOrigin: "",
    experimentalEnabled: true,
    allowedWorkspaceIds: ["workspace"],
  });
  const access = await http("/access");
  cookie = access.cookie!;
  csrf = access.data.csrfToken;
  bootId = access.data.bootId;
});
afterEach(async () => {
  await service.shutdown();
  await rm(dir, { recursive: true, force: true });
});
const action = (text = "append") => ({
  sessionId: "session",
  bootId,
  requestId: randomUUID(),
  expectedRevision: 1,
  turnId: "turn",
  text,
});
const deletion = () => ({
  sessionId: "session",
  bootId,
  requestId: randomUUID(),
  expectedRevision: 1,
});
it("old grants do not gain new capabilities and cannot upload", async () => {
  await pair();
  const capabilities = await http("/codex/capabilities?sessionId=session");
  expect(capabilities.data.features.steer).toEqual({
    available: false,
    reason: "permission_denied",
  });
  expect(
    (await http("/attachments?sessionId=session&name=a.txt&mime=text%2Fplain", "bytes", true))
      .status,
  ).toBe(403);
  expect((await http("/codex/steer", action())).status).toBe(403);
});
it("does not enable follower controls merely because managed protocol supports them", async () => {
  await pair({ advancedControl: true });
  executionMode = "codex-follower";
  expect((await http("/codex/steer", action())).data.error).toBe("capability_unavailable");
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "steer")).toBe(
    false,
  );
});
it("projects queue contents without host paths", async () => {
  await pair({ advancedControl: true });
  const queue = await http("/codex/queue?sessionId=session");
  expect(queue.data).toEqual({
    sessionId: "session",
    data: [{ id: "q", text: "keep", hasAttachments: true }],
  });
});
it("uploads bounded input, converts only trusted IDs and keeps native dispatch idempotent", async () => {
  await pair({ advancedControl: true, attachments: true });
  const upload = await http(
    "/attachments?sessionId=session&name=a.txt&mime=text%2Fplain",
    "bytes",
    true,
  );
  expect(upload.status).toBe(201);
  expect(upload.data).not.toHaveProperty("path");
  const body = {
    ...action(""),
    attachmentIds: [upload.data.id],
    input: [{ type: "localImage", path: "/etc/passwd" }],
  };
  expect((await http("/codex/steer", body)).status).toBe(200);
  const native = runtime.mock.calls.find(
    ([p]) => (p as { operation: string }).operation === "steer",
  )![0];
  expect(JSON.stringify(native)).not.toContain("/etc/passwd");
  expect(JSON.stringify(native)).toContain(upload.data.id);
  expect((await http("/codex/steer", body)).status).toBe(409);
});
it("requires active native turn before queueing an automatically consumed item", async () => {
  await pair({ advancedControl: true });
  status = "idle";
  expect((await http("/codex/queue-add", action())).data.error).toBe("queue_requires_running_turn");
});
it.each(["steer", "queue-add"])(
  "dispatches text-only %s with an empty attachment list without requiring upload permission",
  async (operation) => {
    await pair({ advancedControl: true });
    const result = await http(`/codex/${operation}`, { ...action(), attachmentIds: [] });
    expect(result.status).toBe(200);
    const calls = runtime.mock.calls.filter(
      ([p]) => (p as { operation: string }).operation === operation,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ operation, text: "append" });
    expect(calls[0][0]).not.toHaveProperty("input");
  },
);
it.each([
  { text: "", attachmentIds: [], error: "invalid_text" },
  { text: "append", attachmentIds: "not-an-array", error: "invalid_attachments" },
])("rejects malformed or empty queued input before dispatch: $error", async (input) => {
  await pair({ advancedControl: true });
  const result = await http("/codex/queue-add", {
    ...action(input.text),
    attachmentIds: input.attachmentIds,
  });
  expect(result.status).toBe(400);
  expect(result.data.error).toBe(input.error);
  expect(result.data.controlOutcome).toBe("not-dispatched");
  expect(
    runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "queue-add"),
  ).toBe(false);
});
it("rechecks browser revocation during native preflight", async () => {
  const device = await pair({ advancedControl: true });
  runtime.mockImplementationOnce(async () => {
    await service.request({ operation: "revoke", id: device });
    return { sessions: [{ id: "session", agent: "codex", workspace_id: "workspace" }] };
  });
  expect((await http("/codex/steer", action())).status).toBe(401);
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "steer")).toBe(
    false,
  );
});
it("denies extended requests even through legacy approval decisions", async () => {
  await pair({ approve: true });
  runtime.mockImplementationOnce(async () => ({
    revision: 1,
    runtimeBootId: "runtime",
    executionMode: "codex-managed",
    workspaceId: "workspace",
    approvals: [
      {
        requestId: 7,
        turnId: "turn",
        supported: true,
        requiresExtendedApproval: true,
        availableDecisions: ["accept"],
      },
    ],
  }));
  const result = await http("/approve", { ...action(), approvalId: 7, decision: "accept" });
  expect(result.status).toBe(403);
  expect(result.data.error).toBe("permission_denied");
  expect(
    runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "approve"),
  ).toBe(false);
});
it("rejects arbitrary native approval payloads rather than forwarding JSON", async () => {
  await pair({ approve: true, extendedApproval: true });
  runtime.mockImplementationOnce(async () => ({
    revision: 1,
    runtimeBootId: "runtime",
    executionMode: "codex-managed",
    workspaceId: "workspace",
    approvals: [
      {
        requestId: 7,
        turnId: "turn",
        supported: true,
        requiresExtendedApproval: true,
        availableDecisions: [],
        decisionOptions: [
          { decision: { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["ls"] } } },
        ],
      },
    ],
  }));
  const result = await http("/approve", {
    ...action(),
    approvalId: 7,
    nativeDecision: { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["sh"] } },
  });
  expect(result.status).toBe(409);
  expect(result.data.error).toBe("approval_unavailable");
});
it("forwards an exact advertised native decision separately from the legacy string", async () => {
  await pair({ approve: true, extendedApproval: true });
  const decision = { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["ls"] } };
  runtime.mockImplementationOnce(async () => ({
    revision: 1,
    runtimeBootId: "runtime",
    executionMode: "codex-managed",
    workspaceId: "workspace",
    approvals: [
      {
        requestId: 7,
        turnId: "turn",
        supported: true,
        requiresExtendedApproval: true,
        availableDecisions: [],
        decisionOptions: [{ decision }],
      },
    ],
  }));
  const result = await http("/approve", { ...action(), approvalId: 7, nativeDecision: decision });
  expect(result.status).toBe(200);
  expect(
    runtime.mock.calls.find(([p]) => (p as { operation: string }).operation === "approve")![0],
  ).toMatchObject({ decision: "native", nativeDecision: decision });
});

it("deletes with organize permission and takes the conversation's uploads with it", async () => {
  await pair({ organize: true, attachments: true });
  const upload = await http(
    "/attachments?sessionId=session&name=a.txt&mime=text%2Fplain",
    "bytes",
    true,
  );
  expect(upload.status).toBe(201);
  runtime.mockImplementation(async (input) =>
    (input as { operation: string }).operation === "delete"
      ? {
          accepted: true,
          completed: true,
          deleted: true,
          sessionId: "session",
          requestId: (input as { requestId: string }).requestId,
        }
      : runtimeHandler(input),
  );
  const result = await http("/codex/delete", deletion());
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ accepted: true, deleted: true });
  const dispatched = runtime.mock.calls.filter(
    ([p]) => (p as { operation: string }).operation === "delete",
  );
  expect(dispatched).toHaveLength(1);
  // Only the public fields reach the backend.
  expect(Object.keys(dispatched[0]![0] as object).sort()).toEqual([
    "deviceId",
    "expectedRevision",
    "experimentalEnabled",
    "operation",
    "requestId",
    "runtimeBootId",
    "sessionId",
  ]);
  expect((await http("/attachments?sessionId=session")).data.attachments).toEqual([]);
});
it("keeps uploads when the backend did not delete", async () => {
  await pair({ organize: true, attachments: true });
  await http("/attachments?sessionId=session&name=a.txt&mime=text%2Fplain", "bytes", true);
  runtime.mockImplementation(async (input) =>
    (input as { operation: string }).operation === "delete"
      ? {
          accepted: false,
          controlOutcome: "not-dispatched",
          reason: "codex-owner-busy",
          requestId: (input as { requestId: string }).requestId,
        }
      : runtimeHandler(input),
  );
  const result = await http("/codex/delete", deletion());
  expect(result.status).toBe(409);
  expect(result.data).toMatchObject({
    error: "codex-owner-busy",
    controlOutcome: "not-dispatched",
  });
  expect((await http("/attachments?sessionId=session")).data.attachments).toHaveLength(1);
});
it("deletes a Claude session through the generic action with its public input hash", async () => {
  await pair({ organize: true });
  executionMode = "claude-managed";
  runtime.mockImplementation(async (input) =>
    (input as { operation: string }).operation === "delete"
      ? {
          accepted: true,
          completed: true,
          deleted: true,
          sessionId: "session",
          requestId: (input as { requestId: string }).requestId,
        }
      : runtimeHandler(input),
  );
  const result = await http("/managed/action", {
    ...deletion(),
    operation: "delete",
    agent: "claude-code",
  });
  expect(result.status).toBe(200);
  const dispatched = runtime.mock.calls.find(
    ([p]) => (p as { operation: string }).operation === "delete",
  )![0] as Record<string, unknown>;
  expect(dispatched).toMatchObject({ operation: "delete", sessionId: "session" });
  expect(dispatched.publicInputHash).toMatch(/^[a-f0-9]{64}$/);
});
it("keeps delete behind organize permission", async () => {
  await pair({ attachments: true });
  expect((await http("/codex/delete", deletion())).status).toBe(403);
  expect(
    runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "delete"),
  ).toBe(false);
});
it("allows a scoped managed resume without a handoff confirmation", async () => {
  await pair({ manage: true });
  const result = await http("/codex/resume", action());
  expect(result.status).toBe(200);
  const dispatched = runtime.mock.calls.find(
    ([p]) => (p as { operation: string }).operation === "resume",
  )![0];
  expect(dispatched).not.toHaveProperty("handoffConfirmed");
});
it("keeps explicit resume behind manage permission", async () => {
  await pair();
  expect((await http("/codex/resume", action())).status).toBe(403);
});
it("rejects follower resume even with manage permission", async () => {
  await pair({ manage: true });
  executionMode = "codex-follower";
  expect((await http("/codex/resume", action())).data.error).toBe("capability_unavailable");
  expect(
    runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "resume"),
  ).toBe(false);
});
it("dispatches an idle Codex send with only the existing send grant", async () => {
  await pair();
  status = "idle";
  expect((await http("/send", action())).status).toBe(200);
  const dispatched = runtime.mock.calls.find(
    ([p]) => (p as { operation: string }).operation === "send",
  )![0];
  expect(dispatched).toMatchObject({ expectedRevision: 1, runtimeBootId: "runtime" });
  expect(dispatched).not.toHaveProperty("handoffConfirmed");
});
it.each([
  "codex-owner-busy",
  "codex-cli-version-too-old",
  "codex-cli-unavailable",
  "codex-cli-version-unavailable",
  "codex-owner-check-unavailable",
  "platform-unsupported",
])("preserves the scoped Codex send preflight reason %s", async (reason) => {
  await pair();
  runtime.mockImplementation(async (input) => {
    const result = await runtimeHandler(input);
    return (input as { operation: string }).operation === "live"
      ? { ...(result as object), sendEnabled: false, ownershipReason: reason }
      : result;
  });
  const result = await http("/send", action());
  expect(result.status).toBe(409);
  expect(result.data).toEqual({ error: reason, controlOutcome: "not-dispatched" });
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "send")).toBe(
    false,
  );
});
it("preserves a correlated writer-lock rejection and clears only its unknown fence", async () => {
  await pair();
  runtime.mockImplementation(async (input) => {
    const p = input as { operation: string; requestId?: string };
    return p.operation === "send"
      ? {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          requestId: p.requestId,
          runtimeBootId: "runtime",
          reason: "codex-owner-busy",
        }
      : runtimeHandler(input);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await http("/send", action());
    expect(result.status).toBe(409);
    expect(result.data).toEqual({ error: "codex-owner-busy", controlOutcome: "not-dispatched" });
  }
});
it("keeps an uncorrelated writer-lock result uncertain", async () => {
  await pair();
  runtime.mockImplementation(async (input) =>
    (input as { operation: string }).operation === "send"
      ? {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          requestId: "different-request",
          runtimeBootId: "runtime",
          reason: "codex-owner-busy",
        }
      : runtimeHandler(input),
  );
  const result = await http("/send", action());
  expect(result.status).toBe(502);
  expect(result.data).toEqual({ error: "outcome_unknown", controlOutcome: "unknown" });
});
it.each(["unsupported-model", "unsupported-effort"])(
  "preserves the concrete model send rejection over HTTP: %s",
  async (reason) => {
    await pair();
    status = "idle";
    runtime.mockImplementation(async (input) => {
      const p = input as { operation: string; requestId?: string };
      return p.operation === "send"
        ? {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            requestId: p.requestId,
            runtimeBootId: "runtime",
            error: reason,
          }
        : runtimeHandler(input);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await http("/send", action());
      expect(result.status).toBe(409);
      expect(result.data).toEqual({ error: reason, controlOutcome: "not-dispatched" });
    }
  },
);
it.each(["native-model-unconfirmed", "native-effort-unconfirmed"])(
  "preserves a pre-fork settings rejection over HTTP: %s",
  async (reason) => {
    await pair({ manage: true, advancedControl: true, organize: true });
    status = "idle";
    runtime.mockImplementation(async (input) => {
      const p = input as { operation: string; requestId?: string };
      return p.operation === "fork"
        ? {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            requestId: p.requestId,
            runtimeBootId: "runtime",
            reason,
          }
        : runtimeHandler(input);
    });
    const result = await http("/codex/fork", action());
    expect(result.status).toBe(409);
    expect(result.data).toEqual({ error: reason, controlOutcome: "not-dispatched" });
  },
);
it.each(["request", "runtime", "unknown"])(
  "keeps a model rejection uncertain without matching %s proof",
  async (variant) => {
    await pair();
    status = "idle";
    runtime.mockImplementation(async (input) => {
      const p = input as { operation: string; requestId?: string };
      return p.operation === "send"
        ? {
            accepted: false,
            completed: false,
            controlOutcome: variant === "unknown" ? "unknown" : "not-dispatched",
            requestId: variant === "request" ? "different-request" : p.requestId,
            runtimeBootId: variant === "runtime" ? "different-runtime" : "runtime",
            reason: "unsupported-model",
          }
        : runtimeHandler(input);
    });
    const result = await http("/send", action());
    expect(result.status).toBe(502);
    expect(result.data).toEqual({ error: "outcome_unknown", controlOutcome: "unknown" });
  },
);
it("does not expose arbitrary runtime model errors as public HTTP reasons", async () => {
  await pair();
  status = "idle";
  runtime.mockImplementation(async (input) => {
    const p = input as { operation: string; requestId?: string };
    return p.operation === "send"
      ? {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          requestId: p.requestId,
          runtimeBootId: "runtime",
          reason: "unsupported-model: private diagnostic",
        }
      : runtimeHandler(input);
  });
  const result = await http("/send", action());
  expect(result.data).toEqual({
    error: "control_preflight_rejected",
    controlOutcome: "not-dispatched",
  });
});
it("does not silently discard original queue attachments on text edits", async () => {
  await pair({ advancedControl: true });
  const result = await http("/codex/queue-update", {
    ...action(),
    queuedSubmissionId: "q",
    text: "Edited",
  });
  expect(result.data.error).toBe("queue_attachments_edit_unsupported");
  expect(result.data.controlOutcome).toBe("not-dispatched");
  expect(
    runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "queue-update"),
  ).toBe(false);
});

it("allows settings-only devices to read models without revealing managed workspace choices", async () => {
  await pair({ settings: true });
  const result = await http("/managed/options");
  expect(result.status).toBe(200);
  expect(result.data.models).toEqual([{ id: "model", efforts: ["high"] }]);
  expect(result.data.workspaces).toEqual([]);
});
it("reports oversized native queues instead of silently hiding later entries", async () => {
  await pair({ advancedControl: true });
  runtime.mockImplementationOnce(async () => ({
    sessions: [{ id: "session", agent: "codex", workspace_id: "workspace" }],
  }));
  runtime.mockImplementationOnce(async () => ({
    data: [],
    complete: false,
    reason: "queue-too-large",
  }));
  expect((await http("/codex/queue?sessionId=session")).data.error).toBe("queue_too_large");
});
