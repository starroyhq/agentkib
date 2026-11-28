import {
  REMOTE_FEATURE_VERSIONS,
  REMOTE_SESSION_STATE_CONTRACT,
  parseSessionState,
  type SessionState,
} from "./generated/remote-contract";
import type { LiveSessionAgent } from "./session-providers";

type Coverage = { sessionStateVersion?: unknown; sessionStateProviders?: unknown };

export type SessionStateNegotiation =
  | { kind: "legacy" }
  | { kind: "unavailable" }
  | { kind: "v1"; state: SessionState };

/** Negotiate from the authorized access scope and the selected session's own Provider. */
export function negotiateSessionState(
  access: Coverage,
  provider: LiveSessionAgent,
  value: unknown,
): SessionStateNegotiation {
  const { capability, providerCoverage } = REMOTE_SESSION_STATE_CONTRACT;
  // Hosts outside the negotiated version still use the legacy session fields.
  if (access[capability] !== REMOTE_FEATURE_VERSIONS[capability]) return { kind: "legacy" };

  const covered = access[providerCoverage];
  if (
    !Array.isArray(covered) ||
    covered.some((key) => typeof key !== "string" || !key.length || key.trim() !== key) ||
    new Set(covered).size !== covered.length
  )
    return { kind: "unavailable" };
  if (!covered.includes(provider)) return { kind: "legacy" };

  const state = parseSessionState(value);
  return state ? { kind: "v1", state } : { kind: "unavailable" };
}
