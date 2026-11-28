import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeHostScheduler,
  type ClaudeScheduledSession,
  type ClaudeScheduleAuthority,
} from "./claude-scheduler";
import { createWebControlState, HOSTED_ORIGIN, WebAccessService } from "./service";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(agent?: ClaudeScheduledSession["agent"], deviceId = "phone") {
  const session: ClaudeScheduledSession = {
    sessionId: "session",
    ...(agent && { agent }),
    workspaceId: "workspace",
    runtimeBootId: "runtime",
    revision: 7,
    paused: false,
    next: {
      itemId: "work",
      requestId: "request",
      deviceId,
      kind: "queue",
      requiresAttachments: true,
    },
  };
  const invoke = vi.fn(async (input: unknown): Promise<unknown> => {
    const value = input as Record<string, unknown>;
    if (value.operation === "schedule-list") return { sessions: [structuredClone(session)] };
    if (value.operation === "schedule-prepare")
      return { accepted: true, permitId: "permit", expectedRevision: 8, runtimeBootId: "runtime" };
    return { accepted: true };
  });
  const authority: ClaudeScheduleAuthority = {
    owns: (id) => id === deviceId,
    authorize: vi.fn(async () => {}),
    reserve: vi.fn(() => true),
    release: vi.fn(),
    settled: vi.fn(async () => {}),
  };
  const scheduler = new ClaudeHostScheduler(invoke);
  const unregister = scheduler.register(authority);
  cleanups.push(unregister);
  return {
    session,
    invoke,
    authority,
    scheduler,
    unregister,
    operations: () =>
      invoke.mock.calls.map(([value]) => (value as Record<string, unknown>).operation),
  };
}
describe("shared Claude host scheduler", () => {
  it("authorizes the original device before prepare and again immediately before dispatch", async () => {
    const f = fixture();
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare", "schedule-dispatch"]);
    expect(f.authority.authorize).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deviceId: "phone",
        expectedRevision: 8,
        permitId: "permit",
        requestId: "request",
      }),
    );
    expect(f.authority.release).toHaveBeenCalledWith("session");
  });
  it.each([
    [false, true],
    [true, false],
  ])("dispatches a Codex wait with the fresh restriction (%s to %s)", async (before, after) => {
    const f = fixture("codex");
    const authorize = vi
      .mocked(f.authority.authorize)
      .mockResolvedValueOnce({ restrictNativePolicy: before })
      .mockResolvedValueOnce({ restrictNativePolicy: after });
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare", "schedule-dispatch"]);
    expect(authorize.mock.calls).toEqual([[f.session], [f.session]]);
    expect(authorize.mock.invocationCallOrder[0]!).toBeLessThan(
      f.invoke.mock.invocationCallOrder[1]!,
    );
    expect(f.invoke.mock.invocationCallOrder[1]!).toBeLessThan(
      authorize.mock.invocationCallOrder[1]!,
    );
    expect(authorize.mock.invocationCallOrder[1]!).toBeLessThan(
      f.invoke.mock.invocationCallOrder[2]!,
    );
    expect(f.invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: "schedule-prepare",
        agent: "codex",
        expectedRevision: 7,
        itemId: "work",
        deviceId: "phone",
      }),
    );
    expect(f.invoke).toHaveBeenLastCalledWith({
      operation: "schedule-dispatch",
      agent: "codex",
      sessionId: "session",
      itemId: "work",
      deviceId: "phone",
      requestId: "request",
      expectedRevision: 8,
      runtimeBootId: "runtime",
      permitId: "permit",
      restrictNativePolicy: after,
    });
  });

  it("invalidates a prepared Codex permit when fresh authorization is denied", async () => {
    const f = fixture("codex");
    vi.mocked(f.authority.authorize)
      .mockResolvedValueOnce({ restrictNativePolicy: false })
      .mockRejectedValueOnce(new Error("Codex send grant revoked"));
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare", "schedule-pause"]);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "schedule-pause",
        agent: "codex",
        itemId: "work",
        reason: "authorization-or-prepare-failed",
      }),
    );
    expect(f.authority.release).toHaveBeenCalledExactlyOnceWith("session");
  });

  it("fences a Codex device epoch change after its permit is prepared", async () => {
    const f = fixture("codex");
    let startAuthorize!: () => void;
    const started = new Promise<void>((resolve) => {
      startAuthorize = resolve;
    });
    let verify!: (policy: { restrictNativePolicy: boolean }) => void;
    const verified = new Promise<{ restrictNativePolicy: boolean }>((resolve) => {
      verify = resolve;
    });
    vi.mocked(f.authority.authorize)
      .mockResolvedValueOnce({ restrictNativePolicy: false })
      .mockImplementationOnce(() => {
        startAuthorize();
        return verified;
      });
    const tick = f.scheduler.tick();
    await started;
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare"]);
    await f.scheduler.invalidate("phone", "access-downgraded");
    verify({ restrictNativePolicy: false });
    await tick;
    expect(f.operations()).not.toContain("schedule-dispatch");
    expect(f.operations()).toContain("schedule-invalidate");
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "schedule-pause",
        agent: "codex",
        itemId: "work",
        reason: "authorization-changed",
      }),
    );
  });

  it("keeps ready Codex waits on host shutdown", async () => {
    const f = fixture("codex");
    vi.mocked(f.authority.reserve).mockReturnValue(false);
    await f.scheduler.tick();
    await f.scheduler.invalidate("phone", "application-quit");
    await f.scheduler.tick();
    expect(f.invoke).toHaveBeenCalledWith({
      operation: "schedule-invalidate",
      deviceId: "phone",
      quitting: true,
    });
    expect(f.operations()).not.toContain("schedule-pause");
    expect(f.operations()).not.toContain("schedule-dispatch");
  });

  it("schedules a verified LAN Codex wait with a send-only device grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "ak-lan-codex-scheduler-"));
    const f = fixture("codex");
    f.unregister();
    f.session.next!.requiresAttachments = false;
    const address = "192.168.20.10";
    const port = 1422;
    const workspaces = [{ id: "workspace", name: "Workspace", path: root }];
    const catalog = vi.fn(async () => ({
      sessions: [{ id: "session", agent: "codex", workspace_id: "workspace" }],
      workspaces,
    }));
    const control = createWebControlState();
    const service = new WebAccessService({
      mode: "lan",
      addresses: () => [{ name: "test", address }],
      dataDir: root,
      staticDir: root,
      workspaceRequest: async () => workspaces,
      sessionRequest: async ({ host }) =>
        host.request.operation === "catalog" ? catalog() : f.invoke(host.request),
      enableSerialSessionScheduler: true,
      verifiedCodex: true,
      sharedControl: control,
    });
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...input: unknown[]
    ) {
      const ready = input.at(-1);
      if (typeof ready === "function") ready();
      return this;
    } as typeof Server.prototype.listen);
    try {
      await writeFile(
        join(root, "web-access.json"),
        JSON.stringify({
          config: {
            enabled: true,
            port,
            externalOrigin: HOSTED_ORIGIN,
            experimentalEnabled: true,
            lanAddress: address,
            allowPlaintext: true,
          },
          credentials: [
            {
              hash: "a".repeat(64),
              expiresAt: Date.now() + 60_000,
              binding: `${HOSTED_ORIGIN}|http://${address}:${port}`,
              device: { id: "phone", name: "LAN phone", send: true, approve: false },
            },
          ],
        }),
      );
      await service.initialize();
      await control.claudeScheduler!.tick();
      expect(catalog).toHaveBeenCalledTimes(2);
      expect(f.operations()).toEqual(["schedule-list", "schedule-prepare", "schedule-dispatch"]);
      expect(f.invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: "schedule-dispatch",
          agent: "codex",
          deviceId: "phone",
          restrictNativePolicy: true,
        }),
      );
    } finally {
      listen.mockRestore();
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["scheduler", "remote request", "startup"] as const)(
    "ends an expired pairing when discovered by %s",
    async (discovery) => {
      const root = await mkdtemp(join(tmpdir(), "ak-expired-pairing-"));
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const f = fixture();
      f.unregister();
      f.session.next!.requiresAttachments = false;
      const control = createWebControlState();
      const service = new WebAccessService({
        dataDir: root,
        staticDir: root,
        workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: root }],
        claudeManagedRequest: f.invoke,
        enableClaudeScheduler: true,
        verifiedClaudeManaged: true,
        sharedControl: control,
      });
      service.setSharedRuntimePrimary(true);
      const expiresAt = Date.now() + 60_000;
      const ended = {
        operation: "schedule-invalidate",
        deviceId: "phone",
        authorizationSource: "pairing-ended",
      };
      const file = join(root, "web-access.json");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      try {
        await writeFile(
          file,
          JSON.stringify({
            config: { enabled: true, port, externalOrigin: "", experimentalEnabled: false },
            credentials: [
              {
                hash: "a".repeat(64),
                expiresAt,
                device: {
                  id: "phone",
                  name: "Phone",
                  accessMode: "full",
                  send: true,
                  approve: true,
                  advancedControl: true,
                },
              },
              {
                hash: "b".repeat(64),
                expiresAt: expiresAt + 60_000,
                device: { id: "other-phone", name: "Other phone", send: true, approve: true },
              },
            ],
          }),
        );
        if (discovery === "startup") {
          vi.setSystemTime(expiresAt);
          f.invoke.mockRejectedValueOnce(new Error("runtime_unavailable"));
        }
        await service.initialize();
        const scheduler = control.claudeScheduler!;
        if (discovery !== "startup") {
          await scheduler.tick();
          expect(f.operations()).toEqual([
            "schedule-list",
            "schedule-prepare",
            "schedule-dispatch",
          ]);
          f.invoke.mockClear();
          vi.setSystemTime(expiresAt);
        }
        if (discovery === "remote request") {
          const response = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`, {
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status).toBe(200);
          await response.json();
          expect(f.operations()).toEqual(["schedule-invalidate", "schedule-pause"]);
          expect(f.invoke).toHaveBeenNthCalledWith(1, ended);
        }
        await scheduler.tick();
        expect(
          f.invoke.mock.calls.filter(
            ([request]) => (request as { operation: string }).operation === "schedule-invalidate",
          ),
        ).toEqual(discovery === "startup" ? [[ended], [ended]] : [[ended]]);
        expect(f.operations()).not.toContain("schedule-prepare");
        expect(f.operations()).not.toContain("schedule-dispatch");
        expect(f.invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: "schedule-pause",
            deviceId: "phone",
            reason: "authorization-revoked",
          }),
        );
        // The administrative queue serializes persistence, independent of dispatch.
        expect((await service.request({ operation: "status" })).devices).toMatchObject([
          { id: "other-phone" },
        ]);
        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(
          saved.credentials.map(({ device }: { device: { id: string } }) => device.id),
        ).toEqual(["other-phone"]);
      } finally {
        await service.dispose();
        vi.useRealTimers();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["fails", "stalls"] as const)(
    "retries a confirmed pairing end even if schedule-list still %s",
    async (list) => {
      const f = fixture();
      let runtimeReady = false;
      let delivered = false;
      let finishList!: (value: unknown) => void;
      const pendingList = new Promise((resolve) => {
        finishList = resolve;
      });
      f.invoke.mockImplementation(async (input) => {
        const { operation } = input as Record<string, unknown>;
        if (operation === "schedule-list") {
          if (list === "fails") throw new Error("catalog unavailable");
          return pendingList;
        }
        if (operation === "schedule-invalidate") {
          if (!runtimeReady) throw new Error("runtime unavailable");
          delivered = true;
        }
        return { ok: true };
      });

      await f.scheduler.invalidate("phone", "pairing-ended");
      const firstTick = f.scheduler.tick();
      if (list === "fails") await firstTick;
      else await Promise.resolve();
      expect(delivered).toBe(false);

      runtimeReady = true;
      const retry = f.scheduler.tick();
      try {
        if (list === "stalls") expect(retry).toBe(firstTick);
        expect(delivered).toBe(true);
        expect(f.invoke).toHaveBeenCalledWith({
          operation: "schedule-invalidate",
          deviceId: "phone",
          authorizationSource: "pairing-ended",
        });
      } finally {
        finishList({ sessions: [] });
        await retry;
      }
      const notifications = () =>
        f.operations().filter((operation) => operation === "schedule-invalidate").length;
      expect(notifications()).toBe(3);
      await f.scheduler.tick();
      expect(notifications()).toBe(3);
    },
  );

  it("keeps dispatching other devices while only one pairing-end notification is in flight", async () => {
    const f = fixture("codex", "active-phone");
    const expired = structuredClone(f.session);
    expired.sessionId = "expired";
    expired.next!.deviceId = "expired-phone";
    let finishNotification!: (value: unknown) => void;
    const pendingNotification = new Promise((resolve) => {
      finishNotification = resolve;
    });
    let notifications = 0;
    f.invoke.mockImplementation(async (input) => {
      const value = input as Record<string, unknown>;
      if (value.operation === "schedule-invalidate") {
        if (++notifications === 1) throw new Error("runtime unavailable");
        return pendingNotification;
      }
      if (value.operation === "schedule-list") return { sessions: [expired, f.session] };
      if (value.operation === "schedule-prepare")
        return {
          accepted: true,
          permitId: "permit",
          expectedRevision: 8,
          runtimeBootId: "runtime",
        };
      return { accepted: true };
    });

    await f.scheduler.invalidate("expired-phone", "pairing-ended");
    const tick = f.scheduler.tick();
    try {
      await expect.poll(() => f.operations().at(-1)).toBe("schedule-dispatch");
      await tick;
      await f.scheduler.tick();
      expect(notifications).toBe(2);
      expect(f.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "schedule-dispatch", deviceId: "active-phone" }),
      );
      expect(f.invoke).not.toHaveBeenCalledWith(
        expect.objectContaining({ operation: "schedule-pause", deviceId: "expired-phone" }),
      );
    } finally {
      finishNotification({ ok: true });
      await tick;
    }
  });

  it("coalesces ticks and fences a revoke that races the asynchronous native handshake", async () => {
    const f = fixture();
    let ready!: () => void;
    let prepare!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.invoke.mockImplementation(async (input) => {
      const value = input as Record<string, unknown>;
      if (value.operation === "schedule-list") return { sessions: [f.session] };
      if (value.operation === "schedule-prepare") {
        ready();
        return new Promise((resolve) => {
          prepare = resolve;
        });
      }
      return { accepted: true };
    });
    const tick = f.scheduler.tick();
    expect(f.scheduler.tick()).toBe(tick);
    await started;
    await f.scheduler.invalidate("phone", "access-downgraded");
    prepare({ accepted: true, permitId: "permit", expectedRevision: 8, runtimeBootId: "runtime" });
    await tick;
    expect(f.operations()).not.toContain("schedule-dispatch");
    expect(f.operations()).toContain("schedule-invalidate");
    expect(f.operations()).toContain("schedule-pause");
  });
  it("tells the backend when the host stops because the app quits", async () => {
    const f = fixture();
    await f.scheduler.invalidate("phone", "device-revoked");
    await f.scheduler.invalidate("phone", "application-quit");
    expect(
      f.invoke.mock.calls
        .map(([value]) => value as Record<string, unknown>)
        .filter((value) => value.operation === "schedule-invalidate"),
    ).toEqual([
      {
        operation: "schedule-invalidate",
        deviceId: "phone",
        authorizationSource: "device-revoked",
      },
      { operation: "schedule-invalidate", deviceId: "phone", quitting: true },
    ]);
  });
  it("does not invalidate either synthetic local identity as a paired device", async () => {
    const f = fixture();
    await f.scheduler.invalidate("agentkib-local-owner", "device-revoked");
    await f.scheduler.invalidate("desktop-local", "access-downgraded");
    expect(f.operations()).toEqual([]);
  });
  it("does not consume work after workspace, attachment or device authorization fails", async () => {
    const f = fixture();
    vi.mocked(f.authority.authorize).mockRejectedValueOnce(new Error("attachment revoked"));
    await f.scheduler.tick();
    expect(f.operations()).not.toContain("schedule-prepare");
    expect(f.operations()).not.toContain("schedule-dispatch");
    expect(f.operations()).not.toContain("schedule-invalidate");
    expect(f.operations()).toContain("schedule-pause");
    expect(f.authority.release).toHaveBeenCalledOnce();
  });
  it.each(["schedule-prepare", "schedule-dispatch"])(
    "does not invalidate the local owner when %s loses its reply",
    async (failedOperation) => {
      const f = fixture(undefined, "agentkib-local-owner");
      const invoke = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async (input) => {
        if ((input as { operation: string }).operation === failedOperation)
          throw new Error("runtime request timed out");
        return invoke(input);
      });

      await f.scheduler.tick();

      expect(f.operations()).not.toContain("schedule-invalidate");
      expect(f.operations().filter((operation) => operation === "schedule-dispatch")).toHaveLength(
        failedOperation === "schedule-dispatch" ? 1 : 0,
      );
      expect(f.invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: "schedule-pause",
          sessionId: "session",
          reason:
            failedOperation === "schedule-dispatch"
              ? "scheduled-outcome-unknown"
              : "authorization-or-prepare-failed",
        }),
      );
    },
  );
  it("pauses an unknown dispatch and never retries it within the same tick", async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (input) => {
      const value = input as Record<string, unknown>;
      if (value.operation === "schedule-list") return { sessions: [f.session] };
      if (value.operation === "schedule-prepare")
        return {
          accepted: true,
          permitId: "permit",
          expectedRevision: 8,
          runtimeBootId: "runtime",
        };
      if (value.operation === "schedule-dispatch") throw new Error("response lost");
      return { accepted: true };
    });
    await f.scheduler.tick();
    expect(f.operations().filter((operation) => operation === "schedule-dispatch")).toHaveLength(1);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "schedule-pause", reason: "scheduled-outcome-unknown" }),
    );
  });
  it("respects restart pause and human command admission", async () => {
    const f = fixture();
    f.session.paused = true;
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);
    f.session.paused = false;
    vi.mocked(f.authority.reserve).mockReturnValue(false);
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-list"]);
  });
  it("settles receipts when the native turn no longer presents runnable work", async () => {
    const f = fixture();
    await f.scheduler.tick();
    vi.mocked(f.authority.settled).mockClear();
    f.session.next = null;
    await f.scheduler.tick();
    expect(f.authority.settled).toHaveBeenCalledWith("session");
  });

  it("leaves another desktop's browser work to the authorized desktop", async () => {
    const f = fixture();
    f.scheduler.setSharedRuntimePrimary(false);
    f.session.next!.deviceId = "other-phone";
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);

    f.session.next!.deviceId = "phone";
    await f.scheduler.tick();
    expect(f.operations().slice(1)).toEqual([
      "schedule-list",
      "schedule-prepare",
      "schedule-dispatch",
    ]);
  });

  it("waits for a transport that has temporarily lost its scheduling authority", async () => {
    const f = fixture();
    f.authority.owns = () => false;
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);
    f.authority.owns = (id) => id === "phone";
    await f.scheduler.tick();
    expect(f.operations()).toEqual([
      "schedule-list",
      "schedule-list",
      "schedule-prepare",
      "schedule-dispatch",
    ]);
  });

  it("pauses work first observed after its pairing was revoked", async () => {
    const f = fixture();
    f.authority.owns = () => false;
    await f.scheduler.invalidate("phone", "device-revoked");
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-invalidate", "schedule-list", "schedule-pause"]);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "schedule-pause", reason: "authorization-revoked" }),
    );
  });

  it("leaves a prepared permit to expire when a replacement desktop takes over", async () => {
    const f = fixture();
    f.scheduler.setSharedRuntimePrimary(true);
    let resolvePrepare!: (value: unknown) => void;
    f.invoke.mockImplementation(async (input) => {
      const { operation } = input as Record<string, unknown>;
      if (operation === "schedule-list") return { sessions: [f.session] };
      if (operation === "schedule-prepare")
        return new Promise((resolve) => {
          resolvePrepare = resolve;
        });
      return { accepted: true };
    });
    const tick = f.scheduler.tick();
    await expect.poll(() => f.operations().at(-1)).toBe("schedule-prepare");
    f.authority.owns = () => false;
    f.scheduler.setSharedRuntimePrimary(false);
    resolvePrepare({
      accepted: true,
      permitId: "permit",
      expectedRevision: 8,
      runtimeBootId: "runtime",
    });
    await tick;
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare"]);
    expect(f.authority.release).toHaveBeenCalledWith("session");
  });

  it("lets only the primary desktop queue a due usage-limit continuation", async () => {
    const f = fixture();
    Object.assign(f.session, { paused: true, continueAt: Date.now(), next: null });
    f.scheduler.setSharedRuntimePrimary(false);
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);
    f.scheduler.setSharedRuntimePrimary(true);
    await f.scheduler.tick();
    expect(f.operations().slice(1)).toEqual(["schedule-list", "schedule-continue"]);
  });

  it("moves local scheduling to the elected Web service without pausing the shared queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "ak-shared-scheduler-"));
    const f = fixture();
    f.unregister();
    f.session.next!.deviceId = "agentkib-local-owner";
    f.session.next!.requiresAttachments = false;
    const make = (profile: string, primary: boolean) => {
      const control = createWebControlState();
      const service = new WebAccessService({
        dataDir: join(root, profile),
        staticDir: root,
        runtimeRequest: async () => ({}),
        workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: root }],
        claudeManagedRequest: f.invoke,
        enableClaudeScheduler: true,
        verifiedClaudeManaged: true,
        sharedControl: control,
      });
      service.setSharedRuntimePrimary(primary);
      return { service, scheduler: control.claudeScheduler! };
    };
    const first = make("formal", true);
    const second = make("dev", false);
    try {
      await first.service.initialize();
      await second.service.initialize();
      await second.scheduler.tick();
      expect(f.operations()).toEqual(["schedule-list"]);
      await first.scheduler.tick();
      expect(f.operations().slice(1)).toEqual([
        "schedule-list",
        "schedule-prepare",
        "schedule-dispatch",
      ]);

      first.service.setSharedRuntimePrimary(false);
      second.service.setSharedRuntimePrimary(true);
      await first.service.dispose();
      await second.scheduler.tick();
      expect(f.operations().slice(4)).toEqual([
        "schedule-list",
        "schedule-prepare",
        "schedule-dispatch",
      ]);
    } finally {
      await Promise.all([first.service.dispose(), second.service.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
