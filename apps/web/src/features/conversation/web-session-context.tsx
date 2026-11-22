import { useSessionNavigate } from "./web-session-navigation";
import { createSessionContext } from "@agentkib/session-ui";
import type { ReactNode } from "react";
import {
  useSessionController,
  type SessionController,
  type SessionOptions,
} from "./web-session-controller";
import { webSessionPlatform } from "./session-platform";

const { SessionContextProvider, useSession } = createSessionContext<SessionController>();

export { useSession };

export function SessionProvider({
  children,
  ...options
}: SessionOptions & { children: ReactNode }) {
  const session = useSessionController(options);
  const navigate = useSessionNavigate();
  const Toaster = webSessionPlatform.notifications.Toaster;
  return (
    <SessionContextProvider
      session={session}
      onOpenSession={(source) =>
        navigate({ to: "/sessions/$sessionId", params: { sessionId: source.id } })
      }
      notifications={Toaster && <Toaster locale={session.locale} />}
    >
      {children}
    </SessionContextProvider>
  );
}
