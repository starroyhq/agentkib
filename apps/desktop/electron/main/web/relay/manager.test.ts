import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { request, Server as TlsServer, type Server } from "node:https";
import { Transform, type Duplex } from "node:stream";
import { createServer as createTcpServer, connect, type Socket } from "node:net";
import {
  DEFAULT_RELAY_BROKER,
  RelayManager,
  buildFrpcConfig,
  validateCertificate,
  validateRegistration,
  type Registration,
  type RelayOptions,
} from "./manager";
const directories: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const registration: Registration = {
  deviceId: "a".repeat(32),
  credential: "b".repeat(43),
  controlHost: "device.remote.example.com",
  previewHost: "device.preview.example.net",
  tunnelHost: "tunnel.example.com",
  tunnelPort: 443,
  brokerUrl: "https://relay.example.com",
};
const assignment = {
  ...registration,
  protocolVersion: 2,
  node: { id: "primary", transport: "frp-wss", host: registration.tunnelHost, port: 443 },
  leaseSeconds: 60,
};
type Internals = {
  registration: Registration;
  key: string;
  certificate: string;
  abort: AbortController;
  generation: number;
  leaseUntil: number;
  wallLeaseUntil: number;
  servers: Map<"control" | "preview", Server>;
  children: Map<"control" | "preview", ChildProcess>;
  sockets: Set<Duplex>;
  authorize(generation: number): Promise<void>;
  register(generation: number): Promise<void>;
  ensureCertificate(generation: number): Promise<void>;
  startTls(channel: "control" | "preview", generation: number): Promise<void>;
  spawnFrpc(channel: "control" | "preview", generation: number): void;
  maintain(generation: number): Promise<void>;
  probe(host: string, generation: number): Promise<void>;
  failClosed(reason: "revoked" | "lease-expired", retry: boolean): void;
};
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "agentkib-relay-test-"));
  directories.push(path);
  return path;
}
function setup(path: string, overrides: Partial<RelayOptions> = {}) {
  const manager = new RelayManager({
    brokerUrl: registration.brokerUrl,
    stateDirectory: path,
    frpcPath: "/unused",
    target: { host: "127.0.0.1", port: 1234 },
    preview: { host: "127.0.0.1", port: 1235 },
    ...overrides,
  });
  stops.unshift(() => manager.stop());
  const internal = manager as unknown as Internals;
  internal.generation = 1;
  internal.abort = new AbortController();
  internal.registration = { ...registration };
  internal.leaseUntil = performance.now() + 60_000;
  internal.wallLeaseUntil = Date.now() + 60_000;
  return { manager, internal };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function certificate() {
  const path = await directory();
  const key = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
  await writeFile(join(path, "key.pem"), key, { mode: 0o600 });
  await writeFile(
    join(path, "req.conf"),
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${registration.controlHost}\n[ext]\nsubjectAltName=DNS:${registration.controlHost},DNS:${registration.previewHost}\n`,
  );
  // Only the test fixture uses OpenSSL. Production CSR creation is local runtime IPC.
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-days",
    "2",
    "-key",
    join(path, "key.pem"),
    "-config",
    join(path, "req.conf"),
    "-out",
    join(path, "cert.pem"),
  ]);
  return { path, key, cert: await readFile(join(path, "cert.pem"), "utf8") };
}

describe("relay registration and authorization leases", () => {
  it.each([
    ["ENOTFOUND", "dns"],
    ["EPROTO", "tls"],
  ] as const)(
    "reports a safe broker %s failure without leaking details",
    async (code, category) => {
      const path = await directory();
      await writeFile(join(path, "registration.json"), JSON.stringify(registration));
      const frpc = join(path, "frpc");
      await writeFile(frpc, '#!/bin/sh\nprintf "0.68.0\\n"\n', { mode: 0o700 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw Object.assign(new Error("private network details"), { code });
        }),
      );
      const manager = new RelayManager({
        brokerUrl: registration.brokerUrl,
        stateDirectory: path,
        frpcPath: frpc,
        target: { host: "127.0.0.1", port: 1234 },
        preview: { host: "127.0.0.1", port: 1235 },
      });
      stops.unshift(() => manager.stop());
      await manager.start();
      expect(manager.status.reason).toBe("network");
      expect(manager.status.failure).toEqual({ stage: "broker", code: category });
      expect(JSON.stringify(manager.status)).not.toContain("private network details");
      expect(manager.status.retryAt).toBeGreaterThan(Date.now());
    },
  );
  it("uses the managed default broker and isolates connector configs", async () => {
    const { manager, internal } = setup(await directory(), { brokerUrl: undefined });
    internal.registration = undefined as unknown as Registration;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(url.origin).toBe(DEFAULT_RELAY_BROKER);
        return new Response(JSON.stringify(assignment));
      }),
    );
    const control = buildFrpcConfig(
      validateRegistration(assignment, registration.brokerUrl),
      1234,
      "/roots",
      "control",
    );
    const preview = buildFrpcConfig(
      validateRegistration(assignment, registration.brokerUrl),
      1235,
      "/roots",
      "preview",
    );
    expect(control).toContain('name = "control"');
    expect(control).not.toContain(registration.previewHost);
    expect(preview).toContain('name = "preview"');
    expect(preview).not.toContain(registration.controlHost);
    expect(control).toContain('transport.tls.trustedCaFile = "/roots"');
    expect(manager.status.phase).toBe("disabled");
    expect(() =>
      validateRegistration(
        { ...assignment, node: { ...assignment.node, transport: "http" } },
        registration.brokerUrl,
      ),
    ).toThrow();
    expect(() =>
      validateRegistration({ ...registration, controlHost: "bad\nconfig" }, registration.brokerUrl),
    ).toThrow();
  });
  it("persists registration identity before sending and recovers a lost response after restart without persisting invitation", async () => {
    const path = await directory();
    const first = setup(path, { inviteCode: "private-invitation" });
    let received: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options: RequestInit) => {
        received = JSON.parse(options.body as string);
        const pending = JSON.parse(await readFile(join(path, "registration-pending.json"), "utf8"));
        expect(received.registrationId).toBe(pending.registrationId);
        expect(received.credential).toBe(pending.credential);
        expect(JSON.stringify(pending)).not.toContain("private-invitation");
        throw new Error("Response lost after accepted registration");
      }),
    );
    await expect(first.internal.register(1)).rejects.toThrow();
    await first.manager.stop();
    const second = setup(path);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options: RequestInit) => {
        const retry = JSON.parse(options.body as string);
        expect(retry.registrationId).toBe(received.registrationId);
        expect(retry.credential).toBe(received.credential);
        expect(retry.invitation).toBeUndefined();
        const { credential: _credential, ...result } = assignment;
        return new Response(JSON.stringify(result));
      }),
    );
    await second.internal.register(1);
    expect(second.internal.registration.credential).toBe(received.credential);
    await expect(readFile(join(path, "registration-pending.json"))).rejects.toThrow();
  });
  it("re-registers with a new invitation when both state files are corrupt", async () => {
    const path = await directory();
    await writeFile(join(path, "registration-pending.json"), '{"brokerUrl":');
    await writeFile(join(path, "registration.json"), "not json");
    const { internal } = setup(path, { inviteCode: "fresh-invitation" });
    const fetcher = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      expect(body.invitation).toBe("fresh-invitation");
      const { credential: _credential, ...result } = assignment;
      return new Response(JSON.stringify(result));
    });
    vi.stubGlobal("fetch", fetcher);
    await internal.register(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(internal.registration.deviceId).toBe(registration.deviceId);
    expect(JSON.parse(await readFile(join(path, "registration.json"), "utf8")).deviceId).toBe(
      registration.deviceId,
    );
  });
  it("still surfaces unreadable state files instead of discarding them", async () => {
    const path = await directory();
    // 目录代替文件：readFile 抛 EISDIR，不能当成"损坏"删掉重来。
    await mkdir(join(path, "registration-pending.json"));
    const { internal } = setup(path, { inviteCode: "fresh-invitation" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(internal.register(1)).rejects.toMatchObject({ code: "EISDIR" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reenrollment preserves old identity on failure and resumes pending intent ahead of it after restart", async () => {
    const path = await directory();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    expect(() => setup(path, { reenroll: true })).toThrow("new invitation");
    const first = setup(path, { reenroll: true, inviteCode: "new-invitation" });
    const fetcher = vi.fn(async () => {
      throw new Error("Registration response lost");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(first.internal.register(1)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(path, "registration.json"), "utf8"))).toEqual(
      registration,
    );
    const pending = JSON.parse(await readFile(join(path, "registration-pending.json"), "utf8"));
    expect(pending.reenroll).toBe(true);
    expect(JSON.stringify(pending)).not.toContain("new-invitation");
    await first.manager.stop();
    const restarted = setup(path);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options: RequestInit) => {
        expect(JSON.parse(options.body as string).registrationId).toBe(pending.registrationId);
        expect(JSON.parse(options.body as string).invitation).toBeUndefined();
        return new Response(
          JSON.stringify({ ...assignment, deviceId: "c".repeat(32), credential: undefined }),
        );
      }),
    );
    await restarted.internal.register(1);
    expect(restarted.internal.registration.deviceId).toBe("c".repeat(32));
    const saved = JSON.parse(await readFile(join(path, "registration.json"), "utf8"));
    expect(saved.credential).toBe(pending.credential);
    const idleFetch = vi.fn();
    vi.stubGlobal("fetch", idleFetch);
    await restarted.internal.register(1);
    expect(idleFetch).not.toHaveBeenCalled();
  });
  it("migrates old registration without another invitation and accepts a v2 assignment", async () => {
    const path = await directory();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    const { internal } = setup(path);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(assignment)));
    vi.stubGlobal("fetch", fetcher);
    await internal.register(1);
    expect(fetcher).not.toHaveBeenCalled();
    await internal.authorize(1);
    expect(internal.registration.node?.id).toBe("primary");
    expect(internal.registration.credential).toBe(registration.credential);
  });
  it("counts a lease from request start, refreshes single-flight, and closes all sockets when refresh hangs", async () => {
    const { manager, internal } = setup(await directory());
    vi.useFakeTimers();
    const first = deferred<Response>();
    const later = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => later.promise);
    vi.stubGlobal("fetch", fetcher);
    const started = performance.now();
    const authorization = internal.authorize(1);
    expect(internal.authorize(1)).toBe(authorization);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    first.resolve(new Response(JSON.stringify(assignment)));
    await authorization;
    expect(internal.leaseUntil).toBe(started + 60_000);
    const socket = { destroy: vi.fn() } as unknown as Duplex;
    internal.sockets.add(socket);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40_001);
    expect(socket.destroy).toHaveBeenCalled();
    expect(manager.status.reason).toBe("lease-expired");
    expect(internal.leaseUntil).toBe(0);
    later.resolve(new Response(JSON.stringify(assignment)));
    await Promise.resolve();
    expect(internal.leaseUntil).toBe(0);
    expect(manager.status.phase).not.toBe("ready");
  });
  it("wall clock rollback cannot extend an in-flight lease beyond sixty monotonic seconds", async () => {
    const { manager, internal } = setup(await directory());
    vi.useFakeTimers();
    const first = deferred<Response>();
    const later = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementation(() => later.promise),
    );
    const started = performance.now();
    const auth = internal.authorize(1);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    first.resolve(new Response(JSON.stringify(assignment)));
    await auth;
    expect(internal.leaseUntil).toBe(started + 60_000);
    await vi.advanceTimersByTimeAsync(50_001);
    expect(manager.status.reason).toBe("lease-expired");
    expect(internal.leaseUntil).toBe(0);
    later.resolve(new Response(JSON.stringify(assignment)));
  });
  it("rejects an unsupported unbounded broker response instead of exposing a tunnel", async () => {
    const { internal } = setup(await directory());
    internal.leaseUntil = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(registration))),
    );
    await expect(internal.authorize(1)).rejects.toThrow("bounded authorization");
    expect(internal.leaseUntil).toBe(0);
    expect(internal.children.size).toBe(0);
  });
  it("revocation during refresh fails closed without waiting for lease expiry", async () => {
    const { manager, internal } = setup(await directory());
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(assignment)))
        .mockResolvedValue(new Response("{}", { status: 403 })),
    );
    await internal.authorize(1);
    const socket = { destroy: vi.fn() } as unknown as Duplex;
    internal.sockets.add(socket);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(manager.status.reason).toBe("revoked");
    expect(socket.destroy).toHaveBeenCalled();
    expect(internal.leaseUntil).toBe(0);
  });
  it("stopping a pending authorization rejects it and ignores a late successful response", async () => {
    const { manager, internal } = setup(await directory());
    const response = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response.promise),
    );
    const auth = internal.authorize(1);
    const rejected = expect(auth).rejects.toThrow();
    await manager.stop();
    await rejected;
    response.resolve(new Response(JSON.stringify(assignment)));
    await Promise.resolve();
    expect(manager.status.phase).toBe("disabled");
    expect(internal.leaseUntil).toBe(0);
  });
  it("stop does not wait indefinitely for an origin callback and never exposes a listener afterward", async () => {
    const path = await directory();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    const frpc = join(path, "frpc");
    await writeFile(frpc, '#!/bin/sh\nprintf "0.68.0\\n"\n', { mode: 0o700 });
    const reached = deferred<void>();
    const gate = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(assignment))),
    );
    const manager = new RelayManager({
      brokerUrl: registration.brokerUrl,
      stateDirectory: path,
      frpcPath: frpc,
      target: { host: "127.0.0.1", port: 1234 },
      preview: { host: "127.0.0.1", port: 1235 },
      onOrigins: () => {
        reached.resolve();
        return gate.promise;
      },
    });
    stops.unshift(() => manager.stop());
    const start = manager.start();
    await reached.promise;
    await manager.stop();
    gate.resolve();
    await start;
    expect(manager.status.phase).toBe("disabled");
    expect((manager as unknown as Internals).servers.size).toBe(0);
  });
});

describe("relay TLS channels and certificate lifecycle", () => {
  it("identifies local certificate preparation failures", async () => {
    const path = await directory();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    const frpc = join(path, "frpc");
    await writeFile(frpc, '#!/bin/sh\nprintf "0.68.0\\n"\n', { mode: 0o700 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(assignment))),
    );
    const manager = new RelayManager({
      brokerUrl: registration.brokerUrl,
      stateDirectory: path,
      frpcPath: frpc,
      target: { host: "127.0.0.1", port: 1234 },
      preview: { host: "127.0.0.1", port: 1235 },
      createCsr: async () => {
        throw new Error("private key details");
      },
    });
    stops.unshift(() => manager.stop());
    await manager.start();
    expect(manager.status.reason).toBe("certificate");
    expect(manager.status.failure).toEqual({ stage: "certificate", code: "unknown" });
    expect(JSON.stringify(manager.status)).not.toContain("private key details");
  });
  it("identifies which connector process exited", async () => {
    const path = await directory();
    const frpc = join(path, "frpc");
    await writeFile(frpc, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const { manager, internal } = setup(path, { frpcPath: frpc });
    internal.spawnFrpc("preview", 1);
    await vi.waitFor(() =>
      expect(manager.status.failure).toEqual({ stage: "preview-connector", code: "process" }),
    );
    expect(manager.status.phase).toBe("offline");
  });
  it("validates domain/key/expiry and preserves a valid certificate when renewal fails", async () => {
    const { path, key, cert } = await certificate();
    const csr = vi.fn(async (_input: { privateKeyDer: string; hosts: string[] }) => ({
      csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----",
    }));
    const { manager, internal } = setup(path, { createCsr: csr });
    internal.key = key;
    internal.certificate = cert;
    expect(() => validateCertificate(cert, key, ["wrong.example.com"])).toThrow();
    expect(() =>
      validateCertificate(cert, key, [registration.controlHost], Date.now() + 7 * 86_400_000),
    ).toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, options: RequestInit) => {
        expect(options.body).not.toContain("privateKeyDer");
        expect(options.body).not.toContain("PRIVATE KEY");
        return new Response("{}", { status: 503 });
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 36 * 3_600_000);
    await internal.ensureCertificate(1);
    expect(internal.certificate).toBe(cert);
    expect(csr).toHaveBeenCalled();
    expect(csr.mock.calls[0][0].privateKeyDer).not.toContain("PRIVATE KEY");
    await manager.stop();
  });
  it("keeps refreshing authorization while CSR creation is blocked and aborts CSR on stop", async () => {
    const { path, key, cert } = await certificate();
    const pending = deferred<{ csrPem: string }>();
    const { manager, internal } = setup(path, { createCsr: () => pending.promise });
    internal.key = key;
    internal.certificate = cert;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 36 * 3_600_000);
    const fetcher = vi.fn(async () => new Response(JSON.stringify(assignment)));
    vi.stubGlobal("fetch", fetcher);
    await internal.authorize(1);
    const renewal = internal.ensureCertificate(1);
    const rejected = expect(renewal).rejects.toThrow();
    // 在 CSR 超时（30 秒）之前停止。
    await vi.advanceTimersByTimeAsync(20_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await manager.stop();
    await rejected;
    pending.resolve({ csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nlate" });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(manager.status.phase).toBe("disabled");
  });
  it("gives up on a hung local CSR and keeps the still-valid certificate", async () => {
    const { path, key, cert } = await certificate();
    const { manager, internal } = setup(path, { createCsr: () => new Promise(() => {}) });
    internal.key = key;
    internal.certificate = cert;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 36 * 3_600_000);
    vi.stubGlobal("fetch", vi.fn());
    const renewal = internal.ensureCertificate(1);
    await vi.advanceTimersByTimeAsync(30_000);
    // 证书还有效：续期失败只是告警，不能让 relay 断开。
    await expect(renewal).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(manager.status.certificateWarning).toBeUndefined();
    expect((manager as unknown as { certificateWarning: boolean }).certificateWarning).toBe(true);
  });
  it("reconnects a crashed connector while certificate renewal is still pending", async () => {
    const { path, key, cert } = await certificate();
    const { manager, internal } = setup(path);
    internal.key = key;
    internal.certificate = cert;
    (internal as unknown as { nextRenewal: number }).nextRenewal = 0;
    vi.spyOn(internal, "startTls").mockResolvedValue();
    const spawn = vi.spyOn(internal, "spawnFrpc").mockImplementation((channel) =>
      internal.children.set(channel, {
        kill: vi.fn(),
        once: vi.fn(),
        on: vi.fn(),
        exitCode: 0,
      } as unknown as ChildProcess),
    );
    vi.spyOn(internal, "probe").mockResolvedValue();
    // 续期一直挂着，直到 relay 停止。
    const renewal = vi
      .spyOn(internal, "ensureCertificate")
      .mockImplementation(
        () =>
          new Promise((_, reject) =>
            internal.abort.signal.addEventListener("abort", () => reject(new Error("stopped"))),
          ),
      );
    await internal.maintain(1);
    expect(manager.status.phase).toBe("ready");
    expect(renewal).toHaveBeenCalledTimes(1);
    // 一个 frpc 退出后，下一轮 maintain 必须能重新拉起它，而不是等着卡住的续期。
    internal.children.delete("preview");
    await internal.maintain(1);
    expect(spawn).toHaveBeenLastCalledWith("preview", 1);
    expect(manager.status.phase).toBe("ready");
    expect(renewal).toHaveBeenCalledTimes(1);
  });
  it("cancels unread broker error bodies", async () => {
    const path = await directory();
    const { internal } = setup(path);
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 })),
    );
    await expect(internal.authorize(1)).rejects.toThrow();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
  it("survives repeated error events from an frpc child", async () => {
    const path = await directory();
    const frpc = join(path, "frpc");
    await writeFile(frpc, "#!/bin/sh\nsleep 5\n", { mode: 0o700 });
    const { internal } = setup(path, { frpcPath: frpc });
    internal.spawnFrpc("preview", 1);
    const child = internal.children.get("preview")!;
    child.emit("error", new Error("first"));
    expect(() => child.emit("error", new Error("second"))).not.toThrow();
    child.kill("SIGKILL");
  });
  it("does not reconnect a revoked relay when the computer wakes up", async () => {
    const path = await directory();
    const { manager, internal } = setup(path);
    (internal as unknown as { enabled: boolean }).enabled = true;
    internal.failClosed("revoked", false);
    expect(manager.status).toMatchObject({ phase: "error", reason: "revoked" });
    const start = vi.spyOn(manager, "start");
    await manager.suspend();
    await manager.resume();
    expect(start).not.toHaveBeenCalled();
    expect(manager.status).toMatchObject({ phase: "error", reason: "revoked" });
  });
  it("retries a TLS listener that failed to listen instead of skipping it forever", async () => {
    const { path, key, cert } = await certificate();
    const { internal } = setup(path);
    internal.key = key;
    internal.certificate = cert;
    const listen = vi
      .spyOn(TlsServer.prototype, "listen")
      .mockImplementationOnce(function (this: TlsServer) {
        process.nextTick(() =>
          this.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" })),
        );
        return this;
      });
    await expect(internal.startTls("control", 1)).rejects.toThrow("EMFILE");
    expect(internal.servers.has("control")).toBe(false);
    await internal.startTls("control", 1);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(internal.servers.get("control")?.listening).toBe(true);
  });
  it("kills an frpc that ignores SIGTERM before stop resolves and removes its config", async () => {
    const { path, key, cert } = await certificate();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    await writeFile(join(path, "device-key.pem"), key);
    await writeFile(join(path, "certificate.pem"), cert);
    const frpc = join(path, "frpc-stubborn");
    await writeFile(
      frpc,
      '#!/usr/bin/env node\nif(process.argv.includes("--version")) console.log("0.68.0"); else { process.on("SIGTERM",()=>{}); setInterval(()=>{},1000); }\n',
      { mode: 0o700 },
    );
    const manager = new RelayManager({
      stateDirectory: path,
      brokerUrl: registration.brokerUrl,
      frpcPath: frpc,
      target: { host: "127.0.0.1", port: 1234 },
      preview: { host: "127.0.0.1", port: 1235 },
    });
    const internal = manager as unknown as Internals;
    stops.unshift(() => manager.stop());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(assignment))),
    );
    vi.spyOn(internal, "probe").mockResolvedValue();
    await manager.start();
    expect(manager.status.phase).toBe("ready");
    const children = [...internal.children.values()];
    expect(await readFile(join(path, "frpc-control.toml"), "utf8")).toContain(
      registration.credential,
    );
    // 等 node 装好 SIGTERM 处理器，否则 SIGTERM 会直接杀掉它。
    await new Promise((resolve) => setTimeout(resolve, 300));
    await manager.stop();
    expect(children.map((child) => child.signalCode)).toEqual(["SIGKILL", "SIGKILL"]);
    // 带凭据的 frpc 配置不留在磁盘上。
    for (const channel of ["control", "preview"])
      await expect(readFile(join(path, `frpc-${channel}.toml`))).rejects.toMatchObject({
        code: "ENOENT",
      });
  }, 15_000);
  it("suspend closes both connectors and resume requests a fresh lease before reconnecting", async () => {
    const { path, key, cert } = await certificate();
    await writeFile(join(path, "registration.json"), JSON.stringify(registration));
    await writeFile(join(path, "device-key.pem"), key);
    await writeFile(join(path, "certificate.pem"), cert);
    const frpc = join(path, "frpc-fixture");
    await writeFile(
      frpc,
      '#!/usr/bin/env node\nif(process.argv.includes("--version")) console.log("0.68.0"); else setInterval(()=>{},1000);\n',
      { mode: 0o700 },
    );
    const manager = new RelayManager({
      stateDirectory: path,
      brokerUrl: registration.brokerUrl,
      frpcPath: frpc,
      target: { host: "127.0.0.1", port: 1234 },
      preview: { host: "127.0.0.1", port: 1235 },
    });
    const internal = manager as unknown as Internals;
    stops.unshift(() => manager.stop());
    const fetcher = vi.fn(async () => new Response(JSON.stringify(assignment)));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(internal, "probe").mockResolvedValue();
    await manager.start();
    expect(manager.status.phase).toBe("ready");
    expect(internal.children.size).toBe(2);
    const oldChildren = [...internal.children.values()];
    await manager.suspend();
    expect(manager.status.reason).toBe("suspended");
    expect(internal.children.size).toBe(0);
    expect(internal.servers.size).toBe(0);
    expect(internal.leaseUntil).toBe(0);
    expect(oldChildren.every((child) => child.killed)).toBe(true);
    await manager.resume();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(manager.status.phase).toBe("ready");
    expect(internal.children.size).toBe(2);
    expect([...internal.children.values()].every((child) => !oldChildren.includes(child))).toBe(
      true,
    );
  });
  it("reports ready only when both public channel probes succeed", async () => {
    const { path, key, cert } = await certificate();
    const { manager, internal } = setup(path);
    internal.key = key;
    internal.certificate = cert;
    vi.spyOn(internal, "startTls").mockResolvedValue();
    vi.spyOn(internal, "spawnFrpc").mockImplementation((channel) =>
      internal.children.set(channel, {
        kill: vi.fn(),
        once: vi.fn(),
        exitCode: 0,
      } as unknown as ChildProcess),
    );
    vi.spyOn(internal, "ensureCertificate").mockResolvedValue();
    const probe = vi.spyOn(internal, "probe").mockImplementation(async (host) => {
      if (host === registration.previewHost) throw new Error("Preview unreachable");
    });
    await internal.maintain(1);
    expect(manager.status.phase).toBe("offline");
    expect(manager.status.channels).toEqual({ control: true, preview: false });
    expect(manager.status.failure).toEqual({ stage: "preview-probe", code: "unknown" });
    probe.mockResolvedValue();
    await internal.maintain(1);
    expect(manager.status.phase).toBe("ready");
    expect(manager.status.failure).toBeUndefined();
  });
  it("isolates control/preview TLS targets, streams Range, and closes an active response on revoke", async () => {
    const { path, key, cert } = await certificate();
    const target = createHttpServer((_req, res) => res.end("control"));
    const preview = createHttpServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200);
        res.write("still streaming");
        return;
      }
      expect(req.headers.range).toBe("bytes=2-4");
      expect(req.headers["x-forwarded-proto"]).toBe("https");
      res.writeHead(206, { "content-range": "bytes 2-4/10", "content-length": "3" });
      res.end("234");
    });
    await Promise.all(
      [target, preview].map(
        (server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      ),
    );
    for (const server of [target, preview])
      stops.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
    const port = (server: typeof target) => (server.address() as { port: number }).port;
    const { manager, internal } = setup(path, {
      target: { host: "127.0.0.1", port: port(target) },
      preview: { host: "127.0.0.1", port: port(preview) },
    });
    internal.key = key;
    internal.certificate = cert;
    await internal.startTls("control", 1);
    await internal.startTls("preview", 1);
    const requestOptions = (
      channel: "control" | "preview",
      sni: string,
      host: string,
      url = "/",
    ) => ({
      hostname: "127.0.0.1",
      port: (internal.servers.get(channel)!.address() as { port: number }).port,
      servername: sni,
      ca: cert,
      path: url,
      agent: false as const,
      headers: { host, range: "bytes=2-4" },
    });
    const get = (channel: "control" | "preview", sni: string, host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(requestOptions(channel, sni, host), (res) => {
          let body = "";
          res.on("data", (data) => {
            body += data;
          });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
        req.on("error", reject);
        req.end();
      });
    expect(await get("control", registration.controlHost, registration.controlHost)).toEqual({
      status: 200,
      body: "control",
    });
    expect(await get("preview", registration.previewHost, registration.previewHost)).toEqual({
      status: 206,
      body: "234",
    });
    expect((await get("control", registration.previewHost, registration.previewHost)).status).toBe(
      421,
    );
    expect((await get("preview", registration.previewHost, registration.controlHost)).status).toBe(
      421,
    );
    const streaming = deferred<void>();
    const closed = deferred<void>();
    const req = request(
      requestOptions("preview", registration.previewHost, registration.previewHost, "/stream"),
      (res) => {
        res.on("data", () => streaming.resolve());
        res.on("close", () => closed.resolve());
        res.on("error", () => {});
      },
    );
    req.on("error", () => closed.resolve());
    req.end();
    await streaming.promise;
    expect(internal.sockets.size).toBeGreaterThan(0);
    internal.failClosed("revoked", false);
    await closed.promise;
    expect(internal.sockets.size).toBe(0);
    expect(internal.servers.size).toBe(0);
    expect(manager.status.reason).toBe("revoked");
  });
});

describe("isolated local transport fault exercise", () => {
  it("keeps control and SSE responsive during delayed media, then resumes Range after connection reset", async () => {
    const { path, key, cert } = await certificate();
    let commands = 0;
    let events = 0;
    const mediaSize = 512 * 1024;
    const control = createHttpServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const timer = setInterval(() => res.write(`data: ${++events}\n\n`), 40);
        res.on("close", () => clearInterval(timer));
        return;
      }
      commands++;
      res.end(JSON.stringify({ accepted: true, requestId: req.headers["x-request-id"] }));
    });
    const media = createHttpServer((req, res) => {
      const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
      res.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": `bytes ${start}-${mediaSize - 1}/${mediaSize}`,
        "content-length": mediaSize - start,
        etag: '"fixture-v1"',
      });
      res.end(Buffer.alloc(mediaSize - start, 7));
    });
    await Promise.all(
      [control, media].map(
        (server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      ),
    );
    for (const server of [control, media])
      stops.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
    const portOf = (server: { address(): unknown }) => (server.address() as { port: number }).port;
    const { internal } = setup(path, {
      target: { host: "127.0.0.1", port: portOf(control) },
      preview: { host: "127.0.0.1", port: portOf(media) },
    });
    internal.key = key;
    internal.certificate = cert;
    await internal.startTls("control", 1);
    await internal.startTls("preview", 1);
    const mediaSockets = new Set<Socket>();
    const delayed = createTcpServer((socket) => {
      const upstream = connect(portOf(internal.servers.get("preview")!), "127.0.0.1");
      mediaSockets.add(socket);
      mediaSockets.add(upstream);
      const lag = new Transform({
        transform(chunk, _encoding, done) {
          setTimeout(() => done(null, chunk), 80);
        },
      });
      socket.on("error", () => {});
      upstream.on("error", () => socket.destroy());
      lag.on("error", () => {});
      socket.on("close", () => {
        mediaSockets.delete(socket);
        upstream.destroy();
        lag.destroy();
      });
      upstream.on("close", () => {
        mediaSockets.delete(upstream);
      });
      socket.pipe(upstream);
      upstream.pipe(lag).pipe(socket);
    });
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    stops.unshift(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of mediaSockets) socket.destroy();
          delayed.close(() => resolve());
        }),
    );
    const options = (channel: "control" | "preview", url: string) => ({
      hostname: "127.0.0.1",
      port: channel === "preview" ? portOf(delayed) : portOf(internal.servers.get("control")!),
      servername: channel === "preview" ? registration.previewHost : registration.controlHost,
      ca: cert,
      path: url,
      agent: false as const,
      headers: {
        host: channel === "preview" ? registration.previewHost : registration.controlHost,
      },
    });
    let eventCount = 0;
    const sse = request(options("control", "/events"), (response) => {
      response.on("data", () => eventCount++);
      response.on("error", () => {});
    });
    sse.on("error", () => {});
    sse.end();
    stops.unshift(async () => {
      sse.destroy();
    });
    const began = deferred<void>();
    const broken = deferred<void>();
    let partial = 0;
    const initial = request(
      {
        ...options("preview", "/media"),
        headers: { host: registration.previewHost, range: "bytes=0-" },
      },
      (response) => {
        response.on("data", (chunk) => {
          partial += chunk.length;
          began.resolve();
        });
        response.on("error", () => {});
        response.on("close", () => broken.resolve());
      },
    );
    initial.on("error", () => broken.resolve());
    initial.end();
    await began.promise;
    const latencies: number[] = [];
    for (let index = 0; index < 3; index++) {
      const started = performance.now();
      await new Promise<void>((resolve, reject) => {
        const command = request(
          {
            ...options("control", "/command"),
            method: "POST",
            headers: { host: registration.controlHost, "x-request-id": `isolated-${index}` },
          },
          (response) => {
            response.resume();
            response.on("end", resolve);
          },
        );
        command.on("error", reject);
        command.end();
      });
      latencies.push(performance.now() - started);
    }
    expect(commands).toBe(3);
    expect(eventCount).toBeGreaterThan(1);
    expect(Math.max(...latencies)).toBeLessThan(750);
    for (const socket of mediaSockets) socket.destroy();
    await broken.promise;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(mediaSize);
    let resumed = 0;
    await new Promise<void>((resolve, reject) => {
      const remaining = request(
        {
          ...options("preview", "/media"),
          headers: {
            host: registration.previewHost,
            range: `bytes=${partial}-`,
            "if-range": '"fixture-v1"',
          },
        },
        (response) => {
          expect(response.statusCode).toBe(206);
          expect(response.headers["content-range"]).toBe(
            `bytes ${partial}-${mediaSize - 1}/${mediaSize}`,
          );
          response.on("data", (chunk) => {
            resumed += chunk.length;
          });
          response.on("end", resolve);
          response.on("error", reject);
        },
      );
      remaining.on("error", reject);
      remaining.end();
    });
    expect(partial + resumed).toBe(mediaSize);
    if (process.env.AGENTKIB_RELAY_FAULT_REPORT)
      await writeFile(
        process.env.AGENTKIB_RELAY_FAULT_REPORT,
        JSON.stringify({
          delayPerMediaChunkMs: 80,
          controlRequests: commands,
          maximumControlLatencyMs: Math.ceil(Math.max(...latencies)),
          sseEvents: eventCount,
          partialBytes: partial,
          resumedBytes: resumed,
          totalBytes: mediaSize,
        }),
      );
  }, 15_000);
});

describe("account device registration", () => {
  it("persists account ownership with the pending identity and never stores an access token", async () => {
    const path = await directory();
    const registerAccount = vi.fn(async (input: { registrationId: string; credential: string }) => {
      const pending = JSON.parse(await readFile(join(path, "registration-pending.json"), "utf8"));
      expect(pending).toMatchObject({ ...input, accountId: "account-a" });
      const { credential: _credential, ...description } = assignment;
      return { ...description, accountId: "account-a" };
    });
    const { internal } = setup(path, { registrationAccountId: "account-a", registerAccount });
    await internal.register(1);
    expect(registerAccount).toHaveBeenCalledOnce();
    const stored = JSON.parse(await readFile(join(path, "registration.json"), "utf8"));
    expect(stored.accountId).toBe("account-a");
    expect(stored.accessToken).toBeUndefined();
    expect(stored.refreshToken).toBeUndefined();
  });
  it("does not retry an account registration under another logged-in account", async () => {
    const path = await directory();
    const first = setup(path, {
      registrationAccountId: "account-a",
      registerAccount: async () => {
        throw new Error("response lost");
      },
    });
    await expect(first.internal.register(1)).rejects.toThrow();
    await first.manager.stop();
    const registerAccount = vi.fn();
    const second = setup(path, { registrationAccountId: "account-b", registerAccount });
    await expect(second.internal.register(1)).rejects.toThrow("account_registration_pending");
    expect(registerAccount).not.toHaveBeenCalled();
  });
});
