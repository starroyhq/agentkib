import {
  SessionTools as SharedSessionTools,
  SessionOperations,
  type SessionToolsProps,
} from "@agentkib/session-ui";
import { useOptionalAppNavigationContext } from "@/features/app/AppNavigationContext";
import { useSession } from "../../desktop-session-context";
import { useSessionNavigate } from "../../desktop-session-navigation";
import { desktopProjectAgentClient } from "./project-agent-adapter";

export function DesktopSessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const session = useSession();
  const appNav = useOptionalAppNavigationContext();
  return (
    <SessionOperations
      open={open}
      onOpenChange={onOpenChange}
      session={session}
      projectAgentClient={desktopProjectAgentClient}
      ExecutionControls={SessionTools}
      onOpenIntegrations={
        appNav
          ? () => {
              onOpenChange(false);
              appNav.app.openSettings("integrations");
            }
          : undefined
      }
      onOpenWorkspaces={
        appNav
          ? () => {
              onOpenChange(false);
              appNav.app.navigateGlobal("workspaces");
            }
          : undefined
      }
    />
  );
}

export function SessionTools(props: SessionToolsProps) {
  const session = useSession();
  const navigate = useSessionNavigate();
  return (
    <SharedSessionTools
      {...props}
      session={session}
      onNavigate={(sessionId) => {
        void (sessionId
          ? navigate({ to: "/sessions/$sessionId", params: { sessionId } })
          : navigate({ to: "/sessions" }));
      }}
    />
  );
}
