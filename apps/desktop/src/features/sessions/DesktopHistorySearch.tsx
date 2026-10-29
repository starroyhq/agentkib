import { useState } from "react";
import { HistorySearchLauncher } from "./conversation/features/history/history-search";
import {
  createDesktopConversationClient,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { requestConversationPanel } from "./conversation-panel-commands";
import { useSessionViewStore } from "./session-view-store";
export function DesktopHistorySearch() {
  const [client] = useState(createDesktopConversationClient);
  const { locale } = useI18n();
  const { selected, select } = useSessionHub();
  if (!hasDesktopConversation()) return null;
  const embedded =
    selected &&
    !selected.remote &&
    selected.availability === "readable" &&
    ["codex", "claude-code", "antigravity"].includes(selected.agent);
  return (
    <HistorySearchLauncher
      client={client}
      locale={locale}
      onOpen={embedded ? () => requestConversationPanel("search") : undefined}
      onOpenSession={(source) => {
        useSessionViewStore.getState().revealSession({
          ...source,
          created_at: source.created_at ?? undefined,
          git_branch: source.git_branch ?? undefined,
          forked_from_session_id: source.forked_from_session_id ?? undefined,
          spawned_by_session_id: source.spawned_by_session_id ?? undefined,
          worktree: source.worktree ?? undefined,
        });
        select(source.id);
      }}
    />
  );
}
