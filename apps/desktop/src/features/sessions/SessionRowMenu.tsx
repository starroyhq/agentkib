import { useState, type ComponentProps } from "react";
import { Users } from "lucide-react";
import { SessionManagementRowMenu, type SessionManagementRowMenuProps } from "@agentkib/session-ui";
import { sessionProviderDeclaration } from "@agentkib/web-client";
import { useAppDialogs } from "@/components/AppDialogProvider";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { Dialog as SessionDialog } from "./conversation/components/dialog";
import { sessionCopy, sessionReason } from "./conversation/session-copy";
import { SessionWorkerAssignmentDialog } from "./SessionWorkerAssignmentDialog";
import { workerAssignmentCopy } from "./worker-assignment-copy";

const components: SessionManagementRowMenuProps["components"] = {
  Button,
  Input,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SessionDialog,
};

function RenameDialog({ title, onClose, children }: ComponentProps<typeof SessionDialog>) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  title,
  description,
  onClose,
  children,
  footer,
}: ComponentProps<typeof SessionDialog>) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>{footer}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SessionRowMenu({
  session,
  sessions = [],
  canPin = !session.remote,
  pinOnly = false,
  sidebar,
  onChanged,
  onDeleted,
  onConnectTerminal,
  onOpenIntegrations,
  onOpenWorkspaces,
  onOpenLeadPanel,
}: {
  session: ConversationSessionSummary;
  sessions?: ConversationSessionSummary[];
  canPin?: boolean;
  pinOnly?: boolean;
  sidebar?: SessionManagementRowMenuProps["sidebar"];
  onChanged?: () => void;
  onDeleted?: () => void;
  onConnectTerminal?: () => void;
  onOpenIntegrations?: () => void;
  onOpenWorkspaces?: () => void;
  onOpenLeadPanel?: (targetSessionId: string) => void;
}) {
  const { locale, tr } = useI18n();
  const copy = sessionCopy[locale];
  const dialogs = useAppDialogs();
  const [client] = useState(createDesktopConversationClient);
  const [assigningWorkers, setAssigningWorkers] = useState(false);
  const assignment = workerAssignmentCopy[locale];
  const offersAssignment = sessionProviderDeclaration(session.agent)?.projectAgent?.lead === true;
  const assignmentUnavailable =
    session.orchestration?.role === "worker" ||
    session.availability !== "readable" ||
    session.archived ||
    session.sidechain;
  return (
    <>
      <SessionManagementRowMenu
        session={session}
        client={client}
        locale={locale}
        canPin={canPin}
        pinOnly={pinOnly}
        sidebar={sidebar}
        copy={copy}
        components={components}
        sessionTitle={displaySessionTitle(session.title ?? undefined, tr)}
        deleteDescription={
          session.agent === "claude-code" ? copy.deleteClaudeDetail : copy.deleteCodexDetail
        }
        triggerClassName="session-row-menu size-8 shrink-0 rounded-lg p-0 text-muted-foreground opacity-0 transition-opacity group-hover/session:opacity-100 group-has-[:focus-visible]/session:opacity-100 hover:text-foreground data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
        triggerSize="sm"
        iconSize={15}
        extraMenuItems={
          offersAssignment
            ? (features) => {
                const providerDisabled =
                  session.agent === "antigravity" &&
                  (!features || features.sessionReason === "antigravity-acp-disabled");
                const disabled = assignmentUnavailable || providerDisabled;
                return (
                  <DropdownMenuItem
                    disabled={disabled}
                    onClick={() => !disabled && setAssigningWorkers(true)}
                  >
                    <Users aria-hidden="true" />
                    {assignment.menu}
                  </DropdownMenuItem>
                );
              }
            : undefined
        }
        RenameDialog={RenameDialog}
        RenameFooter={DialogFooter}
        DeleteDialog={DeleteDialog}
        errorMessage={(_, code) => sessionReason(locale, code).text}
        onArchiveError={(description) => dialogs.notify({ description })}
        onChanged={onChanged}
        onDeleted={onDeleted}
      />
      {assigningWorkers && (
        <SessionWorkerAssignmentDialog
          session={session}
          sessions={sessions}
          onClose={() => setAssigningWorkers(false)}
          onChanged={onChanged}
          onConnectTerminal={onConnectTerminal}
          onOpenIntegrations={onOpenIntegrations}
          onOpenWorkspaces={onOpenWorkspaces}
          onOpenLeadPanel={onOpenLeadPanel}
        />
      )}
    </>
  );
}
