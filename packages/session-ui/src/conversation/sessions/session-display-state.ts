import { isLiveSessionAgent } from "@agentkib/web-client";
import { contextUsageCopyForSurface } from "../../context-usage-copy";
import {
  claudeTerminalDisplay,
  dshNativeStatusDisplay,
  sessionContinuationCopy,
} from "../../session-continuation";
import type { SessionSurface } from "../../session-surface-copy";
import { sessionProviderControlsDisabled } from "../../session-provider";
import {
  claudeConnectionCopyForSurface,
  claudeConnectionReason,
} from "../../agents/claude-code/connection-copy";
import { claudeReconnectFailureReason } from "../../agents/claude-code/connection-notice";
import { sessionReason } from "./session-copy";
import { managedControlCopyForSurface } from "./managed-control-copy";
import type { SessionController } from "./use-session-controller";
import { webLayoutCopy } from "./web-layout-copy";

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
> & {
  pendingSend?: SessionController["pendingSend"];
  settingsNotice?: Pick<NonNullable<SessionController["settingsNotice"]>, "status">;
  settingsOnlyBlocked?: boolean;
};

type DisplayState = {
  label: string;
  reason: string;
  tone: "warning" | "active" | "muted";
  loading?: boolean;
  offline?: boolean;
  continuation?:
    | "idle"
    | "starting"
    | "running"
    | "terminal"
    | "terminal-watch"
    | "busy"
    | "codex"
    | "dsh"
    | "dsh-observed"
    | "status-unknown"
    | "view-only";
};

/** Presentation only: never grants capabilities or changes dispatch eligibility. */
export function sessionDisplayState(
  state: State,
  surface: SessionSurface,
  unavailableReason: Parameters<typeof sessionReason>[3],
): DisplayState {
  const { live, online, canSend, access, capabilities, locale } = state;
  const settingsOnlyBlocked = state.settingsOnlyBlocked === true;
  const controlReady = state.controlReady || settingsOnlyBlocked;
  const busy = state.busy && !settingsOnlyBlocked;
  const c = webLayoutCopy[locale];
  const reason =
    live?.reason === "handoff-required" &&
    capabilities?.reason &&
    capabilities.reason !== "handoff-required"
      ? capabilities.reason
      : live?.reason || capabilities?.features.send?.reason || capabilities?.reason;
  if (
    sessionProviderControlsDisabled(
      access,
      state.current?.id === state.selected ? state.current?.agent : undefined,
      live?.sessionId === state.selected || capabilities?.sessionId === state.selected
        ? reason
        : undefined,
    )
  )
    return { label: "", reason: "", tone: "muted" };
  // An explicit fence classification excludes pending message outcomes. Only controllers without
  // that signal infer a settings-only receipt from the current session's idle host projection.
  const settingsReceiptOnly =
    state.settingsOnlyBlocked === undefined &&
    state.settingsNotice?.status === "uncertain" &&
    !!state.selected &&
    state.current?.id === state.selected &&
    live?.sessionId === state.selected &&
    capabilities?.sessionId === state.selected &&
    capabilities.features.send?.available === true &&
    live.sendEnabled &&
    (live.status === "idle" ||
      (state.current.agent === "claude-code" && live.status === "released")) &&
    !live.ownershipReason &&
    live.activity !== "compacting" &&
    !busy &&
    !reason;
  const connectionReady = controlReady || settingsReceiptOnly;
  if (
    state.notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    reason === "control-outcome-unconfirmed" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed"
  )
    return {
      label: c.uncertain,
      reason: sessionReason(locale, "control-outcome-unconfirmed", surface, unavailableReason).text,
      tone: "warning",
    };
  if (
    state.current?.availability === "metadata-only" ||
    (state.current &&
      (("remote" in state.current && state.current.remote) ||
        !isLiveSessionAgent(state.current.agent) ||
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
      offline: true,
    };
  const idleUnderSettings = settingsOnlyBlocked && live?.status === "idle" && !reason;
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
        reason: sessionReason(locale, "control-disabled", surface, unavailableReason).text,
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
    // The Codex app holds the thread with no window on it: a message asks the app to take it.
    if (live.ownerHandoff === true && live.sendEnabled)
      return { label: copy.codexHandoff, reason: "", tone: "muted", continuation: "codex" };
    if (live.executionMode === "codex-follower")
      return {
        label: copy.codexConnected,
        reason: "",
        tone: "muted",
        continuation: "codex",
      };
    // Capabilities can still describe the previous owner while live state changes.
    const codexStateReason = reason === "codex-owner-busy" ? live.reason : reason;
    if (
      !live.sendEnabled &&
      (live.reason === "codex-owner-busy" ||
        (!live.reason && live.ownershipReason === "codex-owner-busy"))
    )
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
    if (!connectionReady)
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (canSend || (live.sendEnabled && !codexStateReason) || idleUnderSettings)
      return { label: "", reason: "", tone: "muted", continuation: "idle" };
    return {
      label: copy.viewOnly,
      reason: sessionReason(locale, codexStateReason, surface, unavailableReason).text,
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
        reason: sessionReason(locale, "control-disabled", surface, unavailableReason).text,
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
    if (live.executionLocation === "terminal") return claudeTerminalDisplay(copy, live);
    if (live.executionLocation === "agentkib")
      return { label: copy.running, reason: "", tone: "active", continuation: "running" };
    if (!connectionReady)
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (canSend || (live.sendEnabled && !reason) || idleUnderSettings)
      return { label: "", reason: "", tone: "muted", continuation: "idle" };
    return {
      label: copy.viewOnly,
      reason:
        reason === "platform-unsupported"
          ? copy.claudeWindowsUnsupported
          : (claudeReconnectFailureReason(live, locale, surface) ??
            claudeConnectionReason(locale, reason, surface) ??
            sessionReason(locale, reason, surface, unavailableReason).text),
      tone: "muted",
      continuation: "view-only",
    };
  }
  if (state.current?.agent === "deepseek-harness") {
    const copy = sessionContinuationCopy(locale);
    if (state.current.id === state.selected && live?.sessionId === state.selected) {
      const native = dshNativeStatusDisplay(live, locale);
      if (native) return native;
    }
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
        reason: sessionReason(locale, "control-disabled", surface, unavailableReason).text,
        tone: "muted",
      };
    if (!access.device?.send)
      return {
        label: c.permissionRequired,
        reason: managedControlCopyForSurface(locale, surface).send,
        tone: "muted",
      };
    if (
      state.current.id !== state.selected ||
      live?.sessionId !== state.selected ||
      capabilities?.sessionId !== state.selected
    )
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (live.executionMode === "dsh-follower") {
      if (live.questions?.length) return { label: c.question, reason: c.question, tone: "warning" };
      if (live.approvals?.length) return { label: c.approval, reason: c.approval, tone: "warning" };
      if (live.activity === "compacting")
        return {
          label: contextUsageCopyForSurface(locale, surface).compacting,
          reason: "",
          tone: "active",
        };
      if (live.executionLocation === "external") {
        const working = live.status === "running";
        return {
          label: working ? copy.runningIn("DeepSeek Harness") : copy.dshConnected,
          reason: "",
          tone: working ? "active" : "muted",
          continuation: "dsh",
        };
      }
      if (live.status === "running")
        return { label: copy.running, reason: "", tone: "active", continuation: "running" };
      if (state.pendingSend?.sessionId === state.selected && live.executionLocation !== "agentkib")
        return {
          label: copy.starting,
          reason: "",
          tone: "muted",
          loading: true,
          continuation: "starting",
        };
      if (!connectionReady)
        return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
      if (canSend || (live.sendEnabled && !reason) || idleUnderSettings)
        return { label: "", reason: "", tone: "muted", continuation: "idle" };
    }
    return {
      label: copy.viewOnly,
      reason: sessionReason(locale, reason, surface, unavailableReason).text,
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
      reason: sessionReason(locale, live.reason, surface, unavailableReason).text,
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
      reason: "",
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
      reason: sessionReason(locale, live.reason, surface, unavailableReason).text,
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
      reason: sessionReason(locale, "control-disabled", surface, unavailableReason).text,
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
    (((!connectionReady || !live) && (!reason || reason === "handoff-required")) ||
      (state.selected &&
        (state.current?.id !== state.selected ||
          live?.sessionId !== state.selected ||
          (capabilities && capabilities.sessionId !== state.selected))))
  )
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  if (controlReady && live?.status === "idle" && live.lastOutcome === "cancelled")
    return { label: c.cancelled, reason: "", tone: "muted" };
  if (idleUnderSettings) return { label: "", reason: "", tone: "muted", continuation: "idle" };
  if (canSend || settingsReceiptOnly) return { label: c.ready, reason: "", tone: "active" };
  if (reason)
    return {
      label: reason === "unverified-installation" ? c.unverified : c.readonly,
      reason: sessionReason(locale, reason, surface, unavailableReason).text,
      tone: "muted",
    };
  if (!connectionReady || !live)
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  return { label: c.readonly, reason: c.readonly, tone: "muted" };
}
