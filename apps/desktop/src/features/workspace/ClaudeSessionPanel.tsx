import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Approval,
  ControlReceipt,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  ManagedActionResult,
  ManagedInspection,
  ManagedOptions,
  SessionCapabilities,
  UploadedAttachment,
  UserQuestionRequest,
} from "../../../../../packages/web-client/src/index";
import {
  ContextUsageIndicator,
  useObservedContextUsage,
} from "@agentkib/conversation-ui/features/sessions/context-usage";
import { contextUsageCopy } from "@agentkib/conversation-ui/features/sessions/context-usage-copy";
import { ClaudeFilesPanel } from "./ClaudeFilesPanel";
import { api } from "@/core/api";
import { hasDesktopConversation } from "@/core/conversation-bridge";
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
import { MarkdownContent } from "@/components/MarkdownContent";
import { isClaudeReadBusy, useClaudeSessionObservation } from "./useClaudeSessionObservation";
import {
  mergeNativeCoverage,
  mergeOrderedPersistedHistory,
} from "@agentkib/conversation-ui/features/sessions/session-model";

type Pending = { requestId: string; operation: string; sessionId?: string; workspaceId: string };
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
    !["create", "adopt", "release", "reconcile", "send", "stop", "approve", "answer"].includes(
      value.operation,
    ) ||
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
async function request<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
  return (await api.claudeRequest({ operation, ...body })) as T;
}

/** Desktop uses the same owner service and receipts as Web; no CLI lives in the renderer. */
export function ClaudeSessionPanel({
  workspaceId,
  initialSessionId,
  onClose,
}: {
  workspaceId: string;
  initialSessionId?: string;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const text = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [observedSessionId, setObservedSessionId] = useState("");
  const [catalog, setCatalog] = useState<ConversationCatalog>();
  const [options, setOptions] = useState<ManagedOptions>();
  const [live, setLive] = useState<Live>();
  const [capabilities, setCapabilities] = useState<SessionCapabilities>();
  const [history, setHistory] = useState<ConversationEventPage>();
  const [inspection, setInspection] = useState<ManagedInspection>();
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [interaction, setInteraction] = useState<Interaction>();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const epoch = useRef(0),
    flight = useRef(false),
    loading = useRef(false);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const shown = useRef(new Set<string>());
  const refreshRef = useRef<(details?: boolean) => Promise<void>>(async () => {});
  const queuedRefresh = useRef<boolean | undefined>(undefined);
  const refreshNeedsDetails = useRef(false);
  useEffect(() => {
    epoch.current++;
    setFilesOpen(false);
    setLive(undefined);
    setObservedSessionId("");
    setCapabilities(undefined);
    setHistory(undefined);
    setInspection(undefined);
    setConfirmed(false);
    setDraft("");
    setAttachments([]);
    setInteraction(undefined);
    setAnswers({});
    setCustom({});
    setConnected(false);
    setRefreshError("");
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
          const receipt = await request<ControlReceipt>("receipt", { requestId: saved.requestId });
          if (generation !== epoch.current) {
            finishRefresh();
            return;
          }
          if (
            receipt.found &&
            receipt.requestId === saved.requestId &&
            receipt.operation === saved.operation &&
            (!saved.sessionId || saved.sessionId === receipt.sessionId) &&
            (receipt.status === "accepted" || receipt.status === "not-dispatched")
          ) {
            forgetPending(workspaceId, saved.requestId);
            nextPending = readPending(workspaceId);
            if (!nextPending) retry();
            if (receipt.status === "accepted" && saved.operation === "create")
              setSessionId(receipt.sessionId);
            if (
              receipt.status === "accepted" &&
              saved.operation === "send" &&
              saved.sessionId === sessionId
            ) {
              setDraft("");
              setAttachments([]);
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

  async function mutate(operation: string, body: Record<string, unknown> = {}) {
    if (
      flight.current ||
      pending ||
      storageBlocked ||
      !online ||
      !controlReady ||
      (compacting && ["send", "adopt", "release"].includes(operation))
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
        const result = await request<
          ManagedActionResult & { controlOutcome?: string; error?: string }
        >(operation, { ...entry, ...body, expectedRevision: live?.revision });
        if (
          (result.accepted !== true && result.reconciled !== true) ||
          (result.sessionId && operation !== "create" && result.sessionId !== sessionId)
        ) {
          if (result.controlOutcome === "not-dispatched") {
            forgetPending(workspaceId, entry.requestId);
            if (generation === epoch.current) setPending(undefined);
          }
          if (generation === epoch.current) setError(result.error || "control_outcome_unconfirmed");
        } else {
          forgetPending(workspaceId, entry.requestId);
          if (generation === epoch.current) {
            setPending(undefined);
            setInteraction(undefined);
            if (operation === "create" && result.sessionId) setSessionId(result.sessionId);
            if (operation === "send") {
              setDraft("");
              setAttachments([]);
            }
            setInspection(undefined);
            setConfirmed(false);
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
  async function inspect() {
    const generation = epoch.current;
    setConfirmed(false);
    setInspection(undefined);
    try {
      const next = await request<ManagedInspection>("inspect", { sessionId });
      if (generation === epoch.current && next.sessionId === sessionId) setInspection(next);
    } catch (e) {
      if (generation === epoch.current) setError(e instanceof Error ? e.message : "inspect_failed");
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
          setAttachments((old) => [...old, item]);
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
    idle: text("空闲", "Idle"),
    starting: text("正在启动", "Starting"),
    running: text("执行中", "Running"),
    "waiting-approval": text("等待审批", "Awaiting approval"),
    "waiting-input": text("等待回答", "Awaiting answer"),
    "awaiting-approval": text("等待审批", "Awaiting approval"),
    "awaiting-input": text("等待回答", "Awaiting answer"),
    "outcome-unknown": text("结果待核对", "Outcome unknown"),
    released: text("已释放", "Released"),
    failed: text("执行失败", "Failed"),
    unavailable: text("不可用", "Unavailable"),
    readonly: text("只读", "Read only"),
  };
  const managed = live?.executionMode === "claude-managed" && live.status !== "released";
  const blocked =
    busy ||
    !!pending ||
    storageBlocked ||
    !online ||
    !controlReady ||
    sessionId !== observedSessionId;
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
            "沿用主机 CLI 的模型和工具权限。关闭窗口不会停止执行；退出 AgentKib 会停止自有进程。",
            "Uses the host CLI model and tool permissions. Closing this panel does not stop execution; quitting AgentKib stops owned processes.",
          )}
        </p>
        <div className="flex gap-2">
          <Button
            disabled={blocked || !options?.available}
            onClick={() => void mutate("create", { workspaceId })}
          >
            {text("新建 Claude 任务", "New Claude task")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              retry();
              void refresh();
            }}
          >
            {text("刷新", "Refresh")}
          </Button>
        </div>
        {(live?.model || live?.cliVersion || options?.cliVersion) && (
          <p className="text-xs">
            {[live?.model, live?.cliVersion || options?.cliVersion].filter(Boolean).join(" · ")}
          </p>
        )}
        {!options?.available && options?.reason && <p role="status">{options.reason}</p>}
        <label>
          {text("会话", "Session")}
          <Select
            value={sessionId}
            disabled={busy}
            onValueChange={(value) => setSessionId(value ?? "")}
          >
            <SelectTrigger aria-label={text("会话", "Session")} className="w-full">
              <SelectValue placeholder={text("选择会话", "Choose a session")}>
                {sessionId
                  ? catalog?.sessions.find((item) => item.id === sessionId)?.title || "Claude Code"
                  : text("选择会话", "Choose a session")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{text("会话", "Session")}</SelectLabel>
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
        {(error || refreshError || catalogError) && (
          <p role="alert" className="text-destructive break-words">
            {error || refreshError || catalogError}
          </p>
        )}
        {pending && (
          <p role="status">
            {text(
              "结果待核对，正在查询原请求回执；不会自动重发。",
              "Outcome unknown. Checking the original receipt; no command will be replayed.",
            )}
          </p>
        )}
        {sessionId && (
          <>
            <p role="status">
              {live?.status === "idle" && live.lastOutcome === "cancelled"
                ? text("已取消", "Cancelled")
                : live?.status
                  ? statusLabels[live.status] || text("状态待核对", "State unavailable")
                  : text("正在读取", "Loading")}
              {live?.reason ? ` · ${live.reason}` : ""}
            </p>
            {filesAvailable && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  {text("文件与产物", "Files and artifacts")}
                </Button>
                {filesOpen && <ClaudeFilesPanel key={sessionId} sessionId={sessionId} />}
              </div>
            )}
            {!managed ? (
              <div className="space-y-2">
                <Button disabled={blocked} onClick={() => void inspect()}>
                  {text("准备接管", "Prepare handoff")}
                </Button>
                {inspection?.handoffFingerprint && (
                  <>
                    <label className="flex gap-2">
                      <Checkbox
                        checked={confirmed}
                        onCheckedChange={(checked) => setConfirmed(checked)}
                      />
                      {text(
                        "我已停止原终端和其他客户端，按原 UUID 继续。",
                        "I have stopped the original terminal and other clients. Continue the same UUID.",
                      )}
                    </label>
                    <Button
                      disabled={blocked || compacting || !confirmed}
                      onClick={() =>
                        void mutate("adopt", {
                          handoffConfirmed: true,
                          handoffFingerprint: inspection.handoffFingerprint,
                        })
                      }
                    >
                      {text("交给 AgentKib", "Hand over to AgentKib")}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={blocked || compacting}
                  onClick={() => void mutate("release")}
                >
                  {text("释放给原客户端", "Release to original client")}
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void mutate("reconcile")}
                >
                  {text("核对执行结果", "Reconcile outcome")}
                </Button>
              </div>
            )}
            <div
              className="max-h-80 overflow-y-auto space-y-3"
              aria-label={text("会话历史", "History")}
            >
              {history?.events.map((event) => (
                <article key={event.id}>
                  <strong className="text-xs">
                    {event.kind === "user-message"
                      ? text("你", "You")
                      : event.tool_name || "Claude"}
                  </strong>
                  <MarkdownContent content={event.content ?? event.tool_status ?? ""} />
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
                  ? text("回答问题", "Answer question")
                  : text("处理审批", "Review approval")}
              </Button>
            ))}
            {interaction && (
              <section className="rounded border p-3 space-y-2">
                <Button variant="ghost" onClick={() => setInteraction(undefined)}>
                  {text("收起", "Dismiss")}
                </Button>
                {!interactionCurrent && (
                  <p role="status">
                    {text("表单已失效，请刷新。", "This form is no longer current. Refresh.")}
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
                            aria-label={`${q.question} ${text("自定义回答", "Custom answer")}`}
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
                      {text("提交回答", "Submit answers")}
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
                          {decision === "allow" ? text("允许", "Allow") : text("拒绝", "Deny")}
                        </Button>
                      ))}
                  </>
                )}
              </section>
            )}
            <label>
              {text("消息", "Message")}
              <Textarea
                value={draft}
                maxLength={16384}
                disabled={blocked}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <label>
              {text("添加图片或文件", "Add images or files")}
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
                  {text("移除", "Remove")}
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
              />
              <Button
                disabled={
                  blocked ||
                  compacting ||
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
                {text("发送", "Send")}
              </Button>
              <Button
                variant="destructive"
                disabled={blocked || !live?.stopEnabled || !live.turnId}
                onClick={() => void mutate("stop", { turnId: live?.turnId })}
              >
                {text("停止", "Stop")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
