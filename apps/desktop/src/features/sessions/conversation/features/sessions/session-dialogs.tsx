import { NativeScope } from "../interactions/native-scope";
import { NativeDecisions } from "../interactions/native-decisions";
import { codexCopy } from "./codex-copy";
import { PreferencesDialog } from "../preferences/preferences-dialog";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { ToolDetailBody } from "@agentkib/session-ui";
import { toolStatusLabel } from "./tool-status";
import { QuestionForm, interactionCopy } from "../interactions/question-form";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
const MCP_REQUEST = "mcpServer/elicitation/request";
/** The text an MCP server or Codex asks the user, shown as written. */
function mcpMessage(input: unknown): string | null {
  const message =
    input && typeof input === "object" ? (input as { message?: unknown }).message : null;
  return typeof message === "string" && message.trim() ? message : null;
}
/** Everything else the request names: server, tool, its arguments, a link or form fields. */
function mcpDetails(input: unknown): unknown {
  if (!input || typeof input !== "object") return null;
  const { message: _message, kind: _kind, ...details } = input as Record<string, unknown>;
  return details;
}
export function SessionDialogs() {
  const {
    modal,
    setModal,
    t,
    locale,
    selected,
    busy,
    access,
    live,
    controlReady,
    online,
    control,
  } = useSession();
  return (
    <>
      {" "}
      {modal === "preferences" && <PreferencesDialog />}
      {modal === "metadata" && <SessionDetailsDialog />}
      {typeof modal === "object" && "kind" in modal && (
        <Dialog closeLabel={t.close} title={t.tool} onClose={() => setModal(undefined)}>
          <h3>{modal.tool_name || t.unknownTool}</h3>
          <p>{toolStatusLabel(modal.tool_status, locale)}</p>
          {modal.timestamp && <time>{new Date(modal.timestamp).toLocaleString(locale)}</time>}
          {modal.tool ? (
            <ToolDetailBody tool={modal.tool} locale={locale} />
          ) : (
            <pre>{modal.content?.trim() ? modal.content : t.toolSummaryUnavailable}</pre>
          )}
          {modal.truncated && <p>{t.truncated}</p>}
        </Dialog>
      )}
      {typeof modal === "object" && "questions" in modal && (
        <Dialog
          panel
          closeLabel={t.close}
          title={interactionCopy[locale].title}
          onClose={() => setModal(undefined)}
        >
          <QuestionForm
            key={`${selected}:${JSON.stringify(modal)}`}
            request={modal}
            locale={locale}
            busy={busy}
            requestContext={
              access && live
                ? { sessionId: selected, bootId: access.bootId, expectedRevision: live.revision }
                : undefined
            }
            enabled={
              !!(
                modal.supported &&
                access?.experimentalEnabled &&
                access.device?.send &&
                online &&
                controlReady &&
                live?.questions?.some((q) => JSON.stringify(q) === JSON.stringify(modal))
              )
            }
            onSubmit={(answers) => void control("answer", undefined, undefined, modal, answers)}
          />
        </Dialog>
      )}
      {typeof modal === "object" && "requestId" in modal && !("questions" in modal) && (
        <Dialog panel closeLabel={t.close} title={t.approval} onClose={() => setModal(undefined)}>
          <p>
            {modal.decisionOptions?.length
              ? codexCopy[locale].native
              : modal.method === "claude/can_use_tool"
                ? t.claudeDecisionInfo
                : t.decisionInfo}
          </p>
          {(modal.method === "claude/can_use_tool" || modal.method === MCP_REQUEST) && (
            <h3>{modal.toolName || t.unknownTool}</h3>
          )}
          {modal.method === MCP_REQUEST && mcpMessage(modal.input) && (
            <p className="whitespace-pre-wrap break-words">{mcpMessage(modal.input)}</p>
          )}
          {modal.environmentId === "local" && <p>{t.localExecution}</p>}
          {modal.cwd && (
            <dl>
              <dt>{t.cwd}</dt>
              <dd>{modal.cwd}</dd>
            </dl>
          )}
          <pre>
            {JSON.stringify(
              modal.method === "claude/can_use_tool"
                ? (modal.input ?? null)
                : modal.method === MCP_REQUEST
                  ? mcpDetails(modal.input)
                  : modal.method === "session/request_permission"
                    ? (modal.toolCall ?? null)
                    : (modal.command ?? modal.changes ?? null),
              null,
              2,
            )}
          </pre>
          {modal.requestContext && <NativeScope value={modal.requestContext} locale={locale} />}
          <NativeDecisions
            key={`${selected}:${JSON.stringify(modal)}`}
            approval={modal}
            locale={locale}
            busy={busy}
            enabled={
              !!(
                modal.supported &&
                access?.experimentalEnabled &&
                access.device?.approve &&
                access.device?.extendedApproval &&
                controlReady &&
                online &&
                live?.approvals.some((item) => JSON.stringify(item) === JSON.stringify(modal))
              )
            }
            submit={(nativeDecision) =>
              void control("approve", modal, undefined, undefined, undefined, { nativeDecision })
            }
          />
          {modal.method === MCP_REQUEST && !modal.availableDecisions.includes("accept") && (
            <aside className="info">{codexCopy[locale].mcpDeclineOnly}</aside>
          )}
          {modal.method === "claude/can_use_tool" && modal.context && (
            <aside className="info">
              <p>{t.claudeContextInfo}</p>
              <pre>{JSON.stringify(modal.context, null, 2)}</pre>
            </aside>
          )}
          {!modal.decisionOptions?.length &&
            modal.method !== "claude/can_use_tool" &&
            modal.proposedExecpolicyAmendment && (
              <aside className="info block [&>pre]:mt-3">
                <p>{t.policyProposal}</p>
                <pre>{JSON.stringify(modal.proposedExecpolicyAmendment, null, 2)}</pre>
              </aside>
            )}
          {modal.supported &&
          access?.experimentalEnabled &&
          access.device?.approve &&
          controlReady &&
          online &&
          live?.approvals.some((a) => JSON.stringify(a) === JSON.stringify(modal)) ? (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {modal.availableDecisions
                .filter(() => !modal.decisionOptions?.length)
                .filter((d) =>
                  (modal.method === "claude/can_use_tool"
                    ? ["allow", "deny"]
                    : modal.method === "session/request_permission"
                      ? (modal.options?.map((option) => option.optionId) ?? [])
                      : ["accept", "decline", "cancel"]
                  ).includes(d),
                )
                .map((d) => (
                  <Button
                    variant="ghost"
                    key={d}
                    className={
                      modal.method !== "session/request_permission" &&
                      (d === "accept" || d === "allow")
                        ? "bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]"
                        : "border"
                    }
                    disabled={busy}
                    onClick={() => void control("approve", modal, d)}
                  >
                    {modal.method !== "session/request_permission" &&
                      (d === "accept" || d === "allow") && <Check size={16} />}{" "}
                    {modal.method === "session/request_permission"
                      ? (modal.options?.find((option) => option.optionId === d)?.name ?? d)
                      : d === "cancel"
                        ? t.cancelTurn
                        : t[d as "accept" | "allow" | "deny" | "decline"]}
                  </Button>
                ))}
            </div>
          ) : (
            <aside className="info">{t.approvalFallback}</aside>
          )}
        </Dialog>
      )}
    </>
  );
}
