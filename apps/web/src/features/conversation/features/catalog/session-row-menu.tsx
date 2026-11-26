import type { ComponentProps } from "react";
import { displaySessionTitle } from "@agentkib/session-catalog";
import { SessionManagementRowMenu } from "@agentkib/session-ui";
import type { ConversationSessionSummary, SessionManagementAction } from "@agentkib/web-client";
import { Dialog } from "../../components/dialog";
import { dictionaries } from "../../i18n";
import { webSessionPlatform } from "../../session-platform";
import { useSession } from "../../web-session-context";
import { sessionCopyForSurface, sessionReason } from "../../session-copy";

function DeleteDialog({ children, footer, ...props }: ComponentProps<typeof Dialog>) {
  return (
    <Dialog {...props}>
      {children}
      <div className="flex justify-end gap-2">{footer}</div>
    </Dialog>
  );
}

export function SessionRowMenu({
  session,
  pinOnly = false,
  sidebar = false,
  onOpenFork,
}: {
  session: ConversationSessionSummary;
  pinOnly?: boolean;
  sidebar?: boolean;
  onOpenFork?: () => void;
}) {
  const { client, locale, refresh, dropDeletedSession, access, error } = useSession();
  const copy = sessionCopyForSurface(locale, "web");
  const reason = (action: SessionManagementAction, code: string) => {
    if (sidebar && code === "follower-operation-unverified")
      return sessionReason(locale, "native-operation-not-integrated", "web").text;
    if (action === "delete" && code === "codex-owner-busy") return copy.deleteOwnerBusy;
    if (
      action === "delete" &&
      (code === "claude-owner-busy" || code === "claude-background-session-running")
    )
      return copy.deleteClaudeOwnerBusy;
    return sessionReason(locale, code, "web").text;
  };
  return (
    <SessionManagementRowMenu
      session={session}
      client={client}
      locale={locale}
      canPin={!error && access?.device?.organize === true}
      pinOnly={pinOnly}
      sidebar={sidebar ? { onOpenFork } : undefined}
      canManage={!sidebar || (!error && access?.device?.organize === true)}
      copy={copy}
      components={webSessionPlatform.components}
      sessionTitle={displaySessionTitle(session.title, dictionaries[locale].untitled)}
      deleteDescription={
        session.agent === "claude-code" ? copy.deleteClaudeDetail : copy.deleteCodexDetail
      }
      triggerClassName="session-row-menu size-11 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity group-hover/session:opacity-100 group-has-[:focus-visible]/session:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
      iconSize={16}
      DeleteDialog={DeleteDialog}
      errorMessage={reason}
      onChanged={() => void refresh(true)}
      onDeleted={() => {
        dropDeletedSession(session.id);
        void refresh(true);
      }}
    />
  );
}
