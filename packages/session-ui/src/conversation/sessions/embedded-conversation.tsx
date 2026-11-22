import { LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { InteractionLocale } from "../../interaction-model";
import type { SessionNavigate } from "./session-context";
import { SessionPanelsContext, type SessionPanels } from "./session-panels";

type HostSelection = {
  sessionId?: string;
  onSessionChange(sessionId?: string): void;
  externalNavigation: { current: boolean };
};

export function useExternalSessionNavigation(sessionId?: string) {
  const lastExternalSession = useRef(sessionId);
  const externalNavigation = useRef(false);
  if (lastExternalSession.current !== sessionId) {
    lastExternalSession.current = sessionId;
    externalNavigation.current = true;
  }
  return externalNavigation;
}

export function useEmbeddedSessionSelection(
  { externalNavigation, sessionId, onSessionChange }: HostSelection,
  id: string | undefined,
  {
    choose,
    sessions,
    excludedSessionIds,
  }: {
    choose(id: string): unknown;
    sessions: readonly { id: string; availability: string }[];
    excludedSessionIds: ReadonlySet<string>;
  },
  navigate: SessionNavigate,
) {
  const excluded = !!id && excludedSessionIds.has(id);
  const readable = sessions.some(
    (session) => session.id === id && session.availability === "readable",
  );
  useEffect(() => {
    // A parent selection can change before the memory router finishes navigation.
    if (externalNavigation.current) {
      if (sessionId !== id) return;
      externalNavigation.current = false;
    }
    if (id && excluded) {
      void choose(id);
      onSessionChange(undefined);
      void navigate({ to: "/sessions", replace: true });
      return;
    }
    if (!id || !readable) return;
    void choose(id);
    if (sessionId !== id) onSessionChange(id);
  }, [id, readable, choose, excluded, navigate, sessionId, onSessionChange, externalNavigation]);
  return { excluded, readable };
}

export function useEmbeddedEmptySelection(
  { externalNavigation, sessionId, onSessionChange }: HostSelection,
  leaveSession: () => void,
) {
  useEffect(() => {
    if (externalNavigation.current) {
      if (sessionId !== undefined) return;
      externalNavigation.current = false;
    }
    leaveSession();
    if (sessionId !== undefined) onSessionChange(undefined);
  }, [leaveSession, sessionId, onSessionChange, externalNavigation]);
}

export function useEmbeddedSessionShell<Session>({
  sessionId,
  refreshRevision,
  locale,
  onCatalogChange,
  selected,
  sessions,
  setLocale,
  refresh,
  modal,
  setTerminalOpen,
}: {
  sessionId?: string;
  refreshRevision?: number;
  locale: InteractionLocale;
  onCatalogChange?: () => void;
  selected: string;
  sessions: readonly Session[];
  setLocale(locale: InteractionLocale): void;
  refresh(): void;
  modal?: unknown;
  setTerminalOpen?: (open: boolean) => void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const previousCatalog = useRef(sessions);
  const hostRefresh = useRef<{
    revision?: number;
    pending?: { sessionId?: string };
  }>({ revision: refreshRevision });

  useEffect(() => {
    const request = hostRefresh.current;
    if (request.revision !== refreshRevision) {
      request.revision = refreshRevision;
      request.pending = { sessionId };
    }
    // The old route may still be rendering while the host switches sessions.
    if (request.pending?.sessionId !== sessionId) request.pending = undefined;
    if (!request.pending || (selected || undefined) !== sessionId) return;
    request.pending = undefined;
    refresh();
  }, [refreshRevision, sessionId, selected, refresh]);
  useEffect(() => {
    setLocale(locale);
  }, [locale, setLocale]);
  useEffect(() => {
    if (previousCatalog.current === sessions) return;
    previousCatalog.current = sessions;
    onCatalogChange?.();
  }, [sessions, onCatalogChange]);
  useLayoutEffect(() => {
    setFilesOpen(false);
    setActionsOpen(false);
    setTerminalOpen?.(false);
  }, [selected, setTerminalOpen]);
  useEffect(() => {
    if (!modal) return;
    setFilesOpen(false);
    setActionsOpen(false);
    setTerminalOpen?.(false);
  }, [modal, setTerminalOpen]);
  return { filesOpen, setFilesOpen, actionsOpen, setActionsOpen };
}

export function EmbeddedSessionShell({
  panels,
  children,
}: {
  panels: SessionPanels;
  children: ReactNode;
}) {
  return (
    <SessionPanelsContext value={panels}>
      <div className="agentkib-conversation flex min-h-0 flex-1 flex-col bg-background text-foreground">
        {children}
      </div>
    </SessionPanelsContext>
  );
}

export function EmbeddedSessionLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
