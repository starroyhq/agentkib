import { HistorySearchControls } from "@agentkib/session-ui";
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { Toaster } from "sonner";
import { codexCopyForSurface } from "./codex-copy";
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
      <Toaster
        position="top-right"
        offset={{ top: "calc(var(--window-toolbar-height, 0px) + 16px)" }}
        closeButton
        duration={5000}
        style={
          {
            "--normal-bg": "var(--card)",
            "--normal-text": "var(--card-foreground)",
            "--normal-border": "var(--border)",
          } as CSSProperties
        }
        toastOptions={{ closeButtonAriaLabel: codexCopyForSurface(value.locale, "web").close }}
      />
    </SessionContext>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing");
  return value;
}
