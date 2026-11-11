import { createContext, use, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { displaySessionTitle, sessionGroupLabels } from "@agentkib/session-catalog";
import { formatSessionTime, HomeSessionList } from "@agentkib/session-ui";
import type { Access, ConversationSessionSummary } from "@agentkib/web-client";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { NewSessionComposer } from "../new-session/new-session-composer";
import { useOpenWhenListed } from "../new-session/use-open-when-listed";
import { useHomeAttention } from "./home-attention";
import { HomeInteraction } from "./home-interaction";
import { useMediaQuery } from "./use-media-query";

/** Whether this visit may start sessions: create one and send its first message. */
export function canStartSessions(access: Omit<Access, "bearerToken"> | undefined) {
  return (
    access?.status === "approved" &&
    access.experimentalEnabled &&
    !!access.device?.manage &&
    !!access.device.send
  );
}

/** Switches the phone layout from the home to all sessions. */
export const HomeViewContext = createContext<{ showAll: () => void }>({ showAll: () => {} });

/**
 * This browser's home: on a wide screen the new-session composer, then what needs the person,
 * unread results and running turns (the directory beside it lists everything else); at phone
 * width the same groups with the three most recent sessions. While the connection is lost the
 * last lists stay readable, and answering and starting sessions wait.
 */
export function SessionHome() {
  const { t, locale, sessions, workspaces, access, indexEnabled, catalogStatus, choose, error } =
    useSession();
  const attention = useHomeAttention();
  const { showAll } = use(HomeViewContext);
  // The directory sits beside a wide home and says what the home would repeat.
  const wide = useMediaQuery("(min-width: 768px)", true);
  const navigate = useNavigate();
  const openWhenListed = useOpenWhenListed();
  const [expanded, setExpanded] = useState<string>();
  const offline = !!error;
  const labels = useMemo(
    () => sessionGroupLabels(sessions, workspaces ?? []),
    [sessions, workspaces],
  );
  const open = (session: ConversationSessionSummary) => {
    void choose(session.id);
    void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
  };
  const describe = (session: ConversationSessionSummary) => ({
    title: displaySessionTitle(session.title, t.untitled),
    agent: agentName(session.agent),
    workspace:
      labels.get(session.id) ??
      workspaces?.find((workspace) => workspace.id === session.workspace_id)?.name,
    time: session.updated_at ? formatSessionTime(session.updated_at, locale) : undefined,
  });
  const workspacePath = (session: ConversationSessionSummary) =>
    workspaces?.find((workspace) => workspace.id === session.workspace_id)?.path;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl content-start gap-5 px-4 pt-4 pb-8 md:px-8 md:pt-8">
        {wide && canStartSessions(access) && (
          <NewSessionComposer onCreated={openWhenListed} disabled={offline} />
        )}
        {!indexEnabled ? (
          !wide && (
            <p className="rounded-xl border bg-card px-5 py-4 text-sm text-muted-foreground">
              {t.indexDisabled}
            </p>
          )
        ) : !attention || (catalogStatus === "loading" && !sessions.length) ? (
          <Placeholder label={t.loading} />
        ) : (
          <HomeSessionList
            locale={locale}
            layout={wide ? "wide" : "compact"}
            groups={attention.groups}
            describe={describe}
            agentMark={(session) => <AgentMark agent={session.agent} />}
            // The directory beside a wide home already lists every session.
            recent={wide ? undefined : { limit: 3, label: "allSessions", onShowAll: showAll }}
            expanded={expanded}
            onToggle={(session) =>
              setExpanded((current) => (current === session.id ? undefined : session.id))
            }
            renderCard={(session) => (
              <HomeInteraction
                session={session}
                workspacePath={workspacePath(session)}
                replies={attention.replies}
                offline={offline}
                onClose={() => setExpanded(undefined)}
              />
            )}
            onOpen={open}
          />
        )}
      </div>
    </div>
  );
}

/** Placeholder rows while the first catalog read has nothing to show yet; never a loading card. */
function Placeholder({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="grid gap-1 rounded-xl border bg-card px-5 py-4"
    >
      {[0, 1].map((row) => (
        <div key={row} aria-hidden="true" className="flex items-center gap-3 py-2">
          <span className="size-8 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <span className="grid flex-1 gap-1.5">
            <span className="h-3.5 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="h-3 w-1/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </span>
        </div>
      ))}
    </div>
  );
}
