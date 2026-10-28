import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

export {
  sessionContinuationCopy,
  sessionContinuationListState,
  SessionContinuationDot,
  SessionContinuationChoice,
  SessionContinuationReadOnly,
  SessionContinuationReturned,
  SessionContinuationStatus,
  SessionContinuationTerminal,
  type SessionContinuationAction,
  type SessionContinuationAgent,
  type SessionContinuationChoiceProps,
  type SessionContinuationCopy,
  type SessionContinuationReadOnlyProps,
  type SessionContinuationStatusProps,
  type SessionContinuationTerminalProps,
} from "./session-continuation";

export { codexCommandPrompt, type CodexCommandPromptRequest } from "./codex-prompts";
export {
  agentKibCommand,
  agentKibPanel,
  claudeSlashOptions,
  matchSlashCommands,
  codexSlashOptions,
  slashCommandCopy,
  slashCommandQuery,
  unsupportedEffortReason,
  useSlashCommandMenu,
  type AgentKibCommand,
  type AgentKibPanel,
  type SlashCommandOption,
} from "./slash-commands";

export {
  DiffPreview,
  ToolDetailBody,
  ToolDetailRow,
  TurnFileChanges,
  formatToolDuration,
  isHiddenWrapperTool,
  toolDetailCopy,
  turnDurationOf,
  turnFileChanges,
  type ToolDetailContentView,
  type ToolDetailKind,
  type ToolDetailView,
  type ToolEventView,
  type TurnFileChange,
} from "./tool-details";

export function toolStatusLabel(status: string | null | undefined, locale: string): string {
  const names =
    locale === "zh-TW"
      ? ["已完成", "失敗", "執行中", "等待中", "已取消", "已拒絕"]
      : locale.startsWith("zh")
        ? ["已完成", "失败", "执行中", "等待中", "已取消", "已拒绝"]
        : locale.startsWith("ja")
          ? ["完了", "失敗", "実行中", "待機中", "キャンセル済み", "拒否済み"]
          : ["Completed", "Failed", "Running", "Pending", "Cancelled", "Declined"];
  const value = status?.toLowerCase();
  if (["completed", "complete", "success", "succeeded"].includes(value ?? "")) return names[0];
  if (["failed", "failure", "error", "errored"].includes(value ?? "")) return names[1];
  if (["running", "in-progress", "inprogress"].includes(value ?? "")) return names[2];
  if (["pending", "queued"].includes(value ?? "")) return names[3];
  if (["cancelled", "canceled"].includes(value ?? "")) return names[4];
  if (["declined", "rejected", "denied"].includes(value ?? "")) return names[5];
  return status ?? "";
}

const markdownComponents: Components = {
  img: ({ alt }) => (
    <span
      role="img"
      aria-label={alt || "Image omitted"}
      title={alt || "Image omitted"}
      className="inline rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
    >
      {alt || "Image omitted"}
    </span>
  ),
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

/** A Markdown tree node, as far as `remarkLiteral` reads it. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}
// Nodes whose children are blocks: an HTML block there becomes a paragraph of its text.
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

/**
 * For text Claude Code wrote itself: HTML shows as written, so a usage line keeps `<name>`
 * rather than losing it to the sanitizer, and each line break stays one. Code, tables and
 * headings still render.
 */
function remarkLiteral() {
  return (tree: MarkdownNode) => keepAsWritten(tree);
}
function keepAsWritten(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type !== "html") return child;
    const text = { type: "text", value: child.value ?? "" };
    return FLOW_PARENTS.has(node.type) ? { type: "paragraph", children: [text] } : text;
  });
  for (const child of node.children) keepAsWritten(child);
  node.children = node.children.flatMap((child) =>
    child.type === "text" && child.value?.includes("\n")
      ? child.value
          .split("\n")
          .flatMap((line, index) => [
            ...(index ? [{ type: "break" }] : []),
            { type: "text", value: line },
          ])
      : [child],
  );
}

const remarkPlugins = [remarkGfm];
const literalRemarkPlugins = [remarkGfm, remarkLiteral];

/**
 * Markdown with raw HTML, scripts and remote images removed. `literal` is for text Claude Code
 * wrote itself (`cli_output`), such as a local command's output.
 */
export function SafeMarkdown({ text, literal = false }: { text: string; literal?: boolean }) {
  return (
    <Markdown
      remarkPlugins={literal ? literalRemarkPlugins : remarkPlugins}
      rehypePlugins={[rehypeSanitize]}
      components={markdownComponents}
    >
      {text}
    </Markdown>
  );
}
