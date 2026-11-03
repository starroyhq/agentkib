// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { RelayManager, type RemoteAccountBinding } from "./relay/manager";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
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
function requireCloud() {
  const state = service as unknown as {
    config: { relay?: { enabled: boolean; brokerUrl: string } };
    relay: RelayManager;
  };
  state.config.relay = { enabled: true, brokerUrl: "https://relay.example.test" };
  state.relay = relay;
  vi.spyOn(relay, "accountLoginContext", "get").mockReturnValue({
    accountId: "owner",
    deviceId: "d".repeat(32),
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentkib-cloud-login-"));
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
    // The production desktop supplies this bridge even for independent relays.
    account: {
      signedIn: () => false,
      accountId: () => undefined,
      ensureDeviceOwner: async () => undefined,
      registerDevice: async () => {
        throw new Error("account_unavailable");
      },
    },
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

it("requires both a verified cloud login and the eight-digit pairing authority", async () => {
  requireCloud();
  const initial = await access();
  expect(initial.data.accountLogin).toMatchObject({
    required: true,
    bound: false,
    proofVersion: 1,
  });
  expect(initial.data.accountLogin?.accountId).toBeUndefined();
  const code = (await service.request({ operation: "generate-code", access: "full" })).code!.value;
  expect((await request("pair", { name: "Synthetic phone", code })).data.error).toBe(
    "account_login_required",
  );
  expect((await request("account-binding", { sessionId: binding.sessionId })).status).toBe(400);
  const redeem = vi.spyOn(relay, "redeemAccountLogin").mockResolvedValue(binding);
  vi.spyOn(relay, "verifyAccountLogins").mockResolvedValue([
    { id: binding.id, active: true, expiresAt: binding.expiresAt },
  ]);
  const proof = {
    code: "p".repeat(43),
    codeVerifier: "v".repeat(43),
    hostChallenge: initial.data.accountLogin!.challenge,
    redemptionId: "r".repeat(43),
  };
  expect(
    (await request("account-binding", { ...proof, hostChallenge: "x".repeat(43) })).status,
  ).toBe(400);
  expect(redeem).not.toHaveBeenCalled();
  expect((await request("account-binding", proof)).data).toEqual({ bound: true });
  const loggedIn = await access();
  expect(loggedIn.data.status).toBe("unpaired");
  expect(loggedIn.data.accountLogin?.bound).toBe(true);
  expect((await request("catalog")).status).toBe(401);
  expect((await request("pair", { name: "Synthetic phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
  expect((await request("catalog")).status).toBe(200);
  expect(redeem).toHaveBeenCalledExactlyOnceWith(proof);
});

it("keeps an independent non-account relay usable with the desktop account bridge present", async () => {
  const state = service as unknown as {
    config: { relay?: { enabled: boolean; brokerUrl: string } };
    relay: RelayManager;
  };
  state.config.relay = { enabled: true, brokerUrl: "https://relay.example.test" };
  state.relay = relay;
  const redeem = vi.spyOn(relay, "redeemAccountLogin");
  expect((await access()).data.accountLogin).toBeUndefined();
  const code = (await service.request({ operation: "generate-code", access: "full" })).code!.value;
  expect((await request("pair", { name: "Independent phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
  expect((await request("catalog")).status).toBe(200);
  expect(redeem).not.toHaveBeenCalled();
});

it("upgrades a paired browser without replaying pairing, and keeps authorization on a cloud verification outage", async () => {
  await access();
  await approveLegacyBrowser(service, cookie);
  requireCloud();
  const initial = await access();
  expect(initial.data.status).toBe("unpaired");
  expect(initial.data.device).toBeUndefined();
  expect((await request("catalog")).data.error).toBe("account_login_required");
  vi.spyOn(relay, "redeemAccountLogin").mockResolvedValue(binding);
  const verify = vi
    .spyOn(relay, "verifyAccountLogins")
    .mockRejectedValue(new Error("temporarily unavailable"));
  await request("account-binding", {
    code: "p".repeat(43),
    codeVerifier: "v".repeat(43),
    hostChallenge: initial.data.accountLogin!.challenge,
    redemptionId: "r".repeat(43),
  });
  expect((await access()).data.status).toBe("approved");
  await service.checkAccountBindings();
  expect((await request("catalog")).status).toBe(200);
  verify.mockResolvedValueOnce([{ id: binding.id, active: false }]);
  await service.checkAccountBindings();
  expect((await access()).data.status).toBe("ended");
  expect((await request("catalog")).status).toBe(401);
});
