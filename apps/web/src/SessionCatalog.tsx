import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  Info,
  Search,
} from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { displaySessionTitle, filterSessions, groupSessions } from "@agentkib/session-catalog";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { dictionaries, type Locale } from "./i18n";
import { catalogCopy } from "./catalog-copy";
import { interactionCopy } from "./QuestionForm";

export interface CatalogWorkspace {
  id: string;
  name: string;
  path: string;
}
export function SessionCatalog({
  sessions,
  workspaces,
  selected,
  onSelect,
  locale = "zh-CN",
  indexEnabled = true,
  pendingSessions = {},
}: {
  sessions: ConversationSessionSummary[];
  workspaces?: CatalogWorkspace[];
  selected: string;
  onSelect: (id: string) => void;
  locale?: Locale;
  indexEnabled?: boolean;
  pendingSessions?: Record<string, boolean>;
}) {
  const t = dictionaries[locale],
    c = catalogCopy[locale];
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [filter, setFilter] = useState<"current" | "archived" | "metadata" | "all">("current");
  const [showAuxiliary, setShowAuxiliary] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const filtered = filterSessions(
    sessions,
    workspaces ?? [],
    { query, agent, filter, showAuxiliary },
    t.untitled,
  );
  const groups = groupSessions(filtered, workspaces ?? []);
  const agents = [
    ...new Set([...sessions.map((s) => s.agent), ...(agent === "all" ? [] : [agent])]),
  ];
  return (
    <>
      <label className="search">
        <Search size={16} />
        <input
          aria-label={t.search}
          placeholder={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <details className="catalog-options">
        <summary>{c.options}</summary>
        <label>
          {c.agent}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="all">{c.allAgents}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {agentName(a)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {c.records}
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            {(["current", "archived", "metadata", "all"] as const).map((f) => (
              <option key={f} value={f}>
                {c[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showAuxiliary}
            onChange={(e) => setShowAuxiliary(e.target.checked)}
          />
          {c.auxiliary}
        </label>
      </details>
      <div className="catalog-list">
        {!indexEnabled ? (
          <p>{t.indexDisabled}</p>
        ) : !workspaces ? (
          <p role="status">{c.missing}</p>
        ) : (
          <>
            {groups.map(({ workspace, sessions: rows, label }) => {
              const open = !!query.trim() || !collapsed[workspace.id];
              return (
                <section key={workspace.id} className="project-group" aria-label={label}>
                  <div className="project-heading-row">
                    <button
                      className="project-heading"
                      aria-expanded={open}
                      title={workspace.path}
                      aria-label={`${label} · ${rows.length}`}
                      onClick={() => {
                        if (!query.trim())
                          setCollapsed((v) => ({ ...v, [workspace.id]: !v[workspace.id] }));
                      }}
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {open ? <FolderOpen size={16} /> : <Folder size={16} />}
                      <strong>{label}</strong>
                      <small>{rows.length}</small>
                    </button>
                    <details className="project-info">
                      <summary aria-label={`${label} · ${c.path}`} title={c.path}>
                        <Info size={14} />
                      </summary>
                      <span>{workspace.path}</span>
                    </details>
                  </div>
                  {open &&
                    rows.map((s) => {
                      const title = displaySessionTitle(s.title, t.untitled);
                      const fork = s.origin === "interactive" && !!s.forked_from_session_id;
                      const description = `${agentName(s.agent)} · ${title}${s.availability !== "readable" ? ` · ${t.metadataOnly}` : ""}${s.archived ? ` · ${c.archived}` : ""}${fork ? ` · ${c.fork}` : ""}`;
                      return (
                        <button
                          key={s.id}
                          className={`session ${s.id === selected ? "selected" : ""}`}
                          aria-label={description}
                          title={description}
                          aria-current={s.id === selected ? "page" : undefined}
                          disabled={s.availability !== "readable"}
                          onClick={() => onSelect(s.id)}
                        >
                          <AgentMark agent={s.agent} />
                          <strong>{title}</strong>
                          {pendingSessions[s.id] && (
                            <span
                              aria-label={interactionCopy[locale].pending}
                              title={interactionCopy[locale].pending}
                            >
                              ●
                            </span>
                          )}
                          {fork && <GitBranch size={14} aria-hidden="true" />}
                        </button>
                      );
                    })}
                </section>
              );
            })}
            {!groups.length && <p className="empty">{sessions.length ? c.noResults : t.empty}</p>}
          </>
        )}
      </div>
    </>
  );
}
