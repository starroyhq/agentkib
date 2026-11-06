import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopAccountProfile, DesktopAccountRequest, DesktopAccountStatus } from "./state";
import { normalizeComputerName } from "./computer-name";
import { checkedRelayUsage, type RelayUsage } from "./relay-usage";

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
  refreshRecovery?: boolean;
};
type SavedSession = {
  version: 1;
  refreshToken: string;
  refreshRecovery: boolean;
  account?: DesktopAccountProfile;
  access?: { value: string; until: number };
  pending?: string;
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
  private savedSession?: SavedSession;
  private sessionLoaded = false;
  private signedOutLocally = false;
  private credentialGeneration = 0;
  private storageWork: Promise<unknown> = Promise.resolve();
  private profileReadAt = 0;
  private loggingOut = false;
  private nameWork?: Promise<string | undefined>;
  /** The name the account shows for this computer, as last reported by the broker. */
  private knownName?: { deviceId: string; name: string };
  /** `accountId:deviceId` already checked for a missing name in this process. */
  private nameChecked?: string;
  private nameReadAt = 0;
  private nameGeneration = 0;
  private nameReadWork?: { key: string; work: Promise<boolean> };
  private relayUsage?: RelayUsage;
  private usageUnavailable = false;
  private usageReadAt = 0;
  private usageRevision = 0;
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
      await this.accessToken();
      this.refreshNameInBackground();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !this.signedOutLocally) {
        this.phase = this.savedSession ? "error" : "signed-out";
        this.error = error instanceof AccountError ? error.code : "account_connection_failed";
      }
    }
    await this.publish();
  }
  private storageChange(change: () => Promise<void>) {
    const work = this.storageWork.then(change);
    this.storageWork = work.catch(() => undefined);
    return work;
  }
  private async saveSession(session: SavedSession, generation: number) {
    await this.storageChange(async () => {
      if (generation !== this.credentialGeneration)
        throw new AccountError("account_identity_changed");
      await this.atomic(this.tokenFile, this.options.storage.encrypt(JSON.stringify(session)));
    });
    if (generation !== this.credentialGeneration)
      throw new AccountError("account_identity_changed");
    this.savedSession = session;
  }
  private async loadSession() {
    if (this.sessionLoaded) return;
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    const generation = this.credentialGeneration;
    let legacyMarker = false;
    try {
      const marker = await readFile(this.rotationFile, "utf8");
      if (generation !== this.credentialGeneration)
        throw new AccountError("account_identity_changed");
      if (marker === "signed-out") {
        // Deleting the encrypted file can fail independently of the logout commit.
        // This tombstone wins over every cached token until a new sign-in is durable.
        this.signedOutLocally = true;
        this.sessionLoaded = true;
        return;
      }
      legacyMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const value = this.options.storage.decrypt(await readFile(this.tokenFile));
    let session: SavedSession;
    const legacy = /^[A-Za-z0-9_-]{32,256}$/.test(value);
    if (legacy) {
      session = { version: 1, refreshToken: value, refreshRecovery: false };
    } else {
      const data = JSON.parse(value) as SavedSession;
      if (
        data?.version !== 1 ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(data.refreshToken) ||
        typeof data.refreshRecovery !== "boolean" ||
        (data.pending !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(data.pending))
      )
        throw new AccountError("account_response_invalid");
      if (data.account)
        this.validateTokens({
          accessToken: "a".repeat(32),
          refreshToken: data.refreshToken,
          expiresIn: 600,
          account: data.account,
        });
      if (
        data.access &&
        (typeof data.access.value !== "string" ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(data.access.value) ||
          !Number.isFinite(data.access.until))
      )
        throw new AccountError("account_response_invalid");
      session = data;
    }
    // The old journal has no request ID and cannot safely recover a rotated token.
    if (legacy && legacyMarker) session.pending = "legacy";
    if (generation !== this.credentialGeneration)
      throw new AccountError("account_identity_changed");
    this.savedSession = session;
    this.sessionLoaded = true;
    this.profile = session.account;
    this.access = session.pending ? undefined : session.access;
    this.phase = this.restingPhase();
  }
  async status(): Promise<DesktopAccountStatus> {
    const identity = await this.options.identity();
    return {
      phase: this.phase,
      secureStorage: this.options.storage.available(),
      ...(this.profile && this.relayUsage ? { relayUsage: { ...this.relayUsage } } : {}),
      ...(this.profile && this.usageUnavailable ? { relayUsageUnavailable: true } : {}),
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
        if (input.operation === "status" && this.phase === "error") await this.accessToken();
        if (
          input.operation === "status" &&
          this.profile &&
          Date.now() - this.profileReadAt > 30_000
        )
          await this.refreshProfile();
        if (input.operation === "status" && this.profile && Date.now() - this.nameReadAt >= 30_000)
          await this.refreshDeviceName();
        if (input.operation === "status" && this.profile && Date.now() - this.usageReadAt >= 30_000)
          await this.refreshRelayUsage();
        if (input.operation === "login") await this.login();
        if (input.operation === "cancel-login") {
          this.cancelLogin();
          this.phase = this.restingPhase();
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
    retryRead = true,
  ): Promise<unknown> {
    const generation = this.credentialGeneration;
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
      if (generation !== this.credentialGeneration) {
        void response.body?.cancel().catch(() => undefined);
        throw new AccountError("account_identity_changed");
      }
      if (!response.ok) {
        let code: unknown;
        try {
          code = ((await this.readResponse(response)) as { error?: unknown })?.error;
        } catch {
          // A proxy's HTML error is not proof that account credentials were revoked.
        }
        if (generation !== this.credentialGeneration)
          throw new AccountError("account_identity_changed");
        if (
          path === "/v1/auth/token" &&
          [400, 401, 403].includes(response.status) &&
          [
            "invalid_grant",
            "session_revoked",
            "account_revoked",
            "account_disabled",
            "account_deleted",
            "authentication_required",
          ].includes(String(code))
        ) {
          throw new AccountError("account_login_required", true);
        }
        if (response.status === 401 && token) {
          if (token === this.access?.value) this.access.until = 0;
          // A previous access token may be rejected while its rotation is still committing.
          // Recover authentication once; writes remain unknown and are never replayed here.
          if (retryRead) {
            const recovered = await this.accessToken();
            if (method === "GET") return this.api(path, body, recovered, method, false);
          }
        }
        // Only recognized categories reach IPC, never arbitrary server error text.
        throw new AccountError(
          response.status === 404 && path === "/v1/account/relay-usage"
            ? "account_usage_unsupported"
            : response.status === 400 && code === "invalid_name"
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
      const data = await this.readResponse(response);
      if (generation !== this.credentialGeneration)
        throw new AccountError("account_identity_changed");
      return data;
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
  private restingPhase(): DesktopAccountStatus["phase"] {
    if (this.signedOutLocally) return "signed-out";
    return this.profile && this.access && !this.savedSession?.pending
      ? "signed-in"
      : this.savedSession
        ? "error"
        : "signed-out";
  }
  private async acceptTokens(
    value: unknown,
    generation = this.credentialGeneration,
    expectedAccountId?: string,
  ) {
    const tokens = this.validateTokens(value);
    if (generation !== this.credentialGeneration)
      throw new AccountError("account_identity_changed");
    if (expectedAccountId && tokens.account.id !== expectedAccountId)
      throw new AccountError("account_response_invalid");
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    const account = {
      id: tokens.account.id,
      username: tokens.account.username,
      status: tokens.account.status,
      deviceLimit: tokens.account.deviceLimit,
      deviceCount: tokens.account.deviceCount,
      totpEnabled: tokens.account.totpEnabled,
    };
    const access = {
      value: tokens.accessToken,
      until: Date.now() + tokens.expiresIn * 1000 - 30_000,
    };
    await this.saveSession(
      {
        version: 1,
        refreshToken: tokens.refreshToken,
        refreshRecovery: tokens.refreshRecovery === true,
        account,
        access,
      },
      generation,
    );
    // Remove the logout tombstone only after the new encrypted record is durable.
    // An IO failure here must remain visible and must not restore the old identity.
    await this.storageChange(() => rm(this.rotationFile, { force: true }));
    if (generation !== this.credentialGeneration)
      throw new AccountError("account_identity_changed");
    if (this.profile && this.profile.id !== account.id) {
      this.knownName = undefined;
      this.nameChecked = undefined;
      this.nameReadAt = 0;
      this.nameGeneration++;
      this.relayUsage = undefined;
      this.usageUnavailable = false;
      this.usageReadAt = 0;
      this.usageRevision++;
    }
    this.signedOutLocally = false;
    this.sessionLoaded = true;
    this.access = access;
    this.profile = account;
    this.profileReadAt = Date.now();
    this.phase = "signed-in";
    this.error = undefined;
    void this.refreshRelayUsage()
      .then(() => this.publish())
      .catch(() => undefined);
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
    const generation = this.credentialGeneration;
    try {
      await this.loadSession();
      if (this.signedOutLocally) throw new AccountError("account_login_required");
      if (this.access && this.access.until > Date.now()) return this.access.value;
      const saved = this.savedSession!;
      if (saved.pending && (!saved.refreshRecovery || saved.pending === "legacy"))
        throw new AccountError("account_login_required");
      const pending = saved.pending ?? randomBytes(32).toString("base64url");
      // Retain the original token and stable request ID until the replacement is durable.
      // Only a server advertising recovery may receive this request again after uncertainty.
      await this.saveSession({ ...saved, pending }, generation);
      this.access = undefined;
      await this.acceptTokens(
        await this.api("/v1/auth/token", {
          grantType: "refresh_token",
          refreshToken: saved.refreshToken,
          ...(saved.refreshRecovery ? { refreshRequestId: pending } : {}),
        }),
        generation,
        saved.account?.id,
      );
      return this.access!.value;
    } catch (error) {
      if (generation !== this.credentialGeneration)
        throw new AccountError("account_identity_changed");
      if (error instanceof AccountError && error.definite) {
        await this.clearCredentials();
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !this.signedOutLocally) {
        this.phase = this.savedSession ? "error" : "signed-out";
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !this.signedOutLocally)
        this.error = error instanceof AccountError ? error.code : "account_connection_failed";
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
    if (this.profile && this.phase === "signed-in")
      throw new AccountError("account_already_signed_in");
    if (!this.options.storage.available())
      throw new AccountError("account_secure_storage_unavailable");
    this.cancelLogin();
    this.credentialGeneration++;
    const credentialGeneration = this.credentialGeneration;
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
          await this.acceptTokens(result, credentialGeneration);
          this.error = undefined;
          const identity = await this.options.identity();
          if (identity?.accountClaimPending) {
            if (identity.accountClaimAccountId === this.profile?.id) await this.claim();
            else this.error = "account_claim_pending";
          }
          this.refreshNameInBackground();
        } catch (error) {
          this.phase = this.restingPhase();
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
      this.phase = this.restingPhase();
      this.error = "account_login_expired";
      void this.publish();
    }, 300_000);
    this.timer.unref();
    const params = new URLSearchParams({ redirectUri, state, codeChallenge: challenge });
    try {
      await this.options.openExternal(`${ACCOUNT_ORIGIN}/#/desktop?${params}`);
    } catch {
      this.cancelLogin();
      this.phase = this.restingPhase();
      throw new AccountError("account_browser_failed");
    }
  }
  private async clearCredentials() {
    this.credentialGeneration++;
    this.savedSession = undefined;
    this.signedOutLocally = true;
    this.sessionLoaded = true;
    this.access = undefined;
    this.profile = undefined;
    this.knownName = undefined;
    this.nameChecked = undefined;
    this.nameReadAt = 0;
    this.nameGeneration++;
    this.relayUsage = undefined;
    this.usageUnavailable = false;
    this.usageReadAt = 0;
    this.usageRevision++;
    this.phase = "signed-out";
    await this.storageChange(async () => {
      try {
        await this.atomic(this.rotationFile, "signed-out");
      } catch (error) {
        // If the tombstone cannot be persisted, still try to remove credentials.
        // Surface the IO failure even if deletion succeeds.
        await rm(this.tokenFile, { force: true });
        throw error;
      }
      await rm(this.tokenFile, { force: true });
    });
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
    await this.accessToken();
    if (this.loggingOut) throw new AccountError("account_login_required");
    if (accountId && this.profile?.id !== accountId)
      throw new AccountError("account_device_conflict");
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
  private async refreshRelayUsage() {
    const owner = this.profile?.id;
    const revision = ++this.usageRevision;
    if (!owner || this.loggingOut) return;
    try {
      const data = checkedRelayUsage(
        await this.api("/v1/account/relay-usage", undefined, await this.accessToken()),
      );
      if (this.profile?.id !== owner || this.loggingOut || this.usageRevision !== revision) return;
      this.relayUsage = data;
      this.usageUnavailable = false;
    } catch (error) {
      if (this.profile?.id !== owner || this.loggingOut || this.usageRevision !== revision) return;
      this.usageUnavailable = !(
        error instanceof AccountError && error.code === "account_usage_unsupported"
      );
      if (!this.usageUnavailable) this.relayUsage = undefined;
    }
    if (this.profile?.id === owner && this.usageRevision === revision)
      this.usageReadAt = Date.now();
  }
  get signedIn() {
    return this.phase === "signed-in" && !!this.profile && !this.loggingOut;
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
    this.refreshNameInBackground();
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
  private refreshNameInBackground() {
    void this.refreshDeviceName()
      .then((changed) => (changed ? this.publish() : undefined))
      .catch(() => undefined);
  }
  /**
   * Keep the once-per-process initial check separate from later reads: names chosen in the account
   * UI must become visible without ever turning a refresh into another automatic rename.
   */
  async backfillName(): Promise<boolean> {
    const accountId = this.profile?.id;
    const identity = await this.options.identity();
    if (!accountId || !identity || identity.accountId !== accountId) return false;
    if (!/^[a-f0-9]{32}$/.test(identity.deviceId)) return false;
    const key = `${accountId}:${identity.deviceId}`;
    if (this.nameChecked === key) return false;
    return this.refreshDeviceName();
  }
  private async refreshDeviceName(): Promise<boolean> {
    const accountId = this.profile?.id;
    const identity = await this.options.identity();
    if (!accountId || !identity || identity.accountId !== accountId || this.loggingOut)
      return false;
    if (!/^[a-f0-9]{32}$/.test(identity.deviceId)) return false;
    const key = `${accountId}:${identity.deviceId}`;
    const generation = this.nameGeneration;
    const workKey = `${generation}:${key}`;
    if (this.nameReadWork?.key === workKey) return this.nameReadWork.work;
    const mayBackfill = this.nameChecked !== key;
    this.nameChecked = key;
    this.nameReadAt = Date.now();
    const work = this.readDeviceName(accountId, identity.deviceId, generation, mayBackfill);
    this.nameReadWork = { key: workKey, work };
    try {
      return await work;
    } finally {
      if (this.nameReadWork?.work === work) this.nameReadWork = undefined;
    }
  }
  private async readDeviceName(
    accountId: string,
    deviceId: string,
    generation: number,
    mayBackfill: boolean,
  ): Promise<boolean> {
    const current = async () => {
      const identity = await this.options.identity();
      return (
        generation === this.nameGeneration &&
        this.profile?.id === accountId &&
        identity?.accountId === accountId &&
        identity.deviceId === deviceId &&
        !this.loggingOut
      );
    };
    const before = this.knownName?.name;
    try {
      const token = await this.accessToken();
      const read = async () => {
        const list = (await this.api("/v1/account/devices", undefined, token)) as {
          devices?: unknown;
        };
        return (Array.isArray(list?.devices) ? list.devices : []).find(
          (row) => (row as { deviceId?: unknown })?.deviceId === deviceId,
        ) as { name?: unknown } | undefined;
      };
      let device = await read();
      if (!(await current())) return false;
      if (mayBackfill && device?.name === null) {
        const name = await this.computerName();
        if (name && (await current())) {
          try {
            device = (await this.api(
              `/v1/account/devices/${deviceId}`,
              { name },
              token,
              "PATCH",
            )) as {
              name?: unknown;
            };
          } catch (error) {
            if (!(error instanceof AccountError) || error.code !== "account_name_already_set")
              return false;
            // A user named the computer after our read. Read that name; never retry the write.
            device = await read();
          }
        }
      }
      if (!(await current())) return false;
      const name = device?.name;
      this.knownName = typeof name === "string" && name ? { deviceId, name } : undefined;
    } catch {
      return false;
    }
    return this.knownName?.name !== before;
  }
  shutdown() {
    this.credentialGeneration++;
    this.cancelLogin();
  }
}
class AccountError extends Error {
  constructor(
    readonly code: string,
    readonly definite = false,
  ) {
    super(code);
  }
}
