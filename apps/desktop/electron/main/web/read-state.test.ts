// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebAccessService, createWebControlState } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { RuntimeRequestError } from "../runtime-host";

describe("read receipt host boundary", () => {
  let directory: string;
  let service: WebAccessService;
  let origin: string;
  let cookie = "",
    csrf = "",
    owner: string | undefined;
  let registered = true;
  let state = { status: "unread", version: "native:one" };
  const control = createWebControlState();
  const runtime = vi.fn(async (params: unknown): Promise<unknown> => {
    const input = params as { operation: string };
    if (input.operation === "catalog")
      return {
        workspaces: [{ id: "w" }],
        sessions: [{ id: "s", workspace_id: "w", agent: "claude-code" }],
      };
    if (input.operation === "read-state" || input.operation === "read-state-update")
      return { readState: state };
    throw new Error("unexpected operation");
  });
  const implementation = runtime.getMockImplementation()!;
  async function http(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/api/web/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: (await response.json()) as Record<string, unknown>,
      response,
    };
  }
  beforeEach(async () => {
    owner = undefined;
    registered = true;
    state = { status: "unread", version: "native:one" };
    runtime.mockReset().mockImplementation(implementation);
    control.admission = false;
    control.active.clear();
    control.requests.clear();
    control.unconfirmed.clear();
    directory = await mkdtemp(join(tmpdir(), "agentkib-read-state-host-"));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      sharedControl: control,
      desktopOrigin: "app://bundle",
      workspaceRequest: async () =>
        registered ? [{ id: "w", name: "Workspace", path: directory }] : [],
      account: {
        signedIn: () => !!owner,
        accountId: () => owner,
        ensureDeviceOwner: async () => undefined,
        registerDevice: async () => ({}),
      },
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      allowedWorkspaceIds: ["w"],
      experimentalEnabled: false,
    });
    cookie = "";
    const access = await http("/access");
    cookie = access.response.headers.get("set-cookie")!.split(";")[0];
    csrf = access.data.csrfToken as string;
    await approveLegacyBrowser(service, cookie, { send: false, approve: false });
  });
  afterEach(async () => {
    await service.shutdown();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const ack = { sessionId: "s", expectedVersion: "native:one", seenResultId: "turn-one" };

  it("lets read-only devices acknowledge without business admission, receipts or controls", async () => {
    control.admission = true;
    expect((await http("/read-state?sessionId=s")).status).toBe(200);
    const response = await http("/read-state", ack);
    expect(response).toMatchObject({ status: 200, data: { readState: state } });
    expect(response.data.controlOutcome).toBeUndefined();
    expect(runtime).toHaveBeenCalledWith({
      operation: "read-state-update",
      ...ack,
      readerScope: "local",
    });
    expect(control.requests.size).toBe(0);
    expect(control.active.size).toBe(0);
    expect(control.unconfirmed.size).toBe(0);
    expect(control.admission).toBe(true);
  });

  it("keeps CSRF, session boundaries and strict host-derived reader identity", async () => {
    expect((await http("/read-state", ack, { "X-CSRF-Token": "wrong" })).status).toBe(403);
    expect((await http("/read-state", { ...ack, readerScope: "account:other" })).status).toBe(400);
    expect((await http("/read-state", { ...ack, sessionId: "other" })).status).toBe(403);
    expect((await http("/read-state?sessionId=s&readerScope=other")).status).toBe(400);
    expect((await http("/read-state?sessionId=s&sessionId=s")).status).toBe(400);
    expect((await http("/read-state", { ...ack, seenResultId: undefined })).status).toBe(400);
    expect(
      runtime.mock.calls.some(
        ([input]) => (input as { operation: string }).operation === "read-state-update",
      ),
    ).toBe(false);
  });

  it("shares a trusted account scope across desktop and paired clients", async () => {
    owner = "owner-account";
    expect((await http("/read-state?sessionId=s")).status).toBe(200);
    expect(await service.localRequest("/read-state", ack)).toMatchObject({ status: 200 });
    expect(runtime).toHaveBeenCalledWith({
      operation: "read-state",
      sessionId: "s",
      readerScope: "account:owner-account",
    });
    expect(runtime).toHaveBeenCalledWith({
      operation: "read-state-update",
      ...ack,
      readerScope: "account:owner-account",
    });
    await service.localRequest("/catalog");
    expect(runtime).toHaveBeenCalledWith({
      operation: "catalog",
      readerScope: "account:owner-account",
    });
  });

  it.each([
    ["read-state-conflict", 409, "read_state_conflict"],
    ["read-state-unavailable", 503, "read_state_unavailable"],
    ["read-state-unsupported", 404, "read_state_unsupported"],
  ])("maps %s without replay or business pending", async (error, status, code) => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "read-state-update")
        throw new RuntimeRequestError({
          code: -32000,
          message: "AgentKib command failed",
          data: { detail: error },
        });
      return implementation(params);
    });
    expect(await http("/read-state", ack)).toMatchObject({ status, data: { error: code } });
    expect(
      runtime.mock.calls.filter(
        ([input]) => (input as { operation: string }).operation === "read-state-update",
      ),
    ).toHaveLength(1);
    expect(control.unconfirmed.size).toBe(0);
  });

  it("rejects a late state after owner changes during the native read", async () => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "read-state") owner = "new-owner";
      return implementation(params);
    });
    expect(await http("/read-state?sessionId=s")).toMatchObject({
      status: 409,
      data: { error: "access_changed" },
    });
  });

  it("rechecks workspace access after desktop receipt resolves", async () => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "read-state-update") registered = false;
      return implementation(params);
    });
    expect(await service.localRequest("/read-state", ack)).toMatchObject({
      status: 403,
      body: { error: "workspace_not_authorized" },
    });
  });
});
