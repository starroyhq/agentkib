import { CodexTools as SharedCodexTools, type CodexToolsProps } from "@agentkib/session-ui";
import { useSessionNavigate } from "../../web-session-navigation";
import { SessionOperations } from "@agentkib/session-ui";

import { useSession } from "../../web-session-context";

export function WebSessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const session = useSession();
  return (
    <SessionOperations
      open={open}
      onOpenChange={onOpenChange}
      session={session}
      projectAgentClient={session.client}
      ExecutionControls={CodexTools}
    />
  );
}

export function CodexTools(props: CodexToolsProps) {
  const session = useSession();
  const navigate = useSessionNavigate();
  return (
    <SharedCodexTools
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
