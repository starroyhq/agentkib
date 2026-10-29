import { sessionContinuationListState, SessionContinuationDot } from "@agentkib/session-ui";
import { NativeSelect } from "../../components/ui/native-select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Info,
  Search,
  Split,
} from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import {
  displaySessionTitle,
  filterSessions,
  groupSessions,
  isSessionListed,
} from "@agentkib/session-catalog";
import type { ConversationSessionSummary, WorkspaceCheckout } from "@agentkib/web-client";
import { dictionaries, type Locale } from "../../i18n";
import { catalogCopyForSurface } from "./catalog-copy";
import { interactionCopy } from "../interactions/question-form";
import { worktreeCopy, worktreeLabel } from "./worktree-copy";
import { WorktreeMark } from "./worktree-note";

export interface CatalogWorkspace {
  id: string;
  name: string;
  path: string;
  checkout?: WorkspaceCheckout | null;
}
export type CatalogStatus = "loading" | "ready" | "error";
export function SessionCatalog({
  sessions,
  workspaces,
  selected,
  onSelect,
  locale = "zh-CN",
  indexEnabled = true,
  pendingSessions = {},
  status = "ready",
  rowMenu,
  execution = false,
  onExecutionChange,
}: {
  sessions: ConversationSessionSummary[];
  workspaces?: CatalogWorkspace[];
  selected: string;
  onSelect: (id: string) => void;
  locale?: Locale;
  indexEnabled?: boolean;
  pendingSessions?: Record<string, boolean>;
  status?: CatalogStatus;
  /** Per-row management (rename, archive, delete); rendered beside the row, never inside it. */
  rowMenu?: (session: ConversationSessionSummary) => ReactNode;
  /** Also list program-started sessions; the option shows only with a change handler. */
  execution?: boolean;
  onExecutionChange?: (execution: boolean) => void;
}) {
  const t = dictionaries[locale],
    c = catalogCopyForSurface(locale, "web");
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [filter, setFilter] = useState<"current" | "archived" | "metadata" | "all">("current");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const w = worktreeCopy[locale];
  const visibleSessions = sessions.filter((s) => isSessionListed(s, { execution }));
  const filtered = filterSessions(
    sessions,
    workspaces ?? [],
    { query, agent, filter, execution },
    t.untitled,
  );
  const groups = groupSessions(filtered, workspaces ?? [], { execution });
  const agents = [
    ...new Set([...visibleSessions.map((s) => s.agent), ...(agent === "all" ? [] : [agent])]),
  ];
  return (
    <>
      <label className="relative mx-4 mb-3 flex items-center text-muted-foreground [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-3 [&>input]:bg-background [&>input]:pl-9">
        <Search size={16} />
        <Input
          aria-label={t.search}
          placeholder={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <details className="mx-4 mb-4 rounded-lg border bg-background/50 px-3 py-1 text-xs text-muted-foreground [&>summary]:cursor-pointer [&>summary]:py-2 [&>label]:my-3 [&>label]:flex [&>label]:items-center [&>label]:justify-between [&>label]:gap-2 [&_select]:max-w-40 [&_select]:text-xs">
        <summary>{c.options}</summary>
        <label>
          {c.agent}
          <NativeSelect value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="all">{c.allAgents}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {agentName(a)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          {c.records}
          <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            {(["current", "archived", "metadata", "all"] as const).map((f) => (
              <option key={f} value={f}>
                {c[f]}
              </option>
            ))}
          </NativeSelect>
        </label>
        {onExecutionChange && (
          <label>
            {w.showExecution}
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={execution}
              onChange={(e) => onExecutionChange(e.target.checked)}
            />
          </label>
        )}
      </details>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        {!indexEnabled ? (
          <p>{t.indexDisabled}</p>
        ) : status === "loading" ? (
          <p role="status">{t.loading}</p>
        ) : status === "error" ? null : !workspaces ? (
          <p role="status">{c.missing}</p>
        ) : (
          <>
            {groups.map((group) => {
              const { sessions: rows, label } = group;
              const open = !!query.trim() || !collapsed[group.id];
              const worktrees = group.worktrees.length
                ? `${w.count(group.worktrees.length)}: ${group.worktrees.join(", ")}`
                : "";
              return (
                <section key={group.id} className="space-y-1" aria-label={label}>
                  <div className="relative flex items-center">
                    <Button
                      variant="ghost"
                      className="h-auto min-h-11 min-w-11 flex-1 justify-start gap-2 px-2 text-xs text-muted-foreground [&>strong]:min-w-0 [&>strong]:truncate [&>strong]:text-left [&>strong]:font-medium [&>small]:text-[10px]"
                      aria-expanded={open}
                      title={[group.path, group.worktree ? w.group : "", worktrees]
                        .filter(Boolean)
                        .join("\n")}
                      aria-label={[label, group.worktree ? w.group : "", worktrees, rows.length]
                        .filter((part) => part !== "")
                        .join(" · ")}
                      onClick={() => {
                        if (!query.trim())
                          setCollapsed((v) => ({ ...v, [group.id]: !v[group.id] }));
                      }}
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {open ? <FolderOpen size={16} /> : <Folder size={16} />}
                      <strong>{label}</strong>
                      {group.worktree && (
                        <Split size={12} className="shrink-0" aria-hidden="true" />
                      )}
                      {group.worktrees.length > 0 && (
                        <span className="shrink-0 truncate text-[11px]" aria-hidden="true">
                          · {w.count(group.worktrees.length)}
                        </span>
                      )}
                      <small className="ml-auto">{rows.length}</small>
                    </Button>
                    <details className="shrink-0 text-muted-foreground [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:grid [&>summary]:size-11 [&>summary]:place-items-center [&>summary]:rounded-md [&>span]:absolute [&>span]:inset-x-0 [&>span]:top-full [&>span]:z-10 [&>span]:rounded-lg [&>span]:border [&>span]:bg-popover [&>span]:p-3 [&>span]:text-xs [&>span]:break-all [&>span]:shadow-md">
                      <summary aria-label={`${label} · ${c.path}`} title={c.path}>
                        <Info size={14} />
                      </summary>
                      <span>{group.path}</span>
                    </details>
                  </div>
                  {open &&
                    rows.map((s) => {
                      const runtime = sessionContinuationListState(s, locale);
                      const title = displaySessionTitle(s.title, t.untitled);
                      const fork = s.origin === "interactive" && !!s.forked_from_session_id;
                      const description = `${agentName(s.agent)} · ${title}${s.availability !== "readable" ? ` · ${t.metadataOnly}` : ""}${s.archived ? ` · ${c.archived}` : ""}${fork ? ` · ${c.fork}` : ""}${s.origin === "execution" ? ` · ${w.execution}` : ""}${s.worktree ? ` · ${worktreeLabel(s.worktree, locale)}` : ""}`;
                      return (
                        <div key={s.id} className="group/session flex items-center gap-1">
                          <Button
                            variant="ghost"
                            className={`h-auto min-h-11 min-w-0 flex-1 justify-start gap-2.5 rounded-lg px-3 py-2.5 text-left [&>strong]:min-w-0 [&>strong]:flex-1 [&>strong]:truncate [&>strong]:text-[13px] [&>strong]:font-normal ${s.id === selected ? "selected bg-accent text-accent-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground"}`}
                            aria-label={`${description}${runtime?.dot ? ` · ${runtime.label}` : ""}`}
                            title={description}
                            aria-current={s.id === selected ? "page" : undefined}
                            disabled={s.availability !== "readable"}
                            onClick={() => onSelect(s.id)}
                          >
                            <AgentMark agent={s.agent} />
                            <strong>{title}</strong>
                            {runtime?.dot && (
                              <SessionContinuationDot
                                label={runtime.label}
                                active={runtime.active}
                              />
                            )}
                            {runtime &&
                              !runtime.dot &&
                              s.continuation?.reason === "codex-cli-version-too-old" && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {runtime.label}
                                </span>
                              )}
                            {pendingSessions[s.id] && (
                              <span
                                aria-label={interactionCopy[locale].pending}
                                title={interactionCopy[locale].pending}
                              >
                                ●
                              </span>
                            )}
                            {s.origin === "execution" && (
                              <Bot size={12} className="shrink-0" aria-hidden="true" />
                            )}
                            {s.worktree && <WorktreeMark worktree={s.worktree} locale={locale} />}
                            {fork && <GitBranch size={14} aria-hidden="true" />}
                          </Button>
                          {rowMenu?.(s)}
                        </div>
                      );
                    })}
                </section>
              );
            })}
            {!groups.length && (
              <p className="px-3 py-8 text-center text-xs leading-6 text-muted-foreground">
                {visibleSessions.length ? c.noResults : t.empty}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
