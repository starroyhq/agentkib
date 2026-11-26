import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Search } from "lucide-react";
import { LoadingSkeleton } from "../../loading-feedback";
import {
  ApiError,
  literalHistoryMatchRanges,
  type Access,
  type ConversationSessionSummary,
  type WebClient,
  type HistorySearchHit,
  type HistorySearchResult,
  type HistorySearchStatus,
  type HistoryLocatedRecord,
  type HistoryLocation,
  type ResolvedHistoryReference,
} from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { historyCopy, historySearchCopy } from "./history-copy";
import { HistorySearchFilters } from "./history-search-filters";
import {
  createHistoryOpenLock,
  historyLocationKey,
  historySessionTarget,
} from "./history-session-target";

function HistoryTimestamp({ value, locale }: { value?: string | null; locale: Locale }) {
  const { copy } = useSessionPlatform();
  return value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{copy.formatDateTime(value, locale)}</time>
  ) : (
    <span>{historyCopy[locale].unknownTime}</span>
  );
}

export function historyAccessScope(access: Access | null | undefined): string {
  return access?.status === "approved" && access.historySearch
    ? JSON.stringify([access.bootId, access.device?.id, access.historySearchScope])
    : "";
}
export function HighlightedHistoryText({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const [from, to] of ranges) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < start ||
      to <= from ||
      to > text.length
    )
      continue;
    nodes.push(
      text.slice(start, from),
      <mark
        key={`${from}:${to}`}
        className="rounded bg-amber-200 text-black dark:bg-amber-500/40 dark:text-foreground"
      >
        {text.slice(from, to)}
      </mark>,
    );
    start = to;
  }
  nodes.push(text.slice(start));
  return <>{nodes}</>;
}
export function HistoryCoverageStatus({
  status,
  locale,
  agentName,
  compact,
}: {
  status: HistorySearchStatus;
  locale: Locale;
  agentName: (agent: string) => string;
  compact?: boolean;
}) {
  const c = historyCopy[locale],
    v = status.coverage;
  if (compact) {
    const building = v.building > 0;
    const limitedSources = (status.sources ?? [])
      .filter(({ body, tools }) => body !== "supported" || tools !== "supported")
      .map(
        (source) =>
          `${agentName(source.agent)}: ${c.messages} ${c[source.body]} · ${c.tools} ${c[source.tools]}`,
      );
    const partial =
      v.ready < v.total ||
      v.partial > 0 ||
      v.stale > 0 ||
      v.unavailable > 0 ||
      limitedSources.length > 0 ||
      v.limitations.length > 0 ||
      status.budgetExceeded;
    if (!status.enabled || (!building && !partial)) return null;
    const detail = [
      ...limitedSources,
      ...v.limitations,
      ...(status.budgetExceeded ? [c.budget] : []),
    ].join(" · ");
    return (
      <span
        role="status"
        className="self-start rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
        title={detail || undefined}
        aria-description={detail || undefined}
      >
        {building ? c.buildingShort : c.partialShort}
      </span>
    );
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground" role="status">
      <p>
        {c.coverage}: {c.ready} {v.ready}/{v.total} · {c.building} {v.building} · {c.partial}{" "}
        {v.partial} · {c.staleCount} {v.stale} · {c.unavailable} {v.unavailable}
      </p>
      {!!status.sources?.length && (
        <ul aria-label={c.sources} className="space-y-1">
          {status.sources.map((source) => (
            <li key={source.agent}>
              {agentName(source.agent)}: {c.messages} {c[source.body]} · {c.tools} {c[source.tools]}
            </li>
          ))}
        </ul>
      )}
      {!!v.limitations.length && <p>{v.limitations.join(" · ")}</p>}
      {status.budgetExceeded && <p>{c.budget}</p>}
    </div>
  );
}
export interface HistorySearchPanelProps {
  client: WebClient;
  locale: Locale;
  scope: string;
  initialQuery?: string;
  onReference?: (reference: ResolvedHistoryReference) => void;
  referenceDisabledReason?: string;
  onOpenSession?: (session: ConversationSessionSummary) => void | Promise<void>;
  currentSessionId?: string;
  navigationContext?: string;
  openDisabled?: boolean;
  onScopeEnded?: () => void;
  onSettingsOpened?: () => void;
}
function sourceSelectionRange(content: string, start: number, end: number): [number, number] {
  let sourceStart = start;
  let sourceEnd = end;
  // Textareas expose LF-normalized UTF-16 offsets, but references address the
  // unchanged source. Each preceding CRLF contributes one additional source unit.
  for (
    let source = 0, displayed = 0;
    source < content.length && displayed < end;
    source++, displayed++
  ) {
    if (content[source] !== "\r" || content[source + 1] !== "\n") continue;
    if (displayed < start) sourceStart++;
    sourceEnd++;
    source++;
  }
  return [sourceStart, sourceEnd];
}
/** A source window is independent of the active conversation and its draft. */
export function HistorySearchPanel({
  client,
  locale,
  scope,
  initialQuery = "",
  onReference,
  referenceDisabledReason,
  onOpenSession,
  currentSessionId,
  navigationContext = "",
  openDisabled = false,
  onScopeEnded,
  onSettingsOpened,
}: HistorySearchPanelProps) {
  const { components, historySearch } = useSessionPlatform();
  const { Button, Input } = components;
  const { agentName, entry, filter, isSessionVisible, openIndexSettings } = historySearch;
  const workspaceEntry = entry === "workspace";
  const c = historySearchCopy(locale, entry);
  const Excerpt = workspaceEntry ? "textarea" : components.Textarea;
  const HitButton = workspaceEntry ? "button" : Button;
  const [query, setQuery] = useState(initialQuery);
  const queryValid = Array.from(query).length <= 256;
  const [workspace, setWorkspace] = useState("");
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<WebClient["catalog"]>>>();
  const workspaceName = (id: string) =>
    catalog?.workspaces?.find((item) => item.id === id)?.name.trim() || id;
  const [status, setStatus] = useState<HistorySearchStatus>();
  const [result, setResult] = useState<HistorySearchResult>();
  const [located, setLocated] = useState<HistoryLocatedRecord>();
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [busy, setBusy] = useState(false);
  const quoteDisabledReason =
    referenceDisabledReason ??
    (busy ? c.loading : selection[0] === selection[1] ? c.selection : undefined);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(false), 1500);
    return () => clearTimeout(timer);
  }, [added]);
  const [openConfirmation, setOpenConfirmation] = useState<{
    context: string;
    source: string;
  }>();
  const opening = useRef(createHistoryOpenLock());
  const navigation = useRef({ navigationContext, currentSessionId, openDisabled, onOpenSession });
  useLayoutEffect(() => {
    navigation.current = { navigationContext, currentSessionId, openDisabled, onOpenSession };
  }, [navigationContext, currentSessionId, openDisabled, onOpenSession]);
  const referenceControl = useRef({ onReference, referenceDisabledReason });
  useLayoutEffect(() => {
    referenceControl.current = { onReference, referenceDisabledReason };
  }, [onReference, referenceDisabledReason]);
  const request = useRef(0);
  const indexEnabled = useRef<boolean | undefined>(undefined);
  const indexGeneration = useRef<string | undefined>(undefined);
  const active = useRef(true);
  const scopeInvalid = useRef(false);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const ended = useRef(onScopeEnded);
  useEffect(() => {
    ended.current = onScopeEnded;
  }, [onScopeEnded]);
  const clearPrivate = useCallback(() => {
    setResult(undefined);
    setLocated(undefined);
    setCatalog(undefined);
    setSelection([0, 0]);
    setQuery("");
    setStatus(undefined);
    setWorkspace("");
    setAgent("");
  }, []);
  useEffect(() => {
    active.current = true;
    scopeInvalid.current = false;
    let checking = false;
    const abort = new AbortController();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const access = await client.access(abort.signal);
        if (abort.signal.aborted) return;
        if (!scope || historyAccessScope(access) !== scope) {
          scopeInvalid.current = true;
          request.current++;
          inFlight.current?.abort();
          clearPrivate();
          ended.current?.();
          return;
        }
        const next = await client.historyStatus(abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        if (!next.enabled) {
          request.current++;
          inFlight.current?.abort();
          setResult(undefined);
          setLocated(undefined);
          if (indexEnabled.current === true) ended.current?.();
        }
        indexEnabled.current = next.enabled;
      } catch (e) {
        if (!abort.signal.aborted) {
          clearPrivate();
          setError(c.error);
          if (e instanceof ApiError && [401, 403].includes(e.status)) {
            scopeInvalid.current = true;
            request.current++;
            inFlight.current?.abort();
            ended.current?.();
          }
        }
      } finally {
        checking = false;
      }
    };
    void check();
    void client
      .catalog(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && !scopeInvalid.current) setCatalog(value);
      })
      .catch(() => {});
    const timer = setInterval(() => void check(), 5000);
    return () => {
      active.current = false;
      request.current++;
      abort.abort();
      inFlight.current?.abort();
      clearInterval(timer);
    };
  }, [client, scope, clearPrivate, c.error]);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(
        e instanceof ApiError && /stale|changed/.test(e.code)
          ? c.stale
          : e instanceof Error && /reference.*(limit|large)|too_many.*reference/.test(e.message)
            ? c.limit
            : c.error,
      );
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        scopeInvalid.current = true;
        request.current++;
        inFlight.current?.abort();
        clearPrivate();
        ended.current?.();
      }
    },
    [c.error, c.stale, c.limit, clearPrivate],
  );
  const current = useCallback(
    async (generation: number, signal: AbortSignal) => {
      if (!active.current || signal.aborted || generation !== request.current) return;
      const access = await client.access(signal);
      if (!active.current || signal.aborted || generation !== request.current) return;
      if (historyAccessScope(access) !== scope) {
        scopeInvalid.current = true;
        request.current++;
        inFlight.current?.abort();
        clearPrivate();
        ended.current?.();
        return;
      }
      return access;
    },
    [client, scope, clearPrivate],
  );
  const begin = useCallback(() => {
    inFlight.current?.abort();
    const abort = new AbortController();
    inFlight.current = abort;
    const generation = ++request.current;
    setBusy(true);
    setError("");
    setAdded(false);
    setOpenConfirmation(undefined);
    return { abort, generation };
  }, []);
  const search = useCallback(
    async (cursor?: string) => {
      if (!query.trim() || !queryValid || !status?.enabled || scopeInvalid.current) return;
      const { abort, generation } = begin();
      try {
        const next = await client.historySearch(
          {
            query,
            ...(workspace ? { workspaceIds: [workspace] } : {}),
            ...(agent ? { agents: [agent] } : {}),
            ...(kind
              ? {
                  kinds:
                    kind === "messages" ? ["user", "assistant"] : ["tool-input", "tool-output"],
                }
              : {}),
            ...(archived ? {} : { archived: false }),
            ...(cursor ? { cursor } : {}),
          },
          abort.signal,
        );
        if (!(await current(generation, abort.signal))) return;
        setStatus(next.status);
        setResult((previous) =>
          cursor && previous ? { ...next, hits: [...previous.hits, ...next.hits] } : next,
        );
        setLocated(undefined);
      } catch (e) {
        if (generation === request.current && !abort.signal.aborted) fail(e);
      } finally {
        if (generation === request.current) setBusy(false);
      }
    },
    [
      query,
      queryValid,
      workspace,
      agent,
      kind,
      archived,
      status?.enabled,
      begin,
      client,
      current,
      fail,
    ],
  );
  useEffect(() => {
    request.current++;
    inFlight.current?.abort();
    setResult(undefined);
    setLocated(undefined);
    setError("");
    setBusy(false);
    const timer = setTimeout(() => void search(), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const locate = useCallback(
    async (location: HistoryLocation) => {
      const { abort, generation } = begin();
      try {
        const value = await client.historyLocate(location, abort.signal);
        if (!(await current(generation, abort.signal))) return;
        setLocated(value);
        setSelection([0, value.content.length]);
      } catch (e) {
        if (generation === request.current && !abort.signal.aborted) {
          setLocated(undefined);
          fail(e);
        }
      } finally {
        if (generation === request.current) setBusy(false);
      }
    },
    [begin, client, current, fail],
  );
  useEffect(() => {
    const previous = indexGeneration.current;
    indexGeneration.current = status?.generation;
    if (
      !previous ||
      !status?.generation ||
      previous === status.generation ||
      result?.status.generation === status.generation
    )
      return;
    setResult(undefined);
    // A different session may have changed. Revalidate an open source without
    // taking the reader back to results unless that source itself disappeared.
    if (located) void locate(located.location);
    else void search();
  }, [status?.generation, result?.status.generation, located, locate, search]);
  async function openSession(confirmed = false) {
    if (
      !located ||
      !onOpenSession ||
      opening.current.isPending(request.current) ||
      openDisabled ||
      scopeInvalid.current
    )
      return;
    const source = historyLocationKey(located.location);
    const expectedContext = confirmed ? openConfirmation?.context : navigationContext;
    if (
      expectedContext === undefined ||
      expectedContext !== navigation.current.navigationContext ||
      (confirmed && source !== openConfirmation?.source)
    ) {
      setOpenConfirmation(undefined);
      setError(c.openChanged);
      return;
    }
    const { abort, generation } = begin();
    const release = opening.current.start(generation, abort.signal);
    try {
      const [fresh, currentCatalog, currentStatus] = await Promise.all([
        client.historyLocate(located.location, abort.signal),
        client.catalog(abort.signal),
        client.historyStatus(abort.signal),
      ]);
      if (!(await current(generation, abort.signal))) return;
      if (
        historyLocationKey(fresh.location) !== source ||
        fresh.contentHash !== located.contentHash ||
        fresh.workspaceId !== located.workspaceId ||
        fresh.agent !== located.agent
      )
        throw new ApiError(409, "history_source_changed");
      const target =
        currentCatalog.indexEnabled && currentStatus.enabled
          ? historySessionTarget(fresh, currentCatalog.sessions, isSessionVisible)
          : undefined;
      if (!target) throw new Error("history_session_unavailable");
      if (
        navigation.current.navigationContext !== expectedContext ||
        navigation.current.openDisabled
      ) {
        setError(c.openChanged);
        return;
      }
      // The confirmation covers text, references and composer-local attachments.
      // Revalidate again after confirmation instead of retaining an old grant.
      if (
        navigation.current.currentSessionId &&
        navigation.current.currentSessionId !== target.id &&
        !confirmed
      ) {
        setOpenConfirmation({ context: expectedContext, source });
        return;
      }
      await navigation.current.onOpenSession?.(target);
    } catch (e) {
      if (generation === request.current && !abort.signal.aborted) fail(e);
    } finally {
      release();
      if (generation === request.current) setBusy(false);
    }
  }
  async function quote() {
    if (!located || !onReference || quoteDisabledReason || scopeInvalid.current) return;
    const { abort, generation } = begin();
    try {
      const value = await client.historyReferences(
        [
          {
            ...located.location,
            start: selection[0],
            end: selection[1],
            contentHash: located.contentHash,
          },
        ],
        abort.signal,
      );
      const access = await current(generation, abort.signal);
      const reference = referenceControl.current;
      if (
        !access?.device?.send ||
        !reference.onReference ||
        reference.referenceDisabledReason ||
        navigation.current.currentSessionId !== currentSessionId
      )
        return;
      if (!value.references[0]) throw new Error("history_reference_unavailable");
      reference.onReference(value.references[0]);
      setAdded(true);
    } catch (e) {
      if (generation === request.current && !abort.signal.aborted) fail(e);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  function backToResults() {
    request.current++;
    inFlight.current?.abort();
    setLocated(undefined);
    setOpenConfirmation(undefined);
    setBusy(false);
  }
  return (
    <div
      className={`flex min-h-0 flex-col ${workspaceEntry ? "gap-3" : "gap-4"}`}
      data-history-search
    >
      {workspaceEntry && <p className="text-xs text-muted-foreground">{c.local}</p>}
      <form
        className={workspaceEntry ? "flex gap-2" : "flex items-center gap-2"}
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        {workspaceEntry ? (
          <Input
            aria-label={c.query}
            placeholder={c.query}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : (
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={c.query}
              placeholder={c.query}
              value={query}
              className="h-10 pl-9"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        <Button type="submit" disabled={!query.trim() || !queryValid || busy || !status?.enabled}>
          {c.search}
        </Button>
      </form>
      <HistorySearchFilters
        mode={filter}
        sourceLabel={c.source}
        archived={{ checked: archived, label: c.archived, onChange: setArchived }}
        filters={[
          {
            id: "workspaces",
            label: c.allWorkspaces,
            groupLabel: c.workspace,
            value: workspace,
            selectedLabel: workspace ? workspaceName(workspace) : c.allWorkspaces,
            onChange: setWorkspace,
            options: (catalog?.workspaces ?? []).map(({ id, name }) => ({
              value: id,
              label: name.trim() || id,
            })),
          },
          {
            id: "agents",
            label: c.allAgents,
            groupLabel: c.allAgents,
            value: agent,
            selectedLabel: agent ? agentName(agent) : c.allAgents,
            onChange: setAgent,
            options: [...new Set(catalog?.sessions.map((session) => session.agent) ?? [])].map(
              (value) => ({ value, label: agentName(value) }),
            ),
          },
          {
            id: "kinds",
            label: c.allKinds,
            groupLabel: c.allKinds,
            value: kind,
            selectedLabel:
              kind === "messages" ? c.messages : kind === "tools" ? c.tools : c.allKinds,
            onChange: setKind,
            options: [
              { value: "messages", label: c.messages },
              { value: "tools", label: c.tools },
            ],
          },
        ]}
      />
      {status && (
        <HistoryCoverageStatus status={status} locale={locale} agentName={agentName} compact />
      )}
      {status?.enabled === false && (
        <div className="space-y-2">
          <p role="status">{c.disabled}</p>
          {openIndexSettings && (
            <Button
              variant="outline"
              onClick={() => {
                if (openIndexSettings()) onSettingsOpened?.();
              }}
            >
              {c.openSettings}
            </Button>
          )}
        </div>
      )}
      {!queryValid && (
        <p role="alert" className="text-sm text-destructive-text">
          {c.queryLimit}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      {busy && !located && <LoadingSkeleton label={c.loading} />}
      {located ? (
        <section
          className={
            workspaceEntry ? "space-y-3 rounded-lg border p-3" : "space-y-4 rounded-lg border p-4"
          }
          aria-label={c.source}
        >
          {workspaceEntry ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" onClick={backToResults}>
                  {c.back}
                </Button>
                <strong className="min-w-0 break-words text-sm">
                  {located.title || agentName(located.agent)}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {c[located.kind]} {located.toolName}
                </span>
              </div>
              <p className="break-words text-xs text-muted-foreground">
                {c.workspace}: {workspaceName(located.workspaceId)}
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{c.source}</p>
                  <strong className="mt-1 block min-w-0 break-words text-sm">
                    {located.title || agentName(located.agent)}
                  </strong>
                </div>
                <Button variant="outline" onClick={backToResults}>
                  {c.back}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-1">
                  {c.workspace}: {workspaceName(located.workspaceId)}
                </span>
                <span className="rounded-md bg-muted px-2 py-1">
                  {c[located.kind]} {located.toolName}
                </span>
              </div>
            </>
          )}
          <pre
            tabIndex={0}
            className={
              workspaceEntry
                ? "max-h-[35dvh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs"
                : "max-h-[35dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 text-xs leading-6"
            }
          >
            <HighlightedHistoryText
              text={located.content}
              ranges={literalHistoryMatchRanges(located.content, query)}
            />
          </pre>
          <div className="flex flex-wrap gap-2">
            {onOpenSession && (
              <Button
                variant="outline"
                disabled={busy || openDisabled}
                onClick={() => void openSession()}
              >
                {c.openSession}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!located.before || busy}
              onClick={() => located.before && void locate(located.before)}
            >
              {c.previous}
            </Button>
            <Button
              variant="outline"
              disabled={!located.after || busy}
              onClick={() => located.after && void locate(located.after)}
            >
              {c.next}
            </Button>
          </div>
          {onOpenSession && <p className="text-xs text-muted-foreground">{c.openPosition}</p>}
          {openConfirmation && (
            <div role="group" aria-label={c.openConfirm} className="space-y-2 rounded border p-3">
              <p className="text-sm">{c.openConfirm}</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || openDisabled} onClick={() => void openSession(true)}>
                  {c.openDiscard}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOpenConfirmation(undefined)}
                >
                  {c.openCancel}
                </Button>
              </div>
            </div>
          )}
          {onReference && (
            <>
              <label className="block text-xs">
                {c.selection}
                <Excerpt
                  aria-label={c.excerpt}
                  readOnly
                  value={located.content}
                  onSelect={(e) =>
                    setSelection(
                      sourceSelectionRange(
                        located.content,
                        e.currentTarget.selectionStart,
                        e.currentTarget.selectionEnd,
                      ),
                    )
                  }
                  className="mt-2 max-h-32 min-h-20 w-full rounded border bg-background p-2"
                />
              </label>
              {!referenceDisabledReason && (
                <p className="text-xs text-muted-foreground">{c.quoteOnly}</p>
              )}
              <Button
                className="disabled:pointer-events-auto"
                disabled={!!quoteDisabledReason}
                title={quoteDisabledReason ?? (added ? c.added : undefined)}
                onClick={() => void quote()}
              >
                {added && (
                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                )}
                {c.quote}
              </Button>
            </>
          )}
        </section>
      ) : (
        <div className="max-h-[45dvh] space-y-2 overflow-auto">
          {result?.hits.map((hit: HistorySearchHit, index) => (
            <HitButton
              {...(!workspaceEntry && { variant: "bare", size: "content" })}
              type="button"
              key={`${JSON.stringify(hit.location)}:${index}`}
              disabled={busy}
              onClick={() => void locate(hit.location)}
              className="block w-full space-y-1 rounded-lg border p-3 text-left hover:bg-accent"
            >
              <strong className="block text-sm">{hit.title || agentName(hit.agent)}</strong>
              <span className="block break-words text-xs text-muted-foreground">
                {c.workspace}: {workspaceName(hit.workspaceId)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {agentName(hit.agent)} · {c[hit.kind]} {hit.toolName} ·{" "}
                <HistoryTimestamp value={hit.timestamp} locale={locale} />
              </span>
              <p className="whitespace-pre-wrap break-words text-xs">
                <HighlightedHistoryText text={hit.snippet} ranges={hit.matchRanges} />
              </p>
              {hit.indexedAt && (
                <small className="block text-muted-foreground">
                  {c.cachedAt}: <HistoryTimestamp value={hit.indexedAt} locale={locale} />
                </small>
              )}
              {hit.stale && <small>{c.stale}</small>}
            </HitButton>
          ))}
          {result && !result.hits.length && <p role="status">{c.empty}</p>}
          {result?.limited && <p className="text-xs">{c.limited}</p>}
          {result?.nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void search(result.nextCursor!)}
            >
              {c.more}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
export function HistorySearchDialog(props: HistorySearchPanelProps & { onClose: () => void }) {
  const {
    components: { SessionDialog },
    historySearch: { entry },
  } = useSessionPlatform();
  const c = historySearchCopy(props.locale, entry);
  return (
    <SessionDialog
      panel
      className={entry === "window" ? "md:max-w-2xl" : undefined}
      title={c.title}
      description={entry === "window" ? c.local : undefined}
      closeLabel={c.close}
      onClose={props.onClose}
    >
      <HistorySearchPanel
        {...props}
        onSettingsOpened={() => {
          props.onSettingsOpened?.();
          props.onClose();
        }}
        onScopeEnded={() => {
          props.onScopeEnded?.();
          props.onClose();
        }}
      />
    </SessionDialog>
  );
}
/** Search entry independent of the active conversation. */
export function HistorySearchLauncher({
  client,
  locale,
  initialQuery = "",
  iconOnly = false,
  onOpen,
  onOpenSession,
}: {
  client: WebClient;
  locale: Locale;
  initialQuery?: string;
  iconOnly?: boolean;
  onOpen?: () => void;
  onOpenSession?: (session: ConversationSessionSummary) => void | Promise<void>;
}) {
  const {
    components: { Button },
    historySearch: { entry },
  } = useSessionPlatform();
  const windowEntry = entry === "window";
  const [access, setAccess] = useState<{ client: WebClient; value: Access }>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    inFlight.current = abort;
    setAccess(undefined);
    setOpen(false);
    setPending(false);
    setError(false);
    void client
      .access(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setAccess({ client, value });
      })
      .catch(() => {})
      .finally(() => {
        if (inFlight.current === abort) inFlight.current = undefined;
      });
    return () => {
      abort.abort();
      inFlight.current?.abort();
    };
  }, [client]);
  async function openSearch() {
    // The initial grant only controls visibility; workspace registration can change its scope.
    if (inFlight.current) return;
    const abort = new AbortController();
    inFlight.current = abort;
    setPending(true);
    setError(false);
    try {
      const value = await client.access(abort.signal);
      if (abort.signal.aborted) return;
      setAccess({ client, value });
      if (!historyAccessScope(value)) {
        setOpen(false);
        return;
      }
      if (onOpen) onOpen();
      else setOpen(true);
    } catch (e) {
      if (abort.signal.aborted) return;
      setOpen(false);
      if (e instanceof ApiError && [401, 403].includes(e.status)) setAccess(undefined);
      else setError(true);
    } finally {
      if (inFlight.current === abort) {
        inFlight.current = undefined;
        if (!abort.signal.aborted) setPending(false);
      }
    }
  }
  const scope = access?.client === client ? historyAccessScope(access.value) : "";
  if (!scope) return null;
  return (
    <>
      <Button
        type="button"
        variant={!windowEntry || iconOnly ? "ghost" : "outline"}
        className={
          !windowEntry
            ? undefined
            : iconOnly
              ? `size-8 shrink-0 rounded-lg p-0 ${error ? "text-destructive-text" : "text-muted-foreground hover:text-foreground"}`
              : "h-10 w-full justify-start gap-2 rounded-xl bg-background px-3 text-sm font-normal shadow-sm"
        }
        aria-label={windowEntry ? historyCopy[locale].title : undefined}
        title={
          windowEntry && iconOnly
            ? error
              ? historyCopy[locale].error
              : historyCopy[locale].title
            : undefined
        }
        aria-busy={windowEntry && pending ? true : undefined}
        disabled={pending}
        onClick={() => void openSearch()}
      >
        <Search
          size={windowEntry && iconOnly ? 15 : 16}
          className={windowEntry && !iconOnly ? "text-muted-foreground" : undefined}
          aria-hidden="true"
        />
        {(!windowEntry || !iconOnly) && historyCopy[locale].title}
      </Button>
      {error && (
        <p
          role="alert"
          className={windowEntry && iconOnly ? "sr-only" : "text-sm text-destructive-text"}
        >
          {historyCopy[locale].error}
        </p>
      )}
      {open && (
        <HistorySearchDialog
          client={client}
          locale={locale}
          scope={scope}
          initialQuery={initialQuery}
          onOpenSession={
            onOpenSession
              ? async (session) => {
                  await onOpenSession(session);
                  setOpen(false);
                }
              : undefined
          }
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
