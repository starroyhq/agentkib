import { HistorySearchControls } from "@agentkib/session-ui";
import { createContext, useContext, type ReactNode } from "react";
import {
  useSessionController,
  type SessionController,
  type SessionOptions,
} from "./use-session-controller";
import { useSessionNavigate } from "./session-navigation";

const SessionContext = createContext<SessionController | null>(null);
export function SessionProvider({
  children,
  ...options
}: SessionOptions & { children: ReactNode }) {
  const value = useSessionController(options);
  const navigate = useSessionNavigate();
  return (
    <SessionContext value={value}>
      {children}
      <HistorySearchControls
        session={value}
        onOpenSession={(source) =>
          navigate({ to: "/sessions/$sessionId", params: { sessionId: source.id } })
        }
      />
    </SessionContext>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}
