import { continuationResources } from "./continuation-draft";
import {
  agentKibCommand,
  claudeSlashOptions,
  sessionContinuationCopy,
  SessionContinuationReturned,
  SessionContinuationTerminal,
  useSlashCommandMenu,
} from "@agentkib/session-ui";
import { SessionBusyChoice } from "./session-busy-choice";
import { SessionReadOnly } from "./session-read-only";
import { isSendEnter, useEnterSends } from "./composer-shortcuts";
import { claudeConnectionCopyForSurface } from "./claude-connection-copy";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUp,
  AlertTriangle,
  CornerDownRight,
  ListPlus,
  MoreHorizontal,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import {
  claudeCommandDecision,
  claudeMenuCommands,
  type UploadedAttachment,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { Input } from "../../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { ContextUsageGauge } from "./context-usage";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { sessionDisplayState } from "./session-display-state";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import { CodexComposerControls, type CodexResource } from "./codex-session-controls";
import { PermissionModeNotice } from "./permission-mode-notice";
import { ClaudeTurnNotice } from "./claude-turn-notice";

type Upload = {
  key: string;
  name: string;
  file?: File;
  percent: number;
  result?: UploadedAttachment;
  failed?: boolean;
  previewUrl?: string;
};
// A paired browser is a remote device, which may run only some Claude Code commands.
const COMMAND_OWNER = false;
export function SessionComposer({
  connectionStatusInBanner = false,
}: {
  connectionStatusInBanner?: boolean;
}) {
  const session = useSession();
  const {
    historyReferences = [],
    setHistoryReferences,
    selected,
    current,
    live,
    client,
    access,
    locale,
    t,
    message,
    setMessage,
    control,
    codexAction,
    controlReady,
    capabilities,
    canSend,
    canStop,
    busy,
    online,
    notice,
  } = session;
  const isClaude = current?.agent === "claude-code";
  const isCodex = current?.agent === "codex";
  const continuation = sessionContinuationCopy(locale);
  const returnKey = JSON.stringify([selected, live?.ownershipReason, live?.reason]);
  const [returnedFor, setReturnedFor] = useState<string | null>(null);
  useEffect(() => setReturnedFor(null), [returnKey]);
  const copy = codexCopyForSurface(locale, "web");
  const layout = composerLayoutCopy[locale];
  const display = sessionDisplayState(session, "web");
  const composerValue = message;
  const setComposerText = setMessage;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const submitPending = useRef(false);
  const composing = useRef(false);
  const enterSends = useEnterSends();
  const [error, setError] = useState("");
  const [resources, setResources] = useState<CodexResource[]>([]);
  const [previewKey, setPreviewKey] = useState<string>();
  const previewUrls = useRef(new Map<string, string>());
  const active = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);
  const count = useRef(0);
  const generation = useRef(0);
  const uploadPermission = !!(
    access?.device?.attachments &&
    capabilities?.sessionId === selected &&
    capabilities.features.attachments?.available
  );
  const commandCatalog =
    isClaude && capabilities?.sessionId === selected ? capabilities.commands : undefined;
  const commandOptions = useMemo(
    () =>
      commandCatalog
        ? claudeSlashOptions(claudeMenuCommands(commandCatalog, COMMAND_OWNER), locale)
        : [],
    [commandCatalog, locale],
  );
  // A refused command keeps its draft; the explanation goes once the draft changes.
  const [commandNotice, setCommandNotice] = useState<{ draft: string; reason: string }>();
  const slash = useSlashCommandMenu({
    value: composerValue,
    options: commandOptions,
    enabled: isClaude && online && controlReady && !busy && !submitted,
    catalogKnown: !!commandCatalog?.length,
    locale,
    onChoose: setMessage,
  });
  useEffect(() => {
    const controllers = active.current;
    const urls = previewUrls.current;
    setUploads([]);
    setResources([]);
    setSubmitted(false);
    submitPending.current = false;
    composing.current = false;
    setError("");
    setCommandNotice(undefined);
    setPreviewKey(undefined);
    count.current = 0;
    return () => {
      generation.current++;
      for (const abort of controllers.values()) abort.abort();
      controllers.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [selected, setComposerText]);
  useEffect(() => {
    if (access?.device?.attachments && live?.executionMode !== "claude-follower") return;
    for (const abort of active.current.values()) abort.abort();
    active.current.clear();
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setPreviewKey(undefined);
    count.current = 0;
    setUploads([]);
  }, [access?.device?.attachments, live?.executionMode, live?.connectionGeneration]);
  useEffect(() => {
    if (!submitted) return;
    if (notice === "accepted") {
      for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      setPreviewKey(undefined);
      setUploads([]);
      setResources([]);
      setHistoryReferences?.([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    } else if (notice === "notDispatched") setSubmitted(false);
  }, [notice, submitted, setMessage, setHistoryReferences]);
  function releasePreview(key: string) {
    const url = previewUrls.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previewUrls.current.delete(key);
    setPreviewKey((current) => (current === key ? undefined : current));
  }
  function unavailablePreview(key: string) {
    releasePreview(key);
    setUploads((items) =>
      items.map((item) => (item.key === key ? { ...item, previewUrl: undefined } : item)),
    );
  }
  async function add(files: File[]) {
    if (!uploadPermission || busy || submitted) return;
    setError("");
    for (const file of files) {
      if (count.current >= 10) {
        setError(copy.limit);
        break;
      }
      count.current++;
      const key = crypto.randomUUID();
      const abort = new AbortController();
      // Only local raster files are rendered, through <img>. Documents and SVG
      // remain ordinary attachments; no remote URL or executable preview is opened.
      const previewUrl =
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      if (previewUrl) previewUrls.current.set(key, previewUrl);
      active.current.set(key, abort);
      setUploads((items) => [...items, { key, name: file.name, file, percent: 0, previewUrl }]);
      void client
        .uploadAttachment(
          selected,
          file,
          (percent) =>
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent } : item)),
            ),
          abort.signal,
        )
        .then((result) => {
          if (!abort.signal.aborted)
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent: 100, result } : item)),
            );
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            releasePreview(key);
            setUploads((items) =>
              items.map((item) =>
                item.key === key ? { ...item, failed: true, previewUrl: undefined } : item,
              ),
            );
            setError(copy.uploadFailed);
          }
        })
        .finally(() => active.current.delete(key));
    }
  }
  useEffect(() => {
    if (!online || !controlReady || busy || submitted || capabilities?.sessionId !== selected)
      return;
    const draft = session.takeContinuationDraft?.(selected);
    if (!draft) return;
    setResources(continuationResources(draft.resources));
    if (!draft.files.length) return;
    if (uploadPermission) void add(draft.files);
    else {
      count.current = draft.files.length;
      setUploads(
        draft.files.map((file) => ({
          key: crypto.randomUUID(),
          name: file.name,
          file,
          percent: 0,
          failed: true,
        })),
      );
      setError(codexReason(locale, capabilities.features.attachments?.reason, "web").text);
    }
  }, [
    selected,
    online,
    controlReady,
    capabilities?.sessionId,
    uploadPermission,
    busy,
    submitted,
    session.takeContinuationDraft,
  ]);
  async function remove(item: Upload) {
    const requestGeneration = generation.current;
    active.current.get(item.key)?.abort();
    active.current.delete(item.key);
    releasePreview(item.key);
    count.current = Math.max(0, count.current - 1);
    setUploads((items) => items.filter((entry) => entry.key !== item.key));
    if (item.result) {
      try {
        await client.request("attachments/delete", {
          sessionId: selected,
          attachmentId: item.result.id,
          version: item.result.version,
        });
      } catch {
        if (requestGeneration === generation.current) setError(copy.error);
      }
    }
  }
  const ready = uploads.every((item) => !!item.result) && resources.every((item) => item.available);
  const attachmentIds = uploads.flatMap((item) => (item.result ? [item.result.id] : []));
  const resourceIds = resources.filter((item) => item.available).map((item) => item.id);
  const draft = composerValue;
  const valid = ready && validHistoryMessage(draft, historyReferences, attachmentIds.length > 0);
  const resourceNeedsMessage =
    resourceIds.length > 0 && !draft.trim() && !attachmentIds.length && !historyReferences.length;
  async function send(action: "send" | "steer" | "queue-add") {
    if (
      !valid ||
      !online ||
      !controlReady ||
      busy ||
      submitted ||
      submitPending.current ||
      (live?.activity === "compacting" && action !== "queue-add")
    )
      return;
    // The host refuses these too; deciding here keeps the draft and explains it without a
    // round trip, and runs AgentKib's own action for the commands it has one for.
    const decision = isClaude
      ? claudeCommandDecision(draft, { owner: COMMAND_OWNER, commands: commandCatalog })
      : null;
    const mapped =
      decision?.refusal &&
      action === "send" &&
      !attachmentIds.length &&
      !resourceIds.length &&
      !historyReferences.length
        ? agentKibCommand(decision)
        : null;
    if (decision?.refusal && !(mapped && capabilities?.features[mapped.action]?.available)) {
      setCommandNotice({ draft, reason: decision.refusal });
      return;
    }
    setCommandNotice(undefined);
    const requestGeneration = generation.current;
    submitPending.current = true;
    setSubmitted(true);
    try {
      const result = mapped
        ? await codexAction(mapped.action, mapped.fields)
        : action === "send"
          ? await control("send", undefined, undefined, undefined, undefined, {
              attachmentIds,
              ...(resourceIds.length ? { resourceIds } : {}),
            })
          : await codexAction(action, {
              text: draft.trim(),
              ...(historyReferences.length
                ? { historyReferences: historyReferences.map((item) => item.reference) }
                : {}),
              ...(attachmentIds.length ? { attachmentIds } : {}),
              ...(resourceIds.length ? { resourceIds } : {}),
              ...(action === "steer" ? { turnId: live?.turnId } : {}),
            });
      if (result && requestGeneration === generation.current) {
        for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
        previewUrls.current.clear();
        setPreviewKey(undefined);
        setUploads([]);
        setResources([]);
        setHistoryReferences?.([]);
        count.current = 0;
        setComposerText("");
        setMessage("");
        setSubmitted(false);
      }
    } finally {
      if (requestGeneration === generation.current) submitPending.current = false;
    }
  }
  const preview = uploads.find((item) => item.key === previewKey && item.previewUrl);
  const compacting = live?.activity === "compacting";
  const running = live?.status === "running";
  const connectionToastId = useId();
  const connectionFailure =
    !canSend &&
    !running &&
    !compacting &&
    display.reason === codexReason(locale, "codex-connection-failed", "web").text;
  useEffect(() => {
    if (!connectionFailure) return;
    toast.error(display.reason, { id: connectionToastId });
    return () => {
      toast.dismiss(connectionToastId);
    };
  }, [connectionFailure, connectionToastId, display.reason, selected]);
  const canSubmit = online && controlReady && canSend;
  const canAdvanced = !!(access?.device?.advancedControl && controlReady && online && !busy);
  const primaryAction =
    canStop && live?.executionMode !== "claude-follower" ? (
      <Button
        type="button"
        variant="outline"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full p-0"
        aria-label={t.stop}
        onClick={() => void control("stop")}
      >
        <Square size={17} />
      </Button>
    ) : (
      <Button
        type="submit"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full p-0"
        aria-label={t.send}
        disabled={!canSubmit || compacting || !valid || submitted}
      >
        <ArrowUp size={20} />
      </Button>
    );
  const advancedActions =
    (running || compacting) &&
    (!isClaude ||
      capabilities?.features.steer?.available ||
      capabilities?.features["queue-add"]?.available) ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={copy.advanced}
          title={copy.advanced}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{copy.advanced}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={
                compacting ||
                !canAdvanced ||
                !capabilities?.features.steer?.available ||
                !valid ||
                submitted
              }
              onClick={() => void send("steer")}
            >
              <CornerDownRight size={16} aria-hidden="true" />
              {copy.steer}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                !canAdvanced ||
                !capabilities?.features["queue-add"]?.available ||
                !valid ||
                submitted
              }
              onClick={() => void send("queue-add")}
            >
              <ListPlus size={16} aria-hidden="true" />
              {copy.queueAdd}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-1.5 py-1 text-xs leading-5 text-muted-foreground">{layout.queue}</p>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  if ((isCodex || isClaude) && display.continuation === "busy")
    return returnedFor === returnKey ? (
      <div className="w-full max-w-3xl self-center">
        <SessionContinuationReturned
          locale={locale}
          agent={isClaude ? "Claude Code" : "Codex"}
          hasDraft={Boolean(
            message.trim() || uploads.length || resources.length || historyReferences.length,
          )}
        />
      </div>
    ) : (
      <SessionBusyChoice
        onReturn={() => setReturnedFor(returnKey)}
        composerDraft={() => ({
          files: uploads.flatMap((item) => (item.file ? [item.file] : [])),
          resources,
        })}
      />
    );
  if ((isCodex || isClaude) && display.continuation === "view-only")
    return <SessionReadOnly reason={display.reason} />;
  if (isClaude && display.continuation === "terminal-watch")
    return (
      <div className="w-full max-w-3xl shrink-0 self-center">
        <SessionContinuationTerminal locale={locale} />
      </div>
    );
  return (
    <div className="w-full max-w-3xl shrink-0 self-center space-y-2">
      {isClaude && display.continuation === "terminal" && (
        <p className="px-3 text-xs leading-5 text-muted-foreground">{continuation.terminalHint}</p>
      )}
      {isClaude && <PermissionModeNotice permission={live?.permission} locale={locale} compact />}
      {isClaude && <ClaudeTurnNotice live={live} locale={locale} surface="web" />}
      <form
        className="relative w-full space-y-2 rounded-3xl border border-border bg-background p-2 shadow-sm transition-colors focus-within:border-ring/40 md:p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !compacting) void send("send");
        }}
      >
        <label className="sr-only" htmlFor="message">
          {t.message}
        </label>
        <Textarea
          id="message"
          className="min-h-10 max-h-40 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 text-sm shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0"
          value={composerValue}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={1}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={isCodex || isClaude ? continuation.placeholder : t.message}
          onFocus={() => {
            if (isCodex || isClaude) void session.checkContinuation?.();
          }}
          disabled={busy || submitted}
          {...slash.inputProps}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onBlur={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (slash.onKeyDown(event, composing.current)) return;
            if (!enterSends || !isSendEnter(event, composing.current)) return;
            event.preventDefault();
            if (
              !event.repeat &&
              !event.currentTarget.disabled &&
              canSubmit &&
              !compacting &&
              valid &&
              !submitPending.current
            )
              event.currentTarget.form?.requestSubmit();
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length && uploadPermission) {
              event.preventDefault();
              void add(files);
            }
          }}
        />
        {slash.menu}
        <HistoryReferenceChips />
        {uploads.length > 0 && (
          <ul className="space-y-2">
            {uploads.map((item) => (
              <li key={item.key} className="flex items-center gap-2 text-xs">
                {item.previewUrl && (
                  <Button
                    type="button"
                    variant="outline"
                    className="size-11 shrink-0 overflow-hidden p-0"
                    aria-label={`${copy.previewAttachment}: ${item.name}`}
                    onClick={() => setPreviewKey(item.key)}
                  >
                    <img
                      src={item.previewUrl}
                      alt=""
                      className="size-full object-cover"
                      onError={() => unavailablePreview(item.key)}
                    />
                  </Button>
                )}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span role="status">
                  {item.failed
                    ? copy.uploadFailed
                    : item.result
                      ? "100%"
                      : `${copy.uploading} ${item.percent}%`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-11 shrink-0 p-0"
                  aria-label={`${copy.remove}: ${item.name}`}
                  disabled={busy || submitted}
                  onClick={() => void remove(item)}
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {preview?.previewUrl && (
          <Dialog
            title={`${copy.previewAttachment}: ${preview.name}`}
            closeLabel={copy.close}
            onClose={() => setPreviewKey(undefined)}
          >
            <img
              src={preview.previewUrl}
              alt={preview.name}
              className="mx-auto max-h-[65dvh] max-w-full object-contain"
              onError={() => unavailablePreview(preview.key)}
            />
          </Dialog>
        )}
        <div className="space-y-2">
          <Input
            ref={fileInput}
            className="hidden"
            type="file"
            multiple
            aria-label={copy.attachment}
            disabled={!uploadPermission || busy || submitted}
            onChange={(event) => {
              void add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          {access?.device?.accessMode === "full" && (
            <CodexComposerControls
              resources={resources}
              setResources={setResources}
              openPhoneFiles={() => fileInput.current?.click()}
              disabled={busy || submitted || !online}
              action={primaryAction}
              advancedActions={advancedActions}
            />
          )}
          {access?.device?.accessMode !== "full" && (
            <div className="@container flex min-w-0 items-center justify-between gap-2 px-2 pb-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 rounded-full"
                disabled={!uploadPermission || busy || submitted}
                title={
                  uploadPermission
                    ? copy.attachmentNote
                    : isClaude && live?.executionMode === "claude-follower"
                      ? claudeConnectionCopyForSurface(locale, "web").attachments
                      : capabilities?.features.attachments?.reason || copy.permission
                }
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" className="size-4" />
                <span className="sr-only">{copy.attachment}</span>
              </Button>
              <div className="flex min-w-0 items-center gap-1">
                {advancedActions}
                <ContextUsageGauge />
                {primaryAction}
              </div>
            </div>
          )}
        </div>
      </form>
      {resources.some((item) => !item.available) && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {copy.resourceRemoved}
        </p>
      )}
      {resourceNeedsMessage && (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          {layout.resourceNeedsMessage}
        </p>
      )}
      {error && (
        <p role="alert" className="px-3 text-xs text-destructive-text">
          {error}
        </p>
      )}
      {commandNotice?.draft === draft && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {codexReason(locale, commandNotice.reason, "web").text}
        </p>
      )}
      {compacting && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {contextUsageCopyForSurface(locale, "web").compactingDetail}
        </p>
      )}
      {!isClaude && access?.device?.accessMode !== "full" && (
        <Disclosure className="px-3 text-xs text-muted-foreground">
          <DisclosureSummary className="min-h-11 cursor-pointer content-center">
            {layout.help}
          </DisclosureSummary>
          <p className="pb-2 leading-5">{copy.composerHint}</p>
        </Disclosure>
      )}
      {!canSend &&
        !(connectionStatusInBanner && isClaude) &&
        (!running || (live?.executionMode === "claude-follower" && display.tone === "warning")) &&
        !compacting &&
        !connectionFailure &&
        !display.loading && (
          <div
            role="status"
            className={`flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 ${
              display.tone === "warning"
                ? "border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200"
                : "border-border bg-muted/40 text-muted-foreground"
            }`}
          >
            {display.tone === "warning" && (
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="min-w-0">{display.reason}</span>
          </div>
        )}
    </div>
  );
}
