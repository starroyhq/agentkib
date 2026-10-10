import { useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { Markdown } from "@tanstack/markdown/react";
import { Fragment, useMemo, useState, type ComponentProps } from "react";
import { FileCode2, Folder, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/core/api";
import type { SkillFileEntry } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { diffLines } from "@/features/workspace/diff";
import { cn } from "cn";

export interface SkillReadableContent {
  path: string;
  content?: string;
  before?: string;
  after?: string;
  binary?: boolean;
  truncated?: boolean;
  reason?: string;
  before_size?: number;
  after_size?: number;
  before_sha256?: string;
  after_sha256?: string;
  before_executable?: boolean;
  after_executable?: boolean;
}

// The existing LCS implementation allocates an N×M table. Bound work before calling it.
export function boundedSkillDiff(before: string, after: string) {
  if (before.length + after.length > 128 * 1024) return undefined;
  const left = before.split("\n").length;
  const right = after.split("\n").length;
  if (left + right > 2_000 || left * right > 250_000) return undefined;
  return diffLines(before, after);
}

function SkillLink({ href, children }: ComponentProps<"a">) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void api.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function SkillImage({ alt }: ComponentProps<"img">) {
  const { tr } = useI18n();
  return (
    <span className="text-muted-foreground">
      [{tr("skills.manager.imageNotLoaded")}
      {alt ? `: ${alt}` : ""}]
    </span>
  );
}

export function SkillSafeMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-content break-words">
      <Markdown allowHtml={false} components={{ a: SkillLink, img: SkillImage }}>
        {content}
      </Markdown>
    </div>
  );
}

interface FileNode {
  name: string;
  path: string;
  children: Map<string, FileNode>;
  file?: SkillFileEntry;
  directory?: boolean;
}

export function isSkillDirectory(path: string) {
  return path.endsWith("/");
}

function FileNodes({
  nodes,
  selected,
  onSelect,
}: {
  nodes: Map<string, FileNode>;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const { tr } = useI18n();
  // Combining versions can make one path both a historical file and a directory.
  return [...nodes.values()].map((node) => (
    <Fragment key={node.path}>
      {node.file && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-left",
            selected === node.path && "bg-muted",
          )}
          title={node.path}
          aria-pressed={selected === node.path}
          onClick={() => onSelect(node.path)}
        >
          <FileCode2 size={14} className="shrink-0" />
          <span className="truncate">{node.name}</span>
        </Button>
      )}
      {node.children.size > 0 && (
        <Collapsible defaultOpen className="text-xs">
          <CollapsibleTrigger className="cursor-pointer rounded px-2 py-2" title={`${node.path}/`}>
            <Folder className="mr-1 inline-block" size={13} />
            {node.name}/
          </CollapsibleTrigger>
          <CollapsibleContent className="ml-3 border-l pl-1">
            <FileNodes nodes={node.children} selected={selected} onSelect={onSelect} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {node.directory && node.children.size === 0 && (
        <div className="px-2 py-2 text-xs" title={`${node.path}/`}>
          <Folder className="mr-1 inline-block" size={13} />
          {node.name}/
          <span className="ml-2 text-muted-foreground">{tr("skills.manager.directory")}</span>
        </div>
      )}
    </Fragment>
  ));
}

export function SkillFileBrowser({
  files,
  readFile,
}: {
  files: SkillFileEntry[];
  readFile: (path: string) => Promise<SkillReadableContent>;
}) {
  const { tr, localizeMessage } = useI18n();
  const readableFiles = files.filter((file) => !isSkillDirectory(file.path));
  const defaultPath =
    readableFiles.find((file) => file.path === "SKILL.md")?.path ?? readableFiles[0]?.path ?? "";
  const [selected, setSelected] = useState(defaultPath);
  const [mode, setMode] = useState("preview");
  const activePath = readableFiles.some((file) => file.path === selected) ? selected : defaultPath;
  const queryClient = useOptionalQueryClient();
  const fileQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: ["skill-file", readerId(readFile), activePath],
      queryFn: () => readFile(activePath),
      enabled: !!activePath,
      staleTime: Infinity,
      gcTime: 0,
    },
    queryClient,
  );
  const value = activePath ? fileQuery.data : undefined;
  const error = activePath ? fileQuery.error : null;
  const loading = !!activePath && fileQuery.isPending;
  const tree = useMemo(() => {
    const root: FileNode = { name: "", path: "", children: new Map() };
    for (const file of files) {
      let current = root;
      const directory = isSkillDirectory(file.path);
      const path = directory ? file.path.slice(0, -1) : file.path;
      path.split("/").forEach((name, index, parts) => {
        const path = parts.slice(0, index + 1).join("/");
        if (!current.children.has(name))
          current.children.set(name, { name, path, children: new Map() });
        current = current.children.get(name)!;
      });
      if (directory) current.directory = true;
      else current.file = file;
    }
    return root.children;
  }, [files]);
  const content = value?.after ?? value?.content ?? "";
  const versions = (["before", "after"] as const).map((side) => {
    const text = side === "after" ? (value?.after ?? value?.content) : value?.before;
    const exists =
      text !== undefined ||
      value?.[`${side}_size`] !== undefined ||
      value?.[`${side}_sha256`] !== undefined;
    return { side, text, exists, binary: Boolean(value?.binary && exists && text === undefined) };
  });
  const hasPrevious = versions[0].exists;
  const diff = useMemo(
    // A null binary snapshot is not an empty text file. Keep mixed versions side by side.
    () =>
      value?.before !== undefined && !value.binary
        ? boundedSkillDiff(value.before, content)
        : undefined,
    [content, value],
  );
  const markdown = /\.md$/i.test(activePath);
  return (
    <div className="grid min-w-0 overflow-hidden rounded-xl border md:grid-cols-[190px_minmax(0,1fr)]">
      <nav
        className="max-h-72 overflow-auto border-b p-2 md:max-h-[440px] md:border-b-0 md:border-r"
        aria-label={tr("skills.manager.fileTree")}
      >
        <FileNodes nodes={tree} selected={activePath} onSelect={setSelected} />
      </nav>
      <div className="grid min-w-0 content-start gap-3 p-3">
        {activePath && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="break-all text-xs">{activePath}</code>
            <Tabs value={mode} onValueChange={setMode}>
              <TabsList>
                <TabsTrigger value="preview">{tr("assets.preview")}</TabsTrigger>
                <TabsTrigger value="source">{tr("skills.manager.sourceText")}</TabsTrigger>
                {hasPrevious && <TabsTrigger value="diff">{tr("skills.manager.diff")}</TabsTrigger>}
              </TabsList>
            </Tabs>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{tr("skills.manager.readOnlyNotice")}</p>
        {!activePath && files.length > 0 && (
          <p className="text-sm text-muted-foreground">{tr("skills.manager.directoriesOnly")}</p>
        )}
        {loading && (
          <div role="status" className="flex gap-2 text-sm">
            <LoaderCircle size={16} className="animate-spin" />
            {tr("common.loading")}
          </div>
        )}
        {error !== undefined && (
          <p role="alert" className="break-words text-sm text-destructive">
            {localizeMessage(error)}
          </p>
        )}
        {value?.reason && <p className="text-sm text-muted-foreground">{value.reason}</p>}
        {value?.binary && <p>{tr("skills.manager.binary")}</p>}
        {value?.truncated && (
          <p className="text-sm text-amber-700">{tr("skills.manager.truncated")}</p>
        )}
        {value && (
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            {(["before", "after"] as const).map((side) =>
              value[`${side}_size`] !== undefined || value[`${side}_sha256`] !== undefined ? (
                <div key={side} className="min-w-0 rounded border p-2">
                  <strong>{tr(`skills.manager.${side}`)}</strong>
                  <p>
                    {value[`${side}_size`]?.toLocaleString()} B
                    {value[`${side}_executable`] !== undefined
                      ? ` · ${tr(value[`${side}_executable`] ? "skills.manager.executable" : "skills.manager.notExecutable")}`
                      : ""}
                  </p>
                  {value[`${side}_sha256`] && (
                    <code className="block break-all">SHA-256: {value[`${side}_sha256`]}</code>
                  )}
                  {versions.find((version) => version.side === side)?.binary && (
                    <p className="text-muted-foreground">{tr("skills.manager.binaryVersion")}</p>
                  )}
                </div>
              ) : null,
            )}
          </div>
        )}
        {value && (!value.binary || versions.some((version) => version.text !== undefined)) && (
          <div className="max-h-[400px] min-h-32 overflow-auto text-sm">
            {value.binary ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {versions
                  .filter((version) => version.exists)
                  .map((version) => (
                    <section key={version.side} aria-label={tr(`skills.manager.${version.side}`)}>
                      <h4 className="mb-2 text-xs font-medium">
                        {tr(`skills.manager.${version.side}`)}
                      </h4>
                      {version.binary ? (
                        <p className="text-xs text-muted-foreground">
                          {tr("skills.manager.binaryVersion")}
                        </p>
                      ) : mode === "preview" && markdown ? (
                        <SkillSafeMarkdown content={version.text ?? ""} />
                      ) : (
                        <pre className="whitespace-pre-wrap break-words text-xs">
                          {version.text}
                        </pre>
                      )}
                    </section>
                  ))}
              </div>
            ) : mode === "diff" && value.before !== undefined ? (
              diff ? (
                <pre aria-label={tr("skills.manager.diff")} className="text-xs">
                  {diff.map((line, index) => (
                    <div
                      key={index}
                      className={cn(
                        "whitespace-pre-wrap break-words px-2",
                        line.type === "added" && "bg-emerald-500/10",
                        line.type === "removed" && "bg-red-500/10",
                      )}
                    >
                      {line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}
                      {line.content || " "}
                    </div>
                  ))}
                </pre>
              ) : (
                <>
                  <p className="mb-2 text-muted-foreground">{tr("skills.manager.diffLimited")}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <pre className="whitespace-pre-wrap break-words text-xs">{value.before}</pre>
                    <pre className="whitespace-pre-wrap break-words text-xs">{content}</pre>
                  </div>
                </>
              )
            ) : mode === "preview" && markdown ? (
              <SkillSafeMarkdown content={content} />
            ) : (
              <pre className="whitespace-pre-wrap break-words text-xs">{content}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// File readers capture preview tokens or detail scopes. Never share content
// between readers merely because both expose the same relative file path.
const readerIds = new WeakMap<(path: string) => Promise<SkillReadableContent>, number>();
let nextReaderId = 0;
function readerId(reader: (path: string) => Promise<SkillReadableContent>) {
  let id = readerIds.get(reader);
  if (id === undefined) {
    id = ++nextReaderId;
    readerIds.set(reader, id);
  }
  return id;
}
