import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowUp, ChevronRight, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { SafeMarkdown, Transcript } from "@agentkib/session-ui";
import { useNavigate } from "@tanstack/react-router";
import { interactionCopy } from "@/features/interactions/question-form";
import { MAX_MESSAGE_LENGTH, isValidMessage } from "./session-model";
import { useSession } from "./session-context";
export function SessionReader() {
  const {
    t,
    c,
    access,
    selected,
    current,
    currentTitle,
    currentWorkspace,
    leaveSession,
    setModal,
    refresh,
    online,
    liveText,
    scroll,
    page,
    busy,
    earlier,
    locale,
    live,
    notice,
    canSend,
    message,
    setMessage,
    control,
  } = useSession();
  const navigate = useNavigate();
  if (!access || !selected) return null;
  return (
    <>
      {" "}
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b px-3 md:px-6">
        <Button
          variant="ghost"
          aria-label={t.back}
          onClick={() => {
            leaveSession();
            void navigate({ to: "/sessions" });
          }}
        >
          <ArrowLeft size={18} />
        </Button>
        <AgentMark agent={current?.agent} size={20} />
        <div className="min-w-0 flex-1 [&>h1]:truncate [&>h1]:text-sm [&>h1]:font-medium [&>small]:block [&>small]:truncate [&>small]:text-xs [&>small]:text-muted-foreground">
          <h1 aria-label={`${agentName(current?.agent)} · ${currentTitle}`} title={currentTitle}>
            {currentTitle}
          </h1>
          <small title={currentWorkspace?.path}>{currentWorkspace?.name || c.missing}</small>
        </div>
        <Button variant="ghost" aria-label={t.details} onClick={() => setModal("metadata")}>
          <Settings2 size={18} />
        </Button>
        <Button variant="ghost" aria-label={t.refresh} onClick={() => void refresh(true)}>
          <RefreshCw size={18} />
        </Button>
      </header>
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3 text-[11px] text-muted-foreground md:px-8">
        <span>{t.history}</span>
        <span
          className={
            online
              ? "inline-flex items-center gap-2 before:size-1.5 before:rounded-full before:bg-emerald-500"
              : "text-amber-600"
          }
        >
          {online ? `${t.live} · ${liveText}` : t.offline}
        </span>
      </div>
      <section
        className="reader-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-3 [scrollbar-gutter:stable] md:px-10"
        ref={scroll}
      >
        {current?.agent === "claude-code" && (
          <aside className="info mx-auto mb-5 max-w-3xl">{t.managedResumeInfo}</aside>
        )}
        {page?.warnings.length ? (
          <aside className="mx-auto mb-5 max-w-3xl rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-600">
            {t.warnings}: {page.warnings.join(" · ")}
          </aside>
        ) : null}
        {page?.next_cursor && (
          <Button
            variant="ghost"
            className="mx-auto mb-5 flex text-xs text-muted-foreground"
            disabled={busy}
            onClick={() => void earlier()}
          >
            {t.earlier}
          </Button>
        )}
        {!page ? (
          <p role="status">{t.loading}</p>
        ) : (
          <Transcript
            key={selected}
            events={page.events}
            incomplete={page.warnings.length > 0}
            labels={t}
            onTool={setModal}
            locale={locale}
          />
        )}
        {live?.streamText && live.status !== "idle" && (
          <article aria-label={t.streamingReply}>
            <small>{t.streamingReply}</small>
            <SafeMarkdown text={live.streamText} />
            {live.streamTextTruncated && <p role="note">{t.streamingReplyTruncated}</p>}
          </article>
        )}
      </section>
      {live?.approvals.map((a) => (
        <Button
          variant="ghost"
          key={a.requestId}
          className="mx-5 my-2 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
          onClick={() => setModal(a)}
        >
          <ShieldCheck size={19} />
          {t.approval}
          <ChevronRight size={18} />
        </Button>
      ))}
      {live?.questions?.map((q) => (
        <Button
          variant="ghost"
          key={q.requestId}
          className="mx-5 my-2 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
          onClick={() => setModal(q)}
        >
          {interactionCopy[locale].title}
          <ChevronRight size={18} />
        </Button>
      ))}
      {notice && (
        <p
          role="status"
          className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
        >
          {t[notice]}
        </p>
      )}
      {(current?.agent === "codex" || current?.agent === "claude-code") &&
      access.experimentalEnabled &&
      access.device?.send ? (
        <form
          className="mx-4 mb-4 mt-3 w-[calc(100%-2rem)] max-w-3xl shrink-0 self-center rounded-2xl border bg-card p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/20 md:mb-6 [&>textarea]:min-h-16 [&>textarea]:max-h-40 [&>textarea]:resize-y [&>textarea]:border-0 [&>textarea]:shadow-none [&>textarea]:focus-visible:ring-0 [&>div]:flex [&>div]:items-end [&>div]:justify-between [&>div]:gap-4 [&_small]:max-w-lg [&_small]:text-[10px] [&_small]:leading-5 [&_small]:text-muted-foreground"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend && isValidMessage(message)) void control("send");
          }}
        >
          <label className="sr-only" htmlFor="message">
            {t.message}
          </label>
          <Textarea
            id="message"
            value={message}
            maxLength={MAX_MESSAGE_LENGTH}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t.message}
            disabled={!online || busy}
          />
          <div>
            <small>
              {t.experimental} · {t.controlInfo}
            </small>
            <Button
              variant="default"
              className="size-9 shrink-0 rounded-xl"
              aria-label={t.send}
              disabled={!canSend || !isValidMessage(message)}
            >
              <ArrowUp size={20} />
            </Button>
          </div>
        </form>
      ) : (
        <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
          {(current?.agent === "codex" || current?.agent === "claude-code") &&
          access.experimentalEnabled &&
          access.device?.approve
            ? t.noSendPermission
            : t.readOnly}
        </footer>
      )}
    </>
  );
}
