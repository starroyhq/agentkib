import { agentName } from "@agentkib/agent-identity";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "../../components/dialog";
import type { SupportedLocale as Locale } from "@/core/types";
import { historyCopy } from "./history-copy";
import { formatDateTime } from "@/core/i18n";
import { useOptionalAppNavigationContext } from "@/features/app/AppNavigationContext";
import {
  createHistoryOpenLock,
  historyLocationKey,
  historySessionTarget,
} from "./history-session-target";

function HistoryTimestamp({ value, locale }: { value?: string | null; locale: Locale }) {
  return value && Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value}>{formatDateTime(value, locale)}</time>
  ) : (
    <span>{historyCopy[locale].unknownTime}</span>
  );
}

export function historyAccessScope(access: Access | undefined): string {
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
}: {
  status: HistorySearchStatus;
  locale: Locale;
}) {
  const c = historyCopy[locale],
    v = status.coverage;
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
  onOpenSession,
  currentSessionId,
  navigationContext = "",
  openDisabled = false,
  onScopeEnded,
  onSettingsOpened,
}: HistorySearchPanelProps) {
  const c = historyCopy[locale];
  const appNavigation = useOptionalAppNavigationContext();
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
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const [openConfirmation, setOpenConfirmation] = useState<{
    context: string;
    source: string;
  }>();
  const opening = useRef(createHistoryOpenLock());
  const navigation = useRef({ navigationContext, currentSessionId, openDisabled, onOpenSession });
  useLayoutEffect(() => {
    navigation.current = { navigationContext, currentSessionId, openDisabled, onOpenSession };
  }, [navigationContext, currentSessionId, openDisabled, onOpenSession]);
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
      if (!active.current || signal.aborted || generation !== request.current) return false;
      const access = await client.access(signal);
      if (!active.current || signal.aborted || generation !== request.current) return false;
      if (historyAccessScope(access) !== scope) {
        scopeInvalid.current = true;
        request.current++;
        inFlight.current?.abort();
        clearPrivate();
        ended.current?.();
        return false;
      }
      return true;
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
          ? historySessionTarget(fresh, currentCatalog.sessions)
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
    if (!located || !onReference || selection[0] === selection[1]) return;
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
      if (!(await current(generation, abort.signal))) return;
      if (!value.references[0]) throw new Error("history_reference_unavailable");
      onReference(value.references[0]);
      setAdded(true);
    } catch (e) {
      if (generation === request.current && !abort.signal.aborted) fail(e);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-col gap-4" data-history-search>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
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
        <Button type="submit" disabled={!query.trim() || !queryValid || busy || !status?.enabled}>
          {c.search}
        </Button>
      </form>
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{c.source}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select
            value={workspace || "__all_workspaces__"}
            onValueChange={(value) =>
              setWorkspace(value === "__all_workspaces__" ? "" : (value ?? ""))
            }
          >
            <SelectTrigger className="h-10 w-full" aria-label={c.allWorkspaces}>
              <SelectValue>
                {workspace
                  ? (catalog?.workspaces?.find((item) => item.id === workspace)?.name.trim() ??
                    workspace)
                  : c.allWorkspaces}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{c.workspace}</SelectLabel>
                <SelectItem value="__all_workspaces__">{c.allWorkspaces}</SelectItem>
                {catalog?.workspaces?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name.trim() || w.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={agent || "__all_agents__"}
            onValueChange={(value) => setAgent(value === "__all_agents__" ? "" : (value ?? ""))}
          >
            <SelectTrigger className="h-10 w-full" aria-label={c.allAgents}>
              <SelectValue>{agent ? agentName(agent) : c.allAgents}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{c.allAgents}</SelectLabel>
                <SelectItem value="__all_agents__">{c.allAgents}</SelectItem>
                {[...new Set(catalog?.sessions.map((s) => s.agent) ?? [])].map((a) => (
                  <SelectItem key={a} value={a}>
                    {agentName(a)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={kind || "__all_kinds__"}
            onValueChange={(value) => setKind(value === "__all_kinds__" ? "" : (value ?? ""))}
          >
            <SelectTrigger className="h-10 w-full" aria-label={c.allKinds}>
              <SelectValue>
                {kind === "messages" ? c.messages : kind === "tools" ? c.tools : c.allKinds}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{c.allKinds}</SelectLabel>
                <SelectItem value="__all_kinds__">{c.allKinds}</SelectItem>
                <SelectItem value="messages">{c.messages}</SelectItem>
                <SelectItem value="tools">{c.tools}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <NativeCheckbox checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          {c.archived}
        </label>
      </fieldset>
      {status && <HistoryCoverageStatus status={status} locale={locale} />}
      {status?.enabled === false && (
        <div className="space-y-2">
          <p role="status">{c.disabled}</p>
          {appNavigation && (
            <Button
              variant="outline"
              onClick={() => {
                if (appNavigation.app.openSettings("privacy") === true) onSettingsOpened?.();
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
      {busy && (
        <p role="status" className="text-xs">
          {c.loading}
        </p>
      )}
      {located ? (
        <section className="space-y-4 rounded-lg border p-4" aria-label={c.source}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{c.source}</p>
              <strong className="mt-1 block min-w-0 break-words text-sm">
                {located.title || agentName(located.agent)}
              </strong>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                request.current++;
                inFlight.current?.abort();
                setLocated(undefined);
                setOpenConfirmation(undefined);
                setBusy(false);
              }}
            >
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
          <pre
            tabIndex={0}
            className="max-h-[35dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 text-xs leading-6"
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
                <Textarea
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
              <p className="text-xs text-muted-foreground">{c.quoteOnly}</p>
              <Button disabled={busy || selection[0] === selection[1]} onClick={() => void quote()}>
                {c.quote}
              </Button>
              {added && (
                <p role="status" className="text-xs">
                  {c.added}
                </p>
              )}
            </>
          )}
        </section>
      ) : (
        <div className="max-h-[45dvh] space-y-2 overflow-auto">
          {result?.hits.map((hit: HistorySearchHit, index) => (
            <Button
              variant="bare"
              size="content"
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
            </Button>
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
  const c = historyCopy[props.locale];
  return (
    <Dialog
      panel
      className="md:max-w-2xl"
      title={c.title}
      description={c.local}
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
    </Dialog>
  );
}
/** Desktop surfaces outside SessionProvider share the same source reader. */
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
        variant={iconOnly ? "ghost" : "outline"}
        className={
          iconOnly
            ? `size-8 shrink-0 rounded-lg p-0 ${error ? "text-destructive-text" : "text-muted-foreground hover:text-foreground"}`
            : "h-10 w-full justify-start gap-2 rounded-xl bg-background px-3 text-sm font-normal shadow-sm"
        }
        aria-label={historyCopy[locale].title}
        title={
          iconOnly ? (error ? historyCopy[locale].error : historyCopy[locale].title) : undefined
        }
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={() => void openSearch()}
      >
        <Search
          size={iconOnly ? 15 : 16}
          className={iconOnly ? undefined : "text-muted-foreground"}
          aria-hidden="true"
        />
        {!iconOnly && historyCopy[locale].title}
      </Button>
      {error && (
        <p role="alert" className={iconOnly ? "sr-only" : "text-sm text-destructive-text"}>
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
