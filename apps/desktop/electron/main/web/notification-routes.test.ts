// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationPolicyStore } from "../push/policy";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { WebAccessService } from "./service";

describe("paired notification policy and activity", () => {
  let directory: string;
  let origin: string;
  let service: WebAccessService;
  let policy: NotificationPolicyStore;
  let orchestrationUnavailable: boolean;
  const workspaces = () =>
    ["visible", "hidden"].map((id) => ({
      id,
      name: id,
      path: join(directory, id),
    }));
  const sessions = [
    { id: "private", workspace_id: "hidden", status: "awaiting-approval" },
    { id: "question", workspace_id: "visible", status: "waiting-input" },
    { id: "running", workspace_id: "visible", status: "running" },
  ].map(({ status, ...entry }) => ({
    ...entry,
    title: entry.id,
    agent: "codex",
    availability: "readable",
    updated_at: "2026-11-24T10:00:00.000Z",
    continuation: { status },
  }));

  async function browser(access?: "full" | "read" | "scoped") {
    const base = origin + "/api/web/v1";
    const bootstrap = await fetch(base + "/access");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await bootstrap.json();
    const request = async (path: string, body?: unknown, csrf = csrfToken) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrf,
          "X-AgentKib-Protocol": "2",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    let deviceId: string | undefined;
    if (access === "scoped") {
      deviceId = await approveLegacyBrowser(service, cookie, { files: true });
    } else if (access) {
      const code = (await service.request({ operation: "generate-code", access })).code!.value;
      const paired = await request("/pair", { name: "Fake phone", code });
      expect(paired.body.status).toBe("approved");
      deviceId = paired.body.device.id;
    }
    return { request, deviceId };
  }

  beforeEach(async () => {
    orchestrationUnavailable = false;
    directory = await mkdtemp(join(tmpdir(), "agentkib-notification-routes-"));
    await Promise.all(workspaces().map(({ path }) => mkdir(path)));
    policy = new NotificationPolicyStore(directory);
    await policy.initialize();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      notificationPolicy: policy,
      runtimeRequest: async () => ({
        sessions,
        workspaces: workspaces(),
        ...(orchestrationUnavailable && { orchestrationUnavailable: true }),
      }),
      workspaceRequest: async () => workspaces(),
      verifiedExperimental: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["visible"],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("shares a private host policy with desktop and fully authorized devices", async () => {
    const guest = await browser();
    expect((await guest.request("/access")).body).not.toHaveProperty("pushPolicyVersion");
    expect((await guest.request("/push/policy")).status).toBe(401);
    const full = await browser("full");
    expect((await full.request("/access")).body).toMatchObject({
      pushPolicyVersion: 1,
      pushActivityVersion: 1,
    });
    const patch = {
      categories: { completed: false },
      quietHours: { start: "22:00", end: "08:00" },
    };
    expect((await full.request("/push/policy", patch, "fake-csrf")).status).toBe(403);
    const updated = await full.request("/push/policy", patch);
    expect(updated).toMatchObject({ status: 200, body: { policy: patch } });
    expect(await service.localRequest("/push/policy")).toEqual(updated);
    const read = await browser("read");
    expect(await read.request("/push/policy")).toEqual(updated);
    expect((await read.request("/push/policy", { enabled: false })).status).toBe(403);
    expect(
      (await full.request("/push/policy", { quietHours: { start: "bad", end: "08:00" } })).status,
    ).toBe(400);
    expect(await full.request("/push/policy")).toEqual(updated);
  });

  it("rechecks the device immediately before committing a pending policy write", async () => {
    const phone = await browser("full");
    const update = policy.update.bind(policy);
    vi.spyOn(policy, "update").mockImplementationOnce(async (patch, authorize) => {
      await service.request({ operation: "revoke", id: phone.deviceId! });
      return update(patch, authorize);
    });
    expect((await phone.request("/push/policy", { enabled: false })).status).toBe(401);
    expect(policy.read().enabled).toBe(true);
  });

  it("negotiates Worker result settings and preserves them across an old phone's update", async () => {
    const guest = await browser();
    const endpoint = "/access?pushPolicyVersion=2";
    expect((await guest.request(endpoint)).body).not.toHaveProperty("pushPolicyVersion");
    const phone = await browser("full");
    expect((await phone.request("/access")).body.pushPolicyVersion).toBe(1);
    expect((await phone.request(endpoint)).body.pushPolicyVersion).toBe(2);
    expect((await service.localRequest(endpoint)).body).toMatchObject({ pushPolicyVersion: 2 });
    expect((await phone.request("/push/policy")).body.policy.workerResults).toBe(false);
    expect(await phone.request("/push/policy", { workerResults: true })).toMatchObject({
      status: 200,
      body: { policy: { workerResults: true } },
    });
    expect(await phone.request("/push/policy", { categories: { failed: false } })).toMatchObject({
      status: 200,
      body: { policy: { workerResults: true, categories: { failed: false } } },
    });
  });

  it("projects and versions only currently authorized activity after reconnect", async () => {
    const scoped = await browser("scoped");
    const single = await scoped.request("/push/activity");
    expect(single).toMatchObject({
      status: 200,
      body: {
        activity: {
          version: expect.any(String),
          waiting: 1,
          running: 1,
          priority: { sessionId: "question", agent: "codex", category: "question", count: 1 },
        },
      },
    });
    expect(JSON.stringify(single)).not.toContain("private");
    expect((await scoped.request("/push/activity")).body.activity.version).toBe(
      single.body.activity.version,
    );
    const full = await browser("full");
    const all = await full.request("/push/activity");
    expect(all.body.activity).toMatchObject({ waiting: 2, priority: { sessionId: "private" } });
    expect(all.body.activity.version).not.toBe(single.body.activity.version);
    await service.request({ operation: "revoke", id: scoped.deviceId! });
    expect((await scoped.request("/push/activity")).status).toBe(401);
  });

  it("omits activity when the runtime cannot confirm the catalog's Worker roles", async () => {
    const phone = await browser("full");
    orchestrationUnavailable = true;
    expect(await phone.request("/push/activity")).toMatchObject({
      status: 200,
      body: { activity: { waiting: 0, running: 0 } },
    });
    expect((await phone.request("/catalog")).body).not.toHaveProperty("orchestrationUnavailable");
    expect((await service.localRequest("/catalog")).body).toHaveProperty(
      "orchestrationUnavailable",
      true,
    );
  });
});
