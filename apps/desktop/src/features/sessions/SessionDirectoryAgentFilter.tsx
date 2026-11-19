import { AgentMark } from "@agentkib/agent-identity";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentKind } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { sessionAgentNames } from "./session-labels";

export function SessionDirectoryAgentFilter({
  agents,
  value,
  onChange,
  disabled,
}: {
  agents: readonly AgentKind[];
  value: AgentKind | "all";
  onChange: (agent: AgentKind | "all") => void;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const viewportId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measureOverflow = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const left = viewport.scrollLeft > 0.5;
    const right = viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 0.5;
    setOverflow((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    if (agents.length < 2) return;
    const viewport = viewportRef.current;
    const items = itemsRef.current;
    if (!viewport || !items) return;

    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureOverflow);
    observer?.observe(viewport);
    observer?.observe(items);
    measureOverflow();
    return () => observer?.disconnect();
  }, [agents.length, measureOverflow]);

  if (agents.length < 2) return null;

  function scroll(direction: -1 | 1, edgeWidth: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Leave enough overlap for icons under the edge fades to pass through clear view.
    viewport.scrollBy({ left: direction * (viewport.clientWidth - 2 * edgeWidth) });
  }

  function filterButton(agent: AgentKind | "all") {
    const label = agent === "all" ? tr("sessions.allAgents") : sessionAgentNames[agent];
    return (
      <Button
        key={agent}
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-10 rounded-full border-border bg-sidebar-accent/45 aria-pressed:border-primary"
        aria-pressed={value === agent}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => onChange(agent)}
      >
        {agent === "all" ? (
          <LayoutGrid className="size-5.5" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <AgentMark agent={agent} size={30} />
        )}
      </Button>
    );
  }

  function scrollButton(direction: -1 | 1) {
    const left = direction === -1;
    const label = tr(left ? "sessions.scrollAgentsLeft" : "sessions.scrollAgentsRight");
    const Icon = left ? ChevronLeft : ChevronRight;
    return (
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 z-10 flex w-7 items-center before:absolute before:inset-0",
          "before:[background:linear-gradient(var(--agent-filter-fade-direction),var(--sidebar)_0_4px,transparent)]",
          left
            ? "left-0 justify-start [--agent-filter-fade-direction:to_right]"
            : "right-0 justify-end [--agent-filter-fade-direction:to_left]",
        )}
      >
        <Button
          type="button"
          variant="bare"
          size="icon-xs"
          className="pointer-events-auto relative rounded-none text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          aria-label={label}
          aria-controls={viewportId}
          title={label}
          onClick={(event) =>
            scroll(direction, event.currentTarget.parentElement?.clientWidth ?? 0)
          }
        >
          <Icon className="size-5" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={tr("conversations.agentFilter")}
      className="relative mx-2 min-w-0"
    >
      {overflow.left && scrollButton(-1)}
      <div
        ref={viewportRef}
        id={viewportId}
        data-agent-filter-viewport=""
        className="overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-7 scrollbar-none motion-safe:scroll-smooth"
        onScroll={measureOverflow}
      >
        <div
          ref={itemsRef}
          data-agent-filter-items=""
          className="flex w-max items-center gap-1.5 p-1"
        >
          {filterButton("all")}
          {agents.map(filterButton)}
        </div>
      </div>
      {overflow.right && scrollButton(1)}
    </div>
  );
}
