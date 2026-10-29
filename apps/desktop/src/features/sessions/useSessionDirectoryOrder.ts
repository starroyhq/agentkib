import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SessionVisibility } from "@agentkib/session-catalog";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { groupSessions } from "./session-catalog";
import {
  normalizeDirectoryOrder,
  normalizeSessionDirectoryOrder,
  useSessionViewStore,
} from "./session-view-store";

/** `workspaceId` names a directory group (see `SessionGroup.id`). */
type DirectoryDragEntry =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; workspaceId: string; sessionId: string };

function moveRelative<T>(
  items: T[],
  sourceId: string,
  targetId: string,
  after: boolean,
  getId: (item: T) => string,
) {
  const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
  const targetIndex = items.findIndex((item) => getId(item) === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  const [source] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((item) => getId(item) === targetId);
  next.splice(targetIndexAfterRemoval + Number(after), 0, source);
  return next;
}

export function sessionOrder(sessions: ConversationSessionSummary[], ids: string[]) {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...sessions].sort((left, right) => {
    const leftPosition = positions.get(left.id);
    const rightPosition = positions.get(right.id);
    if (leftPosition === undefined) return rightPosition === undefined ? 0 : -1;
    if (rightPosition === undefined) return 1;
    return leftPosition - rightPosition;
  });
}

/**
 * Keep full catalog ordering while dragging a filtered directory. Order and collapse state are
 * keyed by group: a repository's checkouts share one group, named by its main checkout.
 */
export function useSessionDirectoryOrder(hub: {
  sessions: ConversationSessionSummary[];
  filtered: ConversationSessionSummary[];
  workspaces: WorkspaceSummary[];
  visibility?: SessionVisibility;
}) {
  const view = useSessionViewStore(
    useShallow((state) => ({
      workspaceOrder: state.workspaceOrder,
      sessionOrder: state.sessionOrder,
      setWorkspaceOrder: state.setWorkspaceOrder,
      setSessionOrder: state.setSessionOrder,
    })),
  );
  const draggedEntry = useRef<DirectoryDragEntry | null>(null);
  const [draggingId, setDraggingId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [dropAfter, setDropAfter] = useState(false);
  const groups = groupSessions(hub.filtered, hub.workspaces, hub.visibility);
  const allGroups = groupSessions(hub.sessions, hub.workspaces, hub.visibility);
  // Saved positions of workspaces without sessions survive until they reappear.
  const orderIds = [
    ...new Set([...hub.workspaces.map((workspace) => workspace.id), ...allGroups.map((g) => g.id)]),
  ];
  const completeWorkspaceOrder = normalizeDirectoryOrder(view.workspaceOrder, orderIds);
  const groupHost = (id: string) =>
    (allGroups.find((group) => group.id === id) ?? groups.find((group) => group.id === id))
      ?.workspace.remote?.host_id ?? "local";
  const workspacePositions = new Map(completeWorkspaceOrder.map((id, index) => [id, index]));
  const orderedGroups = [...groups].sort((left, right) => {
    const leftHost = left.workspace.remote?.host_id ?? "";
    const rightHost = right.workspace.remote?.host_id ?? "";
    const hostOrder = leftHost.localeCompare(rightHost);
    if (hostOrder !== 0) return hostOrder;
    const leftPosition = workspacePositions.get(left.id);
    const rightPosition = workspacePositions.get(right.id);
    if (leftPosition === undefined) return rightPosition === undefined ? 0 : 1;
    if (rightPosition === undefined) return -1;
    return leftPosition - rightPosition;
  });
  const startDrag = (event: DragEvent, entry: DirectoryDragEntry, draggingKey: string) => {
    draggedEntry.current = entry;
    setDraggingId(draggingKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingKey);
  };
  const finishDrag = () => {
    draggedEntry.current = null;
    setDraggingId(undefined);
    setDropTargetId(undefined);
    setDropAfter(false);
  };
  const allowDrop = (event: DragEvent, target: DirectoryDragEntry) => {
    const source = draggedEntry.current;
    if (!source || source.kind !== target.kind) return;
    if (target.kind === "session" && source.workspaceId !== target.workspaceId) return;
    if (
      target.kind === "workspace" &&
      groupHost(source.workspaceId) !== groupHost(target.workspaceId)
    )
      return;
    const sourceId = source.kind === "workspace" ? source.workspaceId : source.sessionId;
    const targetId = target.kind === "workspace" ? target.workspaceId : target.sessionId;
    if (sourceId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetId(targetId);
    setDropAfter(
      event.clientY >=
        event.currentTarget.getBoundingClientRect().top +
          event.currentTarget.getBoundingClientRect().height / 2,
    );
  };
  const dropBefore = (event: DragEvent, target: DirectoryDragEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedEntry.current;
    if (!source || source.kind !== target.kind) return;
    if (source.kind === "workspace" && target.kind === "workspace") {
      if (groupHost(source.workspaceId) !== groupHost(target.workspaceId)) {
        finishDrag();
        return;
      }
      view.setWorkspaceOrder(
        moveRelative(
          completeWorkspaceOrder,
          source.workspaceId,
          target.workspaceId,
          dropAfter,
          (id) => id,
        ),
      );
    } else if (
      source.kind === "session" &&
      target.kind === "session" &&
      source.workspaceId === target.workspaceId
    ) {
      const group = allGroups.find((item) => item.id === source.workspaceId);
      if (group) {
        const completeOrder = normalizeSessionDirectoryOrder(
          view.sessionOrder[source.workspaceId] ?? [],
          group.sessions.map((session) => session.id),
        );
        view.setSessionOrder(
          source.workspaceId,
          moveRelative(completeOrder, source.sessionId, target.sessionId, dropAfter, (id) => id),
        );
      }
    }
    finishDrag();
  };
  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, target: DirectoryDragEntry) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const after = event.key === "ArrowDown";

    if (target.kind === "workspace") {
      const hostId = groupHost(target.workspaceId);
      const siblings = orderedGroups
        .filter((group) => (group.workspace.remote?.host_id ?? "local") === hostId)
        .map((group) => group.id);
      const index = siblings.indexOf(target.workspaceId);
      const neighbor = siblings[index + (after ? 1 : -1)];
      if (!neighbor) return;
      view.setWorkspaceOrder(
        moveRelative(completeWorkspaceOrder, target.workspaceId, neighbor, after, (id) => id),
      );
      return;
    }

    const visibleGroup = groups.find((group) => group.id === target.workspaceId);
    const allGroup = allGroups.find((group) => group.id === target.workspaceId);
    if (!visibleGroup || !allGroup) return;
    const visibleIds = sessionOrder(
      visibleGroup.sessions,
      view.sessionOrder[target.workspaceId] ?? [],
    ).map((session) => session.id);
    const index = visibleIds.indexOf(target.sessionId);
    const neighbor = visibleIds[index + (after ? 1 : -1)];
    if (!neighbor) return;
    const completeOrder = normalizeSessionDirectoryOrder(
      view.sessionOrder[target.workspaceId] ?? [],
      allGroup.sessions.map((session) => session.id),
    );
    view.setSessionOrder(
      target.workspaceId,
      moveRelative(completeOrder, target.sessionId, neighbor, after, (id) => id),
    );
  };
  return {
    groups,
    orderedGroups,
    draggingId,
    dropTargetId,
    dropAfter,
    startDrag,
    finishDrag,
    allowDrop,
    dropBefore,
    moveByKeyboard,
  };
}
