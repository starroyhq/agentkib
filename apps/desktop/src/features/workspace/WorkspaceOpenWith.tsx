import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useState } from "react";
import { ChevronDown, Code2, FolderOpen, SquareTerminal } from "lucide-react";
import { api } from "@/core/api";
import { localizeMessage } from "@/core/i18n";
import type { WorkspaceOpener, WorkspaceSummary } from "@/core/types";
import { useOptionalQueryClient } from "@/features/home/home-query";
import { withAsyncCleanup } from "@/lib/utils";
import { useWorkspaceOpeners, workspaceKeys } from "./workspace-query";

const noOpeners: WorkspaceOpener[] = [];

export function WorkspaceOpenWith({
  workspace,
  onError,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
}) {
  const { tr } = useI18n();
  const queryClient = useOptionalQueryClient();
  // 按工作区缓存；切换工作区时不会短暂显示上一个工作区的打开方式。
  const { data: openers = noOpeners, error } = useWorkspaceOpeners(workspace.id);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (error) onError(localizeMessage(error));
  }, [error, onError]);
  const preferred = openers.find((opener) => opener.preferred) ?? openers[0];

  const openWorkspace = async (openerId?: string) => {
    if (!preferred && !openerId) return;
    setOpening(true);
    onError("");
    await withAsyncCleanup(
      async () => {
        try {
          await api.openWorkspaceWithApp(workspace.id, openerId);
          // 选择其他应用会改变默认项，需要重新读取。
          if (openerId)
            await queryClient.invalidateQueries({ queryKey: workspaceKeys.openers(workspace.id) });
        } catch (reason) {
          onError(localizeMessage(reason));
        }
      },
      () => setOpening(false),
    );
  };

  if (!preferred) return null;
  return (
    <div className="inline-flex h-9 max-w-full items-stretch overflow-hidden rounded-lg border border-border bg-background">
      <Button
        variant="ghost"
        className="min-w-0 max-w-40 justify-start gap-2 rounded-none border-0 px-3"
        disabled={opening}
        onClick={() => void openWorkspace()}
        title={tr("workspaceOpener.openWith", { app: preferred.name })}
      >
        <OpenerIcon category={preferred.category} />
        <span className="truncate">{preferred.name}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" className="h-9 w-8 rounded-none border-0 px-0" />
          }
          aria-label={tr("workspaceOpener.choose")}
          title={tr("workspaceOpener.choose")}
        >
          <ChevronDown size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[248px] max-h-[min(480px,calc(100vh-110px))]" align="end">
          {(["editor", "terminal", "file-manager"] as const).map((category) => {
            const values = openers.filter((opener) => opener.category === category);
            return values.length ? (
              <DropdownMenuGroup
                key={category}
                className="border-t border-border pt-1 first:border-t-0 first:pt-0"
              >
                <DropdownMenuLabel>{tr(`workspaceOpener.category.${category}`)}</DropdownMenuLabel>
                {values.map((opener) => (
                  <DropdownMenuItem
                    key={opener.id}
                    className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2"
                    onClick={() => void openWorkspace(opener.id)}
                  >
                    <OpenerIcon category={opener.category} />
                    <strong className="truncate text-sm">{opener.name}</strong>
                    {opener.preferred && (
                      <em className="text-xs not-italic text-primary">
                        {tr("workspaceOpener.default")}
                      </em>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OpenerIcon({ category }: { category: WorkspaceOpener["category"] }) {
  if (category === "terminal") return <SquareTerminal size={15} />;
  if (category === "file-manager") return <FolderOpen size={15} />;
  return <Code2 size={15} />;
}
