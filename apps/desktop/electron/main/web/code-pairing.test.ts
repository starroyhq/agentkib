// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebAccessService, type WebConfig } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

describe("same-origin one-time code full authorization", () => {
  let service: WebAccessService;
  let dir: string;
  let origin: string;
  let config: WebConfig;
  let workspaces: { id: string; name: string; path: string }[];
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string; requestId?: string };
    if (params.operation === "catalog")
      return {
        workspaces,
        sessions: workspaces.map((w) => ({
          id: `session-${w.id}`,
          agent: "codex",
          workspace_id: w.id,
        })),
      };
    if (params.operation === "live")
      return {
        executionMode: "codex-managed",
        workspaceId: "first",
        runtimeBootId: "runtime",
        revision: 1,
        status: "idle",
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        questions: [],
      };
    if (params.operation === "capabilities")
      return { executionMode: "codex-managed", features: { rename: { available: true } } };
    return { accepted: true, requestId: params.requestId };
  });
  const managed = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string; requestId?: string };
    return params.operation === "options"
      ? { available: true }
      : { accepted: true, requestId: params.requestId };
  });
  const attention = vi.fn();
  async function browser() {
    const initial = await fetch(`${origin}/api/web/v1/access`);
    const access = await initial.json();
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    return {
      cookie,
      access,
      async api(path: string, body?: unknown) {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-CSRF-Token": access.csrfToken,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      },
    };
  }
  async function code() {
    return (await service.request({ operation: "generate-code" })).code!.value;
  }
  beforeEach(async () => {
    runtime.mockClear();
    managed.mockClear();
    attention.mockClear();
    dir = await mkdtemp(join(tmpdir(), "ak-code-access-"));
    await writeFile(join(dir, "result.txt"), "authorized result");
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((r) => listener.close(() => r()));
    origin = `http://127.0.0.1:${port}`;
    workspaces = [{ id: "first", name: "First", path: dir }];
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      managedRequest: managed,
      workspaceRequest: async () => workspaces,
      verifiedCodex: true,
      onPairingRequested: attention,
    });
    await service.initialize();
    config = {
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: [],
    };
    await service.request({ operation: "configure", ...config });
  });
  afterEach(async () => {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("grants every operation without a second approval and follows newly registered workspaces", async () => {
    const b = await browser();
    const result = await b.api("pair", { code: await code(), name: "Phone" });
    expect(result.status).toBe(200);
    expect(result.data.status).toBe("approved");
    expect(result.data.device).toMatchObject({
      accessMode: "full",
      send: true,
      approve: true,
      manage: true,
      files: true,
      attachments: true,
      advancedControl: true,
      organize: true,
      settings: true,
      extendedApproval: true,
    });
    expect((await b.api("access")).data).toMatchObject({
      status: "approved",
      pairingMode: "code",
      experimentalEnabled: true,
    });
    expect(attention).not.toHaveBeenCalled();
    expect((await service.request({ operation: "status" })).pending).toEqual([]);
    expect((await b.api("files/workspaces")).data.workspaces).toEqual([
      { id: "first", name: "First" },
    ]);
    expect((await b.api("live?sessionId=session-first")).data.sendEnabled).toBe(true);
    expect(
      (await b.api("codex/capabilities?sessionId=session-first")).data.features.rename.available,
    ).toBe(true);
    workspaces.push({ id: "later", name: "Later", path: dir });
    expect((await b.api("managed/options")).data.workspaces).toHaveLength(2);
    expect((await b.api("files/workspaces")).data.workspaces).toHaveLength(2);
    const create = await b.api("managed/create", {
      workspaceId: "later",
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(create.status).toBe(200);
    expect(managed).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "later", policyId: "workspace-write-on-request" }),
    );
    const send = await b.api("send", {
      sessionId: "session-first",
      text: "test",
      expectedRevision: 1,
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(send.status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send", experimentalEnabled: true }),
    );
  });

  it("grants a read-only code history and files but rejects every write", async () => {
    const b = await browser();
    const status = await service.request({ operation: "generate-code", access: "read" });
    expect(status.code!.access).toBe("read");
    const result = await b.api("pair", { code: status.code!.value, name: "Tablet" });
    expect(result.status).toBe(200);
    expect(result.data.device).toMatchObject({
      accessMode: "full",
      files: true,
      send: false,
      approve: false,
      manage: false,
      attachments: false,
      advancedControl: false,
      organize: false,
      settings: false,
      extendedApproval: false,
    });
    expect((await service.request({ operation: "status" })).devices[0].accessLevel).toBe("read");
    expect((await b.api("catalog")).status).toBe(200);
    expect((await b.api("files/workspaces")).data.workspaces).toEqual([
      { id: "first", name: "First" },
    ]);
    const send = await b.api("send", {
      sessionId: "session-first",
      text: "test",
      expectedRevision: 1,
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(send.status).toBe(403);
    const create = await b.api("managed/create", {
      workspaceId: "first",
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(create.status).toBe(403);
    expect(managed).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "create" }));
    expect(runtime).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "send" }));
  });

  it("rejects every read-only control and advanced read, not just send and create", async () => {
    const b = await browser();
    const status = await service.request({ operation: "generate-code", access: "read" });
    await b.api("pair", { code: status.code!.value, name: "Tablet" });
    runtime.mockClear();
    const base = {
      sessionId: "session-first",
      expectedRevision: 1,
      bootId: b.access.bootId,
      requestId: randomUUID(),
    };
    const writes: [string, Record<string, unknown>][] = [
      ["approve", { ...base, approvalId: "approval", decision: "accept" }],
      ["answer", { ...base, questionId: "question", answers: {} }],
      ["stop", base],
      ["codex/rename", { ...base, title: "Renamed" }],
      ["codex/goal-set", { ...base, intent: "start", objective: "Ship it" }],
      ["managed/adopt", { ...base, workspaceId: "first" }],
      ["attachments?sessionId=session-first&name=a.txt&mime=text/plain", { data: "x" }],
      ["attachments/delete", { sessionId: "session-first", id: "attachment" }],
    ];
    for (const [path, body] of writes)
      expect({ path, status: (await b.api(path, body)).status }).toEqual({ path, status: 403 });
    for (const path of [
      "codex/session-settings?sessionId=session-first",
      "codex/goals?sessionId=session-first",
      "codex/context-options?sessionId=session-first",
    ])
      expect({ path, status: (await b.api(path)).status }).toEqual({ path, status: 403 });
    // 被拒绝的请求一个都不能到达 runtime / managed。
    const reached = runtime.mock.calls.map(([input]) => (input as { operation: string }).operation);
    expect(reached.filter((operation) => !["catalog", "live"].includes(operation))).toEqual([]);
    expect(managed).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "adopt" }));
  });

  it("changes a paired device between read-only and full access from the desktop", async () => {
    const b = await browser();
    const paired = await b.api("pair", {
      code: (await service.request({ operation: "generate-code", access: "read" })).code!.value,
      name: "Tablet",
    });
    const id = paired.data.device.id;
    const send = () =>
      b.api("send", {
        sessionId: "session-first",
        text: "test",
        expectedRevision: 1,
        bootId: b.access.bootId,
        requestId: randomUUID(),
      });
    expect((await send()).status).toBe(403);

    const upgraded = await service.request({ operation: "set-access", id, access: "full" });
    expect(upgraded.devices[0]).toMatchObject({ id, accessLevel: "full", send: true });
    expect((await send()).status).toBe(200);

    await service.request({ operation: "set-access", id, access: "read" });
    expect((await send()).status).toBe(403);
    const saved = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
    expect(saved.credentials[0].device).toMatchObject({ id, send: false, files: true });
  });

  it("drops a browser's live stream without ending access when its level changes", async () => {
    const b = await browser();
    const paired = await b.api("pair", {
      code: (await service.request({ operation: "generate-code", access: "read" })).code!.value,
      name: "Tablet",
    });
    const stream = await fetch(`${origin}/api/web/v1/stream?sessionId=session-first`, {
      headers: { Cookie: b.cookie, Origin: origin, "X-CSRF-Token": b.access.csrfToken },
    });
    expect(stream.status).toBe(200);
    const body = stream.text();
    await service.request({ operation: "set-access", id: paired.data.device.id, access: "full" });
    // 流被关闭（text() 才会结束），但不能带 access-ended，否则浏览器会当成被注销。
    expect(await body).not.toContain("access-ended");
    expect((await b.api("access")).data).toMatchObject({
      status: "approved",
      device: { send: true },
    });
  });

  it("rejects unknown access levels and devices", async () => {
    await expect(
      service.request({ operation: "generate-code", access: "admin" as never }),
    ).rejects.toThrow("invalid_admin_request");
    await expect(
      service.request({ operation: "set-access", id: "missing", access: "full" }),
    ).rejects.toThrow("device_not_found");
  });

  it("rejects invented workspace IDs and removed workspaces, without accepting client paths", async () => {
    const b = await browser();
    await b.api("pair", { code: await code(), name: "Phone" });
    for (const workspaceId of ["missing", "/etc", "../first"])
      expect(
        (
          await b.api("managed/create", {
            workspaceId,
            path: dir,
            bootId: b.access.bootId,
            requestId: randomUUID(),
          })
        ).status,
      ).toBe(403);
    expect(managed).not.toHaveBeenCalled();
    expect((await b.api("files/list?workspaceId=missing")).status).toBe(403);
    expect((await b.api("live?sessionId=arbitrary-native-id")).status).toBe(403);
    workspaces = [];
    expect((await b.api("files/list?workspaceId=first")).status).toBe(403);
    expect(
      (
        await b.api("send", {
          sessionId: "session-first",
          text: "no",
          bootId: b.access.bootId,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect((await b.api("files/workspaces")).data.workspaces).toEqual([]);
  });

  it("retains legacy scopes and flags when a code is generated and another browser pairs", async () => {
    const legacy = await browser();
    const legacyId = await approveLegacyBrowser(service, legacy.cookie, { files: true });
    const newBrowser = await browser();
    await newBrowser.api("pair", { code: await code(), name: "New" });
    expect((await legacy.api("access")).data).toMatchObject({
      experimentalEnabled: false,
      device: { id: legacyId, send: false, approve: false },
    });
    expect((await legacy.api("access")).data.device.accessMode).toBeUndefined();
    expect((await legacy.api("files/workspaces")).data.workspaces).toEqual([]);
    expect((await legacy.api("managed/options")).status).toBe(403);
    const saved = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
    expect(
      saved.credentials.find((c: { device: { id: string } }) => c.device.id === legacyId).device
        .accessMode,
    ).toBeUndefined();
  });

  it("consumes a code exactly once across simultaneous browsers", async () => {
    const [a, b] = await Promise.all([browser(), browser()]);
    const value = await code();
    const results = await Promise.all([
      a.api("pair", { code: value, name: "A" }),
      b.api("pair", { code: value, name: "B" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect((await service.request({ operation: "status" })).devices).toHaveLength(1);
    expect((await service.request({ operation: "status" })).code).toBeUndefined();
  });

  it("never exposes a grant before durable persistence; failed save preserves code for retry", async () => {
    const b = await browser();
    const value = await code();
    await mkdir(join(dir, "web-access.json.tmp"));
    expect((await b.api("pair", { code: value, name: "Phone" })).status).toBe(500);
    expect((await b.api("access")).data.status).toBe("unpaired");
    expect((await service.request({ operation: "status" })).devices).toEqual([]);
    expect((await service.request({ operation: "status" })).code!.value).toBe(value);
    await rm(join(dir, "web-access.json.tmp"), { recursive: true });
    expect((await b.api("pair", { code: value, name: "Phone" })).status).toBe(200);
  });

  it("checks expiry inside the serialized consumption queue and revokes full access", async () => {
    const b = await browser();
    const value = await code();
    const internals = service as unknown as {
      code: { value: string; expiresAt: number };
      adminQueue: Promise<unknown>;
    };
    internals.code.expiresAt = Date.now() - 1;
    expect((await b.api("pair", { code: value, name: "Phone" })).status).toBe(403);
    const accepted = await b.api("pair", { code: await code(), name: "Phone" });
    await service.request({ operation: "revoke", id: accepted.data.device.id });
    expect((await b.api("access")).data.status).toBe("ended");
    expect((await b.api("files/workspaces")).status).toBe(401);
    expect((await b.api("pair", { code: await code(), name: "Phone" })).status).toBe(409);
  });

  it("recovers a lost success response with the same cookie across a service restart", async () => {
    const b = await browser();
    // The transport may lose this response; recovery only reads /access, never replays /pair.
    await b.api("pair", { code: await code(), name: "Phone" });
    const before = (await b.api("access")).data.device;
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      managedRequest: managed,
      workspaceRequest: async () => workspaces,
      verifiedCodex: true,
    });
    await service.initialize();
    const recovered = (await b.api("access")).data;
    expect(recovered).toMatchObject({
      status: "approved",
      device: { id: before.id, accessMode: "full" },
    });
    expect((await service.request({ operation: "status" })).devices).toHaveLength(1);
    expect((await service.request({ operation: "status" })).code).toBeUndefined();
    expect((await b.api("files/workspaces")).data.workspaces).toHaveLength(1);
  });

  it("keeps new authorization invisible until its save finishes", async () => {
    const b = await browser();
    const value = await code();
    const internals = service as unknown as { save: (...args: unknown[]) => Promise<void> };
    const original = internals.save.bind(service);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "save").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      await original(...args);
    });
    const pairing = b.api("pair", { code: value, name: "Phone" });
    await started;
    expect((await b.api("access")).data.status).toBe("unpaired");
    expect((await b.api("files/workspaces")).status).toBe(401);
    release();
    expect((await pairing).status).toBe(200);
    expect((await b.api("access")).data.status).toBe("approved");
  });

  it("does not share full and legacy control projections", async () => {
    const legacy = await browser();
    await approveLegacyBrowser(service, legacy.cookie, { send: true });
    const full = await browser();
    await full.api("pair", { code: await code(), name: "Full" });
    const [restricted, allowed] = await Promise.all([
      legacy.api("live?sessionId=session-first"),
      full.api("live?sessionId=session-first"),
    ]);
    expect(restricted.data.sendEnabled).toBe(false);
    expect(allowed.data.sendEnabled).toBe(true);
    expect((await legacy.api("files/workspaces")).status).toBe(403);
    expect((await full.api("files/workspaces")).status).toBe(200);
  });

  it("retains native revision and pending-approval checks for full credentials", async () => {
    const b = await browser();
    await b.api("pair", { code: await code(), name: "Phone" });
    const stale = await b.api("send", {
      sessionId: "session-first",
      text: "no",
      expectedRevision: 0,
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe("stale_state");
    const absent = await b.api("approve", {
      sessionId: "session-first",
      approvalId: 7,
      turnId: "turn",
      decision: "accept",
      expectedRevision: 1,
      bootId: b.access.bootId,
      requestId: randomUUID(),
    });
    expect(absent.status).toBe(409);
    expect(absent.data.error).toBe("approval_unavailable");
    expect(
      runtime.mock.calls.some(([input]) =>
        ["send", "approve"].includes((input as { operation: string }).operation),
      ),
    ).toBe(false);
  });

  it("preserves the host acceptance-session restriction for full credentials", async () => {
    const internal = service as unknown as { options: { acceptanceSessionId?: string } };
    internal.options.acceptanceSessionId = "a".repeat(64);
    const b = await browser();
    await b.api("pair", { code: await code(), name: "Phone" });
    expect(
      (
        await b.api("send", {
          sessionId: "session-first",
          bootId: b.access.bootId,
          requestId: randomUUID(),
        })
      ).data.error,
    ).toBe("session_control_not_allowed");
    expect(
      (
        await b.api("managed/create", {
          workspaceId: "first",
          bootId: b.access.bootId,
          requestId: randomUUID(),
        })
      ).data.error,
    ).toBe("session_control_not_allowed");
    expect(
      (await b.api("codex/capabilities?sessionId=session-first")).data.features.rename.available,
    ).toBe(false);
    expect(managed).not.toHaveBeenCalled();
  });

  it("keeps native host verification mandatory even with a full credential", async () => {
    const internal = service as unknown as { options: { verifiedCodex: boolean } };
    internal.options.verifiedCodex = false;
    const b = await browser();
    await b.api("pair", { code: await code(), name: "Phone" });
    expect((await b.api("access")).data.experimentalEnabled).toBe(false);
    expect((await b.api("managed/options")).status).toBe(403);
    expect((await b.api("files/workspaces")).status).toBe(200);
  });
});
