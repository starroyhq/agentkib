import { createContext, useContext, type ReactNode } from "react";
import {
  useSessionController,
  type SessionController,
  type SessionOptions,
} from "./use-session-controller";

const SessionContext = createContext<SessionController | null>(null);
export function SessionProvider({
  children,
  ...options
}: SessionOptions & { children: ReactNode }) {
  const value = useSessionController(options);
  return <SessionContext value={value}>{children}</SessionContext>;
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}
