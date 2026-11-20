import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { SessionGroup } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";

type DirectoryGroup = SessionGroup<ConversationSessionSummary, WorkspaceSummary>;
type AgentFilter = AgentKind | "all";
// Chromium's element-scoped API uses the document API's signature.
type DirectoryScrollport = HTMLDivElement & {
  startViewTransition?: Document["startViewTransition"];
  readonly activeViewTransition?: ViewTransition | null;
};

const progressProperty = "--directory-agent-filter-progress";
const hostKey = (group: DirectoryGroup) => `host:${group.workspace.remote?.host_id ?? ""}`;

function visibleSlots(groups: DirectoryGroup[]) {
  return new Set(
    groups.flatMap((group) => [
      hostKey(group),
      `workspace:${group.id}`,
      ...group.sessions.map((session) => `session:${session.id}`),
    ]),
  );
}

function positionFolderFolds(tree: HTMLElement, startOffsets: Map<string, number>) {
  const moving: Array<{ slot: HTMLElement; from: number; to: number }> = [];
  for (const folder of tree.querySelectorAll<HTMLElement>(".session-workspace")) {
    const heading = folder.querySelector<HTMLElement>(".session-workspace-heading");
    const headingHeight = heading?.getBoundingClientRect().height ?? 0;
    if (!headingHeight) continue;
    const finalHeadingHeight = folder.hasAttribute("inert") ? 0 : headingHeight;
    let finalTop = finalHeadingHeight;
    for (const slot of folder.querySelectorAll<HTMLElement>("[data-directory-agent-session]")) {
      const key = slot.dataset.directoryAgentSession!;
      const from = startOffsets.get(key) ?? 0;
      const leaving = slot.hasAttribute("inert");
      // The slot already moves with the list. Add only the distance from its
      // compacted position to the center of the folder heading.
      const to = leaving ? finalHeadingHeight / 2 - finalTop : 0;
      if (from || to) moving.push({ slot, from, to });
      if (!leaving) finalTop += slot.firstElementChild?.getBoundingClientRect().height ?? 0;
    }
  }
  for (const { slot, from, to } of moving) {
    slot.dataset.directoryAgentHeadingFold = "";
    slot.style.setProperty("--directory-agent-fold-from", `${from}px`);
    slot.style.setProperty("--directory-agent-fold-delta", `${to - from}px`);
  }
  return () => {
    for (const { slot } of moving) {
      delete slot.dataset.directoryAgentHeadingFold;
      slot.style.removeProperty("--directory-agent-fold-from");
      slot.style.removeProperty("--directory-agent-fold-delta");
    }
  };
}

export function useSessionDirectoryAgentMotion({
  viewport,
  ready,
  agent,
  scope,
  sessions,
  workspaces,
  groups,
  allGroups,
  orderGroups,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  ready: boolean;
  agent: AgentFilter;
  scope: string;
  sessions: ConversationSessionSummary[];
  workspaces: WorkspaceSummary[];
  groups: DirectoryGroup[];
  allGroups: DirectoryGroup[];
  orderGroups: (groups: DirectoryGroup[]) => DirectoryGroup[];
}) {
  const switchRequest = useRef(0);
  const [request, setRequest] = useState<{
    agent: AgentFilter;
    scope: string;
    sessions: ConversationSessionSummary[];
    workspaces: WorkspaceSummary[];
    sizes: Map<string, number>;
    offsets: Map<string, number>;
  }>();
  const motion =
    ready &&
    request?.agent === agent &&
    request.scope === scope &&
    request.sessions === sessions &&
    request.workspaces === workspaces
      ? request
      : undefined;

  useLayoutEffect(() => {
    const tree = viewport.current;
    if (!motion || !tree) {
      if (request) setRequest(undefined);
      return;
    }
    // One progress value changes all slot heights in the same normal-flow layout.
    const clearFolderFolds = positionFolderFolds(tree, motion.offsets);
    const animation = tree.animate([{ [progressProperty]: "0" }, { [progressProperty]: "1" }], {
      duration: 280,
      easing: "ease-out",
      fill: "both",
    });
    const finish = () => setRequest((current) => (current === motion ? undefined : current));
    void animation.finished.then(finish, (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Unable to animate the directory Agent filter", error);
      finish();
    });
    return () => {
      animation.cancel();
      clearFolderFolds();
    };
  }, [motion, request, viewport]);

  const visibleGroups = new Map(groups.map((group) => [group.id, group]));
  const target = motion ? visibleSlots(groups) : undefined;
  const displayed = motion
    ? orderGroups(
        allGroups.flatMap((group) => {
          const visible = visibleGroups.get(group.id);
          if (!visible && !motion.sizes.has(`workspace:${group.id}`)) return [];
          return [
            {
              ...(visible ?? group),
              sessions: group.sessions.filter((session) => {
                const key = `session:${session.id}`;
                return target?.has(key) || motion.sizes.has(key);
              }),
            },
          ];
        }),
      )
    : groups;

  function selectAgent(nextAgent: AgentFilter) {
    const sequence = ++switchRequest.current;
    const tree = viewport.current as DirectoryScrollport | null;
    const { agent: currentAgent, setAgent } = useSessionViewStore.getState();
    if (nextAgent === currentAgent) {
      tree?.activeViewTransition?.skipTransition();
      return;
    }

    const animate = ready && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const switchAgent = currentAgent !== "all" && nextAgent !== "all";
    if (animate && switchAgent && tree?.startViewTransition) {
      const transition = tree.startViewTransition({
        types: ["directory-agent-switch"],
        update: () => {
          // A superseded transition can still run its update callback.
          if (
            sequence === switchRequest.current &&
            viewport.current === tree &&
            useSessionViewStore.getState().agent === currentAgent
          ) {
            flushSync(() => {
              setRequest(undefined);
              setAgent(nextAgent);
            });
          }
        },
      });
      void transition.ready.catch((error: unknown) => {
        if (
          !(
            error instanceof DOMException &&
            ["AbortError", "InvalidStateError"].includes(error.name)
          )
        ) {
          console.error("Unable to animate the directory Agent switch", error);
        }
      });
      return;
    }

    tree?.activeViewTransition?.skipTransition();
    if (
      animate &&
      !switchAgent &&
      tree?.animate &&
      globalThis.CSS?.supports("block-size", "calc-size(auto, size * 0.5)")
    ) {
      const visible = target ?? visibleSlots(groups);
      const sizes = new Map<string, number>();
      // On another click, continue from the heights already on screen.
      const progress = motion
        ? Number(getComputedStyle(tree).getPropertyValue(progressProperty))
        : 1;
      for (const key of new Set([...visible, ...(motion?.sizes.keys() ?? [])])) {
        const start = motion?.sizes.get(key) ?? 0;
        const size = start + (Number(visible.has(key)) - start) * progress;
        if (size > 0) sizes.set(key, size);
      }
      const offsets = new Map<string, number>();
      if (motion) {
        for (const slot of tree.querySelectorAll<HTMLElement>(
          "[data-directory-agent-heading-fold]",
        )) {
          const row = slot.firstElementChild;
          const key = slot.dataset.directoryAgentSession!;
          if (row && sizes.has(key)) {
            offsets.set(key, row.getBoundingClientRect().top - slot.getBoundingClientRect().top);
          }
        }
      }
      setRequest({ agent: nextAgent, scope, sessions, workspaces, sizes, offsets });
    } else {
      setRequest(undefined);
    }
    setAgent(nextAgent);
  }

  return {
    displayed,
    active: !!motion,
    isVisible: (key: string) => target?.has(key) ?? true,
    startSize: (key: string) => (motion ? (motion.sizes.get(key) ?? 0) : undefined),
    selectAgent,
  };
}

export function DirectoryAgentFilterSlot({
  from,
  visible,
  sessionKey,
  children,
}: {
  from?: number;
  visible: boolean;
  sessionKey?: string;
  children: ReactNode;
}) {
  const delta = from === undefined ? 0 : Number(visible) - from;
  return (
    <div
      inert={!visible}
      aria-hidden={!visible || undefined}
      data-directory-agent-slot={delta !== 0 ? "" : undefined}
      data-directory-agent-session={sessionKey}
      style={
        delta !== 0
          ? ({
              "--directory-agent-slot-start": from,
              "--directory-agent-slot-delta": delta,
            } as CSSProperties)
          : undefined
      }
    >
      {children}
    </div>
  );
}
