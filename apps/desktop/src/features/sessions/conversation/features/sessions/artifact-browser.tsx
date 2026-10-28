import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import {
  ApiError,
  type ArtifactEntry,
  type ArtifactListing,
  type ArtifactTicket,
} from "@agentkib/web-client";
import { ArtifactPreview } from "./artifact-viewers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SheetClose, SheetTitle } from "@/components/ui/sheet";
import { artifactCopy } from "./artifact-copy";
import { ArtifactPanel } from "./artifact-panel";
import { LivePreview } from "./live-preview";
import { useSession } from "./session-context";

type Root = { id: string; name: string };
const VIEWS = ["artifacts", "files", "diff", "preview"] as const;
type Diff = {
  patch: string;
  binary: boolean;
  submodule: boolean;
  encoding_lossy: boolean;
  truncated: boolean;
};

function formatFileSize(size: number, locale: string) {
  const units = ["B", "KB", "MB", "GB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
}

export function ArtifactBrowser({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
} = {}) {
  const { client, access, current, selected, locale, embedded } = useSession();
  const copy = artifactCopy(locale);
  const titleId = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const open = (controlledOpen ?? localOpen) && Boolean(access?.device?.files);
  const setOpen = useCallback(
    (value: boolean) => {
      setLocalOpen(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const [roots, setRoots] = useState<Root[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tab, setTab] = useState<(typeof VIEWS)[number]>("artifacts");
  const fileView = tab === "artifacts" || tab === "files";
  const [listing, setListing] = useState<ArtifactListing>();
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [entry, setEntry] = useState<ArtifactEntry>();
  const [ticket, setTicket] = useState<ArtifactTicket>();
  const [download, setDownload] = useState<ArtifactTicket>();
  const [text, setText] = useState<string>();
  const [diff, setDiff] = useState<Diff | null>();
  const [kind, setKind] = useState("worktree");
  const [oid, setOid] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const media = useRef<HTMLMediaElement | null>(null);
  const playback = useRef({ time: 0, playing: false });
  const requests = useRef<AbortController | undefined>(undefined);
  const message = useCallback(
    (e: unknown) => (e instanceof ApiError && e.status === 403 ? copy.denied : copy.loadError),
    [copy],
  );
  const stopMedia = useCallback(() => {
    const player = media.current;
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
  }, []);
  const setMedia = useCallback(
    (node: HTMLMediaElement | null) => {
      if (media.current && media.current !== node) stopMedia();
      media.current = node;
    },
    [stopMedia],
  );
  const resetPreview = useCallback(() => {
    stopMedia();
    setEntry(undefined);
    setTicket(undefined);
    setDownload(undefined);
    setText(undefined);
    playback.current = { time: 0, playing: false };
  }, [stopMedia]);
  useEffect(() => () => stopMedia(), [stopMedia]);
  useEffect(() => {
    if (!access?.device?.files) setOpen(false);
  }, [access?.device?.files, setOpen]);
  useEffect(() => {
    if (!open) {
      generation.current++;
      requests.current?.abort();
      resetPreview();
      return;
    }
    const abort = new AbortController();
    void client
      .request<{ workspaces: Root[] }>("files/workspaces", undefined, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setRoots(result.workspaces);
        setWorkspaceId(
          result.workspaces.find((w) => w.id === current?.workspace_id)?.id ??
            result.workspaces[0]?.id ??
            "",
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [open, client, current?.workspace_id, resetPreview, message]);
  const load = useCallback(
    async (directoryId?: string, older?: string) => {
      requests.current?.abort();
      const abort = new AbortController();
      requests.current = abort;
      const g = ++generation.current;
      setError("");
      resetPreview();
      // The web preview reads nothing from the authorized directories.
      setLoading(tab !== "preview");
      if (tab === "preview") return;
      try {
        const query = new URLSearchParams({ workspaceId });
        if (tab === "files") {
          if (directoryId) query.set("directoryId", directoryId);
          const result = await client.request<ArtifactListing>(
            `files/list?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) setListing(result);
        } else if (tab === "artifacts") {
          if (workspaceId !== current?.workspace_id) {
            setArtifacts([]);
            setCursor(undefined);
            return;
          }
          query.set("sessionId", selected);
          if (older) query.set("cursor", older);
          const result = await client.request<{ artifacts: ArtifactEntry[]; next_cursor?: string }>(
            `artifacts?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) {
            setArtifacts((old) =>
              older
                ? [...old, ...result.artifacts].filter(
                    (item, index, all) => all.findIndex((x) => x.id === item.id) === index,
                  )
                : result.artifacts,
            );
            setCursor(result.next_cursor);
          }
        } else {
          query.set("kind", kind);
          if (kind === "commit") {
            if (!/^[a-f0-9]{40,64}$/i.test(oid)) {
              setDiff(undefined);
              return;
            }
            query.set("oid", oid);
          }
          const result = await client.request<Diff | null>(
            `diff?${query}`,
            undefined,
            abort.signal,
          );
          if (g === generation.current) setDiff(result);
        }
      } catch (e) {
        if (g === generation.current && !abort.signal.aborted) setError(message(e));
      } finally {
        if (g === generation.current) setLoading(false);
      }
    },
    [client, workspaceId, tab, current?.workspace_id, selected, kind, oid, resetPreview, message],
  );
  useEffect(() => {
    setListing(undefined);
    setArtifacts([]);
    setDiff(undefined);
    setCursor(undefined);
    if (open && workspaceId) void load();
    return () => {
      generation.current++;
      requests.current?.abort();
    };
  }, [open, workspaceId, tab, kind, selected, current?.workspace_id, load]);
  async function preview(item: ArtifactEntry) {
    if (item.kind === "directory") return load(item.id);
    requests.current?.abort();
    const abort = new AbortController();
    requests.current = abort;
    const g = ++generation.current;
    setLoading(true);
    setError("");
    resetPreview();
    setEntry(item);
    playback.current = { time: 0, playing: false };
    try {
      if (item.previewKind === "text") {
        const query = new URLSearchParams({
          workspaceId,
          artifactId: item.id,
          revision: item.revision,
        });
        const result = await client.request<{ text: string }>(
          `files/text?${query}`,
          undefined,
          abort.signal,
        );
        if (g === generation.current) setText(result.text);
      } else {
        const result = await client.request<ArtifactTicket>(
          "artifact-tickets",
          { workspaceId, artifactId: item.id },
          abort.signal,
        );
        if (g === generation.current) setTicket(result);
      }
    } catch (e) {
      if (g === generation.current && !abort.signal.aborted) setError(message(e));
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  // Renew only through the authenticated parent. The untrusted document never receives control credentials.
  useEffect(() => {
    if (!open || !ticket || !entry) return;
    const g = generation.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expiry = setTimeout(
      () => {
        if (g !== generation.current || abort.signal.aborted) return;
        abort.abort();
        clearTimeout(timer);
        setTicket(undefined);
        setError(copy.expired);
      },
      Math.max(0, ticket.expiresAt - Date.now()),
    );
    const renew = () => {
      void client
        .request<ArtifactTicket>(
          "artifact-tickets",
          { workspaceId, artifactId: entry.id },
          AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        )
        .then((result) => {
          if (g !== generation.current || abort.signal.aborted) return;
          if (result.revision !== ticket.revision) {
            setTicket(undefined);
            setError(copy.changed);
            return;
          }
          const player = media.current;
          if (player) playback.current = { time: player.currentTime, playing: !player.paused };
          setError("");
          setTicket(result);
        })
        .catch((e) => {
          if (!abort.signal.aborted && g === generation.current) {
            if (e instanceof ApiError && [401, 403, 404, 409, 410].includes(e.status)) {
              setTicket(undefined);
              setError(message(e));
            } else if (Date.now() < ticket.expiresAt) {
              // A temporary renewal failure does not invalidate an unexpired URL.
              timer = setTimeout(renew, Math.min(2000, ticket.expiresAt - Date.now()));
            }
          }
        });
    };
    timer = setTimeout(renew, Math.max(1000, ticket.expiresAt - Date.now() - 30_000));
    return () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      abort.abort();
    };
  }, [open, ticket, entry, workspaceId, client, copy, message]);
  async function downloadFile() {
    if (!entry) return;
    const g = generation.current;
    try {
      const result = await client.request<ArtifactTicket>(
        "artifact-tickets",
        {
          workspaceId,
          artifactId: entry.id,
          download: true,
        },
        requests.current?.signal,
      );
      if (g === generation.current) setDownload(result);
    } catch (e) {
      if (g === generation.current) setError(message(e));
    }
  }
  function restorePlayback() {
    const player = media.current;
    if (!player) return;
    player.currentTime = playback.current.time;
    if (playback.current.playing) void player.play().catch(() => {});
  }
  function backToList() {
    generation.current++;
    requests.current?.abort();
    resetPreview();
    setLoading(false);
    setError("");
  }
  if (!access?.device?.files) return null;
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" className="min-h-11" onClick={() => setOpen(true)}>
          <FolderOpen size={16} />
          {copy.title}
        </Button>
      )}
      {open && (
        <ArtifactPanel labelledBy={titleId} onClose={() => setOpen(false)}>
          <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <SheetTitle id={titleId} className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {copy.title}
            </SheetTitle>
            {!entry && tab !== "preview" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-md text-muted-foreground"
                aria-label={copy.refresh}
                title={copy.refresh}
                disabled={loading || !workspaceId}
                onClick={() => void load(tab === "files" ? listing?.directoryId : undefined)}
              >
                <RefreshCw
                  className={`size-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
                  aria-hidden="true"
                />
              </Button>
            )}
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 rounded-md text-muted-foreground"
                  aria-label={copy.close}
                  title={copy.close}
                />
              }
            >
              <X className="size-4" aria-hidden="true" />
            </SheetClose>
          </header>
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as typeof tab)}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="shrink-0 border-b border-border/60 px-3 pt-2">
              <div className="flex min-w-0 items-center">
                <label className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {copy.directory}
                  </span>
                  <Select
                    items={roots.map((workspace) => ({
                      value: workspace.id,
                      label: workspace.name,
                    }))}
                    value={workspaceId || null}
                    onValueChange={(value) => value !== null && setWorkspaceId(value)}
                  >
                    <SelectTrigger
                      aria-label={copy.directory}
                      className="min-w-0 flex-1 rounded-md border-border/70 bg-background px-2 text-xs shadow-none focus-visible:ring-2"
                    >
                      <SelectValue className="min-w-0 truncate" placeholder={copy.directory} />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      {roots.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
              {!roots.length && (
                <p className="pt-2 text-xs text-muted-foreground">{copy.authorize}</p>
              )}
              <TabsList
                variant="line"
                className="mt-2 grid h-9 w-full grid-cols-4 gap-0 p-0"
                aria-label={copy.views}
              >
                {VIEWS.map((value) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    title={copy[value]}
                    className="h-9 min-w-0 px-1 text-xs after:bg-primary group-data-horizontal/tabs:after:inset-x-3 group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-px group-data-[variant=line]/tabs-list:focus-visible:bg-accent"
                  >
                    <span className="min-w-0 truncate">{copy[value]}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent
              value={tab}
              className={
                tab === "preview"
                  ? "flex min-h-0 flex-1 flex-col"
                  : "min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
              }
            >
              {tab === "preview" && <LivePreview />}
              {tab === "diff" && (
                <>
                  <p className="text-xs text-muted-foreground">{copy.diffNote}</p>
                  <Select
                    items={[
                      { value: "worktree", label: copy.worktree },
                      { value: "staged", label: copy.staged },
                      { value: "commit", label: copy.commit },
                    ]}
                    value={kind}
                    onValueChange={(value) => value !== null && setKind(value)}
                  >
                    <SelectTrigger
                      aria-label={copy.diffKind}
                      className="h-11 w-full bg-background text-sm sm:h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectItem value="worktree">{copy.worktree}</SelectItem>
                      <SelectItem value="staged">{copy.staged}</SelectItem>
                      <SelectItem value="commit">{copy.commit}</SelectItem>
                    </SelectContent>
                  </Select>
                  {kind === "commit" && (
                    <label className="block space-y-2 text-sm">
                      {copy.commitSha}
                      <Input
                        className="block h-11 w-full rounded-lg border bg-background px-3 text-sm sm:h-9"
                        value={oid}
                        onChange={(e) => setOid(e.target.value)}
                      />
                      <Button
                        className="min-h-11"
                        disabled={loading || !oid}
                        onClick={() => void load()}
                      >
                        {copy.view}
                      </Button>
                    </label>
                  )}
                  {diff && (
                    <>
                      {(diff.binary || diff.submodule || diff.encoding_lossy || diff.truncated) && (
                        <p className="text-sm">{copy.partial}</p>
                      )}
                      <pre className="max-h-[60dvh] max-w-full overflow-auto rounded border p-3 text-xs">
                        {diff.patch || copy.noChanges}
                      </pre>
                    </>
                  )}
                  {diff === null && <p className="text-sm">{copy.noDiff}</p>}
                </>
              )}
              {error && tab !== "preview" && (
                <p role="alert" className="break-words text-sm text-destructive-text">
                  {error}
                </p>
              )}
              {loading && tab !== "preview" && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {copy.loading}
                </p>
              )}
              {fileView && !entry && (
                <div className="min-w-0 space-y-3">
                  {tab === "files" && listing?.parentId && (
                    <Button
                      className="h-11 gap-2 px-2 text-xs text-muted-foreground sm:h-9"
                      variant="ghost"
                      disabled={loading}
                      onClick={() => void load(listing.parentId)}
                    >
                      <ArrowLeft className="size-3.5" aria-hidden="true" />
                      {copy.parent}
                    </Button>
                  )}
                  <ul className="min-w-0 divide-y divide-border/60">
                    {(tab === "files" ? (listing?.entries ?? []) : artifacts).map((item) => {
                      const Icon =
                        item.kind === "directory"
                          ? Folder
                          : item.previewKind === "image"
                            ? Image
                            : item.previewKind === "text"
                              ? FileText
                              : File;
                      return (
                        <li key={item.id} className="min-w-0">
                          <Button
                            variant="ghost"
                            size="content"
                            disabled={loading}
                            className="group flex min-h-14 w-full min-w-0 items-center justify-start gap-3 rounded-lg px-2 py-2.5 text-left font-normal hover:bg-muted/60"
                            aria-label={item.name}
                            title={item.name}
                            onClick={() => void preview(item)}
                          >
                            <Icon
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                            {item.kind === "file" && (
                              <span
                                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                                aria-hidden="true"
                              >
                                {formatFileSize(item.size, locale)}
                              </span>
                            )}
                            <ChevronRight
                              className="size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-foreground"
                              aria-hidden="true"
                            />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  {!loading && !(tab === "files" ? listing?.entries.length : artifacts.length) && (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground">
                      <FolderOpen className="size-5" aria-hidden="true" />
                      <p className="text-xs">{copy.empty}</p>
                    </div>
                  )}
                  {tab === "artifacts" && cursor && (
                    <div className="space-y-2 border-t pt-3">
                      <p className="text-xs leading-5 text-muted-foreground">{copy.earlierHint}</p>
                      <Button
                        className="min-h-11 w-full gap-2 rounded-lg text-xs sm:min-h-9"
                        variant="ghost"
                        disabled={loading}
                        onClick={() => void load(undefined, cursor)}
                      >
                        {copy.earlier}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {fileView && entry && (
                <div className="min-w-0 space-y-3 [&_audio]:max-w-full">
                  <Button
                    variant="ghost"
                    className="h-11 gap-2 px-2 text-xs text-muted-foreground sm:h-9"
                    onClick={backToList}
                  >
                    <ArrowLeft size={16} />
                    {copy.back}
                  </Button>
                  <div className="space-y-2 text-sm">
                    <strong className="block break-all">{entry.name}</strong>
                    <span className="block text-xs text-muted-foreground">
                      {entry.mime} · {formatFileSize(entry.size, locale)}
                    </span>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={loading}
                      onClick={() => void downloadFile()}
                    >
                      {copy.prepareDownload}
                    </Button>
                    {download && (
                      <a
                        href={download.url}
                        download
                        target={embedded ? "_blank" : undefined}
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center px-3 underline"
                      >
                        {copy.download}
                      </a>
                    )}
                  </div>
                  <ArtifactPreview
                    entry={entry}
                    ticket={ticket}
                    text={text}
                    onMediaRef={setMedia}
                    onLoadedMetadata={restorePlayback}
                    onMediaError={() => setError(copy.mediaError)}
                    openLabel={copy.open}
                  />
                </div>
              )}
            </TabsContent>
          </Tabs>
        </ArtifactPanel>
      )}
    </>
  );
}
