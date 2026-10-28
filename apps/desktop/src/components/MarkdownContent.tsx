import type { InlineNode, MarkdownExtension } from "@tanstack/markdown";
import { Markdown } from "@tanstack/markdown/react";
import type { ComponentProps } from "react";
import { api } from "@/core/api";
import { cn } from "cn";

/**
 * `literal` is for text Claude Code wrote itself (`cli_output`), such as a local command's
 * output: each line break stays one. HTML such as `<name>` already shows as written.
 */
export function MarkdownContent({
  content,
  className,
  literal = false,
}: {
  content: string;
  className?: string;
  literal?: boolean;
}) {
  return (
    <div className={cn("markdown-content", className)}>
      <Markdown
        components={{ a: MarkdownLink }}
        {...(literal ? { extensions: literalExtensions } : {})}
      >
        {content}
      </Markdown>
    </div>
  );
}

function breakLines(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === "text")
      return node.value
        .split("\n")
        .flatMap((line, index): InlineNode[] => [
          ...(index ? [{ type: "break" as const }] : []),
          { type: "text", value: line },
        ]);
    return "children" in node ? [{ ...node, children: breakLines(node.children) }] : [node];
  });
}
const literalExtensions: MarkdownExtension[] = [
  { name: "agentkib-literal-lines", transformInline: (nodes) => breakLines(nodes) },
];

function MarkdownLink({ href, children, ...props }: ComponentProps<"a">) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a
      {...props}
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
