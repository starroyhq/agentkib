import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { HistorySearchControls } from "../history/history-search-controls";

type HistoryControls = ComponentProps<typeof HistorySearchControls>;

export function createSessionContext<Controller extends HistoryControls["session"]>() {
  const SessionContext = createContext<Controller | null>(null);

  function SessionContextProvider({
    session,
    onOpenSession,
    children,
    notifications,
  }: {
    session: Controller;
    onOpenSession: HistoryControls["onOpenSession"];
    children: ReactNode;
    notifications?: ReactNode;
  }) {
    return (
      <SessionContext value={session}>
        {children}
        <HistorySearchControls session={session} onOpenSession={onOpenSession} />
        {notifications}
      </SessionContext>
    );
  }

  function useSession() {
    const value = useContext(SessionContext);
    if (!value) throw new Error("SessionProvider is missing");
    return value;
  }

  return { SessionContextProvider, useSession };
}

export type SessionNavigate = (options: {
  to: string;
  params?: Record<string, string>;
  replace?: boolean;
  resetScroll?: boolean;
}) => Promise<void>;

/** Both host routers expose the same conversation routes. */
export function bindSessionNavigation(useNavigate: () => unknown) {
  return function useSessionNavigate(): SessionNavigate {
    return useNavigate() as SessionNavigate;
  };
}
