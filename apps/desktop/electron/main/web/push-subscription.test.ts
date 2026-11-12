// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { RelayManager, type RemoteAccountBinding } from "./relay/manager";
import type { Access } from "@agentkib/web-client";

let directory: string, service: WebAccessService, relay: RelayManager, origin: string;
let cookie = "",
  csrf = "";
const binding: RemoteAccountBinding = {
  id: "c".repeat(32),
  accountId: "owner",
  sessionId: "a".repeat(36),
  expiresAt: Date.now() + 86_400_000,
};
const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x!;
const subscription = { publicKey, ref: "phone-ref-1", alerts: true, liveActivity: true };

async function request<T = Record<string, unknown>>(path: string, body?: unknown) {
  const response = await fetch(origin + "/api/web/v1/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-AgentKib-Protocol": "2",
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { status: response.status, data: (await response.json()) as T };
}
async function access() {
  const result = await request<Access>("access");
  csrf = result.data.csrfToken;
  return result;
}
function useRelay(accountContext: boolean) {
  const state = service as unknown as {
    config: { relay?: { enabled: boolean; brokerUrl: string } };
    relay: RelayManager;
  };
  state.config.relay = { enabled: true, brokerUrl: "https://relay.example.test" };
  state.relay = relay;
  vi.spyOn(relay, "accountLoginContext", "get").mockReturnValue(
    accountContext ? { accountId: "owner", deviceId: "d".repeat(32) } : undefined,
  );
}
/** A phone paired with a code and bound to its account login, as the phone app does. */
async function pairBoundPhone() {
  useRelay(true);
  const initial = await access();
  vi.spyOn(relay, "redeemAccountLogin").mockResolvedValue(binding);
  vi.spyOn(relay, "verifyAccountLogins").mockResolvedValue([
    { id: binding.id, active: true, expiresAt: binding.expiresAt },
  ]);
  expect(
    (
      await request("account-binding", {
        code: "p".repeat(43),
        codeVerifier: "v".repeat(43),
        hostChallenge: initial.data.accountLogin!.challenge,
        redemptionId: "r".repeat(43),
      })
    ).data,
  ).toEqual({ bound: true });
  const code = (await service.request({ operation: "generate-code", access: "read" })).code!.value;
  expect((await request("pair", { name: "Synthetic phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentkib-push-subscription-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("fixture_port");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  service = new WebAccessService({
    dataDir: directory,
    staticDir: directory,
    runtimeRequest: async () => ({ workspaces: [], sessions: [] }),
  });
  await service.initialize();
  await service.request({
    operation: "configure",
    enabled: true,
    port,
    externalOrigin: "",
    experimentalEnabled: true,
  });
  relay = new RelayManager({
    stateDirectory: directory,
    brokerUrl: "https://relay.example.test",
    frpcPath: "/synthetic/frpc",
    target: { host: "127.0.0.1", port },
    preview: { host: "127.0.0.1", port },
  });
  cookie = "";
  csrf = "";
});
afterEach(async () => {
  await service.shutdown();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("lets an account-bound phone subscribe, keeps it with the pairing, and lets it stop", async () => {
  await pairBoundPhone();
  expect((await access()).data.push).toEqual({ version: 1, subscribed: false });
  expect(service.pushTargets()).toEqual([]);
  const changed = vi.fn();
  service.onPushChanged(changed);

  for (const body of [
    { ...subscription, publicKey: "short" },
    { ...subscription, ref: "bad ref" },
    { ...subscription, alerts: "yes" },
    { ...subscription, extra: true },
  ])
    expect((await request("push/subscribe", body)).data).toEqual({
      error: "invalid_push_subscription",
    });
  expect((await request("push/subscribe", subscription)).data).toEqual({ subscribed: true });
  expect(changed).toHaveBeenCalledOnce();
  expect((await access()).data.push).toEqual({
    version: 1,
    subscribed: true,
    alerts: true,
    liveActivity: true,
  });
  const [target] = service.pushTargets();
  expect(target).toEqual({
    session: binding.sessionId,
    ...subscription,
    updatedAt: expect.any(Number),
  });
  const saved = JSON.parse(await readFile(join(directory, "web-access.json"), "utf8"));
  expect(saved.credentials[0].push).toMatchObject(subscription);

  // The app subscribes on every launch; the same choices change nothing.
  expect((await request("push/subscribe", subscription)).status).toBe(200);
  expect(changed).toHaveBeenCalledOnce();
  expect(service.pushTargets()[0].updatedAt).toBe(target.updatedAt);
  expect((await request("push/subscribe", { ...subscription, liveActivity: false })).status).toBe(
    200,
  );
  expect(changed).toHaveBeenCalledTimes(2);
  expect(service.pushTargets()[0].liveActivity).toBe(false);

  expect((await request("push/unsubscribe", {})).data).toEqual({ subscribed: false });
  expect(changed).toHaveBeenCalledTimes(3);
  expect(service.pushTargets()).toEqual([]);
  expect((await access()).data.push).toEqual({ version: 1, subscribed: false });
});

it("sends through the relay as this computer, and never from the LAN service", async () => {
  await pairBoundPhone();
  expect(service.pushDeviceId()).toBe("d".repeat(32));
  const send = vi.spyOn(relay, "pushSend").mockResolvedValue({ delivered: true });
  const input = { session: binding.sessionId, kind: "alert" as const, envelope: "e".repeat(64) };
  expect(await service.pushSend(input)).toEqual({ delivered: true });
  expect(send).toHaveBeenCalledExactlyOnceWith(input);

  const lan = new WebAccessService({
    dataDir: join(directory, "lan"),
    staticDir: "",
    mode: "lan",
    runtimeRequest: async () => ({ workspaces: [], sessions: [] }),
  });
  expect(lan.pushDeviceId()).toBeUndefined();
  expect(await lan.pushSend(input)).toEqual({ delivered: false, error: "relay_unavailable" });
  expect(lan.pushTargets()).toEqual([]);
});

it("offers nothing to a pairing that is not bound to the computer's account", async () => {
  useRelay(false);
  await access();
  const code = (await service.request({ operation: "generate-code", access: "full" })).code!.value;
  expect((await request("pair", { name: "Independent phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
  expect((await access()).data.push).toBeUndefined();
  expect((await request("push/subscribe", subscription)).data).toEqual({
    error: "push_unavailable",
  });
  expect(service.pushTargets()).toEqual([]);
});

it("stops notifying a phone whose account login ended", async () => {
  await pairBoundPhone();
  await request("push/subscribe", subscription);
  expect(service.pushTargets()).toHaveLength(1);
  vi.spyOn(relay, "verifyAccountLogins").mockResolvedValue([{ id: binding.id, active: false }]);
  await service.checkAccountBindings();
  expect(service.pushTargets()).toEqual([]);
});
