import { useSyncExternalStore } from "react";
import { desktopApi } from "@/core/desktop";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";

type Scope = { key: string; ready: boolean; identityKey?: string };
const listeners = new Set<() => void>();
let snapshot: Scope = {
  key: "legacy-local-owner:0",
  ready: true,
  identityKey: "legacy-local-owner",
};
let revision = 0;
let identity = "";
let release: (() => void) | undefined;
function publish(key: string, ready: boolean) {
  snapshot = { key: `${key}:${++revision}`, ready, identityKey: ready ? key : undefined };
  for (const listener of [...listeners]) listener();
}
function start() {
  let account;
  try {
    account = desktopApi().account;
  } catch {
    /* Browser-only previews have no account bridge. */
  }
  if (!account) return;
  identity = "";
  publish("account-loading", false);
  let active = true,
    eventRevision = 0;
  const apply = (value: DesktopAccountStatus) => {
    const next = JSON.stringify([
      value.phase,
      value.account?.id,
      value.device?.deviceId,
      value.device?.ownership,
    ]);
    if (next === identity) return;
    identity = next;
    publish(next, value.phase === "signed-in" || value.phase === "signed-out");
  };
  const unsubscribe = account.onStatus((value) => {
    eventRevision++;
    if (active) apply(value);
  });
  const requested = eventRevision;
  void account
    .request({ operation: "status" })
    .then((value) => {
      if (active && eventRevision === requested) apply(value);
    })
    .catch(() => {
      /* Unknown identity remains fenced until a real status arrives. */
    });
  release = () => {
    active = false;
    unsubscribe();
  };
}
export function subscribeDesktopReadScope(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      release?.();
      release = undefined;
    }
  };
}
export function desktopReadScope() {
  return snapshot;
}
export function useDesktopReadScope() {
  return useSyncExternalStore(subscribeDesktopReadScope, desktopReadScope);
}
