import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentName } from "@agentkib/agent-identity";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { refreshConversationCatalog } from "@/features/sessions/conversation-catalog";

const queryKey = ["home", "interrupted-quit-work"] as const;

export function InterruptedQuitWork({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const { tr } = useI18n();
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({
    queryKey,
    queryFn: api.interruptedQuitWork,
    retry: false,
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.resumeInterruptedQuitWork(id),
    async onSuccess(result) {
      await queryClient.invalidateQueries({ queryKey });
      if (result.outcome === "continued") void refreshConversationCatalog().catch(() => undefined);
    },
  });
  if (!data.length) return null;
  return (
    <Card className="gap-3 p-4">
      <h2 className="font-medium">{tr("home.quitWork.title")}</h2>
      <ul className="grid gap-2">
        {data.map((task) => {
          const openSession = task.status === "interrupted" && task.openSession === true;
          return (
            <li key={task.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{task.title.trim() || agentName(task.agent)}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !openSession && (resume.isPending || !task.resumable || task.status === "unknown")
                }
                onClick={() => {
                  if (openSession) onOpenSession(task.sessionId);
                  else resume.mutate(task.id);
                }}
              >
                {tr(openSession ? "home.openSession" : "home.quitWork.continue")}
              </Button>
            </li>
          );
        })}
      </ul>
      {(resume.isError || data.some((task) => task.status === "unknown")) && (
        <p role="status" className="text-sm text-muted-foreground">
          {tr("home.quitWork.unknown")}
        </p>
      )}
    </Card>
  );
}
