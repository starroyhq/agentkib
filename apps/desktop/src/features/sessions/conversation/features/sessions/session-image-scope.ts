import { ApiError, type Access, type WebClient } from "@agentkib/web-client";
import { clearMessageImageCache, type MessageImageLoader } from "@agentkib/session-ui";
import { capabilityAccessBinding } from "./use-session-capabilities";
import { desktopReadScope, subscribeDesktopReadScope } from "../../../read-state-scope";
import { desktopApi } from "@/core/desktop";
import { useAppStore } from "@/stores/app-store";

type Owner = {
  client: WebClient;
  connection: string;
  authority?: string;
  binding?: string;
  private: boolean;
  access?: Access;
  indexEnabled: boolean;
  verified: boolean;
  accessProof?: number;
  readAfterPending: boolean;
  mounts: number;
  verify?: () => void;
};
type SessionScope = { base: string; sessionId: string; scope: string; blocked: boolean };
let owner: Owner | undefined;
let revision = 0;
let nextNonce = 0;
let installedWindow: Window | undefined;
let verificationScheduled = false;
const sessionScopes = new Map<string, SessionScope>();

function connectionKey(client: WebClient) {
  return JSON.stringify(["desktop", client.connection.type, client.origin || location.origin]);
}
function authority(client: WebClient, access: Access | undefined) {
  if (
    !platformAvailable() ||
    access?.status !== "approved" ||
    !access.bootId ||
    !access.device?.id ||
    (access.accountLogin?.required && !access.accountLogin.bound)
  )
    return;
  const identity = stableIdentity(access);
  // An older host may prove the current account grant without exposing its ID.
  // Its fresh bytes are readable, but must use a private proof, never a shared identity.
  if (!identity && !(access.accountLogin?.required && access.accountLogin.bound)) return;
  return {
    reusable: !!identity,
    key: JSON.stringify([
      connectionKey(client),
      access.bootId,
      access.device.id,
      identity ?? "private-account-proof",
      access.accountLogin?.accountId,
      access.accountLogin?.deviceId,
      access.accountLogin?.bound,
      access.historySearchScope,
      capabilityAccessBinding(access),
    ]),
  };
}
function binding(client: WebClient, access: Access | undefined) {
  const next = authority(client, access);
  if (
    !next ||
    owner?.client !== client ||
    owner.authority !== next.key ||
    (owner.private && owner.access !== access)
  )
    return;
  return owner.binding;
}
function abortImageRead(): never {
  throw new DOMException("Image scope changed", "AbortError");
}
function scheduleVerification() {
  if (verificationScheduled) return;
  verificationScheduled = true;
  queueMicrotask(() => {
    verificationScheduled = false;
    if (owner?.mounts) owner.verify?.();
  });
}
function clearPrivateScopes(base: string | undefined) {
  if (!base) return;
  for (const [key, state] of sessionScopes)
    if (state.base === base) {
      clearMessageImageCache(state.scope);
      sessionScopes.delete(key);
    }
}
export function invalidateSessionImages(client?: WebClient) {
  if (client && owner?.client !== client) return;
  revision++;
  if (owner) {
    owner.verified = false;
    if (owner.client.connection.type === "lan-http") owner.readAfterPending = true;
  }
  clearMessageImageCache();
  sessionScopes.clear();
}
function externalBoundary() {
  invalidateSessionImages();
  if (platformAvailable()) scheduleVerification();
}
function installGlobalEvents() {
  if (installedWindow !== window) {
    installedWindow = window;
    window.addEventListener("storage", (event) => {
      // Theme, locale and composer preferences are not identity changes.
      if (
        event.key === null ||
        /^agentkib\.(?:remote\.login|account|auth|connections?)(?:\.|$)/.test(event.key)
      )
        externalBoundary();
    });
    window.addEventListener("hashchange", (event) => {
      // The Environment may already have consumed and rewritten the legacy link.
      const hash = event.newURL ? new URL(event.newURL, location.href).hash : location.hash;
      if (new URLSearchParams(hash.replace(/^#/, "")).has("connect")) externalBoundary();
    });
  }
  installPlatformEvents(externalBoundary);
}

/** Keep verified bytes across navigation; a new controller must verify access again. */
export function mountSessionImages(client: WebClient, verify?: () => void) {
  installGlobalEvents();
  const connection = connectionKey(client);
  if (owner && owner.connection !== connection) invalidateSessionImages();
  if (owner?.client !== client) {
    const previous = owner?.connection === connection ? owner : undefined;
    revision++;
    owner = {
      client,
      connection,
      authority: previous?.authority,
      binding: previous?.binding,
      private: previous?.private ?? false,
      indexEnabled: previous?.indexEnabled ?? true,
      verified: false,
      readAfterPending: false,
      mounts: 0,
    };
  }
  const current = owner!;
  current.mounts++;
  current.verify = verify;
  return () => {
    if (owner !== current) return;
    current.mounts--;
    if (!current.mounts) {
      revision++;
      current.verified = false;
      if (current.private) clearPrivateScopes(current.binding);
      if (client.connection.type === "lan-http") current.readAfterPending = true;
      current.verify = undefined;
    }
  };
}
export function sessionImageRevision(client: WebClient) {
  return owner && owner.client === client ? revision : -1;
}
export async function readSessionImageAccess(client: WebClient): Promise<Access> {
  const current = owner,
    proof = revision;
  let access = await client.access();
  if (
    current?.client === client &&
    current === owner &&
    proof === revision &&
    current.readAfterPending &&
    access.status === "approved"
  ) {
    // LAN access() may share a read started before the owner boundary.
    await Promise.resolve();
    access = await client.access();
  }
  if (current?.client === client && current === owner && proof === revision)
    current.readAfterPending = false;
  return access;
}
export function acceptSessionImageAccess(client: WebClient, access: Access) {
  if (owner?.client !== client || !owner.mounts) return;
  const next = authority(client, access);
  const blocked =
    next && !next.reusable && owner.private && owner.authority === next.key
      ? [...sessionScopes.values()]
          .filter((state) => state.base === owner!.binding && state.blocked)
          .map((state) => state.sessionId)
      : [];
  if (owner.authority !== undefined && owner.authority !== next?.key)
    invalidateSessionImages(client);
  if (next && !next.reusable) {
    clearPrivateScopes(owner.binding);
    revision++;
  }
  owner.access = access;
  owner.authority = next?.key;
  owner.private = !!next && !next.reusable;
  owner.binding = next
    ? next.reusable
      ? next.key
      : JSON.stringify(["private-proof", ++nextNonce, next.key])
    : undefined;
  owner.accessProof = revision;
  owner.verified = !!next && owner.indexEnabled;
  for (const id of blocked) sessionScope(owner.binding!, id).blocked = true;
}
export function setSessionImageIndexEnabled(client: WebClient, enabled: boolean) {
  if (owner?.client !== client) return;
  if (!enabled) invalidateSessionImages(client);
  owner.indexEnabled = enabled;
  owner.verified =
    enabled &&
    owner.accessProof === revision &&
    !!binding(client, owner.access) &&
    owner.binding === binding(client, owner.access);
}
function sessionScope(base: string, sessionId: string) {
  const key = JSON.stringify([base, sessionId]);
  let state = sessionScopes.get(key);
  if (!state) {
    state = {
      base,
      sessionId,
      blocked: false,
      scope: JSON.stringify([base, sessionId, ++nextNonce]),
    };
  } else sessionScopes.delete(key);
  sessionScopes.set(key, state);
  if (sessionScopes.size > 256) {
    const oldest = sessionScopes.keys().next().value!;
    clearMessageImageCache(sessionScopes.get(oldest)!.scope);
    sessionScopes.delete(oldest);
  }
  return state;
}
function advanceSessionScope(state: SessionScope, sessionId: string, blocked: boolean) {
  clearMessageImageCache(state.scope);
  state.scope = JSON.stringify([state.base, sessionId, ++nextNonce]);
  state.blocked = blocked;
}
export function forgetSessionImages(client: WebClient, sessionId: string) {
  if (owner?.client !== client || !owner.binding) return;
  const key = JSON.stringify([owner.binding, sessionId]);
  clearMessageImageCache(key);
  const state = sessionScopes.get(key);
  if (state && !state.blocked) advanceSessionScope(state, sessionId, true);
}
export function restoreSessionImages(client: WebClient, sessionId: string) {
  if (owner?.client !== client || !owner.binding) return;
  const state = sessionScopes.get(JSON.stringify([owner.binding, sessionId]));
  if (state?.blocked) advanceSessionScope(state, sessionId, false);
}
let runtimeBoot: { connection: string; boot: string } | undefined;
export function noteSessionImageBoot(client: WebClient, boot: string | undefined) {
  if (!boot || owner?.client !== client) return;
  const connection = connectionKey(client);
  if (runtimeBoot?.connection === connection && runtimeBoot.boot !== boot) externalBoundary();
  runtimeBoot = { connection, boot };
}
export function sessionImageCacheScope(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  indexEnabled: boolean,
) {
  if (
    !owner ||
    owner.client !== client ||
    !owner.mounts ||
    !owner.verified ||
    owner.accessProof !== revision ||
    !sessionId ||
    !indexEnabled
  )
    return;
  const base = binding(client, access);
  if (!base || owner.binding !== base) return;
  const state = sessionScope(base, sessionId);
  return state.blocked ? undefined : state.scope;
}
export function createSessionImageLoader(
  client: WebClient,
  access: Access | undefined,
  sessionId: string,
  indexEnabled: boolean,
  isCurrent: () => boolean,
): MessageImageLoader {
  const cacheScope = sessionImageCacheScope(client, access, sessionId, indexEnabled);
  return Object.assign(
    async (imageId: string, signal: AbortSignal) => {
      const proof = revision;
      const current = () =>
        proof === revision &&
        isCurrent() &&
        !signal.aborted &&
        sessionImageCacheScope(client, access, sessionId, indexEnabled) === cacheScope;
      if (!cacheScope || !current()) abortImageRead();
      try {
        const result = await client.sessionImage(sessionId, imageId, signal);
        if (!current()) abortImageRead();
        return result;
      } catch (error) {
        if (!current()) abortImageRead();
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.code === "access_ended")
        )
          invalidateSessionImages(client);
        throw error;
      }
    },
    { cacheScope },
  );
}
function stableIdentity(access: Access | undefined) {
  if (
    access?.accountLogin?.required &&
    (!access.accountLogin.bound || !access.accountLogin.accountId)
  )
    return;
  return desktopReadScope().ready ? desktopReadScope().identityKey : undefined;
}
function platformAvailable() {
  return (
    desktopReadScope().ready && useAppStore.getState().runtime?.session_index_enabled !== false
  );
}
let platformBridge: ReturnType<typeof desktopApi> | undefined;
let stopPlatform: (() => void) | undefined;
function installPlatformEvents(invalidate: () => void) {
  let desktop;
  try {
    desktop = desktopApi();
  } catch {
    return;
  }
  if (platformBridge === desktop) return;
  stopPlatform?.();
  platformBridge = desktop;
  const stopScope = subscribeDesktopReadScope(invalidate);
  const stopIndex = useAppStore.subscribe((next, previous) => {
    if (
      (next.runtime?.session_index_enabled === false &&
        previous.runtime?.session_index_enabled !== false) ||
      (previous.runtime && (!next.runtime || next.runtime.data_dir !== previous.runtime.data_dir))
    )
      invalidate();
  });
  let restarts: number | undefined;
  const stopRuntime =
    desktop.events?.onRuntimeStatus?.((status) => {
      if (status.state !== "ready" || (restarts !== undefined && restarts !== status.restartCount))
        invalidate();
      restarts = status.restartCount;
    }) ?? (() => {});
  stopPlatform = () => {
    stopScope();
    stopIndex();
    stopRuntime();
  };
}
