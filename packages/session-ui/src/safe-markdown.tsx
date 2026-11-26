import { createContext, useContext } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CodeBlock } from "./code-block";

const TranscriptLocale = createContext<string | undefined>(undefined);

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
        rehypePlugins={[rehypeSanitize]}
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </TranscriptLocale.Provider>
  );
}
