import { WebClient, type Access } from "@agentkib/web-client";

const KEY = "agentkib.remote.login.v1";
const ACCOUNT_ORIGIN = "https://account.agentkib.com";
const computerOrigin = (deviceId: string) => `https://${deviceId}.control.remote.agentkib.com`;
const token = () => {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
type PendingLogin = {
  version: 1;
  origin: string;
  deviceId: string;
  hostChallenge: string;
  state: string;
  verifier: string;
  redemptionId: string;
  expiresAt: number;
};

export async function beginComputerAccountLogin(access: Access): Promise<string> {
  const login = access.accountLogin;
  if (
    !login ||
    login.required !== true ||
    login.proofVersion !== 1 ||
    location.protocol !== "https:" ||
    !/^[a-f0-9]{32}$/.test(login.deviceId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(login.challenge) ||
    location.origin !== computerOrigin(login.deviceId)
  )
    throw new Error("account_login_unavailable");
  const pending: PendingLogin = {
    version: 1,
    origin: location.origin,
    deviceId: login.deviceId,
    hostChallenge: login.challenge,
    state: token(),
    verifier: token(),
    redemptionId: token(),
    expiresAt: Date.now() + 15 * 60_000,
  };
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier)),
  );
  const codeChallenge = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  // Only the short-lived PKCE attempt survives this tab's account-site round trip.
  sessionStorage.setItem(KEY, JSON.stringify(pending));
  return `${ACCOUNT_ORIGIN}/#/device?${new URLSearchParams({ deviceId: pending.deviceId, hostChallenge: pending.hostChallenge, state: pending.state, codeChallenge })}`;
}

let completion: Promise<void> | undefined;
export function finishComputerAccountLogin(): Promise<void> {
  // StrictMode/remount must not submit a second one-use proof.
  return (completion ??= finish());
}
async function finish() {
  const prefix = "#/account-callback?";
  if (!location.hash.startsWith(prefix)) throw new Error("invalid_account_callback");
  const params = new URLSearchParams(location.hash.slice(prefix.length));
  const raw = sessionStorage.getItem(KEY);
  const pending = raw ? (JSON.parse(raw) as PendingLogin) : undefined;
  if (
    !pending ||
    pending.version !== 1 ||
    pending.origin !== location.origin ||
    pending.origin !== computerOrigin(pending.deviceId) ||
    pending.expiresAt <= Date.now() ||
    !Number.isSafeInteger(pending.expiresAt) ||
    !/^[a-f0-9]{32}$/.test(pending.deviceId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) ||
    !/^[A-Za-z0-9_-]{43}$/.test(pending.hostChallenge) ||
    !/^[A-Za-z0-9_-]{43}$/.test(pending.redemptionId) ||
    params.getAll("code").length !== 1 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(params.get("code") ?? "") ||
    params.getAll("state").length !== 1 ||
    params.get("state") !== pending.state ||
    [...params.keys()].some((key) => !["code", "state"].includes(key))
  )
    throw new Error("invalid_account_callback");
  const code = params.get("code")!;
  sessionStorage.removeItem(KEY);
  history.replaceState(
    history.state,
    "",
    location.pathname + location.search + "#/account-callback",
  );
  const client = new WebClient();
  const access = await client.access();
  if (
    access.accountLogin?.deviceId !== pending.deviceId ||
    access.accountLogin.challenge !== pending.hostChallenge
  )
    throw new Error("invalid_account_callback");
  await client.request("account-binding", {
    code,
    codeVerifier: pending.verifier,
    hostChallenge: pending.hostChallenge,
    redemptionId: pending.redemptionId,
  });
}

/** Read back after an unknown result; never resend the proof or pairing operation. */
export async function computerAccountLoginBound(): Promise<boolean> {
  return (await new WebClient().access()).accountLogin?.bound === true;
}
