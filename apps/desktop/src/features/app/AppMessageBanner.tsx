import { CircleAlert, X } from "lucide-react";
import { Button } from "@agentkib/ui/button";
import { useI18n } from "@/core/useI18n";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

export function AppMessageBanner() {
  const { tr } = useI18n();
  const message = useWorkspaceStore((state) => state.message);
  const revision = useWorkspaceStore((state) => state.messageRevision);
  const dismissed = useWorkspaceStore((state) => state.messageDismissed);
  if (!message || dismissed) return null;
  return (
    <div
      role="alert"
      className="mx-7 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text"
    >
      <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={tr("common.close")}
        onClick={() => useWorkspaceStore.getState().dismissMessage(revision)}
      >
        <X size={15} aria-hidden="true" />
      </Button>
    </div>
  );
}
