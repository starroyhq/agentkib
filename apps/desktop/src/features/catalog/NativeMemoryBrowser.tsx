import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, ChevronDown, FileText, Folder, PanelLeftClose } from "lucide-react";
import type { NativeMemoryFile, NativeMemorySource } from "@agentkib/runtime-protocol";
import type { MemoryRecord, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "cn";
import "./native-memory-browser.css";

interface ProjectGroup {
  id: string;
  name: string;
  source?: NativeMemorySource;
  workspaces: Array<{ id: string; name: string; path?: string }>;
  files: NativeMemoryFile[];
  records: MemoryRecord[];
}

export function NativeMemoryBrowser({
  files,
  sources,
  records,
  workspaces,
  selectedKey,
  onOpenFile,
  onOpenRecord,
  onClose,
  reader,
  empty,
  more,
}: {
  files: NativeMemoryFile[];
  sources: NativeMemorySource[];
  records: MemoryRecord[];
  workspaces: WorkspaceSummary[];
  selectedKey: string | null;
  onOpenFile: (id: string, sourceId: string) => void;
  onOpenRecord: (id: string) => void;
  onClose: () => void;
  reader: ReactNode;
  empty: ReactNode;
  more?: ReactNode;
}) {
  const { tr } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () =>
      setNarrow((element.getBoundingClientRect().width || window.innerWidth) < 840);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const groups = useMemo(() => {
    const result = new Map<string, ProjectGroup>();
    for (const source of sources) {
      if (["disabled", "unavailable"].includes(source.status)) continue;
      const entries = files.filter((file) => file.sourceId === source.id);
      if (!entries.length) continue;
      const associated = source.workspaces
        .map((workspace) => ({
          ...workspace,
          path: workspaces.find((value) => value.id === workspace.id)?.path,
        }))
        .sort(
          (a, b) =>
            (a.path?.length ?? Infinity) - (b.path?.length ?? Infinity) ||
            a.name.localeCompare(b.name),
        );
      result.set(source.id, {
        id: source.id,
        source,
        name: associated[0]?.name ?? tr("memory.native.untitledProject"),
        workspaces: associated,
        files: [...entries].sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            b.modifiedAt.localeCompare(a.modifiedAt) ||
            (a.title ?? a.relativePath).localeCompare(b.title ?? b.relativePath),
        ),
        records: [],
      });
    }
    for (const record of records) {
      const workspace = workspaces.find(
        (value) =>
          value.id === record.project_id || value.manifest_workspace_id === record.project_id,
      );
      const existing =
        workspace &&
        [...result.values()].find((group) =>
          group.workspaces.some((value) => value.id === workspace.id),
        );
      const id = existing?.id ?? `platform:${workspace?.id ?? record.project_id}`;
      const group = existing ??
        result.get(id) ?? {
          id,
          name:
            workspace?.name ??
            `${tr("memory.native.untitledProject")} · ${record.project_id.slice(0, 8)}`,
          workspaces: workspace
            ? [{ id: workspace.id, name: workspace.name, path: workspace.path }]
            : [],
          files: [],
          records: [],
        };
      group.records.push(record);
      result.set(id, group);
    }
    return [...result.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }, [files, sources, records, workspaces, tr]);

  return (
    <div
      ref={container}
      className="native-memory-browser min-h-0 min-w-0 flex-1"
      data-narrow={narrow}
    >
      <section
        aria-label={tr("memory.native.projects")}
        className="native-memory-list min-h-0 min-w-0 overflow-y-auto overscroll-contain"
      >
        {groups.map((group) => {
          const open = !collapsed.has(group.id);
          const needsAttention =
            group.source &&
            (group.source.stale || group.source.incomplete || group.source.status === "error");
          return (
            <div key={group.id} className="mb-3 min-w-0">
              <Button
                variant="bare"
                size="content"
                type="button"
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                <ChevronDown
                  size={13}
                  className={cn(
                    "shrink-0 text-muted-foreground transition-transform",
                    !open && "-rotate-90",
                  )}
                />
                <Folder size={16} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.name}</span>
                {needsAttention && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                    aria-label={tr("memory.native.sourcesUnavailable", { count: 1 })}
                  />
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {group.files.length + group.records.length}
                </span>
              </Button>
              {open && (
                <>
                  {group.workspaces.length > 1 && (
                    <Collapsible className="mx-3 mb-1 text-xs text-muted-foreground">
                      <CollapsibleTrigger
                        render={<Button variant="bare" size="content" className="py-1" />}
                      >
                        {tr("memory.native.sharedWorkspaces", { count: group.workspaces.length })}
                      </CollapsibleTrigger>
                      <CollapsibleContent keepMounted>
                        <ul
                          aria-label={tr("memory.native.associations")}
                          className="grid gap-2 py-2"
                        >
                          {group.workspaces.map((workspace) => (
                            <li key={workspace.id} className="min-w-0">
                              <span>{workspace.name}</span>
                              {workspace.path && (
                                <span className="block break-all text-[11px]">
                                  {workspace.path}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                  {needsAttention && (
                    <p className="px-3 pb-1 text-xs text-amber-700 dark:text-amber-400">
                      {group.source?.stale
                        ? tr("memory.native.stale")
                        : group.source?.incomplete
                          ? tr("memory.native.incomplete")
                          : tr("memory.native.loadError")}
                    </p>
                  )}
                  {group.files.map((file) => (
                    <Button
                      variant="bare"
                      size="content"
                      key={file.id}
                      type="button"
                      aria-pressed={selectedKey === `native:${file.id}`}
                      className={cn(
                        "native-memory-file group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted/60",
                        selectedKey === `native:${file.id}` && "bg-muted",
                      )}
                      onClick={() => onOpenFile(file.id, file.sourceId)}
                    >
                      <FileText size={15} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {file.relativePath}
                      </span>
                    </Button>
                  ))}
                  {group.records.map((record) => (
                    <Button
                      variant="bare"
                      size="content"
                      key={record.id}
                      type="button"
                      aria-pressed={selectedKey === `platform:${record.id}`}
                      className={cn(
                        "native-memory-file flex w-full min-w-0 items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-muted/60",
                        selectedKey === `platform:${record.id}` && "bg-muted",
                      )}
                      onClick={() => onOpenRecord(record.id)}
                    >
                      <Brain size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="grid min-w-0 flex-1 gap-1">
                        <span className="line-clamp-2 break-words text-[13px] font-medium">
                          {record.content}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {tr("memory.native.platformRecord")} ·{" "}
                          {tr(`status.memory.${record.status}`)}
                        </span>
                      </span>
                    </Button>
                  ))}
                </>
              )}
            </div>
          );
        })}
        {!groups.length && <div className="px-3 py-8 text-sm text-muted-foreground">{empty}</div>}
        {more}
      </section>
      <div className="native-memory-reader-slot min-h-0 min-w-0">
        {!selectedKey && (
          <section
            aria-label={tr("memory.native.reader")}
            className="grid h-full place-content-center justify-items-center gap-2 px-6 text-center text-muted-foreground"
          >
            <Brain size={28} className="mb-2 opacity-50" />
            <h3 className="text-sm font-medium text-foreground">
              {tr("memory.native.selectFile")}
            </h3>
            <p className="max-w-72 text-xs leading-relaxed">{tr("memory.native.selectFileHint")}</p>
          </section>
        )}
        {narrow ? (
          <Sheet
            open={Boolean(selectedKey)}
            onOpenChange={(open) => {
              if (!open) onClose();
            }}
          >
            <SheetContent className="native-memory-reader-pane w-[min(100%,700px)]">
              <SheetTitle className="sr-only">{tr("memory.native.reader")}</SheetTitle>
              <section
                aria-label={tr("memory.native.reader")}
                className="flex h-full min-h-0 min-w-0 flex-col"
              >
                <div className="shrink-0 border-b border-border px-3 py-2">
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    <PanelLeftClose size={15} />
                    {tr("memory.native.backToList")}
                  </Button>
                </div>
                {reader}
              </section>
            </SheetContent>
          </Sheet>
        ) : selectedKey ? (
          <section
            aria-label={tr("memory.native.reader")}
            className="native-memory-reader-pane flex h-full min-h-0 min-w-0 flex-col"
          >
            {reader}
          </section>
        ) : null}
      </div>
    </div>
  );
}
