import { Markdown } from "@tanstack/markdown/react";
import type { ComponentProps } from "react";
import { api } from "@/core/api";
import { cn } from "cn";

export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("markdown-content", className)}>
      <Markdown components={{ a: MarkdownLink }}>{content}</Markdown>
    </div>
  );
}

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
