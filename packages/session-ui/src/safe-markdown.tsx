import { Check, Copy } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { CodeBlock } from "./code-block";
import { useClipboardFeedback } from "./message-actions";
import { useOptionalSessionPlatform } from "./session-platform";

const TranscriptLocale = createContext<string | undefined>(undefined);

const localPathCopy = {
  "zh-CN": {
    copy: (path: string) => `复制路径：${path}`,
    copied: "已复制路径",
  },
  "zh-Hant": {
    copy: (path: string) => `複製路徑：${path}`,
    copied: "已複製路徑",
  },
  "en-US": {
    copy: (path: string) => `Copy path: ${path}`,
    copied: "Path copied",
  },
  "ja-JP": {
    copy: (path: string) => `パスをコピー: ${path}`,
    copied: "パスをコピーしました",
  },
} as const;

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
};

function normalizeLocale(locale?: string): keyof typeof localPathCopy {
  if (locale === "zh-Hant") return "zh-Hant";
  if (locale?.startsWith("zh")) return "zh-CN";
  if (locale?.startsWith("ja")) return "ja-JP";
  return "en-US";
}

function extractLocalPath(href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^file:\/\//i.test(trimmed)) {
    const raw = trimmed.replace(/^file:\/\//i, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  // Reject all other URI schemes (http, https, mailto, javascript, data, vbscript, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function LocalPathChip({ path, children }: { path: string; children: ReactNode }) {
  const locale = useContext(TranscriptLocale);
  const platform = useOptionalSessionPlatform();
  const { feedback, copyText } = useClipboardFeedback();
  const words = localPathCopy[normalizeLocale(locale)];

  if (platform?.kind === "desktop") {
    return (
      <button
        type="button"
        className="aui-local-path"
        data-local-path={path}
        title={path}
        aria-label={feedback === "copied" ? words.copied : words.copy(path)}
        onClick={() => void copyText(path)}
      >
        <span>{children}</span>
        {feedback === "copied" ? (
          <Check
            aria-hidden="true"
            className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        ) : (
          <Copy aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        )}
      </button>
    );
  }

  return (
    <span className="aui-local-path" data-local-path={path} title={path}>
      {children}
    </span>
  );
}

const MarkdownPre: NonNullable<Components["pre"]> = ({ node, children, ...props }) => {
  const locale = useContext(TranscriptLocale);
  const code = node?.children[0];
  if (
    locale === undefined ||
    node?.children.length !== 1 ||
    code?.type !== "element" ||
    code.tagName !== "code" ||
    !code.children.every((child) => child.type === "text")
  ) {
    return <pre {...props}>{children}</pre>;
  }

  const names = code.properties.className;
  const languageClass = Array.isArray(names)
    ? names.find((name): name is string => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  // Markdown adds one final newline to each nonempty block. Preserve the source's own blank lines.
  const source = code.children
    .map((child) => child.value)
    .join("")
    .replace(/\n$/, "");
  return (
    <CodeBlock
      source={source}
      language={languageClass?.slice("language-".length)}
      locale={locale}
    />
  );
};

const markdownComponents: Components = {
  pre: MarkdownPre,
  table: ({ node: _node, children, ...props }) => (
    <div className="aui-table-scroll" data-markdown-table="" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
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
  a: ({ href, children }) => {
    if (href && /^https?:\/\//i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    }
    const localPath = extractLocalPath(href);
    if (localPath) {
      return <LocalPathChip path={localPath}>{children}</LocalPathChip>;
    }
    return <span>{children}</span>;
  },
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

function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (extractLocalPath(trimmed)) return trimmed;
  return "";
}

/**
 * Markdown with raw HTML, scripts and remote images removed. `literal` is for text Claude Code
 * wrote itself (`cli_output`), such as a local command's output.
 */
export function SafeMarkdown({
  text,
  literal = false,
  locale,
}: {
  text: string;
  literal?: boolean;
  locale?: string;
}) {
  return (
    <TranscriptLocale.Provider value={locale}>
      <Markdown
        remarkPlugins={literal ? literalRemarkPlugins : remarkPlugins}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        urlTransform={safeUrlTransform}
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </TranscriptLocale.Provider>
  );
}
