import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { CLAUDE_BRIDGE_CLI_VERSION } from "@agentkib/runtime-protocol";
import { ClaudeCompatibilityNote } from "./claude-compatibility-note";
import type { ClaudeBridgeChallenge, ClaudeBridgeStatus } from "../../../../../../electron/api";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";

const incompatibleReasons = new Set([
  "bridge-cli-too-old",
  "bridge-cli-unsupported",
  "bridge-capabilities-missing",
  "bridge-plugin-update-required",
  "bridge-version-mismatch",
]);

function CommandBlock({
  value,
  copy,
  label,
  onCopy,
  truncate = false,
}: {
  value: string;
  copy: string;
  label: string;
  onCopy: () => void;
  truncate?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = <code className={truncate && !expanded ? "line-clamp-2" : "block"}>{value}</code>;
  return (
    <div className="relative min-w-0 rounded-lg border bg-muted/50 p-3 pt-11">
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-1.5 right-2"
        aria-label={label}
        onClick={onCopy}
      >
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
    typeof row.version !== "string" ||
    typeof row.pluginDirectory !== "string" ||
    typeof row.installInstructions !== "string" ||
    (row.connectionError !== undefined && typeof row.connectionError !== "string") ||
    (row.connectionCliVersion !== undefined && typeof row.connectionCliVersion !== "string") ||
    (row.bridgeCompatibility !== undefined &&
      row.bridgeCompatibility !== null &&
      (!row.bridgeCompatibility ||
        typeof row.bridgeCompatibility !== "object" ||
        !("cliVersion" in row.bridgeCompatibility) ||
        typeof row.bridgeCompatibility.cliVersion !== "string" ||
        !("status" in row.bridgeCompatibility) ||
        !["verified", "unverified"].includes(String(row.bridgeCompatibility.status))))
  )
    throw new Error("invalid_bridge_status");
  return value as ClaudeBridgeStatus;
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
export function ClaudeBridgePanel({ active, onClose }: { active: boolean; onClose?: () => void }) {
  const session = useSession();
  const { selected, current, live, access, online, controlReady, busy, locale, notice } = session;
  const copy = claudeConnectionCopy[locale];
  const [statusObservation, setStatusObservation] = useState<{
    status: ClaudeBridgeStatus;
    connectionGeneration?: string;
  }>();
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
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const statusRequest = useRef(0);
  const copyRequest = useRef(0);
  const pending = useRef(false);
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
    notice !== "uncertain" &&
    live?.status !== "outcome-unknown"
  );
  // A status refresh or a busy/idle transition must not revoke a displayed code.
  useEffect(() => {
    generation.current++;
    pending.current = false;
    lastConnected.current = false;
    setChallenge(undefined);
    setStatusObservation(undefined);
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
    if (!canManage) return;
    const request = generation.current;
    let disposed = false;
    let checking: number | undefined;
    async function check(showLoading: boolean) {
      if (
        (checking !== undefined && checking === statusRequest.current) ||
        pending.current ||
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
          await desktopApi().claude.request({ operation: "bridge-status", sessionId: selected }),
          selected,
        );
        if (isCurrent()) {
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
  }, [canManage, selected, live?.connectionGeneration, revision]);
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
  const connected =
    (status?.sessionId === selected && status.connected) ||
    (!locallyRevoked &&
      live?.sessionId === selected &&
      live.executionMode === "claude-follower" &&
      live.status !== "unsupported" &&
      live.reason !== "claude-bridge-disconnected");
  const hasBinding =
    connected ||
    (!locallyRevoked && live?.sessionId === selected && live.executionMode === "claude-follower");
  async function copyText(value: string, label: string) {
    const request = ++copyRequest.current;
    const scope = generation.current;
    setCopied("");
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      if (generation.current === scope && copyRequest.current === request) setCopied(label);
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
    const request = generation.current;
    setLoading(true);
    setError(false);
    setStatusObservation((previous) =>
      previous
        ? { ...previous, status: { ...previous.status, connectionError: undefined } }
        : previous,
    );
    copyRequest.current++;
    setCopied("");
    setCopyError(false);
    setChallenge(undefined);
    setExpired(false);
    try {
      const result = await desktopApi().claude.request({ operation, sessionId: selected });
      if (generation.current !== request) return;
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
        setConfirmDisconnect(undefined);
        setRevokedBinding({
          connectionGeneration: live?.connectionGeneration,
          runtimeBootId: live?.runtimeBootId,
        });
        setStatusObservation((previous) =>
          previous ? { ...previous, status: { ...previous.status, connected: false } } : previous,
        );
        setRevision((value) => value + 1);
        void session.refresh(true);
      }
    } catch {
      if (generation.current === request) setError(true);
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setLoading(false);
      }
    }
  }
  if (!active || current?.agent !== "claude-code" || !access?.device?.manage) return null;
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
        : !status && hasBinding && !liveDisconnected
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
    !incompatible && challenge?.sessionId === selected && canRevoke ? challenge : undefined;
  const stateKind = problem
    ? "error"
    : confirmedConnected
      ? "connected"
      : connectionExpired
        ? "expired"
        : (hasBinding || locallyRevoked || status?.reason === "claude-bridge-disconnected") &&
            !displayedChallenge
          ? "disconnected"
          : "steps";
  const canGenerate = canManage && !!status?.supported && !connected && !loading;
  const checkConnection = (
    <Button
      variant="link"
      size="sm"
      disabled={!canManage || loading}
      onClick={() => setRevision((value) => value + 1)}
    >
      {copy.refresh}
    </Button>
  );
  const revokeButton = hasBinding && (
    <Button
      ref={revokeTrigger}
      variant="outline"
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
          onClick={() => void run("bridge-disconnect")}
        >
          {confirmDisconnect === "clear" ? copy.confirmClearConnection : copy.confirmDisconnect}
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {copy.loading}
        </p>
      )}
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
        truncate={truncate}
        onCopy={() => void copyText(value, label)}
      />
    );
  }
  const command = displayedChallenge && (
    <div className="min-w-0 space-y-2">
      {commandBlock(displayedChallenge.instructions, copy.copyCommand, true)}
      <p className="text-xs text-muted-foreground">
        {copy.codeExpiresSafety.replace(
          "{time}",
          new Date(displayedChallenge.expiresAt).toLocaleTimeString(locale, {
            hour: "2-digit",
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
            onClick={() => void copyText(displayedChallenge.challenge, copy.copyCode)}
          >
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
      {confirmedConnected ? copy.connectedBadge : copy.notConnected}
    </Badge>
  );
  const installed = stateKind === "connected" || stateKind === "disconnected";
  const installContent = status?.installInstructions ? (
    commandBlock(status.installInstructions, copy.copyInstall)
  ) : (
    <p className="text-sm text-muted-foreground">{loading ? copy.loading : copy.instructions}</p>
  );
  const caution = !online || uncertain || (!status && hasBinding && !liveDisconnected);
  const StateIcon =
    stateKind === "connected"
      ? CircleCheck
      : stateKind === "disconnected" || caution
        ? TriangleAlert
        : CircleAlert;
  const stateIconClass =
    stateKind === "connected"
      ? "text-[var(--green)]"
      : stateKind === "disconnected" || caution
        ? "text-[var(--amber)]"
        : "text-destructive-icon";
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
      <div className="space-y-1">
        <p className="text-sm">{copy.flow}</p>
        <p className="text-xs text-muted-foreground">
          {copy.platformVersion.replace("{version}", status?.version ?? CLAUDE_BRIDGE_CLI_VERSION)}
        </p>
        {confirmedConnected && (
          <ClaudeCompatibilityNote locale={locale} compatibility={status?.bridgeCompatibility} />
        )}
      </div>
      {platformUnsupported ? (
        <div className="rounded-lg border bg-muted/30 p-4" role="status">
          <h3 className="font-medium">{copy.unsupportedTitle}</h3>
        </div>
      ) : (
        <ol className="space-y-0">
          <li className="relative min-w-0 border-l border-border pb-5 pl-7 ml-3">
            <span
              className={`absolute -left-3 top-0 grid size-6 place-items-center rounded-full text-xs ${installed ? "bg-[color-mix(in_srgb,var(--green)_10%,transparent)] text-[var(--green)]" : "bg-primary/10 text-primary-text"}`}
              aria-hidden="true"
            >
              {installed ? <Check className="size-3.5 text-[var(--green)]" /> : 1}
            </span>
            {installed ? (
              <Collapsible key={stateKind} defaultOpen={false}>
                <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-sm text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  {copy.installedStep}
                  <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted className="mt-2">
                  {installContent}
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <>
                <h3 className="mb-2 text-sm font-medium">{copy.installStep}</h3>
                {installContent}
              </>
            )}
          </li>
          {stateKind === "steps" ? (
            <>
              <li className="relative min-w-0 border-l border-border pb-5 pl-7 ml-3">
                <span
                  className="absolute -left-3 top-0 grid size-6 place-items-center rounded-full bg-primary/10 text-xs text-primary-text"
                  aria-hidden="true"
                >
                  2
                </span>
                <h3 className="mb-2 text-sm font-medium">{copy.generateStep}</h3>
                {command ?? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button disabled={!canGenerate} onClick={() => void run("bridge-challenge")}>
                      {copy.generate}
                    </Button>
                    <p className="text-xs text-muted-foreground">{copy.codeSafety}</p>
                  </div>
                )}
              </li>
              <li className="relative min-w-0 pl-7 ml-3">
                <span
                  className="absolute -left-3 top-0 grid size-6 place-items-center rounded-full border bg-background text-xs text-muted-foreground"
                  aria-hidden="true"
                >
                  3
                </span>
                <h3
                  className={`mb-2 text-sm font-medium ${!displayedChallenge ? "text-muted-foreground" : ""}`}
                >
                  {copy.pasteStep}
                </h3>
                {displayedChallenge ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="flex items-center gap-2 text-sm" role="status">
                      <LoaderCircle
                        className="size-4 animate-spin text-muted-foreground"
                        aria-hidden="true"
                      />
                      {copy.waiting}
                    </p>
                    {checkConnection}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{copy.pasteHint}</p>
                )}
              </li>
            </>
          ) : (
            <li className="relative min-w-0 pl-7 ml-3">
              <span
                className="absolute -left-3 top-0 grid size-6 place-items-center rounded-full bg-primary/10 text-xs text-primary-text"
                aria-hidden="true"
              >
                2
              </span>
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
                    <div role="status" className="min-w-0 space-y-1">
                      <h3 className="text-sm font-medium">
                        {stateKind === "connected"
                          ? copy.connectedTitle
                          : stateKind === "expired"
                            ? copy.expiredTitle
                            : copy.lostTitle}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {stateKind === "connected"
                          ? copy.connectedInfo
                          : stateKind === "expired"
                            ? copy.expiredInfo
                            : copy.disconnectedInfo}
                      </p>
                    </div>
                  )}
                </div>
                {stateKind !== "connected" && stateKind !== "expired" && command}
                {!command &&
                  (confirmDisconnect ? (
                    revocation
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {stateKind !== "connected" && (
                        <>
                          {stateKind !== "expired" && checkConnection}
                          <Button
                            variant={stateKind === "expired" ? "default" : "outline"}
                            disabled={!canGenerate}
                            onClick={() => void run("bridge-challenge")}
                          >
                            {copy.regenerate}
                          </Button>
                        </>
                      )}
                      {revokeButton}
                    </div>
                  ))}
                {command && stateKind !== "connected" && checkConnection}
              </div>
            </li>
          )}
        </ol>
      )}
      {copied && (
        <p role="status" className="text-xs text-muted-foreground">
          {copied} · {copy.copied}
        </p>
      )}
      {copyError && (
        <p role="alert" className="text-sm">
          {copy.copyFailed}
        </p>
      )}
      {loading && status && !confirmDisconnect && (
        <p role="status" className="text-xs text-muted-foreground">
          {copy.loading}
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
