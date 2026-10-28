import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Approval,
  ControlReceipt,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  ManagedActionResult,
  ManagedOptions,
  SessionCapabilities,
  UploadedAttachment,
  UserQuestionRequest,
} from "../../../../../packages/web-client/src/index";
import {
  type CompactAction,
  ContextUsageIndicator,
  useObservedContextUsage,
} from "@/features/sessions/conversation/features/sessions/context-usage";
import { codexReason } from "@/features/sessions/conversation/features/sessions/codex-copy";
import { ApiError, WebClient } from "@agentkib/web-client";
import { toast } from "sonner";
import {
  SessionContinuationChoice,
  SessionContinuationReadOnly,
  SessionContinuationReturned,
  SessionContinuationStatus,
  SessionContinuationTerminal,
  sessionContinuationCopy,
} from "@agentkib/session-ui";
import { contextUsageCopy } from "@/features/sessions/conversation/features/sessions/context-usage-copy";
import { PermissionModeNotice } from "@/features/sessions/conversation/features/sessions/permission-mode-notice";
import { ManagedTurnNotice } from "@/features/sessions/conversation/features/sessions/managed-turn-notice";
import { ClaudeFilesPanel } from "./ClaudeFilesPanel";
import { api } from "@/core/api";
import {
  createDesktopConversationAdapter,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MarkdownContent } from "@/components/MarkdownContent";
import { isClaudeReadBusy, useClaudeSessionObservation } from "./useClaudeSessionObservation";
import { mergeNativeCoverage, mergeOrderedPersistedHistory } from "@agentkib/conversation-state";

type Pending = {
  requestId: string;
  operation: string;
  sessionId?: string;
  workspaceId: string;
  transport?: "conversation";
};
type Interaction = Approval | UserQuestionRequest;
const pendingKey = (workspaceId: string) => `agentkib:claude-owner-pending:v1:${workspaceId}`;
function readPending(workspaceId: string): Pending | undefined {
  const raw = localStorage.getItem(pendingKey(workspaceId));
  if (!raw) return;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.requestId) ||
    !("operation" in value) ||
    typeof value.operation !== "string" ||
    ![
      "create",
      "adopt",
      "release",
      "reconcile",
      "send",
      "stop",
      "approve",
      "answer",
      "fork",
    ].includes(value.operation) ||
    ("transport" in value && value.transport !== "conversation") ||
    (value.operation === "fork" &&
      (!("transport" in value) || value.transport !== "conversation")) ||
    !("workspaceId" in value) ||
    value.workspaceId !== workspaceId ||
    (value.operation !== "create" &&
      (!("sessionId" in value) ||
        typeof value.sessionId !== "string" ||
        !value.sessionId ||
        value.sessionId.length > 256))
  )
    throw new Error("pending_control_storage_invalid");
  return value as Pending;
}
function forgetPending(workspaceId: string, requestId: string) {
  if (readPending(workspaceId)?.requestId === requestId)
    localStorage.removeItem(pendingKey(workspaceId));
}
function isOwnerBusy(reason?: string | null) {
  return [
    "claude-owner-busy",
    "claude-background-session-running",
    "owner-opened-elsewhere",
  ].includes(reason ?? "");
}
async function request<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
  return (await api.claudeRequest({ operation, ...body })) as T;
}

function TechnicalDetails({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <Collapsible className="text-xs">
      <CollapsibleTrigger className="cursor-pointer text-left underline underline-offset-2">
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <pre className="whitespace-pre-wrap">{value}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Desktop uses the same owner service and receipts as Web; no CLI lives in the renderer. */
export function ClaudeSessionPanel({
  workspaceId,
  initialSessionId,
  onClose,
  onConnectTerminal,
}: {
  workspaceId: string;
  initialSessionId?: string;
  onClose: () => void;
  onConnectTerminal?: (sessionId: string) => void;
}) {
  const { locale } = useI18n();
  const continuationCopy = sessionContinuationCopy(locale);
  const [conversationClient] = useState(
    () => new WebClient(undefined, { type: "same-origin" }, createDesktopConversationAdapter()),
  );
  const text = (zh: string, en: string, tw: string, ja: string) =>
    ({ "zh-CN": zh, "en-US": en, "zh-TW": tw, "ja-JP": ja })[locale];
  const detailsLabel = text("技术详情", "Technical details", "技術詳情", "技術的な詳細");
  const explainError = (reason: string) => {
    // Only the code is normalized: a coded reason's detail (`<code>: <detail>`) is the CLI's
    // own text, such as an environment variable name, and is shown as is.
    const separator = reason.indexOf(": ");
    const normalized =
      separator > 0
        ? `${reason.slice(0, separator).replaceAll("_", "-")}${reason.slice(separator)}`
        : reason.replaceAll("_", "-");
    const messages: Record<string, string> = {
      "attachment-limit": text(
        "最多添加 10 个附件，请移除后重试。",
        "Choose at most 10 attachments. Remove one and retry.",
        "最多新增 10 個附件，請移除後重試。",
        "添付は 10 件までです。削除して再試行してください。",
      ),
      "attachment-too-large": text(
        "附件不能超过 25 MB，请选择较小的文件。",
        "Attachments must be at most 25 MB. Choose a smaller file.",
        "附件不能超過 25 MB，請選擇較小的檔案。",
        "添付は 25 MB 以下にしてください。小さいファイルを選択してください。",
      ),
      "upload-failed": text(
        "附件上传失败，请重新选择文件。",
        "The attachment upload failed. Choose the file again.",
        "附件上傳失敗，請重新選擇檔案。",
        "添付をアップロードできませんでした。ファイルを選び直してください。",
      ),
      "inspect-failed": text(
        "无法检查会话状态，请刷新后重试。",
        "Could not check session status. Refresh and retry.",
        "無法檢查對話狀態，請重新整理後重試。",
        "会話の状態を確認できません。更新して再試行してください。",
      ),
      "connection-failed": text(
        "连接失败，请检查终端并刷新。",
        "The connection failed. Check the terminal and refresh.",
        "連線失敗，請檢查終端並重新整理。",
        "接続できませんでした。ターミナルを確認して更新してください。",
      ),
      "claude-session-unavailable": text(
        "此 Claude 会话暂不可用，请检查终端并刷新。",
        "This Claude session is unavailable. Check the terminal and refresh.",
        "此 Claude 對話暫時無法使用，請檢查終端並重新整理。",
        "この Claude 会話を利用できません。ターミナルを確認して更新してください。",
      ),
    };
    if (messages[normalized]) return { text: messages[normalized], technical: reason };
    const mapped = codexReason(locale, normalized);
    return mapped.technical === normalized
      ? {
          text: text(
            "操作未完成，请刷新状态后重试。",
            "The operation could not be completed. Refresh the state before retrying.",
            "操作未完成，請重新整理狀態後重試。",
            "操作を完了できませんでした。状態を更新してから再試行してください。",
          ),
          technical: reason,
        }
      : { ...mapped, technical: mapped.technical ?? reason };
  };
  const [filesOpen, setFilesOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [observedSessionId, setObservedSessionId] = useState("");
  const [catalog, setCatalog] = useState<ConversationCatalog>();
  const [options, setOptions] = useState<ManagedOptions>();
  const [live, setLive] = useState<Live>();
  const stoppedReason = live?.reason ? explainError(live.reason) : undefined;
  const [capabilities, setCapabilities] = useState<SessionCapabilities>();
  const [history, setHistory] = useState<ConversationEventPage>();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [unuploadedAttachments, setUnuploadedAttachments] = useState<File[]>([]);
  const attachmentFiles = useRef(new Map<string, File>());
  const draftTransfer = useRef<
    | {
        sessionId: string;
        draft: string;
        attachments: UploadedAttachment[];
        files: File[];
      }
    | undefined
  >(undefined);
  const forkDraft = useRef<
    | { requestId: string; source: string; generation: number; draft: string; files: File[] }
    | undefined
  >(undefined);
  const [submittedDraft, setSubmittedDraft] = useState<{
    requestId: string;
    sessionId: string;
    text: string;
    priorUserIds: Set<string>;
    accepted?: true;
  }>();
  const [returnedToClient, setReturnedToClient] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [continuationError, setContinuationError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [interaction, setInteraction] = useState<Interaction>();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const epoch = useRef(0),
    continuationRequest = useRef(0),
    checkingContinuation = useRef(false),
    flight = useRef(false),
    loading = useRef(false);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  useLayoutEffect(() => {
    // A different terminal binding or a newly delivered owner state invalidates old reads.
    continuationRequest.current++;
  }, [workspaceId, sessionId, live?.executionMode, live?.connectionGeneration, live?.revision]);
  const shown = useRef(new Set<string>());
  const refreshRef = useRef<(details?: boolean) => Promise<void>>(async () => {});
  const queuedRefresh = useRef<boolean | undefined>(undefined);
  const refreshNeedsDetails = useRef(false);
  useEffect(() => {
    epoch.current++;
    setFilesOpen(false);
    setOperationsOpen(false);
    setDetailsOpen(false);
    setLive(undefined);
    setObservedSessionId("");
    setCapabilities(undefined);
    setHistory(undefined);
    const transfer =
      draftTransfer.current?.sessionId === sessionId ? draftTransfer.current : undefined;
    draftTransfer.current = undefined;
    const retainedFiles = new Map<string, File>();
    for (const item of transfer?.attachments ?? []) {
      const file = attachmentFiles.current.get(item.id);
      if (file) retainedFiles.set(item.id, file);
    }
    attachmentFiles.current = retainedFiles;
    setDraft(transfer?.draft ?? "");
    setAttachments(transfer?.attachments ?? []);
    setUnuploadedAttachments(transfer?.files ?? []);
    setSubmittedDraft(undefined);
    setReturnedToClient(false);
    setInteraction(undefined);
    setAnswers({});
    setCustom({});
    setConnected(false);
    setRefreshError("");
    setContinuationError("");
    refreshNeedsDetails.current = false;
    setError("");
    void refreshRef.current();
    return () => {
      epoch.current++;
      queuedRefresh.current = undefined;
    };
  }, [workspaceId, sessionId]);
  const refreshMetadata = useCallback(() => {
    void refreshRef.current(false);
  }, []);
  const hasPending = useCallback(() => {
    try {
      return !!readPending(workspaceId);
    } catch {
      return true;
    }
  }, [workspaceId]);
  const {
    liveDelivery,
    usageEpoch,
    nativeCoverage,
    catalogReady,
    catalogError,
    controlReady,
    retry,
    deferredRead,
    deferRead,
    refreshWake,
    completeDeferredRead,
  } = useClaudeSessionObservation({
    sessionId: observedSessionId,
    generation: epoch,
    setLive,
    setHistory,
    setOnline: setConnected,
    setError,
    refreshMetadata,
    refreshCapabilities: refreshMetadata,
    hasPending,
  });
  const online = connected && catalogReady && !refreshError;
  const displayError = error || refreshError || catalogError || continuationError;
  const errorCopy = displayError ? explainError(displayError) : undefined;
  const optionsReason =
    !options?.available && options?.reason ? explainError(options.reason) : undefined;
  const compacting = live?.activity === "compacting";
  const usageView = useObservedContextUsage({
    selected: sessionId,
    scope: `${sessionId}\0${workspaceId}\0${usageEpoch}`,
    live,
    online,
    authorized: true,
  });

  const refresh = useCallback(
    async (details = true) => {
      details = details || deferredRead.current || refreshNeedsDetails.current;
      if (loading.current) {
        queuedRefresh.current = queuedRefresh.current === true || details;
        return;
      }
      const finishRefresh = () => {
        loading.current = false;
        if (queuedRefresh.current !== undefined) {
          const queuedDetails = queuedRefresh.current;
          queuedRefresh.current = undefined;
          void refreshRef.current(queuedDetails);
        }
      };
      loading.current = true;
      const generation = epoch.current;
      const delivery = liveDelivery.current;
      const wake = refreshWake.current;
      try {
        const saved = readPending(workspaceId);
        let nextPending = saved;
        if (saved) {
          const receipt =
            saved.transport === "conversation"
              ? await conversationClient.receipt(saved.requestId)
              : await request<ControlReceipt>("receipt", { requestId: saved.requestId });
          if (generation !== epoch.current) {
            finishRefresh();
            return;
          }
          if (
            receipt.found &&
            receipt.requestId === saved.requestId &&
            receipt.operation === saved.operation &&
            (!saved.sessionId || saved.sessionId === receipt.sessionId) &&
            (receipt.status === "not-dispatched" ||
              (receipt.status === "accepted" &&
                (saved.operation !== "fork" ||
                  (typeof receipt.ack?.sessionId === "string" &&
                    !!receipt.ack.sessionId &&
                    receipt.ack.sessionId !== saved.sessionId))))
          ) {
            forgetPending(workspaceId, saved.requestId);
            nextPending = readPending(workspaceId);
            if (!nextPending) retry();
            if (receipt.status === "accepted" && saved.operation === "create")
              setSessionId(receipt.sessionId);
            if (
              receipt.status === "accepted" &&
              saved.operation === "fork" &&
              receipt.ack?.sessionId
            ) {
              const transfer = forkDraft.current;
              if (
                transfer?.requestId === saved.requestId &&
                transfer.source === sessionId &&
                transfer.generation === epoch.current
              )
                draftTransfer.current = {
                  sessionId: receipt.ack.sessionId,
                  draft: transfer.draft,
                  attachments: [],
                  files: transfer.files,
                };
              forkDraft.current = undefined;
              setSessionId(receipt.ack.sessionId);
            }
            if (
              receipt.status === "accepted" &&
              saved.operation === "send" &&
              saved.sessionId === sessionId
            ) {
              setDraft("");
              setAttachments([]);
              setSubmittedDraft((current) =>
                current?.requestId === saved.requestId ? { ...current, accepted: true } : current,
              );
            }
          }
        }
        const [nextOptions, nextCatalog] = await Promise.all([
          request<ManagedOptions>("options"),
          request<ConversationCatalog>("catalog"),
        ]);
        if (generation !== epoch.current) {
          finishRefresh();
          return;
        }
        setPending(nextPending);
        setOptions(nextOptions);
        setCatalog(nextCatalog);
        if (sessionId) {
          // Workspace history uses the index ID, while control uses the managed
          // identity. Resolve only an exact, unique mapping in this workspace.
          const localSessions = nextCatalog.sessions.filter(
            (row) => row.workspace_id === workspaceId && row.agent === "claude-code",
          );
          if (!localSessions.some((row) => row.id === sessionId)) {
            const matches = localSessions.filter(
              (row) =>
                row.indexedSessionId === sessionId || row.indexedSessionIds?.includes(sessionId),
            );
            if (matches.length === 1) {
              setSessionId(matches[0].id);
              finishRefresh();
              return;
            }
            refreshNeedsDetails.current = refreshNeedsDetails.current || details;
            setRefreshError("claude_session_unavailable");
            if (!sessionId || !hasDesktopConversation()) setConnected(false);
            try {
              readPending(workspaceId);
            } catch {
              setStorageBlocked(true);
            }
            finishRefresh();
            return;
          }
          setObservedSessionId(sessionId);
          // Native state changes invalidate metadata even when history stays current.
          // Keep dynamic capabilities in the same serialized refresh and busy recovery.
          const [nextCaps, nextLive, nextHistory] = await Promise.all([
            request<SessionCapabilities>("capabilities", { sessionId }),
            details ? request<Live>("live", { sessionId }) : undefined,
            details ? request<ConversationEventPage>("events", { sessionId }) : undefined,
          ]);
          if (generation !== epoch.current) {
            finishRefresh();
            return;
          }
          setCapabilities(nextCaps);
          if (nextLive && nextHistory) {
            if (delivery === liveDelivery.current) setLive(nextLive);
            setHistory((old) => ({
              ...nextHistory,
              events: mergeNativeCoverage(
                mergeOrderedPersistedHistory(
                  old?.events ?? [],
                  nextHistory.events,
                  old ? "latest" : "older",
                ),
                nativeCoverage.current,
              ),
            }));
          }
        }
        // Reads and the stream recover independently: neither can clear the
        // other's failure and reopen controls before both are healthy.
        setRefreshError("");
        setContinuationError("");
        refreshNeedsDetails.current = false;
        if (!sessionId || !hasDesktopConversation()) setConnected(true);
        setStorageBlocked(false);
        if (details) completeDeferredRead();
      } catch (e) {
        if (generation !== epoch.current) {
          finishRefresh();
          return;
        }
        if (isClaudeReadBusy(e)) {
          deferRead(wake, generation);
          finishRefresh();
          return;
        }
        // A metadata-only success cannot recover an unread history/live page.
        refreshNeedsDetails.current = refreshNeedsDetails.current || details;
        setRefreshError((e instanceof Error && e.message) || "connection_failed");
        if (!sessionId || !hasDesktopConversation()) setConnected(false);
        try {
          readPending(workspaceId);
        } catch {
          setStorageBlocked(true);
        }
      }
      finishRefresh();
    },
    [
      workspaceId,
      sessionId,
      liveDelivery,
      nativeCoverage,
      retry,
      deferredRead,
      deferRead,
      refreshWake,
      completeDeferredRead,
      conversationClient,
      setSessionId,
      setDraft,
      setAttachments,
      setSubmittedDraft,
    ],
  );
  useLayoutEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!online || interaction || !live) return;
    const next = [...live.approvals, ...(live.questions ?? [])].find(
      (item) =>
        item.supported && !shown.current.has(`${sessionId}:${item.turnId}:${item.requestId}`),
    );
    if (next) {
      shown.current.add(`${sessionId}:${next.turnId}:${next.requestId}`);
      setInteraction(next);
      setAnswers({});
      setCustom({});
    }
  }, [live, interaction, online, sessionId]);

  /** A `command` send is a slash command sent on its own, so the draft and attachments stay. */
  async function mutate(operation: string, body: Record<string, unknown> = {}, command = false) {
    if (
      flight.current ||
      pending ||
      storageBlocked ||
      !online ||
      !controlReady ||
      (operation === "send" &&
        (!liveRef.current?.sendEnabled || liveRef.current.status !== "idle" || ownerBusy)) ||
      (compacting && operation === "send")
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const entry: Pending = {
      requestId: crypto.randomUUID(),
      operation,
      workspaceId,
      ...(operation !== "create" && sessionId ? { sessionId } : {}),
    };
    try {
      // Persist identity before IPC. An ambiguous failure is reconciled, never replayed.
      if (readPending(workspaceId)) {
        if (generation === epoch.current) setError("control_outcome_unconfirmed");
      } else {
        localStorage.setItem(pendingKey(workspaceId), JSON.stringify(entry));
        setPending(entry);
        if (operation === "send")
          setSubmittedDraft({
            requestId: entry.requestId,
            sessionId,
            text: command ? String(body.text) : draft.trim(),
            priorUserIds: new Set(
              history?.events
                .filter((event) => event.kind === "user-message")
                .map((event) => event.id),
            ),
          });
        const result = await request<
          ManagedActionResult & { controlOutcome?: string; error?: string }
        >(operation, { ...entry, ...body, expectedRevision: live?.revision });
        if (
          (result.accepted !== true && result.reconciled !== true) ||
          (result.sessionId && operation !== "create" && result.sessionId !== sessionId)
        ) {
          if (result.controlOutcome === "not-dispatched") {
            forgetPending(workspaceId, entry.requestId);
            if (generation === epoch.current) {
              setPending(undefined);
              if (operation === "send") setSubmittedDraft(undefined);
            }
          }
          if (generation === epoch.current) {
            if (result.controlOutcome === "not-dispatched" && isOwnerBusy(result.error)) {
              setLive((current) =>
                current
                  ? {
                      ...current,
                      executionLocation: "external",
                      ownershipReason: result.error,
                      sendEnabled: false,
                    }
                  : current,
              );
              setReturnedToClient(false);
            } else setError(result.error || "control_outcome_unconfirmed");
          }
        } else {
          forgetPending(workspaceId, entry.requestId);
          if (generation === epoch.current) {
            setPending(undefined);
            setInteraction(undefined);
            if (operation === "create" && result.sessionId) setSessionId(result.sessionId);
            if (operation === "send") {
              if (!command) {
                setDraft("");
                setAttachments([]);
              }
              setSubmittedDraft((current) =>
                current?.requestId === entry.requestId ? { ...current, accepted: true } : current,
              );
            }
            await refresh();
            if (generation === epoch.current) retry();
          }
        }
      }
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "control_outcome_unconfirmed");
    }
    flight.current = false;
    setBusy(false);
  }
  const checkContinuation = useCallback(async () => {
    if (
      checkingContinuation.current ||
      flight.current ||
      hasPending() ||
      !online ||
      !controlReady ||
      !sessionId ||
      sessionId !== observedSessionId ||
      liveRef.current?.activity === "compacting"
    )
      return;
    checkingContinuation.current = true;
    const generation = epoch.current,
      delivery = liveDelivery.current;
    const check = ++continuationRequest.current;
    const current = () =>
      generation === epoch.current &&
      check === continuationRequest.current &&
      delivery === liveDelivery.current;
    try {
      const next = await request<Live>("live", { sessionId });
      if (current() && next.sessionId === sessionId) {
        setLive(next);
        setContinuationError("");
        if (!isOwnerBusy(next.ownershipReason ?? next.reason)) setReturnedToClient(false);
      }
    } catch (e) {
      if (current()) setContinuationError(e instanceof Error ? e.message : "inspect_failed");
    } finally {
      checkingContinuation.current = false;
    }
  }, [
    sessionId,
    observedSessionId,
    online,
    controlReady,
    hasPending,
    liveDelivery,
    setReturnedToClient,
  ]);
  const ownerBusy = !!live && isOwnerBusy(live.ownershipReason ?? live.reason);
  useEffect(() => {
    if (!ownerBusy) setReturnedToClient(false);
  }, [ownerBusy]);
  useEffect(() => {
    if (!ownerBusy || !online) return;
    const timer = setInterval(() => void checkContinuation(), 4000);
    return () => clearInterval(timer);
  }, [ownerBusy, online, checkContinuation]);
  const loadResumeCommand = useCallback(
    async (signal: AbortSignal) =>
      (await conversationClient.codexResumeCommand(sessionId, signal)).command,
    [conversationClient, sessionId],
  );

  async function forkContinuation() {
    if (blocked || !ownerBusy || !capabilities?.features.fork?.available || hasPending()) return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const source = sessionId;
    let entry: Pending | undefined;
    try {
      const access = await conversationClient.access();
      if (generation !== epoch.current) return;
      if (
        access.status !== "approved" ||
        access.protocolVersion !== 2 ||
        !access.experimentalEnabled ||
        !access.device?.manage
      )
        throw new ApiError(403, "permission_denied", "not-dispatched");
      entry = {
        requestId: crypto.randomUUID(),
        operation: "fork",
        transport: "conversation",
        workspaceId,
        sessionId: source,
      };
      if (readPending(workspaceId)) throw new Error("control_outcome_unconfirmed");
      // A previous fork or recovered receipt may still have files awaiting upload.
      // Keep the whole draft by File identity, including distinct files with the same name.
      const files = [
        ...attachments.flatMap((item) => {
          const file = attachmentFiles.current.get(item.id);
          return file ? [file] : [];
        }),
        ...unuploadedAttachments,
      ];
      forkDraft.current = {
        requestId: entry.requestId,
        source,
        generation,
        draft,
        files,
      };
      localStorage.setItem(pendingKey(workspaceId), JSON.stringify(entry));
      setPending(entry);
      const result = await conversationClient.sessionAction(
        "fork",
        {
          requestId: entry.requestId,
          bootId: access.bootId,
          sessionId: source,
          expectedRevision: live?.revision ?? 0,
        },
        "claude-code",
      );
      if (!result.accepted || !result.sessionId || result.sessionId === source)
        throw new Error("control_outcome_unconfirmed");
      forgetPending(workspaceId, entry.requestId);
      if (generation !== epoch.current) return;
      setPending(undefined);
      const transferred: UploadedAttachment[] = [];
      const remaining: File[] = [];
      for (const file of files) {
        try {
          const uploaded = await request<UploadedAttachment>("upload", {
            sessionId: result.sessionId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          transferred.push(uploaded);
          attachmentFiles.current.set(uploaded.id, file);
        } catch {
          remaining.push(file);
        }
        if (generation !== epoch.current) return;
      }
      draftTransfer.current = {
        sessionId: result.sessionId,
        draft,
        attachments: transferred,
        files: remaining,
      };
      forkDraft.current = undefined;
      setSessionId(result.sessionId);
    } catch (e) {
      if (entry && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        forgetPending(workspaceId, entry.requestId);
        if (generation === epoch.current) setPending(undefined);
        forkDraft.current = undefined;
      }
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "control_outcome_unconfirmed");
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function upload(files: File[]) {
    if (
      flight.current ||
      pending ||
      !online ||
      !controlReady ||
      capabilities?.features.attachments?.available !== true
    )
      return;
    flight.current = true;
    setBusy(true);
    const generation = epoch.current;
    try {
      if (attachments.length + files.length > 10) {
        if (generation === epoch.current) setError("attachment_limit");
      } else {
        for (const file of files) {
          if (file.size > 25 * 1024 * 1024) {
            if (generation === epoch.current) setError("attachment_too_large");
            break;
          }
          const item = await request<UploadedAttachment>("upload", {
            sessionId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          if (generation !== epoch.current) break;
          attachmentFiles.current.set(item.id, file);
          setAttachments((old) => [...old, item]);
          setUnuploadedAttachments((old) => old.filter((pending) => pending !== file));
        }
      }
    } catch (e) {
      if (generation === epoch.current) setError(e instanceof Error ? e.message : "upload_failed");
    }
    flight.current = false;
    setBusy(false);
  }
  const filesAvailable =
    online &&
    capabilities?.sessionId === sessionId &&
    capabilities.features.files?.available === true;
  const statusLabels: Record<string, string> = {
    idle: text("空闲", "Idle", "閒置", "待機中"),
    starting: text("正在启动", "Starting", "正在啟動", "起動中"),
    running: text("执行中", "Running", "執行中", "実行中"),
    "waiting-approval": text("等待审批", "Awaiting approval", "等待審批", "承認待ち"),
    "waiting-input": text("等待回答", "Awaiting answer", "等待回答", "回答待ち"),
    "awaiting-approval": text("等待审批", "Awaiting approval", "等待審批", "承認待ち"),
    "awaiting-input": text("等待回答", "Awaiting answer", "等待回答", "回答待ち"),
    "outcome-unknown": text("结果待核对", "Outcome unknown", "結果待核對", "結果の確認が必要"),

    failed: text("执行失败", "Failed", "執行失敗", "実行に失敗"),
    unavailable: text("不可用", "Unavailable", "無法使用", "利用できません"),
    readonly: text("只读", "Read only", "唯讀", "閲覧のみ"),
  };
  const terminalConnected =
    live?.executionLocation === "terminal" ||
    (live?.executionMode === "claude-follower" && live.status !== "unsupported");
  const continuationLabel = ownerBusy
    ? continuationCopy.busy("Claude Code")
    : live?.status === "starting" || (busy && pending?.operation === "send")
      ? continuationCopy.starting
      : terminalConnected
        ? continuationCopy.terminalConnected
        : live?.executionLocation === "agentkib"
          ? continuationCopy.running
          : live?.status === "idle" || live?.status === "released"
            ? undefined
            : live?.status
              ? statusLabels[live.status]
              : undefined;
  const viewOnly =
    !ownerBusy &&
    (live?.status === "unsupported" ||
      live?.status === "readonly" ||
      ["platform-unsupported", "claude-cli-unavailable", "unsupported-Claude-version"].includes(
        live?.reason ?? "",
      ));
  // Until the plugin takes messages from here, a connected terminal is followed, not typed into.
  const terminalWatch = terminalConnected && !live?.terminalSend && !live?.sendEnabled;
  const continuationNotice =
    live?.continuationNotice === "owner-opened-elsewhere"
      ? continuationCopy.ownerOpenedElsewhere
      : live?.continuationNotice === "background-ended"
        ? continuationCopy.backgroundEnded
        : undefined;
  const blocked =
    busy ||
    !!pending ||
    storageBlocked ||
    !online ||
    !controlReady ||
    !!continuationError ||
    sessionId !== observedSessionId;
  // Claude Code's /compact as in the conversation page: a message of its own, the draft stays.
  const compact: CompactAction | undefined =
    live?.executionMode === "claude-managed" && live.sessionId === sessionId
      ? {
          agent: "Claude Code",
          // There is nothing to summarize before the first message.
          enabled:
            !blocked &&
            !compacting &&
            !!live.sendEnabled &&
            live.status === "idle" &&
            !!history?.events.length,
          afterTurn: live.status === "running",
          run: () => void mutate("send", { text: "/compact", attachmentIds: [] }, true),
        }
      : undefined;
  const interactionCurrent =
    !!interaction &&
    interaction.supported &&
    online &&
    [...(live?.approvals ?? []), ...(live?.questions ?? [])].some(
      (item) => JSON.stringify(item) === JSON.stringify(interaction),
    );
  const questionAnswers =
    interaction && "questions" in interaction
      ? Object.fromEntries(
          interaction.questions.map((q) => [
            q.id,
            [
              ...(answers[q.id] ?? []),
              ...(q.allowCustom && custom[q.id]?.trim() ? [custom[q.id].trim()] : []),
            ],
          ]),
        )
      : {};
  const validAnswers =
    interaction &&
    "questions" in interaction &&
    interaction.questions.every(
      (q) =>
        (questionAnswers[q.id]?.length ?? 0) > 0 &&
        (q.multiSelect || questionAnswers[q.id].length === 1),
    ) &&
    JSON.stringify(questionAnswers).length <= 16384;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogTitle>Claude Code</DialogTitle>
        <p className="text-xs text-muted-foreground">
          {text(
            "沿用这台电脑上 CLI 的模型和工具权限。离开后会等当前轮次结束，再自动结束后台进程。",
            "Uses the CLI model and tool permissions on this computer. After you leave, the background process ends when the current turn finishes.",
            "沿用這台電腦上 CLI 的模型與工具權限。離開後會等目前輪次結束，再自動結束背景程序。",
            "このコンピューターの CLI のモデルとツール権限を使用します。離れた後は、現在のターンの完了を待ってバックグラウンドプロセスを終了します。",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={blocked || !options?.available}
            onClick={() => void mutate("create", { workspaceId })}
          >
            {text(
              "新建 Claude 任务",
              "New Claude task",
              "新增 Claude 任務",
              "Claude タスクを新規作成",
            )}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              retry();
              void refresh();
            }}
          >
            {text("刷新", "Refresh", "重新整理", "更新")}
          </Button>
        </div>
        {sessionId && (
          <>
            <Button
              variant="outline"
              aria-expanded={operationsOpen}
              onClick={() => setOperationsOpen((open) => !open)}
            >
              {text("会话操作", "Session actions", "對話操作", "会話の操作")}
            </Button>
            {operationsOpen && (
              <section
                className="space-y-2 rounded border p-3"
                aria-label={text("会话操作", "Session actions", "對話操作", "会話の操作")}
              >
                {onConnectTerminal && (
                  <Button
                    variant="outline"
                    disabled={blocked}
                    onClick={() => onConnectTerminal(sessionId)}
                  >
                    {continuationCopy.connectTerminal}
                  </Button>
                )}
                <Button
                  variant="outline"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  {text("会话详情", "Session details", "對話詳情", "会話の詳細")}
                </Button>
                {detailsOpen && (
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {[live?.model, live?.cliVersion || options?.cliVersion, sessionId]
                      .filter(Boolean)
                      .join(" · ")}
                  </pre>
                )}
              </section>
            )}
          </>
        )}
        <PermissionModeNotice permission={live?.permission} locale={locale} />
        {/* The session's reason, an authentication failure included, is shown below. */}
        <ManagedTurnNotice live={live} locale={locale} retriesOnly />
        {optionsReason && (!sessionId || options?.reason !== live?.reason) && (
          <div role="status">
            <p>{optionsReason.text}</p>
            <TechnicalDetails label={detailsLabel} value={optionsReason.technical} />
          </div>
        )}
        <label>
          {text("会话", "Session", "對話", "会話")}
          <Select
            value={sessionId}
            disabled={busy}
            onValueChange={(value) => setSessionId(value ?? "")}
          >
            <SelectTrigger aria-label={text("会话", "Session", "對話", "会話")} className="w-full">
              <SelectValue
                placeholder={text("选择会话", "Choose a session", "選擇對話", "会話を選択")}
              >
                {sessionId
                  ? catalog?.sessions.find((item) => item.id === sessionId)?.title || "Claude Code"
                  : text("选择会话", "Choose a session", "選擇對話", "会話を選択")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{text("会话", "Session", "對話", "会話")}</SelectLabel>
                {catalog?.sessions
                  .filter((item) => item.workspace_id === workspaceId)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title || "Claude Code"}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        {errorCopy && (
          <div role="alert" className="text-destructive-text break-words">
            <p>{errorCopy.text}</p>
            <TechnicalDetails label={detailsLabel} value={errorCopy.technical} />
          </div>
        )}
        {pending && !busy && (
          <p role="status">
            {text(
              "结果待核对，正在查询原请求回执；不会自动重发。",
              "Outcome unknown. Checking the original receipt; no command will be replayed.",
              "結果待核對，正在查詢原請求回執；不會自動重送。",
              "結果を確認中です。元のリクエストの受領記録を照会しています。コマンドは再送しません。",
            )}
          </p>
        )}
        {sessionId && (
          <>
            <SessionContinuationStatus
              label={viewOnly && !ownerBusy ? continuationCopy.viewOnly : continuationLabel}
              active={live?.executionLocation === "agentkib"}
              loading={live?.status === "starting" || (busy && pending?.operation === "send")}
            />
            {!ownerBusy && !viewOnly && !continuationNotice && stoppedReason && (
              <div className="text-xs text-muted-foreground">
                <p>{stoppedReason.text}</p>
                <TechnicalDetails label={detailsLabel} value={stoppedReason.technical} />
              </div>
            )}
            {filesAvailable && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  {text("文件与产物", "Files and artifacts", "檔案與產物", "ファイルと成果物")}
                </Button>
                {filesOpen && <ClaudeFilesPanel key={sessionId} sessionId={sessionId} />}
              </div>
            )}
            {live?.status === "outcome-unknown" && (
              <Button variant="outline" disabled={blocked} onClick={() => void mutate("reconcile")}>
                {text("核对执行结果", "Reconcile outcome", "核對執行結果", "実行結果を確認")}
              </Button>
            )}
            <div
              className="max-h-80 overflow-y-auto space-y-3"
              aria-label={text("会话历史", "History", "對話歷史", "会話履歴")}
            >
              {history?.events.map((event) => (
                <article key={event.id}>
                  <strong className="text-xs">
                    {event.kind === "user-message"
                      ? text("你", "You", "你", "あなた")
                      : event.tool_name || "Claude"}
                  </strong>
                  <MarkdownContent
                    content={event.content ?? event.tool_status ?? ""}
                    literal={event.cli_output === true}
                  />
                </article>
              ))}
              {live?.status !== "idle" &&
                live?.streamText &&
                !(
                  live.turnId &&
                  history?.events.some(
                    (event) => event.kind === "agent-message" && event.turn_id === live.turnId,
                  )
                ) && <MarkdownContent content={live.streamText} />}
              {submittedDraft?.sessionId === sessionId &&
                (submittedDraft.accepted ||
                  (busy && pending?.requestId === submittedDraft.requestId)) &&
                !history?.events.some(
                  (event) =>
                    event.kind === "user-message" &&
                    (event.turn_id === submittedDraft.requestId ||
                      (!submittedDraft.priorUserIds.has(event.id) &&
                        event.content === submittedDraft.text)),
                ) && (
                  <article data-pending-user-message>
                    <strong className="text-xs">{text("你", "You", "你", "あなた")}</strong>
                    <MarkdownContent content={submittedDraft.text} />
                  </article>
                )}
              {history?.warnings.map((warning) => (
                <p key={warning} role="status">
                  {warning}
                </p>
              ))}
            </div>
            {[...(live?.approvals ?? []), ...(live?.questions ?? [])].map((item) => (
              <Button
                key={item.requestId}
                variant="outline"
                onClick={() => {
                  setInteraction(item);
                  setAnswers({});
                  setCustom({});
                }}
              >
                {"questions" in item
                  ? text("回答问题", "Answer question", "回答問題", "質問に回答")
                  : text("处理审批", "Review approval", "處理審批", "承認内容を確認")}
              </Button>
            ))}
            {interaction && (
              <section className="rounded border p-3 space-y-2">
                <Button variant="ghost" onClick={() => setInteraction(undefined)}>
                  {text("收起", "Dismiss", "收合", "閉じる")}
                </Button>
                {!interactionCurrent && (
                  <p role="status">
                    {text(
                      "表单已失效，请刷新。",
                      "This form is no longer current. Refresh.",
                      "表單已失效，請重新整理。",
                      "このフォームは無効です。更新してください。",
                    )}
                  </p>
                )}
                {"questions" in interaction ? (
                  <>
                    {interaction.questions.map((q) => (
                      <fieldset key={q.id} disabled={blocked || !interactionCurrent}>
                        <legend>{q.question}</legend>
                        {q.options.map((option) => (
                          <label key={option.label} className="flex gap-2">
                            <Checkbox
                              name={q.id}
                              checked={(answers[q.id] ?? []).includes(option.label)}
                              onCheckedChange={(checked) => {
                                if (!q.multiSelect) setCustom((old) => ({ ...old, [q.id]: "" }));
                                setAnswers((old) => ({
                                  ...old,
                                  [q.id]: q.multiSelect
                                    ? checked
                                      ? [...(old[q.id] ?? []), option.label]
                                      : (old[q.id] ?? []).filter((x) => x !== option.label)
                                    : [option.label],
                                }));
                              }}
                            />
                            {option.label}
                            {option.description ? ` — ${option.description}` : ""}
                          </label>
                        ))}
                        {q.allowCustom && (
                          <Input
                            aria-label={`${q.question} ${text("自定义回答", "Custom answer", "自訂回答", "自由回答")}`}
                            type={q.isSecret || q.secret ? "password" : "text"}
                            maxLength={4096}
                            value={custom[q.id] ?? ""}
                            onChange={(event) => {
                              setCustom((old) => ({ ...old, [q.id]: event.target.value }));
                              if (!q.multiSelect) setAnswers((old) => ({ ...old, [q.id]: [] }));
                            }}
                          />
                        )}
                      </fieldset>
                    ))}
                    <Button
                      disabled={blocked || !interactionCurrent || !validAnswers}
                      onClick={() => {
                        if (
                          liveRef.current &&
                          [...(liveRef.current.questions ?? [])].some(
                            (item) => JSON.stringify(item) === JSON.stringify(interaction),
                          )
                        )
                          void mutate("answer", {
                            turnId: interaction.turnId,
                            questionId: interaction.requestId,
                            answers: questionAnswers,
                          });
                      }}
                    >
                      {text("提交回答", "Submit answers", "提交回答", "回答を送信")}
                    </Button>
                  </>
                ) : (
                  <>
                    <pre className="overflow-auto text-xs">
                      {JSON.stringify(interaction.input ?? interaction.toolCall ?? {}, null, 2)}
                    </pre>
                    {["allow", "deny"]
                      .filter(
                        (decision) =>
                          interaction.supported &&
                          interaction.availableDecisions.includes(decision),
                      )
                      .map((decision) => (
                        <Button
                          key={decision}
                          disabled={blocked || !interactionCurrent}
                          onClick={() => {
                            if (
                              liveRef.current?.approvals.some(
                                (item) => JSON.stringify(item) === JSON.stringify(interaction),
                              )
                            )
                              void mutate("approve", {
                                turnId: interaction.turnId,
                                approvalId: interaction.requestId,
                                decision,
                              });
                          }}
                        >
                          {decision === "allow"
                            ? text("允许", "Allow", "允許", "許可")
                            : text("拒绝", "Deny", "拒絕", "拒否")}
                        </Button>
                      ))}
                  </>
                )}
              </section>
            )}
            {continuationNotice && (
              <p role="status" className="text-xs leading-5 text-muted-foreground">
                {continuationNotice}
              </p>
            )}
            {ownerBusy && !returnedToClient ? (
              <SessionContinuationChoice
                locale={locale}
                agent="Claude Code"
                title={
                  catalog?.sessions.find((item) => item.id === sessionId)?.title || "Claude Code"
                }
                disabled={busy || !!pending || storageBlocked}
                hasDraft={Boolean(
                  draft.trim() || attachments.length || unuploadedAttachments.length,
                )}
                forkDisabled={blocked || !capabilities?.features.fork?.available}
                onFork={() => void forkContinuation()}
                onReturn={() => setReturnedToClient(true)}
              />
            ) : ownerBusy ? (
              <SessionContinuationReturned
                locale={locale}
                agent="Claude Code"
                hasDraft={Boolean(
                  draft.trim() || attachments.length || unuploadedAttachments.length,
                )}
              />
            ) : viewOnly ? (
              <SessionContinuationReadOnly
                key={sessionId}
                locale={locale}
                loadCommand={loadResumeCommand}
                onCopied={() => toast.success(continuationCopy.commandCopied)}
                local
                reason={
                  live?.reason === "platform-unsupported"
                    ? continuationCopy.claudeWindowsUnsupported
                    : stoppedReason?.text
                }
              />
            ) : terminalWatch ? (
              <SessionContinuationTerminal locale={locale} />
            ) : (
              <>
                {terminalConnected && (
                  <p className="text-xs text-muted-foreground">{continuationCopy.terminalHint}</p>
                )}
                <label>
                  {text("消息", "Message", "訊息", "メッセージ")}
                  <Textarea
                    value={draft}
                    maxLength={16384}
                    placeholder={continuationCopy.placeholder}
                    disabled={blocked}
                    onFocus={() => void checkContinuation()}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                <label>
                  {text(
                    "添加图片或文件",
                    "Add images or files",
                    "新增圖片或檔案",
                    "画像やファイルを追加",
                  )}
                  <Input
                    type="file"
                    multiple
                    disabled={blocked || !capabilities?.features.attachments?.available}
                    onChange={(event) => {
                      void upload(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </label>
                {unuploadedAttachments.map((file, index) => (
                  <div key={`${file.name}:${index}`} className="flex flex-wrap gap-2 text-sm">
                    <span>{file.name}</span>
                    <span className="text-muted-foreground">
                      {text(
                        "附件尚未上传",
                        "Attachment not uploaded",
                        "附件尚未上傳",
                        "添付は未アップロードです",
                      )}
                    </span>
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() => void upload([file])}
                    >
                      {text("重试上传", "Retry upload", "重試上傳", "アップロードを再試行")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={blocked}
                      onClick={() =>
                        setUnuploadedAttachments((old) => old.filter((item) => item !== file))
                      }
                    >
                      {text("移除", "Remove", "移除", "削除")}
                    </Button>
                  </div>
                ))}
                {attachments.map((item) => (
                  <div key={item.id} className="flex gap-2">
                    {item.name}
                    <Button
                      variant="ghost"
                      disabled={blocked}
                      onClick={async () => {
                        const generation = epoch.current;
                        try {
                          await request("remove-attachment", {
                            sessionId,
                            attachmentId: item.id,
                            version: item.version,
                          });
                          if (generation === epoch.current)
                            setAttachments((old) => old.filter((value) => value.id !== item.id));
                        } catch (e) {
                          if (generation === epoch.current)
                            setError(e instanceof Error ? e.message : "remove_failed");
                        }
                      }}
                    >
                      {text("移除", "Remove", "移除", "削除")}
                    </Button>
                  </div>
                ))}
                {compacting && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {contextUsageCopy[locale].compactingDetail}
                  </p>
                )}
                <div className="flex gap-2">
                  <ContextUsageIndicator
                    scope={`${sessionId}\0${workspaceId}\0${usageEpoch}`}
                    locale={locale}
                    online={online}
                    view={usageView}
                    compact={compact}
                  />
                  <Button
                    disabled={
                      blocked ||
                      compacting ||
                      !!unuploadedAttachments.length ||
                      !live?.sendEnabled ||
                      live.status !== "idle" ||
                      (!draft.trim() && !attachments.length)
                    }
                    onClick={() =>
                      void mutate("send", {
                        text: draft.trim(),
                        attachmentIds: attachments.map((item) => item.id),
                      })
                    }
                  >
                    {text("发送", "Send", "傳送", "送信")}
                  </Button>
                  {live?.executionMode !== "claude-follower" &&
                    live?.stopEnabled &&
                    live.turnId && (
                      <Button
                        variant="outline"
                        disabled={blocked}
                        onClick={() => void mutate("stop", { turnId: live.turnId })}
                      >
                        {text("停止", "Stop", "停止", "停止")}
                      </Button>
                    )}
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
