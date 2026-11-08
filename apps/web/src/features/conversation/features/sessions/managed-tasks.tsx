import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { codexReason } from "./codex-copy";
import { managedErrorCopyForSurface } from "./managed-error-copy";
import { managedText } from "./managed-copy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSessionNavigate } from "./session-navigation";
import { subscribeSessionInvalidation } from "./session-events";
import { Plus } from "lucide-react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  type ManagedAgent,
  type ManagedOptions,
  type ClaudePermissionMode,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { useSession } from "./session-context";
import { catalogCopy } from "../catalog/catalog-copy";
import { dictionaries } from "../../i18n";
import { sessionAgentCopy } from "./session-agent-copy";
import { dshAgentPresetCopy, dshAgentPresetText } from "@agentkib/session-ui";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";

type Options = ManagedOptions;

export function ManagedTasks({
  create = false,
  active,
  renderContent,
  onClose,
  onDismiss,
  initialOpen = false,
  showTrigger = true,
}: {
  create?: boolean;
  active?: boolean;
  renderContent?: (content: ReactNode) => ReactNode;
  onClose?: () => void;
  onDismiss?: () => void;
  initialOpen?: boolean;
  showTrigger?: boolean;
}) {
  const session = useSession();
  const { client, origin, access, current, selected, refresh, locale } = session;
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const open = renderContent ? !!active : localOpen;
  function setOpen(value: boolean) {
    setLocalOpen(value);
    if (!value && renderContent) onClose?.();
  }
  const [createAgent, setCreateAgent] = useState<ManagedAgent>("codex");
  const agent: ManagedAgent = create
    ? createAgent
    : current?.agent === "claude-code"
      ? "claude-code"
      : "codex";
  const [options, setOptions] = useState<Options>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode | "">("");
  const [agentPreset, setAgentPreset] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  function reportError(value: unknown) {
    if (value instanceof ApiError) {
      const reason = codexReason(locale, value.code.replaceAll("_", "-"), "web");
      setError(
        value.controlOutcome === "unknown"
          ? managedErrorCopyForSurface(locale, "web").unconfirmed
          : reason.technical
            ? managedErrorCopyForSurface(locale, "web").failed
            : reason.text,
      );
      setErrorDetail(value.code);
    } else {
      setError(managedErrorCopyForSurface(locale, "web").connection);
      setErrorDetail("");
    }
  }
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<PendingControl>();
  const [pendingReadRevision, setPendingReadRevision] = useState(0);
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
  const flight = useRef(false);
  const epoch = useRef(0);
  const navigate = useSessionNavigate();
  useEffect(() => {
    // A panel closing only hides controls; it must not invalidate an in-flight
    // command or prevent its unknown outcome from entering receipt reconciliation.
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [
    scope,
    selected,
    create,
    agent,
    client,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
  ]);
  useEffect(() => {
    const readSaved = () => {
      // A create already in flight is reconciled only after its transport result is unknown.
      if (create && flight.current) return;
      setPending(undefined);
      setUncertain(false);
      if (!scope) return;
      try {
        const entry = readPending(scope).find((value) =>
          create
            ? value.kind === "create" && (value.agent ?? "codex") === agent
            : value.sessionId === selected &&
              ["adopt", "release", "reconcile"].includes(value.kind),
        );
        setPending(entry);
        setUncertain(!!entry);
      } catch {
        setUncertain(true);
        setError(
          managedText(
            locale,
            "Cannot read the saved request identity.",
            "无法读取已保存的请求标识。",
            "web",
          ),
        );
      }
    };
    readSaved();
    return subscribePending(readSaved);
  }, [scope, selected, create, agent, locale, pendingReadRevision]);
  useEffect(() => {
    if (
      !scope ||
      !pending ||
      access?.status !== "approved" ||
      !access.device?.manage ||
      !access.experimentalEnabled
    )
      return;
    let cancelled = false;
    let checking = false;
    let dirty = false;
    const checkOnce = async () => {
      const generation = epoch.current;
      try {
        const result = await client.receipt(pending.requestId);
        if (
          cancelled ||
          !result.found ||
          result.requestId !== pending.requestId ||
          (!isLegacyPreparedReceipt(result, pending.requestId) &&
            (result.recovery !== undefined ||
              (pending.sessionId && result.sessionId !== pending.sessionId) ||
              result.operation !== pending.kind ||
              result.status === "unknown"))
        )
          return false;
        if (result.status !== "accepted" && result.status !== "not-dispatched") return false;
        forgetPending(scope, pending.requestId);
        if (create) {
          setPending(undefined);
          setUncertain(false);
        }
        setError(
          result.status === "not-dispatched"
            ? managedText(
                locale,
                "The request was not dispatched.",
                "该请求未发送到执行端。",
                "web",
              )
            : "",
        );
        await refresh(true);
        if (generation !== epoch.current) return true;
        if (result.status === "accepted" && pending.kind === "create") {
          setOpen(false);
          void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
        }
        return true;
      } catch {
        /* Keep the saved identity and never retry the command itself. */
        return false;
      }
    };
    const check = async () => {
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        do {
          dirty = false;
          if (await checkOnce()) break;
        } while (dirty && !cancelled);
      } finally {
        checking = false;
      }
    };
    void check();
    const unsubscribe = subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["receipts", "ownership"].includes(domain))
      )
        void check();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    scope,
    pending,
    access?.status,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
    client,
    refresh,
    navigate,
    locale,
  ]);
  useEffect(() => {
    if (!create || !open || !access?.device?.manage || !access.experimentalEnabled) return;
    const abort = new AbortController();
    setOptions(undefined);
    void client
      .request<Options>(
        agent === "codex" ? "managed/options" : `managed/options?agent=${agent}`,
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (abort.signal.aborted) return;
        setOptions(value);
        setWorkspaceId(value.workspaces[0]?.id ?? "");
        setModel("");
        setEffort("");
        setPermissionMode("");
        setAgentPreset(value.agentPresets?.find((preset) => preset.isDefault)?.id ?? "");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) reportError(e);
      });
    return () => {
      abort.abort();
    };
  }, [
    open,
    agent,
    create,
    client,
    selected,
    access?.bootId,
    access?.device?.id,
    access?.device?.manage,
    access?.experimentalEnabled,
  ]);
  useEffect(() => {
    // An initial create request may arrive before the trusted access read finishes.
    if (access && (!access.device?.manage || !access.experimentalEnabled)) setLocalOpen(false);
  }, [access?.status, access?.device?.manage, access?.experimentalEnabled]);
  if (
    !access?.device?.manage ||
    !access.experimentalEnabled ||
    (!create && current?.agent !== "codex" && current?.agent !== "claude-code") ||
    (!create && !uncertain)
  )
    return renderContent ? renderContent(null) : null;
  async function run() {
    if (flight.current || !create || uncertain || !options?.available || !workspaceId) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setErrorDetail("");
    const generation = epoch.current;
    const requestId = crypto.randomUUID();
    const entry: PendingControl = {
      requestId,
      kind: "create",
      agent,
      workspaceId,
    };
    try {
      try {
        if (!scope) throw new Error("missing_device_scope");
        rememberPending(scope, entry);
      } catch {
        throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
      }
      const result = await client.request<{ sessionId?: string }>("managed/create", {
        ...(agent !== "codex" ? { agent } : {}),
        bootId: access!.bootId,
        requestId,
        workspaceId,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(agent === "claude-code" && permissionMode ? { permissionMode } : {}),
        // Without a choice DSH starts its own default preset.
        ...(agent === "deepseek-harness" &&
        agentPreset &&
        agentPreset !== options.agentPresets?.find((preset) => preset.isDefault)?.id
          ? { agentPreset }
          : {}),
      });
      if (scope) forgetPending(scope, requestId);
      if (generation !== epoch.current) return;
      setPending(undefined);
      await refresh(true);
      if (generation !== epoch.current) return;
      setOpen(false);
      setUncertain(false);

      if (result.sessionId)
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
    } catch (e) {
      if (scope && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        try {
          forgetPending(scope, requestId);
        } catch {
          /* Preserve storage if unavailable. */
        }
      } else if (generation === epoch.current) setPending(entry);
      if (
        generation === epoch.current &&
        (!(e instanceof ApiError) || e.controlOutcome !== "not-dispatched")
      ) {
        setUncertain(true);
      }
      if (generation === epoch.current) reportError(e);
    } finally {
      flight.current = false;
      setBusy(false);
      // An access/runtime change may have suppressed the storage subscription
      // while this create was in flight. Read its durable identity in the new scope.
      if (generation !== epoch.current) setPendingReadRevision((value) => value + 1);
    }
  }
  const content = (
    <div className="space-y-4">
      {create && (
        <p className="text-sm text-muted-foreground">
          {managedText(
            locale,
            "AgentKib must stay running on this computer (the computer running the Agent). Tasks use workspace access and request approval when needed.",
            "AgentKib 需要在这台电脑上保持运行。任务使用工作区权限，需要审批时等待你的确认。",
            "web",
          )}
        </p>
      )}
      {create && (
        <label>
          {managedText(locale, "Agent", "执行工具", "web")}
          <select
            className="mt-2 w-full rounded border bg-background p-2"
            value={agent}
            disabled={busy || uncertain}
            onChange={(event) => setCreateAgent(event.target.value as ManagedAgent)}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
            <option value="deepseek-harness">DeepSeek Harness</option>
          </select>
        </label>
      )}
      {error && (
        <div role="alert" className="break-words text-sm text-destructive-text">
          <p>{error}</p>
          {errorDetail && (
            <Disclosure className="mt-2">
              <DisclosureSummary>
                {managedErrorCopyForSurface(locale, "web").details}
              </DisclosureSummary>
              <code>{errorDetail}</code>
            </Disclosure>
          )}
        </div>
      )}
      {uncertain && (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>
            {managedText(
              locale,
              "The previous outcome is unconfirmed. Wait for the saved request's status before another operation.",
              "上次操作结果尚未确认。请等待系统确认已保存的请求，再执行新的操作。",
              "web",
            )}
          </p>
          <p>
            {managedText(
              locale,
              "The saved request status is checked automatically. Refreshing does not run the operation again.",
              "正在自动查询已保存请求的处理状态；刷新不会重新执行操作。",
              "web",
            )}
          </p>
        </div>
      )}
      {!create ? null : !options ? (
        <p role="status">{managedText(locale, "Loading…", "正在读取…", "web")}</p>
      ) : (
        <>
          {!options.available && (
            <div role="status">
              <p>
                {options.reason
                  ? codexReason(locale, options.reason, "web").text
                  : managedText(locale, "Agent unavailable", "执行工具暂不可用", "web")}
              </p>
              {options.reason && (
                <Disclosure className="mt-2">
                  <DisclosureSummary>
                    {managedErrorCopyForSurface(locale, "web").details}
                  </DisclosureSummary>
                  <code>{options.reason}</code>
                </Disclosure>
              )}
            </div>
          )}
          {
            <>
              <label>
                {managedText(locale, "Workspace", "工作区", "web")}
                <select
                  className="mt-2 w-full rounded border bg-background p-2"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {options.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              {/* Beside the workspace, as on DSH's new-session screen: a preset is chosen only
                  when a session starts. */}
              {agent === "deepseek-harness" && !!options.agentPresets?.length && (
                <label>
                  {dshAgentPresetCopy(locale).label}
                  <select
                    className="mt-2 w-full rounded border bg-background p-2"
                    value={agentPreset}
                    onChange={(e) => setAgentPreset(e.target.value)}
                  >
                    {options.agentPresets.map((preset) => (
                      <option key={preset.id} value={preset.id} disabled={!!preset.broken}>
                        {dshAgentPresetText(preset, locale).name}
                        {preset.broken ? ` · ${dshAgentPresetCopy(locale).broken}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!options.workspaces.length && (
                <p>
                  {managedText(
                    locale,
                    "Authorize a workspace in Web settings in AgentKib on this computer first.",
                    "请先在这台电脑上的 AgentKib 的 Web 设置中授权工作区。",
                    "web",
                  )}
                </p>
              )}
              {(agent === "codex" || !!options.models?.length) && (
                <>
                  {agent === "codex" && (
                    <p className="text-xs text-muted-foreground">
                      {catalogCopy[locale].codexContextNote}
                    </p>
                  )}
                  <label>
                    {managedText(locale, "Model", "模型", "web")}
                    <select
                      className="mt-2 w-full rounded border bg-background p-2"
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setEffort("");
                      }}
                    >
                      <option value="">
                        {managedText(locale, "Computer default", "这台电脑默认", "web")}
                      </option>
                      {options.models?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!!options.models?.find((m) => m.id === model)?.efforts?.length && (
                    <label>
                      {managedText(locale, "Reasoning effort", "思考强度", "web")}
                      <select
                        className="mt-2 w-full rounded border bg-background p-2"
                        value={effort}
                        onChange={(e) => setEffort(e.target.value)}
                      >
                        <option value="">{managedText(locale, "Default", "默认", "web")}</option>
                        {options.models
                          .find((m) => m.id === model)!
                          .efforts!.map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              {agent === "claude-code" && !!options.permissionModes?.length && (
                <label>
                  {sessionAgentCopy[locale].permission}
                  <select
                    className="mt-2 w-full rounded border bg-background p-2"
                    value={permissionMode}
                    onChange={(event) =>
                      setPermissionMode(event.target.value as ClaudePermissionMode | "")
                    }
                  >
                    <option value="">
                      {managedText(locale, "Computer default", "这台电脑默认", "web")}
                    </option>
                    {options.permissionModes
                      .filter((item) => ["default", "plan", "acceptEdits"].includes(item.id))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {agent === "claude-code" && (
                <p className="text-xs text-muted-foreground">
                  {managedText(
                    locale,
                    "Uses the Claude Code model and tool permissions from this computer by default. Creating a task does not start a model request.",
                    "默认沿用这台电脑上的 Claude Code 的模型与工具权限。创建任务不会调用模型。",
                    "web",
                  )}
                </p>
              )}
              <Button
                disabled={busy || uncertain || !options.available || !workspaceId}
                onClick={() => void run()}
              >
                {managedText(locale, "Create", "创建", "web")}
              </Button>
            </>
          }
        </>
      )}
    </div>
  );
  if (renderContent) return renderContent(content);
  if (!create) return null;
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setOpen(true)}>
          {create && <Plus size={16} />}
          {managedText(locale, "New task", "新建任务", "web")}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) onDismiss?.();
          }
        }}
      >
        <DialogContent closeLabel={dictionaries[locale].close}>
          <DialogTitle>{managedText(locale, "New task", "新建任务", "web")}</DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    </>
  );
}
