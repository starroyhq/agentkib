import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopAccountProfile, DesktopAccountRequest, DesktopAccountStatus } from "./state";
import { normalizeComputerName } from "./computer-name";

export const ACCOUNT_ORIGIN = "https://account.agentkib.com";
export const ACCOUNT_API = "https://api.agentkib.com";
type Identity = {
  deviceId: string;
  credential: string;
  accountId?: string;
  accountClaimPending?: boolean;
  accountClaimAccountId?: string;
};
type Options = {
  directory: string;
  storage: { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
  openExternal(url: string): Promise<unknown>;
  pauseRemote(): Promise<unknown>;
  identity(): Promise<Identity | undefined>;
  bindIdentity(accountId: string): Promise<void>;
  prepareIdentityClaim(accountId: string): Promise<void>;
  onStatus?(status: DesktopAccountStatus): void;
  /** The computer's display name, sent as the account device name. Failures never block registration. */
  computerName?(): Promise<string | undefined>;
  fetch?: typeof fetch;
};
type TokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  account: DesktopAccountProfile;
};

/** Account credentials never enter renderer IPC or the device control API. */
export class DesktopAccountService {
  private profile?: DesktopAccountProfile;
  private access?: { value: string; until: number };
  private phase: DesktopAccountStatus["phase"] = "signed-out";
  private error?: string;
  private server?: Server;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshWork?: Promise<string>;
  private profileReadAt = 0;
  private loggingOut = false;
  private nameWork?: Promise<string | undefined>;
  /** The name the account shows for this computer, as last reported by the broker. */
  private knownName?: { deviceId: string; name: string };
  /** `accountId:deviceId` already checked for a missing name in this process. */
  private nameChecked?: string;
  constructor(private readonly options: Options) {}
  private get tokenFile() {
    return join(this.options.directory, "refresh.enc");
  }
  private get rotationFile() {
    return join(this.options.directory, "rotation-pending");
  }
  private async atomic(file: string, value: Buffer | string) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await writeFile(file + ".tmp", value, { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  async initialize() {
    try {
      await readFile(this.rotationFile);
      await this.clearCredentials();
      this.error = "account_login_required";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await this.accessToken();
        this.backfillNameInBackground();
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT")
          this.error = "account_login_required";
      }
    }
    await this.publish();
  }
  async status(): Promise<DesktopAccountStatus> {
    const identity = await this.options.identity();
    return {
      phase: this.phase,
      secureStorage: this.options.storage.available(),
      ...(this.profile ? { account: { ...this.profile } } : {}),
      ...(identity
        ? {
            device: {
              deviceId: identity.deviceId,
              ownership: !identity.accountId
                ? "unclaimed"
                : identity.accountId === this.profile?.id
                  ? "owned"
                  : "other",
              ...(identity.accountId &&
              identity.accountId === this.profile?.id &&
              this.knownName?.deviceId === identity.deviceId
                ? { name: this.knownName.name }
                : {}),
            } as const,
          }
        : {}),
      ...(this.error || identity?.accountClaimPending
        ? { error: this.error ?? "account_claim_pending" }
        : {}),
    };
  }
  private async publish() {
    const state = await this.status();
    this.options.onStatus?.(state);
    return state;
  }
  request(input: DesktopAccountRequest): Promise<DesktopAccountStatus> {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "operation") ||
      !["status", "login", "cancel-login", "logout", "claim", "manage"].includes(input.operation)
    )
      return Promise.reject(new Error("invalid_account_request"));
    const work = this.queue.then(async () => {
      if (input.operation !== "status") this.error = undefined;
      try {
        if (
          input.operation === "status" &&
          this.profile &&
          Date.now() - this.profileReadAt > 30_000
        )
          await this.refreshProfile();
        if (input.operation === "login") await this.login();
        if (input.operation === "cancel-login") {
          this.cancelLogin();
          this.phase = this.profile ? "signed-in" : "signed-out";
        }
        if (input.operation === "logout") await this.logout();
        if (input.operation === "manage") await this.options.openExternal(ACCOUNT_ORIGIN);
        if (input.operation === "claim") await this.claim();
      } catch (error) {
        this.error = error instanceof AccountError ? error.code : "account_request_failed";
      }
      return this.publish();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  private async api(
    path: string,
    body?: object,
    token?: string,
    method = body ? "POST" : "GET",
  ): Promise<unknown> {
    try {
      const response = await (this.options.fetch ?? fetch)(new URL(path, ACCOUNT_API), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        if (response.status === 401 && token && token === this.access?.value && !this.refreshWork) {
          // A definitive rejection invalidates cached login state as well as the token file.
          // Do not clear a newer credential because an older in-flight request failed.
          await this.clearCredentials();
          this.error = "account_login_required";
          await this.publish();
        }
        let code: unknown;
        if (response.status === 409 || response.status === 400) {
          try {
            code = ((await this.readResponse(response)) as { error?: unknown })?.error;
          } catch {
            /* Unrecognized/malformed error bodies keep the generic status mapping. */
          }
        } else {
          void response.body?.cancel().catch(() => undefined);
        }
        // Only recognized categories reach IPC, never arbitrary server error text.
        throw new AccountError(
          response.status === 400 && code === "invalid_name"
            ? "account_invalid_name"
            : response.status === 401
              ? "account_login_required"
              : response.status === 403
                ? "account_forbidden"
                : response.status === 409
                  ? code === "device_limit_reached"
                    ? "account_device_limit"
                    : code === "name_already_set"
                      ? "account_name_already_set"
                      : "account_device_conflict"
                  : response.status === 429
                    ? "account_rate_limited"
                    : "account_request_failed",
        );
      }
      return await this.readResponse(response);
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError("account_connection_failed");
    }
  }
  private async readResponse(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65_536) throw new Error("oversized");
        chunks.push(chunk.value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private validateTokens(value: unknown): TokenResponse {
    const data = value as TokenResponse;
    if (
      !data ||
      typeof data.accessToken !== "string" ||
      typeof data.refreshToken !== "string" ||
      data.accessToken.length < 32 ||
      data.refreshToken.length < 32 ||
      data.accessToken.length > 2048 ||
      data.refreshToken.length > 2048 ||
      !Number.isFinite(data.expiresIn) ||
      data.expiresIn <= 0 ||
      data.expiresIn > 600 ||
      !data.account ||
      typeof data.account.id !== "string" ||
      typeof data.account.username !== "string" ||
      !Number.isInteger(data.account.deviceLimit) ||
      !Number.isInteger(data.account.deviceCount) ||
      typeof data.account.totpEnabled !== "boolean"
    )
      throw new AccountError("account_response_invalid");
    return data;
  }
  private async acceptTokens(value: unknown) {
    const tokens = this.validateTokens(value);
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    await this.atomic(this.tokenFile, this.options.storage.encrypt(tokens.refreshToken));
    await rm(this.rotationFile, { force: true });
    this.access = {
      value: tokens.accessToken,
      until: Date.now() + tokens.expiresIn * 1000 - 30_000,
    };
    this.profile = {
      id: tokens.account.id,
      username: tokens.account.username,
      status: tokens.account.status,
      deviceLimit: tokens.account.deviceLimit,
      deviceCount: tokens.account.deviceCount,
      totpEnabled: tokens.account.totpEnabled,
    };
    this.profileReadAt = Date.now();
    this.phase = "signed-in";
  }
  async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.value;
    if (this.refreshWork) return this.refreshWork;
    const work = this.refresh();
    this.refreshWork = work;
    try {
      return await work;
    } finally {
      if (this.refreshWork === work) this.refreshWork = undefined;
    }
  }
  private async refresh() {
    // Also check at the call boundary: relay startup can race background initialize().
    try {
      await readFile(this.rotationFile);
      await this.clearCredentials();
      throw new AccountError("account_login_required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    const encrypted = await readFile(this.tokenFile);
    const refreshToken = this.options.storage.decrypt(encrypted);
    // Durable uncertainty marker before network I/O: never replay a rotated credential.
    await this.atomic(this.rotationFile, "pending");
    try {
      await this.acceptTokens(
        await this.api("/v1/auth/token", { grantType: "refresh_token", refreshToken }),
      );
      return this.access!.value;
    } catch (error) {
      await this.clearCredentials();
      throw error;
    }
  }
  private cancelLogin() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.server?.close();
    this.server = undefined;
  }
  private async login() {
    if (this.refreshWork) await this.refreshWork.catch(() => undefined);
    if (this.profile) throw new AccountError("account_already_signed_in");
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    this.cancelLogin();
    const generation = this.generation;
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let redirectUri = "";
    let consumed = false;
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      if (
        req.method !== "GET" ||
        req.headers.host !== new URL(redirectUri).host ||
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== state ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(url.searchParams.get("code") ?? "") ||
        consumed ||
        generation !== this.generation
      ) {
        res.writeHead(400).end("Invalid login callback");
        return;
      }
      consumed = true;
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("AgentKib: return to the desktop app to check login status.");
      const code = url.searchParams.get("code")!;
      const work = this.queue.then(async () => {
        if (generation !== this.generation) return;
        try {
          const result = await this.api("/v1/auth/token", {
            grantType: "authorization_code",
            code,
            codeVerifier: verifier,
            redirectUri,
          });
          if (generation !== this.generation) return;
          await this.acceptTokens(result);
          this.error = undefined;
          const identity = await this.options.identity();
          if (identity?.accountClaimPending) {
            if (identity.accountClaimAccountId === this.profile?.id) await this.claim();
            else this.error = "account_claim_pending";
          }
          this.backfillNameInBackground();
        } catch (error) {
          this.phase = this.profile ? "signed-in" : "signed-out";
          this.error = error instanceof AccountError ? error.code : "account_login_required";
        }
        this.cancelLogin();
        await this.publish();
      });
      this.queue = work.catch(() => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new AccountError("account_callback_failed");
    redirectUri = `http://127.0.0.1:${address.port}/callback`;
    this.phase = "signing-in";
    this.timer = setTimeout(() => {
      this.cancelLogin();
      this.phase = this.profile ? "signed-in" : "signed-out";
      this.error = "account_login_expired";
      void this.publish();
    }, 300_000);
    this.timer.unref();
    const params = new URLSearchParams({ redirectUri, state, codeChallenge: challenge });
    try {
      await this.options.openExternal(`${ACCOUNT_ORIGIN}/#/desktop?${params}`);
    } catch {
      this.cancelLogin();
      this.phase = this.profile ? "signed-in" : "signed-out";
      throw new AccountError("account_browser_failed");
    }
  }
  private async clearCredentials() {
    this.access = undefined;
    this.profile = undefined;
    this.knownName = undefined;
    this.nameChecked = undefined;
    this.phase = "signed-out";
    await rm(this.tokenFile, { force: true });
    await rm(this.rotationFile, { force: true });
  }
  private async logout() {
    this.cancelLogin();
    this.loggingOut = true;
    try {
      // Persist disabled relay intent before clearing credentials; never stop Codex tasks.
      await this.options.pauseRemote();
      let failed = false;
      try {
        const token = await this.accessToken();
        await this.api("/v1/auth/logout", {}, token);
      } catch {
        failed = true;
      }
      await this.clearCredentials();
      if (failed) this.error = "account_remote_logout_unconfirmed";
    } finally {
      this.loggingOut = false;
    }
  }
  async ensureDeviceOwner(accountId?: string) {
    if (this.loggingOut) throw new AccountError("account_login_required");
    if (!accountId) return;
    await this.accessToken();
    if (this.profile?.id !== accountId) throw new AccountError("account_device_conflict");
  }
  async registerDevice(input: { registrationId: string; credential: string }) {
    const token = await this.accessToken();
    const result = (await this.withName((name) =>
      this.api("/v1/account/devices", { ...input, ...name }, token),
    )) as Record<string, unknown>;
    this.rememberName(result);
    this.profileReadAt = 0;
    void this.refreshProfile()
      .then(() => this.publish())
      .catch(() => undefined);
    return result;
  }
  private async refreshProfile() {
    const data = (await this.api(
      "/v1/account",
      undefined,
      await this.accessToken(),
    )) as DesktopAccountProfile;
    if (
      !data ||
      data.id !== this.profile?.id ||
      typeof data.username !== "string" ||
      typeof data.status !== "string" ||
      !Number.isInteger(data.deviceLimit) ||
      !Number.isInteger(data.deviceCount) ||
      typeof data.totpEnabled !== "boolean"
    )
      throw new AccountError("account_response_invalid");
    this.profile = {
      id: data.id,
      username: data.username,
      status: data.status,
      deviceLimit: data.deviceLimit,
      deviceCount: data.deviceCount,
      totpEnabled: data.totpEnabled,
    };
    this.profileReadAt = Date.now();
  }
  get signedIn() {
    return !!this.profile && !this.loggingOut;
  }
  get accountId() {
    return this.profile?.id;
  }
  /**
   * The account's live logins, for paired phones bound to one of them. Only their IDs and kinds
   * leave this service; tokens never do. Throws when signed out or when the account cannot be read.
   */
  async liveSessions(): Promise<{ accountId: string; sessions: { id: string; kind: string }[] }> {
    const accountId = this.profile?.id;
    if (!accountId || this.loggingOut) throw new AccountError("account_login_required");
    const data = (await this.api("/v1/account/sessions", undefined, await this.accessToken())) as {
      sessions?: unknown;
    };
    if (!Array.isArray(data?.sessions) || this.profile?.id !== accountId)
      throw new AccountError("account_response_invalid");
    return {
      accountId,
      sessions: data.sessions.flatMap((row) => {
        const { id, kind } = (row ?? {}) as { id?: unknown; kind?: unknown };
        return typeof id === "string" && typeof kind === "string" ? [{ id, kind }] : [];
      }),
    };
  }
  private async claim() {
    const identity = await this.options.identity();
    if (!identity) throw new AccountError("account_device_missing");
    const token = await this.accessToken();
    if (identity.accountId && identity.accountId !== this.profile?.id)
      throw new AccountError("account_device_conflict");
    if (identity.accountClaimPending && identity.accountClaimAccountId !== this.profile?.id)
      throw new AccountError("account_claim_pending");
    await this.options.prepareIdentityClaim(this.profile!.id);
    const result = (await this.withName((name) =>
      this.api(
        "/v1/account/devices/claim",
        { deviceId: identity.deviceId, credential: identity.credential, ...name },
        token,
      ),
    )) as { accountId?: string; deviceId?: string };
    if (result.accountId !== this.profile?.id || result.deviceId !== identity.deviceId)
      throw new AccountError("account_response_invalid");
    await this.options.bindIdentity(result.accountId!);
    this.rememberName(result);
    this.backfillNameInBackground();
    this.profileReadAt = 0;
    await this.refreshProfile().catch(() => {
      this.error = "account_profile_refresh_failed";
    });
  }
  private computerName() {
    this.nameWork ??= Promise.resolve()
      .then(() => this.options.computerName?.())
      .then(normalizeComputerName, () => undefined);
    return this.nameWork;
  }
  /**
   * Sends the computer name with a register or claim body. A broker that rejects the name gets one
   * retry without it, so naming never blocks registration. (Older brokers ignore the field.)
   */
  private async withName(send: (name: { name?: string }) => Promise<unknown>) {
    const name = await this.computerName();
    if (!name) return send({});
    try {
      return await send({ name });
    } catch (error) {
      if (error instanceof AccountError && error.code === "account_invalid_name") return send({});
      throw error;
    }
  }
  private rememberName(device: unknown) {
    const { deviceId, name } = (device ?? {}) as { deviceId?: unknown; name?: unknown };
    if (typeof deviceId === "string" && typeof name === "string" && name)
      this.knownName = { deviceId, name };
  }
  private backfillNameInBackground() {
    void this.backfillName()
      .then((changed) => (changed ? this.publish() : undefined))
      .catch(() => undefined);
  }
  /**
   * Once per account and device in this process: if the account lists this computer without a name,
   * fill it in. The broker only lets a desktop session set a missing name (409 otherwise), so a
   * name the user chose is never overwritten. A broker without names omits the field (skip) or
   * answers PATCH with 404/405; every failure is ignored.
   */
  async backfillName(): Promise<boolean> {
    const accountId = this.profile?.id;
    const identity = await this.options.identity();
    if (!accountId || !identity || identity.accountId !== accountId) return false;
    if (!/^[a-f0-9]{32}$/.test(identity.deviceId)) return false;
    const key = `${accountId}:${identity.deviceId}`;
    if (this.nameChecked === key) return false;
    this.nameChecked = key;
    const before = this.knownName?.name;
    try {
      const token = await this.accessToken();
      const list = (await this.api("/v1/account/devices", undefined, token)) as {
        devices?: unknown;
      };
      const device = (Array.isArray(list?.devices) ? list.devices : []).find(
        (row) => (row as { deviceId?: unknown })?.deviceId === identity.deviceId,
      ) as { name?: unknown } | undefined;
      if (!device || !("name" in device)) return false;
      if (device.name === null) {
        const name = await this.computerName();
        if (!name) return false;
        try {
          this.rememberName(
            await this.api(`/v1/account/devices/${identity.deviceId}`, { name }, token, "PATCH"),
          );
        } catch {
          // 409 name_already_set (named meanwhile), 404/405 (old broker) and the rest: keep going.
          return false;
        }
      } else this.rememberName({ deviceId: identity.deviceId, name: device.name });
    } catch {
      return false;
    }
    return this.knownName?.name !== before;
  }
  shutdown() {
    this.cancelLogin();
  }
}
class AccountError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
