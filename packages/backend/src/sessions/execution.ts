import type { SessionExecution } from "@agentkib/runtime-protocol";

/** Read ownership without a new native query or an inference about control grants. */
export function projectSessionExecution(
  value: {
    executionMode?: unknown;
    executionLocation?: unknown;
    ownerHandoff?: unknown;
    status?: unknown;
    reason?: unknown;
    ownershipReason?: unknown;
    bridgeCompatibility?: unknown;
  },
  retainedManaged = false,
): SessionExecution {
  const { executionMode: mode, executionLocation: location } = value;
  if (value.ownerHandoff === true || (mode === "codex-follower" && location === "external"))
    return { owner: "native-app", observed: true, confidence: "live" };
  if (location === "agentkib" || location === "terminal")
    return { owner: location, observed: true, confidence: "live" };
  if (mode === "dsh-follower" && value.reason === "dsh-native-turn-observed")
    return { owner: "external", observed: true, confidence: "inferred" };
  const ownershipReason = value.ownershipReason ?? value.reason;
  if (
    location === "external" ||
    ownershipReason === "codex-owner-busy" ||
    ownershipReason === "claude-owner-busy" ||
    ownershipReason === "claude-background-session-running" ||
    ownershipReason === "owner-opened-elsewhere"
  ) {
    const observed = mode === "dsh-follower" && value.bridgeCompatibility != null;
    return { owner: "external", observed, confidence: observed ? "live" : "inferred" };
  }
  if (
    location === undefined &&
    value.status !== "unsupported" &&
    value.status !== "outcome-unknown"
  ) {
    if (mode === "codex-follower")
      return { owner: "native-app", observed: false, confidence: "inferred" };
    if (mode === "claude-follower")
      return { owner: "terminal", observed: false, confidence: "inferred" };
  }
  if (
    retainedManaged &&
    !value.ownershipReason &&
    value.status !== "unsupported" &&
    value.status !== "outcome-unknown"
  )
    return { owner: "agentkib", observed: false, confidence: "inferred" };
  if (
    location === undefined &&
    value.status !== "unsupported" &&
    (mode === "codex-managed" ||
      mode === "claude-managed" ||
      mode === "devin-print" ||
      mode === "acp-managed" ||
      mode === "managed-resume")
  ) {
    return { owner: "agentkib", observed: false, confidence: "inferred" };
  }
  return { owner: null, observed: false, confidence: "unknown" };
}
