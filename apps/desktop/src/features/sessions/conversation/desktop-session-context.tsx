import { useSessionNavigate } from "./desktop-session-navigation";
import { createSessionContext } from "@agentkib/session-ui";
import type { ReactNode } from "react";
import {
  useSessionController,
  type SessionController,
  type SessionOptions,
} from "./desktop-session-controller";

const { SessionContextProvider, useSession } = createSessionContext<SessionController>();

export { useSession };

export function SessionProvider({
  children,
  ...options
}: SessionOptions & { children: ReactNode }) {
  const session = useSessionController(options);
  const navigate = useSessionNavigate();
  return (
    <SessionContextProvider
      session={session}
      onOpenSession={(source) =>
        navigate({ to: "/sessions/$sessionId", params: { sessionId: source.id } })
      }
    >
      {children}
    </SessionContextProvider>
  );
}
