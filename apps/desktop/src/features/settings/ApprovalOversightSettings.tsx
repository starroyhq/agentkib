import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, History, ListChecks } from "lucide-react";
import { agentName } from "@agentkib/agent-identity";
import { MANAGED_AGENTS } from "@agentkib/runtime-protocol";
import type {
  ApprovalRule,
  ApprovalRuleList,
  SessionApprovalAuditPage,
} from "@agentkib/web-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import type { WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { SettingsNotice, SettingsSection, SettingsStatus } from "./components/SettingsLayout";

type Workspace = Pick<WorkspaceSummary, "id" | "name">;
type ReadState<T> = { kind: "ready"; value: T } | { kind: "unavailable" | "error" };

function OversightEntry({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border/60">
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="group/entry h-13 w-full justify-start rounded-none px-5 text-sm font-medium"
          />
        }
      >
        {icon}
        {label}
        <ChevronRight
          className="ms-auto size-4 text-muted-foreground group-aria-expanded/entry:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{open && children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ApprovalOversightSettings({ workspaces }: { workspaces: Workspace[] }) {
  const { tr } = useI18n();
  if (!hasDesktopConversation()) return null;
  return (
    <SettingsSection title={tr("settings.approvalOversight.title")}>
      <OversightEntry
        icon={<ListChecks aria-hidden />}
        label={tr("settings.approvalOversight.rules")}
      >
        <ApprovalRulesSettings workspaces={workspaces} />
      </OversightEntry>
      <OversightEntry icon={<History aria-hidden />} label={tr("settings.approvalOversight.audit")}>
        <ApprovalAuditSettings workspaces={workspaces} />
      </OversightEntry>
    </SettingsSection>
  );
}

function ReadNotice({ kind, retry }: { kind?: ReadState<never>["kind"]; retry: () => void }) {
  const { tr } = useI18n();
  if (kind === "ready") return null;
  if (kind === "error")
    return (
      <SettingsNotice
        tone="error"
        role="alert"
        inset={false}
        className="items-center justify-between"
      >
        {tr("settings.approvalOversight.readFailed")}
        <Button variant="outline" size="sm" onClick={retry}>
          {tr("sessions.retry")}
        </Button>
      </SettingsNotice>
    );
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {kind === "unavailable" ? tr("settings.approvalOversight.unsupported") : tr("common.loading")}
    </p>
  );
}

function ApprovalRulesSettings({ workspaces }: { workspaces: Workspace[] }) {
  const { tr, formatDateTime } = useI18n();
  const [client] = useState(createDesktopConversationClient);
  const selectId = useId();
  const [selection, setSelection] = useState("");
  const workspaceId = workspaces.find(({ id }) => id === selection)?.id;
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{
    workspaceId?: string;
    revision: number;
    state: ReadState<{ list: ApprovalRuleList; fullAccess: boolean }>;
  }>();
  const visibleRead =
    read?.revision === revision && read.workspaceId === workspaceId ? read.state : undefined;
  const [selectedRule, setSelectedRule] = useState<{ rule: ApprovalRule; workspaceId?: string }>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"revoked" | "failed">();
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const settle = (state: NonNullable<typeof read>["state"]) => {
      if (!abort.signal.aborted) setRead({ workspaceId, revision, state });
    };
    void client
      .access(abort.signal)
      .then(async (access) => {
        if (abort.signal.aborted) return;
        if (access.approvalRulesVersion !== 1) {
          settle({ kind: "unavailable" });
          return;
        }
        const list = await client.approvalRules(workspaceId);
        settle({
          kind: "ready",
          value: {
            list,
            fullAccess: access.device?.accessMode === "full" && access.device.settings === true,
          },
        });
      })
      .catch(() => settle({ kind: "error" }));
    return () => abort.abort();
  }, [client, workspaceId, revision]);

  const list = visibleRead?.kind === "ready" ? visibleRead.value.list : undefined;
  const fullAccess = visibleRead?.kind === "ready" && visibleRead.value.fullAccess;
  function reload() {
    setFeedback(undefined);
    setRevision((current) => current + 1);
  }
  async function revoke() {
    if (
      saving.current ||
      !selectedRule ||
      selectedRule.workspaceId !== workspaceId ||
      !selectedRule.rule.revocable ||
      !list?.providers[selectedRule.rule.agent]?.revoke ||
      !fullAccess
    )
      return;
    const { rule, workspaceId: requestedWorkspace } = selectedRule;
    saving.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      const access = await client.access();
      if (!mounted.current) return;
      if (
        access.approvalRulesVersion !== 1 ||
        access.device?.accessMode !== "full" ||
        access.device.settings !== true
      )
        throw new Error("approval-rule-write-not-authorized");
      const result = await client.revokeApprovalRule(rule.agent, rule.id, requestedWorkspace);
      if (result?.revoked !== true) throw new Error("approval-rule-write-unconfirmed");
      if (mounted.current) {
        setFeedback("revoked");
        setRevision((current) => current + 1);
      }
    } catch {
      if (mounted.current) {
        setFeedback("failed");
        setRevision((current) => current + 1);
      }
    } finally {
      saving.current = false;
      if (mounted.current) {
        setBusy(false);
        setSelectedRule(undefined);
      }
    }
  }

  return (
    <div className="grid gap-4 border-t border-border/60 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor={selectId}>
          {tr("settings.approvalOversight.scope")}
        </label>
        <NativeSelect
          id={selectId}
          value={workspaceId ?? ""}
          disabled={busy || selectedRule !== undefined || visibleRead?.kind === "unavailable"}
          onChange={(event) => {
            setSelection(event.target.value);
            setFeedback(undefined);
          }}
        >
          <NativeSelectOption value="">
            {tr("settings.approvalOversight.scope.global")}
          </NativeSelectOption>
          {workspaces.map((workspace) => (
            <NativeSelectOption key={workspace.id} value={workspace.id}>
              {workspace.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {list && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={reload}>
            {tr("common.refresh")}
          </Button>
        )}
      </div>
      <ReadNotice kind={visibleRead?.kind} retry={reload} />
      {list && (
        <div className="grid gap-4">
          {!list.rules.length && (
            <p className="text-sm text-muted-foreground">
              {tr("settings.approvalOversight.emptyRules")}
            </p>
          )}
          {MANAGED_AGENTS.map((agent) => {
            const provider = list.providers[agent];
            const rules = list.rules.filter((rule) => rule.agent === agent);
            return (
              <div key={agent} className="grid gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <h3>{agentName(agent)}</h3>
                  <SettingsStatus indicator={false}>
                    {!provider?.list
                      ? tr("settings.approvalOversight.notListed")
                      : !provider.revoke || !fullAccess
                        ? tr("settings.approvalOversight.readOnly")
                        : null}
                  </SettingsStatus>
                </div>
                {!!rules.length && (
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {rules.map((rule) => {
                      const canRevoke = rule.revocable && Boolean(provider?.revoke) && fullAccess;
                      return (
                        <li key={rule.id} className="flex items-start justify-between gap-3 p-3">
                          <div className="grid min-w-0 gap-1">
                            <code className="text-sm break-all">{rule.content}</code>
                            <span className="text-xs break-all text-muted-foreground">
                              {tr("settings.approvalOversight.scope." + rule.scope)} · {rule.source}
                            </span>
                            {rule.lastUsedAt && (
                              <span className="text-xs text-muted-foreground">
                                {tr("settings.approvalOversight.lastUsed", {
                                  time: formatDateTime(rule.lastUsedAt),
                                })}
                              </span>
                            )}
                          </div>
                          <Button
                            className="shrink-0"
                            variant="outline"
                            size="sm"
                            disabled={!canRevoke || busy}
                            title={
                              !canRevoke ? tr("settings.approvalOversight.readOnly") : undefined
                            }
                            onClick={() => setSelectedRule({ rule, workspaceId })}
                          >
                            {tr("settings.approvalOversight.revoke")}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      {feedback && (
        <SettingsNotice
          inset={false}
          role={feedback === "failed" ? "alert" : "status"}
          tone={feedback === "failed" ? "error" : "default"}
        >
          {tr("settings.approvalOversight." + (feedback === "failed" ? "revokeFailed" : "revoked"))}
        </SettingsNotice>
      )}
      <AlertDialog
        open={selectedRule !== undefined}
        onOpenChange={(open) => {
          if (!open && !saving.current) setSelectedRule(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("settings.approvalOversight.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("settings.approvalOversight.revokeDescription")}
            </AlertDialogDescription>
            <code className="text-sm break-all">{selectedRule?.rule.content}</code>
            <span className="text-xs break-all text-muted-foreground">
              {selectedRule?.rule.source}
            </span>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{tr("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy || selectedRule?.workspaceId !== workspaceId}
              aria-busy={busy}
              onClick={() => void revoke()}
            >
              {tr("settings.approvalOversight.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ApprovalAuditSettings({ workspaces }: { workspaces: Workspace[] }) {
  const { tr, formatDateTime } = useI18n();
  const [client] = useState(createDesktopConversationClient);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{
    revision: number;
    state: ReadState<SessionApprovalAuditPage>;
  }>();
  const visibleRead = read?.revision === revision ? read.state : undefined;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pageError, setPageError] = useState(false);
  const paging = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    const settle = (state: ReadState<SessionApprovalAuditPage>) => {
      if (!abort.signal.aborted) setRead({ revision, state });
    };
    void client
      .access(abort.signal)
      .then(async (access) => {
        if (abort.signal.aborted) return;
        if (access.approvalAuditVersion !== 1) {
          settle({ kind: "unavailable" });
          return;
        }
        settle({ kind: "ready", value: await client.approvalAudit() });
      })
      .catch(() => settle({ kind: "error" }));
    return () => abort.abort();
  }, [client, revision]);

  const page = visibleRead?.kind === "ready" ? visibleRead.value : undefined;
  function reload() {
    setPageError(false);
    setRevision((current) => current + 1);
  }
  async function loadOlder() {
    if (paging.current || !page?.nextCursor) return;
    const before = page.nextCursor;
    paging.current = true;
    setLoadingOlder(true);
    setPageError(false);
    try {
      const next = await client.approvalAudit(before);
      setRead((current) => {
        if (current?.revision !== revision || current.state.kind !== "ready") return current;
        if (current.state.value.nextCursor !== before) return current;
        const entries = current.state.value.entries;
        const known = new Set(entries.map((entry) => entry.id));
        return {
          ...current,
          state: {
            kind: "ready",
            value: {
              entries: [...entries, ...next.entries.filter((entry) => !known.has(entry.id))],
              nextCursor: next.nextCursor,
            },
          },
        };
      });
    } catch {
      setPageError(true);
    } finally {
      paging.current = false;
      setLoadingOlder(false);
    }
  }

  return (
    <div className="grid gap-4 border-t border-border/60 px-5 py-4">
      <ReadNotice kind={visibleRead?.kind} retry={reload} />
      {page && (
        <>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={reload} disabled={loadingOlder}>
              {tr("common.refresh")}
            </Button>
          </div>
          {!page.entries.length && (
            <p className="text-sm text-muted-foreground">
              {tr("settings.approvalOversight.emptyAudit")}
            </p>
          )}
          {!!page.entries.length && (
            <ol className="grid gap-3">
              {page.entries.map((entry) => {
                const workspace = workspaces.find(({ id }) => id === entry.workspaceId);
                return (
                  <li key={entry.id} className="grid gap-2 rounded-lg border border-border/60 p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <strong>
                        {tr("settings.approvalOversight.decision." + entry.decision.kind)}
                      </strong>
                      <span>
                        {tr("settings.approvalOversight.decisionScope." + entry.decision.scope)}
                      </span>
                      <time className="ms-auto text-xs text-muted-foreground" dateTime={entry.time}>
                        {formatDateTime(entry.time)}
                      </time>
                    </div>
                    <p className="text-sm wrap-anywhere">{entry.summary}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <SettingsStatus
                        tone={
                          entry.risk.level === "high"
                            ? "error"
                            : entry.risk.level === "file-modification"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {tr("settings.approvalOversight.risk." + entry.risk.level)}
                      </SettingsStatus>
                      <SettingsStatus
                        tone={
                          entry.result === "executed"
                            ? "success"
                            : entry.result === "denied"
                              ? "error"
                              : entry.result === "expired"
                                ? "warning"
                                : "neutral"
                        }
                      >
                        {tr("settings.approvalOversight.result." + entry.result)}
                      </SettingsStatus>
                    </div>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <dt>{tr("settings.approvalOversight.source")}</dt>
                      <dd className="break-all">
                        {[
                          tr("settings.approvalOversight.channel." + entry.source.kind),
                          entry.source.deviceName,
                          entry.source.deviceId,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </dd>
                      <dt>{agentName(entry.agent)}</dt>
                      <dd className="break-all">
                        {tr("settings.approvalOversight.session")}: <code>{entry.sessionId}</code>
                      </dd>
                      {entry.workspaceId && (
                        <>
                          <dt>{tr("catalog.workspace")}</dt>
                          <dd className="break-all">
                            {workspace && <>{workspace.name} · </>}
                            <code>{entry.workspaceId}</code>
                          </dd>
                        </>
                      )}
                    </dl>
                  </li>
                );
              })}
            </ol>
          )}
          {pageError && (
            <SettingsNotice inset={false} role="alert" tone="error">
              {tr("settings.approvalOversight.readFailed")}
            </SettingsNotice>
          )}
          {page.nextCursor && (
            <Button
              variant="outline"
              className="justify-self-start"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder
                ? tr("common.loading")
                : pageError
                  ? tr("sessions.retry")
                  : tr("settings.approvalOversight.older")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
