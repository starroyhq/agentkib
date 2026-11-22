import { SessionOperations } from "@agentkib/session-ui";
import { CodexTools } from "./codex-tools";
import { useSession } from "./session-context";
import { SessionReceiptRecovery } from "./session-receipt-recovery";

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
      ReceiptRecovery={SessionReceiptRecovery}
    />
  );
}
