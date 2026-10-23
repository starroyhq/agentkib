import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request, Server as TlsServer, type Server } from "node:https";
import { Transform, type Duplex } from "node:stream";
import { createServer as createTcpServer, connect, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
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
  directListeners: Map<
    string,
    { servers: Map<"control" | "preview", Server>; sockets: Set<Duplex> }
  >;
  children: Map<"control" | "preview", ChildProcess>;
  sockets: Set<Duplex>;
  authorize(generation: number): Promise<void>;
  register(generation: number): Promise<void>;
  ensureCertificate(generation: number): Promise<void>;
  startTls(channel: "control" | "preview", generation: number): Promise<void>;
  checkDirectAddresses(generation: number): Promise<void>;
  maintainDirect(generation: number): Promise<void>;
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

describe("authenticated direct TLS routes", () => {
  function isolatedPrivateListeners() {
    const original = TlsServer.prototype.listen;
    const bindings: string[] = [];
    // Exercise real TLS without exposing test endpoints on the developer's LAN.
    vi.spyOn(TlsServer.prototype, "listen").mockImplementation(function (
      this: TlsServer,
      ...args: Parameters<TlsServer["listen"]>
    ) {
      const options = args[0];
      if (options && typeof options === "object" && "host" in options) {
        bindings.push(String(options.host));
        return Reflect.apply(original, this, [{ ...options, host: "127.0.0.1" }, ...args.slice(1)]);
      }
      return Reflect.apply(original, this, args);
    });
    return bindings;
  }
  async function localTarget() {
    const server = createHttpServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: alive\n\n");
      } else {
        res.end(JSON.stringify({ cookie: req.headers.cookie, origin: req.headers.origin }));
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    stops.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    return { host: "127.0.0.1" as const, port: (server.address() as { port: number }).port };
  }
  function get(port: number, cert: string, host = registration.controlHost, sni = host) {
    return new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          servername: sni,
          ca: cert,
          agent: false,
          headers: { Host: host, Cookie: "ak_web_secure=paired", Origin: `https://${host}` },
        },
        (res) => {
          let body = "";
          res.on("data", (data) => {
            body += data;
          });
          res.on("end", () => done({ status: res.statusCode!, body }));
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      req.end();
    });
  }
  it("keeps HTTPS identity and credentials across both routes and rejects wrong host/SNI", async () => {
    const bindings = isolatedPrivateListeners();
    const { path, key, cert } = await certificate();
    const target = await localTarget();
    const { manager, internal } = setup(path, {
      target,
      preview: target,
      directAddresses: () => [
        "192.168.20.10",
        "192.168.20.10",
        "127.0.0.1",
        "0.0.0.0",
        "8.8.8.8",
        "192.168.020.10",
      ],
    });
    internal.key = key;
    internal.certificate = cert;
    await internal.startTls("control", 1);
    await internal.checkDirectAddresses(1);
    expect(bindings).toEqual(["192.168.20.10", "192.168.20.10"]);
    const direct = manager.directConnection!;
    expect(direct).toMatchObject({
      version: 1,
      controlOrigin: `https://${registration.controlHost}`,
      previewOrigin: `https://${registration.previewHost}`,
      candidates: [{ address: "192.168.20.10" }],
    });
    const candidate = direct.candidates[0];
    const expected = {
      status: 200,
      body: JSON.stringify({ cookie: "ak_web_secure=paired", origin: direct.controlOrigin }),
    };
    expect(await get(candidate.controlPort, cert)).toEqual(expected);
    expect(
      await get((internal.servers.get("control")!.address() as { port: number }).port, cert),
    ).toEqual(expected);
    expect((await get(candidate.previewPort, cert, registration.previewHost)).status).toBe(200);
    expect((await get(candidate.controlPort, cert, registration.previewHost)).status).toBe(421);
    expect(
      (await get(candidate.controlPort, cert, registration.controlHost, registration.previewHost))
        .status,
    ).toBe(421);
    internal.failClosed("revoked", false);
    expect(manager.directConnection).toBeUndefined();
    expect(internal.directListeners.size).toBe(0);
    expect(internal.sockets.size).toBe(0);
    await expect(get(candidate.controlPort, cert)).rejects.toThrow();
  });
  it("removes disappeared addresses and their active stream without closing the public route", async () => {
    isolatedPrivateListeners();
    const { path, key, cert } = await certificate();
    const target = await localTarget();
    let addresses = ["192.168.20.10"];
    const { manager, internal } = setup(path, {
      target,
      preview: target,
      directAddresses: () => addresses,
    });
    internal.key = key;
    internal.certificate = cert;
    await internal.startTls("control", 1);
    const publicPort = (internal.servers.get("control")!.address() as { port: number }).port;
    await internal.checkDirectAddresses(1);
    const oldPort = manager.directConnection!.candidates[0].controlPort;
    const streaming = deferred<void>(),
      closed = deferred<void>();
    const req = request(
      {
        hostname: "127.0.0.1",
        port: oldPort,
        servername: registration.controlHost,
        ca: cert,
        agent: false,
        path: "/stream",
        headers: { Host: registration.controlHost },
      },
      (res) => {
        res.on("data", () => streaming.resolve());
        res.on("close", () => closed.resolve());
        res.on("error", () => {});
      },
    );
    req.on("error", () => closed.resolve());
    req.end();
    await streaming.promise;
    addresses = ["10.0.1.5"];
    // Stale candidates are hidden even before the periodic reconciliation runs.
    expect(manager.directConnection).toBeUndefined();
    await internal.checkDirectAddresses(1);
    await closed.promise;
    expect(manager.directConnection!.candidates.map((c) => c.address)).toEqual(addresses);
    expect(internal.directListeners.has("192.168.20.10")).toBe(false);
    expect((await get(publicPort, cert)).status).toBe(200);
    await expect(get(oldPort, cert)).rejects.toThrow();
  });
  it("rechecks adapters every five seconds and closes direct routes on suspend", async () => {
    isolatedPrivateListeners();
    const { path, key, cert } = await certificate();
    let addresses: string[] = [];
    const { manager, internal } = setup(path, { directAddresses: () => addresses });
    internal.key = key;
    internal.certificate = cert;
    vi.useFakeTimers();
    await internal.maintainDirect(1);
    addresses = ["172.16.2.3"];
    await vi.advanceTimersByTimeAsync(4_999);
    expect(manager.directConnection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(manager.directConnection?.candidates).toHaveLength(1));
    await manager.suspend();
    expect(manager.directConnection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(internal.directListeners.size).toBe(0);
  });
  it("keeps a healthy LAN route when frpc fails and ignores a failed additional bind", async () => {
    const bindings = isolatedPrivateListeners();
    const { path, key, cert } = await certificate();
    const target = await localTarget();
    let addresses = ["192.168.20.10"];
    const { manager, internal } = setup(path, {
      target,
      preview: target,
      directAddresses: () => addresses,
    });
    internal.key = key;
    internal.certificate = cert;
    vi.spyOn(internal, "spawnFrpc").mockImplementation(() => {
      throw new Error("unreachable relay");
    });
    await internal.maintain(1);
    expect(manager.status.phase).toBe("offline");
    const port = manager.directConnection!.candidates[0].controlPort;
    expect((await get(port, cert)).status).toBe(200);
    addresses = ["192.168.20.10", "10.0.1.5"];
    vi.spyOn(TlsServer.prototype, "listen").mockImplementationOnce(function (this: TlsServer) {
      process.nextTick(() =>
        this.emit(
          "error",
          Object.assign(new Error("address unavailable"), { code: "EADDRNOTAVAIL" }),
        ),
      );
      return this;
    });
    await internal.checkDirectAddresses(1);
    expect(manager.directConnection!.candidates).toHaveLength(1);
    expect((await get(port, cert)).status).toBe(200);
    expect(bindings).toEqual(["192.168.20.10", "192.168.20.10"]);
    internal.failClosed("lease-expired", false);
    expect(internal.directListeners.size).toBe(0);
    expect(manager.directConnection).toBeUndefined();
  });
  it("does not publish a late binding after stop and never reopens it from the timer", async () => {
    const { path, key, cert } = await certificate();
    const { manager, internal } = setup(path, { directAddresses: () => ["192.168.20.10"] });
    internal.key = key;
    internal.certificate = cert;
    let completeBinding: (() => void) | undefined;
    vi.spyOn(TlsServer.prototype, "listen").mockImplementationOnce(function (
      this: TlsServer,
      ...args: Parameters<TlsServer["listen"]>
    ) {
      const callback = args[1];
      completeBinding = () => {
        if (typeof callback === "function") callback();
      };
      return this;
    });
    const pending = internal.maintainDirect(1);
    expect(internal.directListeners.size).toBe(1);
    await manager.stop();
    completeBinding?.();
    await pending;
    expect(internal.directListeners.size).toBe(0);
    expect(manager.directConnection).toBeUndefined();
    expect(internal.sockets.size).toBe(0);
  });
  it.each([false, true])(
    "hot-renews both LAN channels with public probes failing: %s",
    async (publicFailure) => {
      isolatedPrivateListeners();
      const { path, key, cert } = await certificate();
      const target = await localTarget();
      const { manager, internal } = setup(path, {
        target,
        preview: target,
        directAddresses: () => ["192.168.20.10"],
        createCsr: async () => ({
          csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----",
        }),
      });
      internal.key = key;
      internal.certificate = cert;
      const publicProbe = vi
        .spyOn(internal, "probe")
        .mockRejectedValue(new Error("public unreachable"));
      if (publicFailure) {
        vi.spyOn(internal, "spawnFrpc").mockImplementation((channel) =>
          internal.children.set(channel, {
            kill: vi.fn(),
            once: vi.fn(),
            exitCode: 0,
          } as unknown as ChildProcess),
        );
        // Establish the private route while both public probes remain unavailable.
        await internal.maintain(1);
        expect(manager.status.phase).toBe("offline");
      }
      await internal.checkDirectAddresses(1);
      const candidate = manager.directConnection!.candidates[0];
      execFileSync("openssl", [
        "req",
        "-new",
        "-x509",
        "-days",
        "3",
        "-set_serial",
        "42",
        "-key",
        join(path, "key.pem"),
        "-config",
        join(path, "req.conf"),
        "-out",
        join(path, "renewed.pem"),
      ]);
      const renewed = await readFile(join(path, "renewed.pem"), "utf8");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ certificate: renewed }))),
      );
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 36 * 3_600_000);
      internal.leaseUntil = performance.now() + 60_000;
      internal.wallLeaseUntil = Date.now() + 60_000;
      if (publicFailure) {
        await internal.maintain(1);
        await vi.waitFor(() => expect(internal.certificate).toBe(renewed));
        expect(publicProbe).toHaveBeenCalledTimes(4);
        expect(manager.status.phase).toBe("offline");
      } else {
        await internal.ensureCertificate(1);
      }
      expect(manager.directConnection!.candidates[0]).toEqual(candidate);
      for (const [port, host] of [
        [candidate.controlPort, registration.controlHost],
        [candidate.previewPort, registration.previewHost],
      ] as const) {
        const peer = await new Promise<string>((done, fail) => {
          const socket = connectTls(
            { host: "127.0.0.1", port, servername: host, ca: renewed },
            () => {
              done(socket.getPeerCertificate().fingerprint256);
              socket.destroy();
            },
          );
          socket.on("error", fail);
        });
        expect(peer).toBe(new X509Certificate(renewed).fingerprint256);
      }
    },
  );
});

describe("relay managed WebSocket transport", () => {
  async function fixture() {
    const { path, key, cert } = await certificate();
    const target = createHttpServer();
    const targetSockets = new Set<Duplex>();
    target.on("connection", (socket) => {
      targetSockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => targetSockets.delete(socket));
    });
    target.on("upgrade", (_req, socket) => {
      socket.on("end", () => socket.end());
      socket.resume();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    stops.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of targetSockets) socket.destroy();
          target.close(() => resolve());
        }),
    );
    const { manager, internal } = setup(path, {
      target: { host: "127.0.0.1", port: (target.address() as { port: number }).port },
      preview: { host: "127.0.0.1", port: (target.address() as { port: number }).port },
    });
    internal.key = key;
    internal.certificate = cert;
    await internal.startTls("control", 1);
    await internal.startTls("preview", 1);
    const open = async (
      options: {
        channel?: "control" | "preview";
        method?: string;
        path?: string;
        host?: string;
        sni?: string;
        head?: Buffer;
      } = {},
    ) => {
      const channel = options.channel ?? "control";
      const host = channel === "control" ? registration.controlHost : registration.previewHost;
      const socket = connectTls({
        host: "127.0.0.1",
        port: (internal.servers.get(channel)!.address() as { port: number }).port,
        servername: options.sni ?? host,
        ca: cert,
      });
      socket.on("error", () => {});
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      const headers = [
        `${options.method ?? "GET"} ${options.path ?? "/api/web/v1/socket"} HTTP/1.1`,
        `Host: ${options.host ?? host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Origin: https://${registration.controlHost}`,
        "Cookie: agentkib_pair=fixture-paired-device",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol: agentkib.fixture",
        "Forwarded: for=untrusted;proto=http",
        "X-Forwarded-Host: untrusted.example.org",
        "X-Forwarded-For: 192.0.2.1",
        "X-Forwarded-Proto: http",
      ];
      socket.write(
        Buffer.concat([
          Buffer.from(headers.join("\r\n") + "\r\n\r\n"),
          options.head ?? Buffer.alloc(0),
        ]),
      );
      return { socket, closed, bytes: () => Buffer.concat(chunks) };
    };
    const accept = (socket: Duplex, first = "") =>
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: agentkib.fixture\r\n\r\n" +
          first,
      );
    return { manager, internal, target, targetSockets, open, accept };
  }

  it("preserves authenticated handshake fields, both initial heads and streaming backpressure", async () => {
    const { target, open, accept } = await fixture();
    const received = deferred<Buffer>();
    const payload = Buffer.alloc(512 * 1024, "x");
    target.on("upgrade", (req, socket, head) => {
      expect(req.url).toBe("/api/web/v1/socket");
      expect(req.headers).toMatchObject({
        host: registration.controlHost,
        origin: `https://${registration.controlHost}`,
        cookie: "agentkib_pair=fixture-paired-device",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": "agentkib.fixture",
        "x-forwarded-proto": "https",
      });
      for (const header of ["forwarded", "x-forwarded-host", "x-forwarded-for"])
        expect(req.headers[header]).toBeUndefined();
      const chunks: Buffer[] = head.length ? [head] : [];
      let size = head.length;
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size === payload.length + 5) received.resolve(Buffer.concat(chunks));
      });
      accept(socket, "first-from-server");
      socket.write(payload);
    });
    const client = await open({ head: Buffer.from("first") });
    client.socket.pause();
    client.socket.write(payload);
    // Compare every byte natively: deep equality enumerates these large Buffers
    // twice and can consume the unchanged timeout before the socket resumes.
    expect((await received.promise).equals(Buffer.concat([Buffer.from("first"), payload]))).toBe(
      true,
    );
    client.socket.resume();
    await vi.waitFor(() =>
      expect(client.bytes().length).toBeGreaterThan(payload.length + "first-from-server".length),
    );
    const bytes = client.bytes();
    const boundary = bytes.indexOf("\r\n\r\n") + 4;
    expect(bytes.subarray(0, boundary).toString()).toContain("101 Switching Protocols");
    expect(bytes.subarray(0, boundary).toString()).toContain(
      "Sec-WebSocket-Protocol: agentkib.fixture",
    );
    expect(
      bytes.subarray(boundary).equals(Buffer.concat([Buffer.from("first-from-server"), payload])),
    ).toBe(true);
    client.socket.destroy();
  });

  it.each([
    { path: "/api/web/v1/managed/action" },
    { path: "/api/web/v1/socket?unexpected=1" },
    { path: "/api/web/v1/socket/" },
    { method: "POST" },
    { channel: "preview" as const },
    { host: registration.previewHost },
    { sni: registration.previewHost },
  ])("rejects a disallowed upgrade before contacting the local service: %j", async (options) => {
    const { target, open } = await fixture();
    const requested = vi.fn();
    target.on("upgrade", requested);
    target.on("request", requested);
    const client = await open(options);
    await client.closed;
    expect(client.bytes().length).toBe(0);
    expect(requested).not.toHaveBeenCalled();
  });

  it.each(["monotonic lease", "wall lease", "generation", "abort"])(
    "rejects an upgrade with a stale %s before dispatch",
    async (kind) => {
      const { target, open, internal } = await fixture();
      const requested = vi.fn();
      target.on("upgrade", requested);
      if (kind === "monotonic lease") internal.leaseUntil = 0;
      else if (kind === "wall lease") internal.wallLeaseUntil = 0;
      else if (kind === "generation") internal.generation++;
      else internal.abort.abort();
      const client = await open();
      await client.closed;
      expect(requested).not.toHaveBeenCalled();
    },
  );

  it.each(["monotonic lease", "wall lease", "generation"])(
    "rejects a late local 101 after %s changed",
    async (kind) => {
      const { target, open, accept, internal } = await fixture();
      const pending = deferred<Duplex>();
      target.on("upgrade", (_req, socket) => pending.resolve(socket));
      const client = await open();
      const upstream = await pending.promise;
      if (kind === "monotonic lease") internal.leaseUntil = 0;
      else if (kind === "wall lease") internal.wallLeaseUntil = 0;
      else internal.generation++;
      accept(upstream, "must not reach the browser");
      await client.closed;
      expect(client.bytes().length).toBe(0);
      await vi.waitFor(() => expect(upstream.destroyed).toBe(true));
    },
  );

  it.each(["revoked", "lease-expired", "stop"] as const)(
    "closes pending and upgraded connections together on %s",
    async (reason) => {
      const { target, open, accept, internal, manager, targetSockets } = await fixture();
      const pending = deferred<void>();
      let count = 0;
      target.on("upgrade", (_req, socket) => {
        if (++count === 1) accept(socket);
        else pending.resolve();
      });
      const upgraded = await open();
      await vi.waitFor(() => expect(upgraded.bytes().toString()).toContain("101"));
      const waiting = await open();
      await pending.promise;
      if (reason === "stop") await manager.stop();
      else internal.failClosed(reason, false);
      await Promise.all([upgraded.closed, waiting.closed]);
      expect(waiting.bytes().length).toBe(0);
      expect(internal.sockets.size).toBe(0);
      await vi.waitFor(() => expect(targetSockets.size).toBe(0));
    },
  );

  it("returns a local authorization rejection with intact chunks, cookies and trailers", async () => {
    const { target, open } = await fixture();
    target.on("upgrade", (_req, socket) => {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\nSet-Cookie: fixture-a=1\r\nSet-Cookie: fixture-b=2\r\nTrailer: X-Fixture\r\n\r\n6\r\ndenied\r\n0\r\nX-Fixture: rejected\r\n\r\n",
      );
    });
    const client = await open();
    await client.closed;
    const response = client.bytes().toString();
    expect(response).toContain("403 Forbidden");
    expect(response.toLowerCase()).toContain("set-cookie: fixture-a=1");
    expect(response.toLowerCase()).toContain("set-cookie: fixture-b=2");
    expect(response).toContain("\r\n6\r\ndenied\r\n0\r\nX-Fixture: rejected\r\n\r\n");
  });

  it.each([6, 2 * 1024 * 1024])(
    "flushes a %i-byte rejection and releases sockets despite unread early client data",
    async (size) => {
      const { target, open, internal } = await fixture();
      const payload = Buffer.alloc(size, "x");
      target.on("upgrade", (_req, socket) => {
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${size}\r\n\r\n`,
            ),
            payload,
          ]),
        );
      });
      const client = await open({ head: Buffer.alloc(512 * 1024, "x") });
      await client.closed;
      const bytes = client.bytes();
      const boundary = bytes.indexOf("\r\n\r\n") + 4;
      expect(bytes.subarray(0, boundary).toString()).toContain("403 Forbidden");
      expect(bytes.subarray(boundary).equals(payload)).toBe(true);
      await vi.waitFor(() => expect(internal.sockets.size).toBe(0));
    },
  );

  it("expires the handshake at ten seconds without retrying the request", async () => {
    const { target, open } = await fixture();
    const pending = deferred<void>();
    const upgraded = vi.fn(() => pending.resolve());
    target.on("upgrade", upgraded);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = await open();
    await pending.promise;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await client.closed;
    expect(client.bytes().length).toBe(0);
    expect(upgraded).toHaveBeenCalledOnce();
  });

  it.each(["client", "upstream"])("closes the opposite side when %s disconnects", async (side) => {
    const { target, open, accept, targetSockets } = await fixture();
    const accepted = deferred<Duplex>();
    target.on("upgrade", (_req, socket) => {
      accepted.resolve(socket);
      accept(socket);
    });
    const client = await open();
    const upstream = await accepted.promise;
    await vi.waitFor(() => expect(client.bytes().toString()).toContain("101"));
    if (side === "client") client.socket.destroy();
    else upstream.destroy();
    await client.closed;
    await vi.waitFor(() => expect(targetSockets.size).toBe(0));
  });

  it("closes the browser when the upstream resets before accepting", async () => {
    const { target, open } = await fixture();
    const requested = vi.fn((_req, socket: Duplex) => socket.destroy());
    target.on("upgrade", requested);
    const client = await open();
    await client.closed;
    expect(client.bytes().length).toBe(0);
    expect(requested).toHaveBeenCalledOnce();
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
        const timer = setInterval(
          () => res.write(`data: ${JSON.stringify({ seq: ++events, at: performance.now() })}\n\n`),
          40,
        );
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
    const relayEventLatency: number[] = [];
    const directEventLatency: number[] = [];
    const measure = (latencies: number[]) => {
      let pending = "";
      return (chunk: Buffer) => {
        pending += chunk.toString();
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = JSON.parse(frame.slice(6)) as { at: number };
          latencies.push(performance.now() - data.at);
        }
      };
    };
    const sse = request(options("control", "/events"), (response) => {
      response.on("data", () => eventCount++);
      response.on("data", measure(relayEventLatency));
      response.on("error", () => {});
    });
    sse.on("error", () => {});
    sse.end();
    const direct = httpRequest(
      { hostname: "127.0.0.1", port: portOf(control), path: "/events", agent: false },
      (response) => {
        response.on("data", measure(directEventLatency));
        response.on("error", () => {});
      },
    );
    direct.on("error", () => {});
    direct.end();
    stops.unshift(async () => {
      sse.destroy();
      direct.destroy();
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
    const p95 = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    expect(relayEventLatency.length).toBeGreaterThan(10);
    expect(directEventLatency.length).toBeGreaterThan(10);
    expect(p95(relayEventLatency)).toBeLessThan(150);
    expect(p95(directEventLatency)).toBeLessThan(150);
    if (process.env.AGENTKIB_RELAY_FAULT_REPORT)
      await writeFile(
        process.env.AGENTKIB_RELAY_FAULT_REPORT,
        JSON.stringify({
          delayPerMediaChunkMs: 80,
          controlRequests: commands,
          maximumControlLatencyMs: Math.ceil(Math.max(...latencies)),
          sseEvents: eventCount,
          directHttpSseP95Ms: p95(directEventLatency),
          localTlsRelaySseP95Ms: p95(relayEventLatency),
          sseSamples: { direct: directEventLatency.length, relay: relayEventLatency.length },
          environment: `${process.platform}/${process.arch} ${process.version}; loopback fixture, not a physical LAN or public relay`,
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
