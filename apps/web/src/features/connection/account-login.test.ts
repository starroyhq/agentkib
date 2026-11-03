import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import type { Access } from "@agentkib/web-client";

const computer = "d".repeat(32);
const origin = `https://${computer}.control.remote.agentkib.com`;
const access: Access = {
  status: "unpaired",
  csrfToken: "csrf",
  bootId: "synthetic",
  protocolVersion: 2,
  experimentalEnabled: false,
  accountLogin: {
    required: true,
    proofVersion: 1,
    deviceId: computer,
    challenge: "h".repeat(43),
    bound: false,
  },
};
let page: {
  origin: string;
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
};
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  page = {
    origin,
    protocol: "https:",
    hostname: new URL(origin).hostname,
    pathname: "/",
    search: "",
    hash: "#/pair",
  };
  vi.stubGlobal("location", page);
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses account-site PKCE and submits only the one-use device proof to the computer", async () => {
  const api = await import("./account-login");
  const url = new URL(await api.beginComputerAccountLogin(access));
  expect(url.origin).toBe("https://account.agentkib.com");
  const params = new URLSearchParams(url.hash.slice("#/device?".length));
  expect([...params.keys()].sort()).toEqual([
    "codeChallenge",
    "deviceId",
    "hostChallenge",
    "state",
  ]);
  page.hash = `#/account-callback?${new URLSearchParams({ code: "p".repeat(43), state: params.get("state")! })}`;
  const fetcher = vi.fn<typeof fetch>(async (_url, request) =>
    Response.json(request?.method === "POST" ? { bound: true } : access),
  );
  vi.stubGlobal("fetch", fetcher);
  await api.finishComputerAccountLogin();
  const post = fetcher.mock.calls.find(([, request]) => request?.method === "POST")!;
  const body = JSON.parse(post[1]!.body as string) as Record<string, string>;
  expect(post[0]).toBe("/api/web/v1/account-binding");
  expect(Object.keys(body).sort()).toEqual([
    "code",
    "codeVerifier",
    "hostChallenge",
    "redemptionId",
  ]);
  expect(createHash("sha256").update(body.codeVerifier).digest("base64url")).toBe(
    params.get("codeChallenge"),
  );
  expect(body.hostChallenge).toBe(access.accountLogin!.challenge);
  expect(sessionStorage.length).toBe(0);
  expect(history.replaceState).toHaveBeenCalledWith(null, "", "/#/account-callback");
});

it.each([
  `https://${computer}.untrusted.example`,
  `${origin}:8443`,
  `https://${"e".repeat(32)}.control.remote.agentkib.com`,
])("rejects a relayed login challenge from an untrusted origin: %s", async (untrusted) => {
  const api = await import("./account-login");
  page.origin = untrusted;
  page.hostname = new URL(untrusted).hostname;
  await expect(api.beginComputerAccountLogin(access)).rejects.toThrow("account_login_unavailable");
  expect(sessionStorage.length).toBe(0);
});

it("does not replay an unconfirmed proof across remount or reload and permits only readback recovery", async () => {
  const api = await import("./account-login");
  const url = new URL(await api.beginComputerAccountLogin(access));
  const params = new URLSearchParams(url.hash.split("?")[1]);
  page.hash = `#/account-callback?code=${"p".repeat(43)}&state=${params.get("state")}`;
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, request) => {
      if (request?.method === "POST") {
        writes++;
        throw new Error("response lost");
      }
      return Response.json({
        ...access,
        accountLogin: { ...access.accountLogin!, bound: writes > 0 },
      });
    }),
  );
  await expect(api.finishComputerAccountLogin()).rejects.toThrow();
  await expect(api.finishComputerAccountLogin()).rejects.toThrow();
  expect(writes).toBe(1);
  expect(await api.computerAccountLoginBound()).toBe(true);
  expect(writes).toBe(1);
  vi.resetModules();
  await expect((await import("./account-login")).finishComputerAccountLogin()).rejects.toThrow();
  expect(writes).toBe(1);
});

it("rejects callback state, target and host-challenge changes before submitting any proof", async () => {
  const api = await import("./account-login");
  const url = new URL(await api.beginComputerAccountLogin(access));
  const params = new URLSearchParams(url.hash.split("?")[1]);
  page.hash = `#/account-callback?code=${"p".repeat(43)}&state=wrong`;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(access));
  vi.stubGlobal("fetch", fetcher);
  await expect(api.finishComputerAccountLogin()).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  vi.resetModules();
  page.hash = `#/account-callback?code=${"p".repeat(43)}&state=${params.get("state")}`;
  fetcher.mockResolvedValueOnce(
    Response.json({
      ...access,
      accountLogin: { ...access.accountLogin!, challenge: "x".repeat(43) },
    }),
  );
  await expect((await import("./account-login")).finishComputerAccountLogin()).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
});
