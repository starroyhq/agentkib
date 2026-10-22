import type { SessionSurface } from "./session-surface-copy";
import { claudeConnectionCopyForSurface, claudeConnectionReason } from "./claude-connection-copy";
import type { SessionController } from "./use-session-controller";
import { codexReason } from "./codex-copy";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { webLayoutCopy } from "./web-layout-copy";
import { managedControlCopyForSurface } from "./managed-control-copy";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import { claudeReconnectFailureReason } from "./claude-session-banner";

type State = Pick<
  SessionController,
  | "locale"
  | "live"
  | "online"
  | "controlReady"
  | "busy"
  | "canSend"
  | "access"
  | "capabilities"
  | "selected"
  | "current"
  | "notice"
> & { pendingSend?: SessionController["pendingSend"] };

export type SessionNextAction = "managed-handoff";
type DisplayState = {
  label: string;
  reason: string;
  tone: "warning" | "active" | "muted";
  loading?: boolean;
  nextAction?: SessionNextAction;
  continuation?:
    | "idle"
    | "starting"
    | "running"
    | "terminal"
    | "terminal-watch"
    | "busy"
    | "view-only";
};

/** Execution ownership is automatic; no user-visible handoff action remains. */
export function sessionNextAction(_state: State): SessionNextAction | undefined {
  return undefined;
}
/** Presentation only: never grants capabilities or changes dispatch eligibility. */
export function sessionDisplayState(
  state: State,
  surface: SessionSurface = "desktop",
): DisplayState {
  const { live, online, controlReady, busy, canSend, access, capabilities, locale } = state;
  const c = webLayoutCopy[locale];
  const reason =
    live?.reason === "handoff-required" &&
    capabilities?.reason &&
    capabilities.reason !== "handoff-required"
      ? capabilities.reason
      : live?.reason || capabilities?.features.send?.reason || capabilities?.reason;
  if (
    state.notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    reason === "control-outcome-unconfirmed" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed"
  )
    return {
      label: c.uncertain,
      reason: codexReason(locale, "control-outcome-unconfirmed", surface).text,
      tone: "warning",
    };
  if (
    state.current?.availability === "metadata-only" ||
    (state.current &&
      (("remote" in state.current && state.current.remote) ||
        !["codex", "claude-code", "antigravity"].includes(state.current.agent) ||
        state.current.origin === "auxiliary" ||
        state.current.origin === "execution"))
  )
    return { label: c.readonly, reason: c.readonly, tone: "muted" };
  if (!online)
    return {
      label: live ? c.offline : c.connecting,
      reason: live ? c.offline : c.connecting,
      tone: "warning",
      loading: !live,
    };
  if (state.current?.agent === "codex") {
    const copy = sessionContinuationCopy(locale);
    if (access?.status !== "approved")
      return {
        label: c.accessRequired,
        reason: managedControlCopyForSurface(locale, surface).access,
        tone: "muted",
      };
    if (access.protocolVersion !== 2)
      return {
        label: c.controlUnavailable,
        reason: managedControlCopyForSurface(locale, surface).protocol,
        tone: "muted",
      };
    if (!access.experimentalEnabled)
      return {
        label: c.controlDisabled,
        reason: codexReason(locale, "control-disabled", surface).text,
        tone: "muted",
      };
    if (!access.device?.send)
      return {
        label: c.permissionRequired,
        reason: managedControlCopyForSurface(locale, surface).send,
        tone: "muted",
      };
    // Only the selected session's authoritative projection can describe its owner.
    if (
      state.current.id !== state.selected ||
      live?.sessionId !== state.selected ||
      capabilities?.sessionId !== state.selected
    )
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (live.ownershipReason === "codex-owner-busy" || reason === "codex-owner-busy")
      return { label: copy.busy("Codex"), reason: "", tone: "muted", continuation: "busy" };
    if (
      (state.pendingSend?.sessionId === state.selected &&
        !["agentkib", "terminal"].includes(live.executionLocation ?? "")) ||
      live.status === "starting"
    )
      return {
        label: copy.starting,
        reason: "",
        tone: "muted",
        loading: true,
        continuation: "starting",
      };
    if (live.executionLocation === "agentkib")
      return { label: copy.running, reason: "", tone: "active", continuation: "running" };
    if (!controlReady)
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (canSend || (live.sendEnabled && !reason))
      return { label: "", reason: "", tone: "muted", continuation: "idle" };
    return {
      label: copy.viewOnly,
      reason: codexReason(locale, reason, surface).text,
      tone: "muted",
      continuation: "view-only",
    };
  }
  if (state.current?.agent === "claude-code") {
    const copy = sessionContinuationCopy(locale);
    if (access?.status !== "approved")
      return {
        label: c.accessRequired,
        reason: managedControlCopyForSurface(locale, surface).access,
        tone: "muted",
      };
    if (access.protocolVersion !== 2)
      return {
        label: c.controlUnavailable,
        reason: managedControlCopyForSurface(locale, surface).protocol,
        tone: "muted",
      };
    if (!access.experimentalEnabled)
      return {
        label: c.controlDisabled,
        reason: codexReason(locale, "control-disabled", surface).text,
        tone: "muted",
      };
    if (!access.device?.send)
      return {
        label: c.permissionRequired,
        reason: managedControlCopyForSurface(locale, surface).send,
        tone: "muted",
      };
    // A late projection from the previous selection must never describe this owner.
    if (
      state.current.id !== state.selected ||
      live?.sessionId !== state.selected ||
      capabilities?.sessionId !== state.selected
    )
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    const ownershipReason = live.ownershipReason || reason;
    if (
      ["claude-owner-busy", "claude-background-session-running", "owner-opened-elsewhere"].includes(
        ownershipReason ?? "",
      )
    )
      return { label: copy.busy("Claude Code"), reason: "", tone: "muted", continuation: "busy" };
    if (
      (state.pendingSend?.sessionId === state.selected &&
        !["agentkib", "terminal"].includes(live.executionLocation ?? "")) ||
      live.status === "starting"
    )
      return {
        label: copy.starting,
        reason: "",
        tone: "muted",
        loading: true,
        continuation: "starting",
      };
    if (live.executionLocation === "terminal")
      return {
        label: copy.terminalConnected,
        reason: "",
        tone: "muted",
        // Until the plugin takes messages from here, the terminal is followed, not typed into.
        continuation: live.terminalSend || live.sendEnabled ? "terminal" : "terminal-watch",
      };
    if (live.executionLocation === "agentkib")
      return { label: copy.running, reason: "", tone: "active", continuation: "running" };
    if (!controlReady)
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (canSend || (live.sendEnabled && !reason))
      return { label: "", reason: "", tone: "muted", continuation: "idle" };
    return {
      label: copy.viewOnly,
      reason:
        reason === "platform-unsupported"
          ? copy.claudeWindowsUnsupported
          : (claudeReconnectFailureReason(live, locale, surface) ??
            claudeConnectionReason(locale, reason, surface) ??
            codexReason(locale, reason, surface).text),
      tone: "muted",
      continuation: "view-only",
    };
  }
  if (
    live?.executionMode === "claude-follower" &&
    ["claude-terminal-approval", "claude-terminal-question"].includes(live.reason ?? "")
  )
    return {
      label: live.reason === "claude-terminal-question" ? c.question : c.approval,
      reason: codexReason(locale, live.reason, surface).text,
      tone: "warning",
    };
  if (live?.questions?.length) return { label: c.question, reason: c.question, tone: "warning" };
  if (
    live?.approvals?.length ||
    live?.status === "awaiting-approval" ||
    live?.status === "waiting-approval"
  )
    return { label: c.approval, reason: c.approval, tone: "warning" };
  if (live?.activity === "compacting")
    return {
      label: contextUsageCopyForSurface(locale, surface).compacting,
      reason: contextUsageCopyForSurface(locale, surface).compactingDetail,
      tone: "active",
    };
  if (
    live?.executionMode === "claude-follower" &&
    ["claude-follower-turn-unconfirmed", "claude-terminal-permission-unconfirmed"].includes(
      live.reason ?? "",
    )
  )
    return {
      label: c.running,
      reason: codexReason(locale, live.reason, surface).text,
      tone: "warning",
    };
  if (live?.executionMode === "claude-follower" && live.reason === "claude-bridge-event-gap")
    return {
      label: c.verifying,
      reason: claudeConnectionCopyForSurface(locale, surface).gap,
      tone: "warning",
    };
  if (
    live?.executionMode === "claude-follower" &&
    (live.status === "unsupported" || live.reason === "claude-bridge-disconnected")
  )
    return {
      label: claudeConnectionCopyForSurface(locale, surface).lostTitle,
      reason: claudeConnectionCopyForSurface(locale, surface).lost,
      tone: "warning",
    };
  if (live?.status === "running") return { label: c.running, reason: c.running, tone: "active" };
  if (busy) return { label: c.busy, reason: c.busy, tone: "active", loading: true };
  if (access?.status !== "approved")
    return {
      label: c.accessRequired,
      reason: managedControlCopyForSurface(locale, surface).access,
      tone: "muted",
    };
  if (access.protocolVersion !== 2)
    return {
      label: c.controlUnavailable,
      reason: managedControlCopyForSurface(locale, surface).protocol,
      tone: "muted",
    };
  if (!access.experimentalEnabled)
    return {
      label: c.controlDisabled,
      reason: codexReason(locale, "control-disabled", surface).text,
      tone: "muted",
    };
  if (!access.device?.send)
    return {
      label: c.permissionRequired,
      reason: managedControlCopyForSurface(locale, surface).send,
      tone: "muted",
    };
  if (live?.executionMode === "claude-follower" && live.status === "idle")
    return {
      label: claudeConnectionCopyForSurface(locale, surface).connected,
      reason:
        claudeConnectionReason(locale, reason, surface) ??
        claudeConnectionCopyForSurface(locale, surface).info,
      tone: "active",
    };
  if (
    !canSend &&
    (((!controlReady || !live) && (!reason || reason === "handoff-required")) ||
      (state.selected &&
        (state.current?.id !== state.selected ||
          live?.sessionId !== state.selected ||
          (capabilities && capabilities.sessionId !== state.selected))))
  )
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  if (controlReady && live?.status === "idle" && live.lastOutcome === "cancelled")
    return { label: c.cancelled, reason: "", tone: "muted" };
  if (canSend) return { label: c.ready, reason: "", tone: "active" };
  if (
    reason === "handoff-required" &&
    !access.device.manage &&
    capabilities?.features.adopt?.available
  )
    return {
      label: c.permissionRequired,
      reason: managedControlCopyForSurface(locale, surface).management,
      tone: "muted",
    };
  if (reason)
    return {
      label: reason === "unverified-installation" ? c.unverified : c.readonly,
      reason: codexReason(locale, reason, surface).text,
      tone: "muted",
    };
  if (!controlReady || !live)
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  return { label: c.readonly, reason: c.readonly, tone: "muted" };
}
