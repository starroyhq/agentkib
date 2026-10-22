import { create } from "zustand";
import type { AgentKind, ConversationSessionSummary } from "@/core/types";
import type { ConversationPanel } from "./conversation-panel-commands";
import { isSessionVisible } from "./session-catalog";

export type RequestedConversationPanel = { sessionId: string; panel: ConversationPanel };
export type TerminalEntryRegistration = { sessionId: string; open: () => void };

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

const SESSION_DIRECTORY_ORDER_STORAGE_KEY = "agentkib.session-directory-order";

export function normalizeDirectoryOrder(savedOrder: string[], availableIds: string[]) {
  const available = new Set(availableIds);
  const seen = new Set<string>();
  const normalized = savedOrder.filter((id) => {
    if (!available.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...normalized, ...availableIds.filter((id) => !seen.has(id))];
}

export function normalizeSessionDirectoryOrder(savedOrder: string[], availableIds: string[]) {
  const available = new Set(availableIds);
  const saved = new Set(savedOrder.filter((id) => available.has(id)));
  const normalized = normalizeDirectoryOrder(savedOrder, availableIds);
  return [
    ...availableIds.filter((id) => !saved.has(id)),
    ...normalized.filter((id) => saved.has(id)),
  ];
}

function initialSessionDirectoryOrder() {
  try {
    const value = localStorage?.getItem(SESSION_DIRECTORY_ORDER_STORAGE_KEY);
    if (!value) return { workspaceOrder: [], sessionOrder: {} };
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return { workspaceOrder: [], sessionOrder: {} };
    const record = parsed as Record<string, unknown>;
    return {
      workspaceOrder: Array.isArray(record.workspaceOrder)
        ? record.workspaceOrder.filter((id): id is string => typeof id === "string")
        : [],
      sessionOrder:
        record.sessionOrder && typeof record.sessionOrder === "object"
          ? Object.fromEntries(
              Object.entries(record.sessionOrder).flatMap(([workspaceId, ids]) =>
                Array.isArray(ids)
                  ? [[workspaceId, ids.filter((id): id is string => typeof id === "string")]]
                  : [],
              ),
            )
          : {},
    };
  } catch {
    return { workspaceOrder: [], sessionOrder: {} };
  }
}

function persistSessionDirectoryOrder(
  workspaceOrder: string[],
  sessionOrder: Record<string, string[]>,
) {
  try {
    localStorage?.setItem(
      SESSION_DIRECTORY_ORDER_STORAGE_KEY,
      JSON.stringify({ workspaceOrder, sessionOrder }),
    );
  } catch {
    // Persisting sidebar order is best-effort in restricted webviews.
  }
}

const initialDirectoryOrder = initialSessionDirectoryOrder();

// View-only state survives navigation, but never persists transcript content to disk.
export const useSessionViewStore = create<{
  agent: AgentKind | "all";
  host: string;
  filter: SessionRecordFilter;
  collapsed: Record<string, boolean>;
  workspaceOrder: string[];
  sessionOrder: Record<string, string[]>;
  scrollTop: number;
  creatingConversation: boolean;
  requestedPanel?: RequestedConversationPanel;
  terminalEntry?: TerminalEntryRegistration;
  requestPanel: (sessionId: string, panel: ConversationPanel) => void;
  consumePanel: (request: RequestedConversationPanel) => void;
  registerTerminalEntry: (entry: TerminalEntryRegistration) => void;
  unregisterTerminalEntry: (entry: TerminalEntryRegistration) => void;
  setCreatingConversation: (creating: boolean) => void;
  revealSession: (session: ConversationSessionSummary) => void;
  setAgent: (agent: AgentKind | "all") => void;
  setHost: (host: string) => void;
  setFilter: (filter: SessionRecordFilter) => void;
  toggleWorkspace: (id: string) => void;
  setWorkspaceOrder: (workspaceOrder: string[]) => void;
  setSessionOrder: (workspaceId: string, sessionOrder: string[]) => void;
  setScrollTop: (scrollTop: number) => void;
  resetFilters: () => void;
}>((set) => ({
  agent: "all",
  host: "all",
  filter: "current",
  collapsed: {},
  ...initialDirectoryOrder,
  scrollTop: 0,
  creatingConversation: false,
  requestPanel: (sessionId, panel) => set({ requestedPanel: { sessionId, panel } }),
  consumePanel: (request) =>
    set((state) => (state.requestedPanel === request ? { requestedPanel: undefined } : {})),
  registerTerminalEntry: (terminalEntry) => set({ terminalEntry }),
  unregisterTerminalEntry: (entry) =>
    set((state) => (state.terminalEntry === entry ? { terminalEntry: undefined } : {})),
  setCreatingConversation: (creatingConversation) => set({ creatingConversation }),
  revealSession: (session) => {
    if (!isSessionVisible(session)) return;
    set((state) => ({
      host:
        state.host === "all" || state.host === (session.remote?.host_id ?? "local")
          ? state.host
          : "all",
      agent: state.agent === "all" || state.agent === session.agent ? state.agent : "all",
      filter:
        (state.filter === "current" && (session.archived || session.availability !== "readable")) ||
        (state.filter === "archived" && !session.archived) ||
        (state.filter === "metadata" && session.availability !== "metadata-only")
          ? "all"
          : state.filter,
      collapsed: { ...state.collapsed, [session.workspace_id]: false },
    }));
  },
  setAgent: (agent) => set({ agent }),
  setHost: (host) => set({ host }),
  setFilter: (filter) => set({ filter }),
  toggleWorkspace: (id) =>
    set((state) => ({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })),
  setWorkspaceOrder: (workspaceOrder) =>
    set((state) => {
      persistSessionDirectoryOrder(workspaceOrder, state.sessionOrder);
      return { workspaceOrder };
    }),
  setSessionOrder: (workspaceId, order) =>
    set((state) => {
      const sessionOrder = { ...state.sessionOrder, [workspaceId]: order };
      persistSessionDirectoryOrder(state.workspaceOrder, sessionOrder);
      return { sessionOrder };
    }),
  setScrollTop: (scrollTop) => set({ scrollTop }),
  resetFilters: () => set({ agent: "all", filter: "current", host: "all" }),
}));
