import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert, CirclePause, Copy, LoaderCircle, TriangleAlert } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform, type SessionPlatform } from "../../session-platform";
import type { SessionTerminalPanelProps } from "../session-connection-panels";
import { claudeConnectionCopy, claudeConnectionReason } from "./connection-copy";
import { readClaudeBridgePluginStatus, type ClaudeBridgePluginStatus } from "./plugin-status";
import { ClaudeTerminalHandover } from "./terminal-handover";
import { DelayedSpinner, LoadingSkeleton } from "../../loading-feedback";
import { useDelayedBusy } from "../../delayed-busy";

type ClaudeBridgeStatus = {
  connectionCliVersion?: string;
  connectionError?: string;
  supported: boolean;
  connected: boolean;
  /** A verified, unrevoked original binding; independent of the current terminal lease. */
  hasBinding?: boolean;
  sessionId: string;
  version: string;
  reason?: string;
  pluginDirectory: string;
  autoConnect?: { available: boolean; enabled: boolean; declined?: boolean };
  pluginUpdate?: ClaudeBridgePluginStatus;
};

type ClaudeBridgeChallenge = { challenge: string; expiresAt: string; instructions: string };

const incompatibleReasons = new Set([
  "bridge-cli-too-old",
  "bridge-cli-unsupported",
  "bridge-capabilities-missing",
  "bridge-plugin-update-required",
  "bridge-version-mismatch",
]);

function ActionProgress({ active }: { active: boolean }) {
  return (
    <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
      <DelayedSpinner active={active} />
    </span>
  );
}

function CommandBlock({
  value,
  copy,
  label,
  copied,
  onCopy,
  truncate = false,
}: {
  value: string;
  copy: string;
  label: string;
  copied: boolean;
  onCopy: () => void;
  truncate?: boolean;
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const [expanded, setExpanded] = useState(false);
  const text = <code className={truncate && !expanded ? "line-clamp-2" : "block"}>{value}</code>;
  return (
    <div className="relative min-w-0 rounded-lg border bg-muted/50 p-3 pt-11">
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1.5 right-2"
        aria-label={label}
        data-copied={copied || undefined}
        onClick={onCopy}
      >
        {copied ? (
          <Check className="text-emerald-600" aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {copy}
      </Button>
      {truncate ? (
        <Button
          variant="bare"
          size="content"
          type="button"
          title={value}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="block w-full min-w-0 cursor-pointer select-text whitespace-pre-wrap break-all rounded-sm text-left font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
        >
          {text}
        </Button>
      ) : (
        <pre
          className="select-text whitespace-pre-wrap break-all text-xs leading-relaxed"
          style={{ margin: 0, padding: 0, border: 0, background: "transparent" }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function statusResponse(value: unknown, sessionId: string): ClaudeBridgeStatus {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    value.sessionId !== sessionId
  )
    throw new Error("invalid_bridge_status");
  const row = value as Record<string, unknown>;
  if (
    typeof row.supported !== "boolean" ||
    typeof row.connected !== "boolean" ||
    (row.hasBinding !== undefined && typeof row.hasBinding !== "boolean") ||
    typeof row.version !== "string" ||
    typeof row.pluginDirectory !== "string" ||
    (row.connectionError !== undefined && typeof row.connectionError !== "string") ||
    (row.connectionCliVersion !== undefined && typeof row.connectionCliVersion !== "string") ||
    (row.bridgeCompatibility !== undefined &&
      row.bridgeCompatibility !== null &&
      (!row.bridgeCompatibility ||
        typeof row.bridgeCompatibility !== "object" ||
        !("cliVersion" in row.bridgeCompatibility) ||
        typeof row.bridgeCompatibility.cliVersion !== "string" ||
        !("status" in row.bridgeCompatibility) ||
        !["verified", "unverified"].includes(String(row.bridgeCompatibility.status)))) ||
    (row.autoConnect !== undefined && !autoConnectResponse(row.autoConnect))
  )
    throw new Error("invalid_bridge_status");
  return {
    ...(value as ClaudeBridgeStatus),
    pluginUpdate: readClaudeBridgePluginStatus(row.pluginUpdate),
  };
}
function autoConnectResponse(value: unknown): ClaudeBridgeStatus["autoConnect"] {
  if (
    !value ||
    typeof value !== "object" ||
    !("available" in value) ||
    typeof value.available !== "boolean" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    ("declined" in value && typeof value.declined !== "boolean")
  )
    return undefined;
  return {
    available: value.available,
    enabled: value.enabled,
    declined: "declined" in value && value.declined === true,
  };
}
function challengeResponse(value: unknown): ClaudeBridgeChallenge {
  if (!value || typeof value !== "object") throw new Error("invalid_bridge_challenge");
  const row = value as Record<string, unknown>;
  if (
    typeof row.challenge !== "string" ||
    !row.challenge ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    typeof row.instructions !== "string"
  )
    throw new Error("invalid_bridge_challenge");
  return value as ClaudeBridgeChallenge;
}

/** Local owner IPC only; no connection credentials or paths are accepted from Web. */
export function ClaudeBridgePanel(props: SessionTerminalPanelProps) {
  const { components, desktop } = useSessionPlatform();
  const { collapsible } = components;
  return desktop && collapsible ? (
    <ClaudeTerminalBridge
      {...props}
      components={components}
      collapsible={collapsible}
      desktop={desktop}
    />
  ) : null;
}

function ClaudeTerminalBridge({
  active,
  onClose,
  session,
  components: { Button, SessionDialog: Dialog },
  collapsible: { Collapsible, CollapsibleContent, CollapsibleTrigger },
  desktop: {
    components: { Badge, Switch },
    requestBridge,
  },
}: SessionTerminalPanelProps & {
  components: SessionPlatform["components"];
  collapsible: NonNullable<SessionPlatform["components"]["collapsible"]>;
  desktop: NonNullable<SessionPlatform["desktop"]>;
}) {
  const {
    selected,
    current,
    live,
    access,
    online,
    controlReady,
    busy,
    loadingEarlier,
    locale,
    notice,
    capabilities,
    runSessionAction,
  } = session;
  const copy = claudeConnectionCopy[locale];
  const [statusObservation, setStatusObservation] = useState<{
    status: ClaudeBridgeStatus;
    connectionGeneration?: string;
  }>();
  const [bindingEvidence, setBindingEvidence] = useState<{ sessionId: string }>();
  // An observation describes the lease that was current when its read began.
  // A later live generation must obtain its own confirmation, even while gated.
  const status =
    statusObservation?.status.sessionId === selected &&
    statusObservation.connectionGeneration === live?.connectionGeneration
      ? statusObservation.status
      : undefined;
  const [challenge, setChallenge] = useState<
    ClaudeBridgeChallenge & {
      sessionId: string;
      connectionGeneration?: string;
    }
  >();
  const incompatible = incompatibleReasons.has(status?.connectionError ?? "");
  const [expired, setExpired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<"disconnect" | "clear">();
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  // Expiry and status checks can move the inline confirmation to another card.
  // Focus the new cancel button on mount, including after a pending clear fails.
  const focusCancelConfirmation = useCallback((button: HTMLButtonElement | null) => {
    cancelConfirmation.current = button;
    button?.focus();
  }, []);
  const hadConfirmation = useRef(false);
  useEffect(() => {
    if (confirmDisconnect) cancelConfirmation.current?.focus();
    else if (hadConfirmation.current) revokeTrigger.current?.focus();
    hadConfirmation.current = !!confirmDisconnect;
  }, [confirmDisconnect, loading]);
  const [revokedBinding, setRevokedBinding] = useState<{
    connectionGeneration?: string;
    runtimeBootId?: string;
  }>();
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState(false);
  const [copyingResume, setCopyingResume] = useState(false);
  const resumeCopyWaiting = useDelayedBusy(copyingResume);
  const resumeRequest = useRef<AbortController | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const copyRequest = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);
  const clearCopyFeedback = useCallback(() => {
    window.clearTimeout(copyTimer.current);
    copyTimer.current = undefined;
    setCopied("");
    setCopyError(false);
  }, []);
  const invalidateCopyFeedback = useCallback(() => {
    copyRequest.current++;
    clearCopyFeedback();
  }, [clearCopyFeedback]);
  function showCopyFeedback(label: string, request: number) {
    window.clearTimeout(copyTimer.current);
    setCopied(label);
    copyTimer.current = window.setTimeout(() => {
      if (copyRequest.current !== request) return;
      copyTimer.current = undefined;
      setCopied("");
    }, 1500);
  }
  const operationRequest = useRef(0);
  const pendingOperation = useRef<"bridge-challenge" | "bridge-disconnect" | undefined>(undefined);
  const pending = useRef(false);
  const pluginRetryPending = useRef(false);
  const [retryingPlugin, setRetryingPlugin] = useState(false);
  const lastConnected = useRef(false);
  const canRevoke = !!(
    active &&
    selected &&
    current?.id === selected &&
    current.agent === "claude-code" &&
    access?.status === "approved" &&
    access.protocolVersion === 2 &&
    access.device?.manage &&
    online
  );
  const canManage = !!(
    canRevoke &&
    access?.experimentalEnabled &&
    controlReady &&
    !busy &&
    !loadingEarlier &&
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown"
  );
  // A status refresh or a busy/idle transition must not revoke a displayed code.
  useEffect(() => {
    generation.current++;
    pending.current = false;
    pendingOperation.current = undefined;
    pluginRetryPending.current = false;
    setRetryingPlugin(false);
    lastConnected.current = false;
    setChallenge(undefined);
    setStatusObservation(undefined);
    setBindingEvidence(undefined);
    setExpired(false);
    setError(false);
    setLoading(false);
    setConfirmDisconnect(undefined);
    setRevokedBinding(undefined);
    setCopied("");
    setCopyError(false);
    return () => {
      generation.current++;
    };
  }, [canRevoke, selected]);
  useEffect(() => {
    // A new terminal lease invalidates only a pending connection code. A
    // revocation must still process its ACK and fence the lease it revoked.
    if (pendingOperation.current === "bridge-challenge") {
      operationRequest.current++;
      pendingOperation.current = undefined;
      pending.current = false;
      setLoading(false);
    }
    setChallenge((previous) =>
      previous?.connectionGeneration === live?.connectionGeneration ? previous : undefined,
    );
  }, [live?.connectionGeneration]);
  useEffect(() => {
    if (!canManage) return;
    const request = generation.current;
    let disposed = false;
    let checking: number | undefined;
    async function check(showLoading: boolean) {
      if (
        (checking !== undefined && checking === statusRequest.current) ||
        pending.current ||
        pluginRetryPending.current ||
        disposed
      )
        return;
      const query = ++statusRequest.current;
      checking = query;
      const isCurrent = () =>
        !disposed && generation.current === request && statusRequest.current === query;
      if (showLoading) setLoading(true);
      try {
        const result = statusResponse(
          await requestBridge({ operation: "bridge-status", sessionId: selected }),
          selected,
        );
        if (isCurrent()) {
          if (result.hasBinding === true) {
            setBindingEvidence({ sessionId: selected });
            if (result.supported) setRevokedBinding(undefined);
          } else if (result.supported && result.hasBinding === false) setBindingEvidence(undefined);
          setStatusObservation({
            status: result,
            connectionGeneration: live?.connectionGeneration,
          });
          setError(false);
          if (incompatibleReasons.has(result.connectionError ?? "")) setChallenge(undefined);
          if (result.connectionError === "expired-bridge-challenge") {
            setChallenge(undefined);
            setExpired(true);
          }
          if (result.connected) {
            setRevokedBinding(undefined);
            setChallenge(undefined);
            setExpired(false);
            if (!lastConnected.current) void session.refresh(true);
          }
          lastConnected.current = result.connected;
        }
      } catch {
        if (isCurrent()) {
          setStatusObservation(undefined);
          setError(true);
        }
      } finally {
        if (checking === query) checking = undefined;
        if (isCurrent() && showLoading) setLoading(false);
      }
    }
    void check(true);
    // Keep observing after code expiry so failed connection attempts remain visible.
    const timer = window.setInterval(() => void check(false), 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (!pending.current) setLoading(false);
    };
  }, [canManage, selected, live?.connectionGeneration, revision, requestBridge]);
  if (
    revokedBinding &&
    live?.sessionId === selected &&
    live.executionMode === "claude-follower" &&
    live.connectionGeneration !== revokedBinding.connectionGeneration &&
    live.connectionGeneration !== revokedBinding.runtimeBootId
  )
    setRevokedBinding(undefined);
  // Disconnect publishes a boot-generation snapshot before returning its ACK.
  // Suppress both old snapshots until a different lease proves a new binding.
  const locallyRevoked =
    !!revokedBinding &&
    (revokedBinding.connectionGeneration === live?.connectionGeneration ||
      (!!revokedBinding.runtimeBootId &&
        revokedBinding.runtimeBootId === live?.connectionGeneration));
  // An unavailable source cannot disprove an existing live binding. Only a
  // successful owner lookup or a revocation ACK can clear that evidence.
  const bindingKnownAbsent = status?.supported && status.hasBinding === false;
  // A validated binding survives a lease change for display and revocation.
  // Confirming, copying and generating still require the new generation's status.
  const retainedBinding = !locallyRevoked && bindingEvidence?.sessionId === selected;
  const connected =
    !locallyRevoked &&
    ((status?.sessionId === selected && status.connected) ||
      (status?.hasBinding === undefined &&
        !bindingKnownAbsent &&
        live?.sessionId === selected &&
        live.executionMode === "claude-follower" &&
        live.status !== "unsupported" &&
        live.reason !== "claude-bridge-disconnected"));
  const hasBinding =
    !locallyRevoked &&
    !bindingKnownAbsent &&
    (status?.hasBinding === true ||
      retainedBinding ||
      connected ||
      (live?.sessionId === selected && live.executionMode === "claude-follower"));
  const canCopyResume = !!(
    canManage &&
    hasBinding &&
    !connected &&
    status?.supported &&
    !status.connectionError &&
    !error &&
    !loading
  );
  // Clean up before the newly enabled button can receive input. A passive
  // cleanup could otherwise abort a request started during the new commit.
  useLayoutEffect(() => {
    return () => {
      resumeRequest.current?.abort();
      resumeRequest.current = undefined;
      setCopyingResume(false);
    };
  }, [canCopyResume, selected, live?.connectionGeneration]);
  async function copyResumeCommand() {
    if (!canCopyResume || resumeRequest.current) return;
    const controller = new AbortController();
    resumeRequest.current = controller;
    const request = ++copyRequest.current;
    const scope = generation.current;
    const isCurrent = () =>
      !controller.signal.aborted && generation.current === scope && copyRequest.current === request;
    clearCopyFeedback();
    setCopyingResume(true);
    try {
      const result = await session.client.claudeResumeCommand(selected, controller.signal);
      if (!isCurrent()) return;
      if (
        result?.available !== true ||
        typeof result.command !== "string" ||
        !result.command.trim()
      )
        throw new Error("command-unavailable");
      await navigator.clipboard.writeText(result.command);
      if (isCurrent()) showCopyFeedback(copy.copyResumeCommand, request);
    } catch {
      if (isCurrent()) setCopyError(true);
    } finally {
      if (resumeRequest.current === controller) {
        resumeRequest.current = undefined;
        setCopyingResume(false);
      }
    }
  }
  async function copyText(value: string, label: string) {
    const request = ++copyRequest.current;
    const scope = generation.current;
    clearCopyFeedback();
    try {
      await navigator.clipboard.writeText(value);
      if (generation.current === scope && copyRequest.current === request)
        showCopyFeedback(label, request);
    } catch {
      if (generation.current === scope && copyRequest.current === request) {
        setCopied("");
        setCopyError(true);
      }
    }
  }
  useEffect(() => {
    if (!challenge) return;
    const expires = Date.parse(challenge.expiresAt);
    const timer = window.setTimeout(
      () => {
        setChallenge(undefined);
        setExpired(true);
      },
      Math.max(0, Math.min(expires - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [challenge]);
  async function run(operation: "bridge-challenge" | "bridge-disconnect") {
    if (
      (operation === "bridge-challenge"
        ? !canManage || status?.sessionId !== selected || !status.supported || connected
        : !canRevoke || !hasBinding) ||
      loading ||
      pending.current
    )
      return;
    // A lookup started before this operation cannot describe its connection code or result.
    statusRequest.current++;
    pending.current = true;
    pendingOperation.current = operation;
    const request = generation.current;
    const transaction = ++operationRequest.current;
    const isCurrent = () =>
      generation.current === request && operationRequest.current === transaction;
    setLoading(true);
    setError(false);
    setStatusObservation((previous) =>
      previous
        ? { ...previous, status: { ...previous.status, connectionError: undefined } }
        : previous,
    );
    copyRequest.current++;
    clearCopyFeedback();
    setChallenge(undefined);
    setExpired(false);
    try {
      const result = await requestBridge({ operation, sessionId: selected });
      if (!isCurrent()) return;
      if (operation === "bridge-challenge")
        setChallenge({
          ...challengeResponse(result),
          sessionId: selected,
          connectionGeneration: live?.connectionGeneration,
        });
      else {
        if (
          !result ||
          typeof result !== "object" ||
          !("disconnected" in result) ||
          result.disconnected !== true
        )
          throw new Error("invalid_bridge_disconnect");
        lastConnected.current = false;
        setBindingEvidence(undefined);
        setConfirmDisconnect(undefined);
        setRevokedBinding({
          connectionGeneration: live?.connectionGeneration,
          runtimeBootId: live?.runtimeBootId,
        });
        setStatusObservation((previous) =>
          previous
            ? { ...previous, status: { ...previous.status, connected: false, hasBinding: false } }
            : previous,
        );
        setRevision((value) => value + 1);
        void session.refresh(true);
      }
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      if (isCurrent()) {
        pending.current = false;
        pendingOperation.current = undefined;
        setLoading(false);
      }
    }
  }
  const [autoChange, setAutoChange] = useState<{ sessionId: string; enabled: boolean }>();
  const [autoFailed, setAutoFailed] = useState(false);
  // The setting belongs to the workspace; the selected session only names it.
  async function changeAutoConnect(enabled: boolean) {
    if (!canRevoke || autoChange) return;
    const target = selected;
    setAutoFailed(false);
    setAutoChange({ sessionId: target, enabled });
    try {
      const result = await requestBridge({
        operation: "bridge-auto-connect",
        sessionId: target,
        enabled,
      });
      const value = autoConnectResponse(
        result && typeof result === "object" && "autoConnect" in result
          ? result.autoConnect
          : undefined,
      );
      if (!value) throw new Error("invalid_bridge_auto_connect");
      setStatusObservation((previous) =>
        previous?.status.sessionId === target
          ? { ...previous, status: { ...previous.status, autoConnect: value } }
          : previous,
      );
    } catch {
      setAutoFailed(true);
    } finally {
      setAutoChange(undefined);
    }
  }
  const pluginUpdate = status?.pluginUpdate;
  const canRetryPlugin =
    canManage && !loading && !retryingPlugin && pluginUpdate?.automaticEnabled !== false;
  async function retryPlugin() {
    if (
      !canRetryPlugin ||
      pluginUpdate?.status !== "failed" ||
      pending.current ||
      pluginRetryPending.current
    )
      return;
    const request = generation.current;
    statusRequest.current++;
    pluginRetryPending.current = true;
    setRetryingPlugin(true);
    let result: ClaudeBridgePluginStatus;
    try {
      const value = readClaudeBridgePluginStatus(
        await requestBridge({ operation: "bridge-plugin-retry", sessionId: selected }),
      );
      if (!value) throw new Error("invalid_bridge_plugin_status");
      result = value;
    } catch {
      result = { ...pluginUpdate, reason: undefined };
    }
    if (generation.current !== request) return;
    setStatusObservation((previous) =>
      previous?.status.sessionId === selected
        ? { ...previous, status: { ...previous.status, pluginUpdate: result } }
        : previous,
    );
    pluginRetryPending.current = false;
    setRetryingPlugin(false);
  }
  const autoConnect = status?.autoConnect;
  const autoEnabled =
    autoChange?.sessionId === selected ? autoChange.enabled : autoConnect?.enabled === true;
  const platformUnsupported = status?.reason === "platform-unsupported";
  // The live fallback still guards code generation, but only a fresh status can
  // promise that the terminal is connected in this dialog.
  const uncertain = notice === "uncertain" || live?.status === "outcome-unknown";
  const liveDisconnected =
    live?.sessionId === selected &&
    live.executionMode === "claude-follower" &&
    live.reason === "claude-bridge-disconnected";
  const confirmedConnected = !!(
    online &&
    !uncertain &&
    !error &&
    !liveDisconnected &&
    status?.connected
  );
  const connectionExpired = expired || status?.connectionError === "expired-bridge-challenge";
  const problem = !online
    ? copy.hostDisconnectedInfo
    : uncertain
      ? copy.connectionUnconfirmed
      : error
        ? copy.failed
        : !status && hasBinding && !liveDisconnected && !retainedBinding
          ? copy.statusUnavailable
          : status?.connectionError && status.connectionError !== "expired-bridge-challenge"
            ? status.connectionError === "control-outcome-unconfirmed"
              ? copy.connectionUnconfirmed
              : (claudeConnectionReason(locale, status.connectionError, "desktop", {
                  cliVersion: status.connectionCliVersion,
                }) ?? copy.failed)
            : status && !status.supported
              ? (claudeConnectionReason(locale, status.reason) ?? copy.failed)
              : undefined;
  const displayedChallenge =
    !incompatible &&
    challenge?.sessionId === selected &&
    challenge.connectionGeneration === live?.connectionGeneration &&
    canRevoke
      ? challenge
      : undefined;
  const stateKind = problem
    ? "error"
    : confirmedConnected
      ? "connected"
      : connectionExpired
        ? "expired"
        : hasBinding && !displayedChallenge
          ? "reconnecting"
          : "steps";
  // Fence clipboard completions and timers before the next connection scope
  // can receive input, including when a dialog closes without unmounting.
  useLayoutEffect(
    () => invalidateCopyFeedback,
    [
      active,
      canRevoke,
      selected,
      live?.connectionGeneration,
      connected,
      stateKind,
      status?.supported,
      status?.connectionError,
      invalidateCopyFeedback,
    ],
  );
  if (!active || current?.agent !== "claude-code" || !access?.device?.manage) return null;
  const canGenerate = canManage && !!status?.supported && !connected && !loading;
  const generating = loading && pendingOperation.current === "bridge-challenge";
  const disconnecting = loading && pendingOperation.current === "bridge-disconnect";
  const checkingConnection = loading && !generating && !disconnecting;
  const checkConnection = (
    <Button
      variant="link"
      size="sm"
      disabled={!canManage || loading}
      aria-busy={checkingConnection || undefined}
      onClick={() => setRevision((value) => value + 1)}
    >
      {copy.refresh}
      <ActionProgress active={checkingConnection} />
    </Button>
  );
  const revokeButton = hasBinding && (
    <Button
      ref={revokeTrigger}
      variant={stateKind === "reconnecting" ? "link" : "outline"}
      disabled={!canRevoke || loading}
      onClick={() => setConfirmDisconnect(confirmedConnected ? "disconnect" : "clear")}
    >
      {confirmedConnected ? copy.disconnectShort : copy.clearConnection}
    </Button>
  );
  const revocation = confirmDisconnect ? (
    <div
      role="group"
      aria-label={confirmDisconnect === "clear" ? copy.clearConnection : copy.disconnect}
      className="min-w-0 space-y-2"
    >
      <p className="text-sm">
        {confirmDisconnect === "clear" ? copy.clearConnectionInfo : copy.disconnectConfirmInfo}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={focusCancelConfirmation}
          variant="outline"
          disabled={loading}
          onClick={() => setConfirmDisconnect(undefined)}
        >
          {copy.cancel}
        </Button>
        <Button
          variant="destructive"
          disabled={loading || !canRevoke || !hasBinding}
          aria-busy={disconnecting || undefined}
          onClick={() => void run("bridge-disconnect")}
        >
          {confirmDisconnect === "clear" ? copy.confirmClearConnection : copy.confirmDisconnect}
          <ActionProgress active={disconnecting} />
        </Button>
      </div>
    </div>
  ) : (
    revokeButton
  );
  function commandBlock(value: string, label: string, truncate = false) {
    return (
      <CommandBlock
        key={value}
        value={value}
        copy={copy.copy}
        label={label}
        copied={copied === label}
        truncate={truncate}
        onCopy={() => void copyText(value, label)}
      />
    );
  }
  const command = displayedChallenge && (
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium">{copy.pasteStep}</h3>
      {commandBlock(displayedChallenge.instructions, copy.copyCommand, true)}
      <p className="text-xs text-muted-foreground">
        {copy.codeExpiresSafety.replace(
          "{time}",
          new Date(displayedChallenge.expiresAt).toLocaleTimeString(locale, {
            hour: "numeric",
            minute: "2-digit",
          }),
        )}
      </p>
      <Collapsible className="text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="link"
            size="content"
            disabled={!canGenerate}
            onClick={() => void run("bridge-challenge")}
          >
            {copy.regenerate}
          </Button>
          <CollapsibleTrigger className="cursor-pointer rounded-sm text-left text-primary-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {copy.copyOptions}
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="mt-2 min-w-0 space-y-2">
          <code className="block select-text break-all">{displayedChallenge.challenge}</code>
          <Button
            variant="outline"
            size="sm"
            data-copied={copied === copy.copyCode || undefined}
            onClick={() => void copyText(displayedChallenge.challenge, copy.copyCode)}
          >
            {copied === copy.copyCode ? (
              <Check className="text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copy.copyCode}
          </Button>
        </CollapsibleContent>
      </Collapsible>
      {hasBinding && <div className="rounded-lg border bg-muted/30 p-3">{revocation}</div>}
    </div>
  );
  const badge = !platformUnsupported && (
    <Badge
      variant="outline"
      className={`rounded-full border-transparent ${confirmedConnected ? "bg-[color-mix(in_srgb,var(--green)_10%,transparent)] text-[var(--green)]" : "bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-muted-foreground"}`}
    >
      <ActionProgress active={checkingConnection} />
      {confirmedConnected ? copy.connectedBadge : copy.notConnected}
    </Badge>
  );
  const scopeLabels = {
    user: copy.pluginScopeUser,
    project: copy.pluginScopeProject,
    local: copy.pluginScopeLocal,
  };
  const reloadTerminal =
    status?.supported &&
    online &&
    !status.connected &&
    pluginUpdate?.installations?.some(({ scope }) => scope === "user");
  const pluginInfo = pluginUpdate && (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="text-muted-foreground">
        {(pluginUpdate.installations === undefined || pluginUpdate.installedVersion === null) && (
          <>
            {pluginUpdate.installedVersion === null
              ? copy.pluginNotInstalled
              : copy.pluginInstalledVersion.replace("{version}", pluginUpdate.installedVersion)}
            {" · "}
          </>
        )}
        {copy.pluginBundledVersion.replace("{version}", pluginUpdate.bundledVersion)}
      </p>
      {!!pluginUpdate.installations?.length && (
        <ul className="space-y-1 text-muted-foreground">
          {pluginUpdate.installations.map(({ scope, version, projectPath }) => (
            <li className="break-words" key={JSON.stringify([scope, projectPath, version])}>
              {scopeLabels[scope]} · {version}
              {projectPath && ` · ${projectPath}`}
            </li>
          ))}
        </ul>
      )}
      {reloadTerminal && <p>{copy.pluginReload}</p>}
      {(pluginUpdate.status === "failed" || retryingPlugin) && (
        <>
          {!retryingPlugin && (
            <div role="alert" className="space-y-1">
              <p>
                {pluginUpdate.installations ? copy.pluginAutomaticFailed : copy.pluginUpdateFailed}
              </p>
              {pluginUpdate.reason && (
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {pluginUpdate.reason}
                </p>
              )}
              {pluginUpdate.installInstructions &&
                commandBlock(pluginUpdate.installInstructions, copy.copyInstall)}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!canRetryPlugin}
            title={pluginUpdate.automaticEnabled === false ? copy.pluginAutomaticOff : undefined}
            aria-busy={retryingPlugin || undefined}
            onClick={() => void retryPlugin()}
          >
            {copy.pluginRetry}
            <ActionProgress active={retryingPlugin} />
          </Button>
        </>
      )}
    </div>
  );
  const caution = !online || uncertain || (!status && hasBinding && !liveDisconnected);
  const StateIcon =
    stateKind === "reconnecting" ? CirclePause : caution ? TriangleAlert : CircleAlert;
  const stateIconClass =
    stateKind === "reconnecting"
      ? "text-muted-foreground"
      : caution
        ? "text-[var(--amber)]"
        : "text-destructive-icon";
  const handoverFeatures = capabilities?.sessionId === selected ? capabilities.features : undefined;
  const handoverReason = live?.terminalHandover?.reason;
  const handover = runSessionAction && live?.sessionId === selected && live.terminalHandover && (
    <ClaudeTerminalHandover
      key={selected}
      locale={locale}
      live={live}
      ready={online && controlReady && !busy && !loading && !confirmDisconnect}
      localAvailable={handoverFeatures?.["adopt-terminal"]?.available === true}
      forceAvailable={handoverFeatures?.["handover-terminal"]?.available === true}
      unavailableReason={
        handoverReason ? claudeConnectionReason(locale, handoverReason) : undefined
      }
      onAdopt={() => runSessionAction("adopt-terminal")}
      onTransfer={(turnId) =>
        runSessionAction("handover-terminal", {
          handoffConfirmed: true,
          ...(turnId ? { turnId } : {}),
        })
      }
    />
  );
  const content = (
    <section
      className="min-w-0 space-y-4"
      aria-label={copy.title}
      onKeyDownCapture={(event) => {
        if (confirmDisconnect && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!pending.current) setConfirmDisconnect(undefined);
        }
      }}
    >
      {!onClose && badge}
      {platformUnsupported ? (
        <p className="text-sm" role="status">
          {copy.unsupportedTitle}
        </p>
      ) : (
        <>
          {pluginInfo ? (
            <div className="space-y-1">
              <h3
                className="flex items-center gap-2 text-sm font-medium"
                aria-busy={pluginUpdate?.status === "updating" || undefined}
              >
                {copy.pluginScopes}
                {pluginUpdate?.status === "updating" && <ActionProgress active />}
              </h3>
              {pluginInfo}
            </div>
          ) : checkingConnection && !status ? (
            <LoadingSkeleton label={copy.loading} rows={1} />
          ) : null}
          {stateKind === "connected" ? (
            <div>{revocation}</div>
          ) : stateKind === "steps" ? (
            <div className="min-w-0 space-y-2">
              {command ? (
                <>
                  {command}
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm" role="status">
                      {copy.waiting}
                    </p>
                    {checkConnection}
                  </div>
                </>
              ) : (
                <Button
                  disabled={!canGenerate}
                  aria-busy={generating || undefined}
                  onClick={() => void run("bridge-challenge")}
                >
                  {copy.generate}
                  <ActionProgress active={generating} />
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-start gap-2">
                <StateIcon
                  className={`mt-0.5 size-4 shrink-0 ${stateIconClass}`}
                  aria-hidden="true"
                />
                {stateKind === "error" ? (
                  <p
                    role="alert"
                    className={`text-sm ${caution ? "text-[var(--amber)]" : "text-destructive-text"}`}
                  >
                    {problem}
                  </p>
                ) : (
                  <p role="status" className="text-sm font-medium">
                    {stateKind === "expired" ? copy.expiredTitle : copy.reconnectingTitle}
                  </p>
                )}
              </div>
              {stateKind !== "expired" && command}
              {(!command || stateKind === "expired") &&
                (confirmDisconnect ? (
                  revocation
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {stateKind === "reconnecting" && (
                      <Button
                        variant="outline"
                        disabled={!canCopyResume || copyingResume}
                        aria-busy={copyingResume}
                        data-copied={copied === copy.copyResumeCommand || undefined}
                        onClick={() => void copyResumeCommand()}
                      >
                        {resumeCopyWaiting ? (
                          <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
                        ) : copied === copy.copyResumeCommand ? (
                          <Check className="text-emerald-600" aria-hidden="true" />
                        ) : (
                          <Copy aria-hidden="true" />
                        )}
                        {copy.copyResumeCommand}
                      </Button>
                    )}
                    {stateKind === "error" && checkConnection}
                    <Button
                      variant={
                        stateKind === "expired"
                          ? "default"
                          : stateKind === "reconnecting"
                            ? "link"
                            : "outline"
                      }
                      disabled={!canGenerate}
                      aria-busy={generating || undefined}
                      onClick={() => void run("bridge-challenge")}
                    >
                      {stateKind === "reconnecting" ? copy.regenerateConnection : copy.regenerate}
                      <ActionProgress active={generating} />
                    </Button>
                    {revokeButton}
                  </div>
                ))}
              {command && stateKind !== "expired" && checkConnection}
            </div>
          )}
        </>
      )}
      {handover && <div className="flex justify-end gap-2 border-t pt-4">{handover}</div>}
      {!platformUnsupported && autoConnect?.available && (
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{copy.autoConnect}</p>
            {autoFailed && (
              <p role="alert" className="text-xs text-destructive-text">
                {copy.autoConnectFailed}
              </p>
            )}
          </div>
          <Switch
            aria-label={copy.autoConnect}
            checked={autoEnabled}
            disabled={!canRevoke || !!autoChange}
            onCheckedChange={(checked) => void changeAutoConnect(checked)}
          />
        </div>
      )}
      {copyError && (
        <p role="alert" className="text-sm">
          {copy.copyFailed}
        </p>
      )}
    </section>
  );
  return onClose ? (
    <Dialog
      panel
      title={copy.title}
      description={
        <span className="block truncate" title={session.currentTitle ?? current.title}>
          {session.currentTitle ?? current.title} · Claude Code
        </span>
      }
      closeLabel={session.t?.close ?? copy.cancel}
      onClose={() => {
        if (confirmDisconnect) {
          if (!pending.current) setConfirmDisconnect(undefined);
        } else onClose();
      }}
      headerAdornment={badge}
      className="sm:max-w-2xl"
    >
      {content}
    </Dialog>
  ) : (
    content
  );
}
