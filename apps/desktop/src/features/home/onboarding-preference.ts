import { useSyncExternalStore } from "react";
import { api } from "@/core/api";
import type { RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";

const STORAGE_KEY = "agentkib.onboarding.dismissedVersion.v1";

let cachedDismissedVersion: number | null | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function readStoredDismissedVersion(): number | null {
  if (cachedDismissedVersion !== undefined) return cachedDismissedVersion;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      cachedDismissedVersion = null;
      return null;
    }
    const parsed = Number(raw);
    cachedDismissedVersion = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    cachedDismissedVersion = null;
  }
  return cachedDismissedVersion;
}

export function dismissOnboardingLocally(version: number): void {
  if (!Number.isInteger(version) || version <= 0) return;
  const current = readStoredDismissedVersion();
  if (current !== null && current >= version) return;
  cachedDismissedVersion = version;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(version));
  } catch {
    // Ignore storage quota or sandbox errors; in-memory state still hides onboarding.
  }
  notify();
}

export function clearOnboardingDismissal(): void {
  cachedDismissedVersion = null;
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
  notify();
}

export function isOnboardingDismissedLocally(version: number | undefined): boolean {
  if (!version || version <= 0) return false;
  const dismissed = readStoredDismissedVersion();
  return dismissed !== null && dismissed >= version;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOnboardingDismissedLocally(version: number | undefined): boolean {
  const dismissedVersion = useSyncExternalStore(subscribe, readStoredDismissedVersion, () => null);
  return Boolean(
    version && version > 0 && dismissedVersion !== null && dismissedVersion >= version,
  );
}

/**
 * Exits first-minute onboarding once the user enters or resumes a session.
 * Persists via the existing `dismissed` runtime event when available without blocking navigation.
 */
export function dismissActiveOnboarding(
  onRuntimeChanged?: (runtime: RuntimeInfo) => void,
  explicitVersion?: number,
): void {
  const runtimeOnboarding = useAppStore.getState().runtime?.onboarding;
  const version = explicitVersion ?? runtimeOnboarding?.version;
  const alreadyAcknowledged =
    runtimeOnboarding !== undefined &&
    runtimeOnboarding.acknowledged_version >= runtimeOnboarding.version;
  if (!version || alreadyAcknowledged) return;
  dismissOnboardingLocally(version);
  if (typeof api.updateOnboarding !== "function") return;
  try {
    void Promise.resolve(api.updateOnboarding({ event: "dismissed" }))
      .then((nextRuntime) => {
        if (!nextRuntime) return;
        useAppStore.getState().setRuntime(nextRuntime);
        onRuntimeChanged?.(nextRuntime);
      })
      .catch(() => undefined);
  } catch {
    // Ignore missing desktop bridge in isolated unit tests; local dismissal is already applied.
  }
}

export function resetOnboardingPreferenceForTest(): void {
  cachedDismissedVersion = undefined;
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
  notify();
}
