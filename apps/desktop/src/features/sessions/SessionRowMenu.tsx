import { useState, type ComponentProps } from "react";
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
  onChanged,
  onDeleted,
}: {
  session: ConversationSessionSummary;
  sessions?: ConversationSessionSummary[];
  canPin?: boolean;
  pinOnly?: boolean;
  onChanged?: () => void;
  onDeleted?: () => void;
}) {
  const { locale, tr } = useI18n();
  const copy = sessionCopy[locale];
  const dialogs = useAppDialogs();
  const [client] = useState(createDesktopConversationClient);
  const [assigningWorkers, setAssigningWorkers] = useState(false);
  const assignment = workerAssignmentCopy[locale];
  const offersAssignment = sessionProviderDeclaration(session.agent)?.projectAgent?.lead === true;
  const assignmentDisabledReason =
    session.orchestration?.role === "worker"
      ? assignment.reasons["session-is-a-worker"]
      : session.availability !== "readable" || session.archived || session.sidechain
        ? assignment.cannotLead
        : undefined;
  return (
    <>
      <SessionManagementRowMenu
        session={session}
        client={client}
        locale={locale}
        canPin={canPin}
        pinOnly={pinOnly}
        copy={copy}
        components={components}
        sessionTitle={displaySessionTitle(session.title ?? undefined, tr)}
        deleteDescription={
          session.agent === "claude-code" ? copy.deleteClaudeDetail : copy.deleteCodexDetail
        }
        triggerClassName="session-row-menu size-8 shrink-0 rounded-lg p-0 text-muted-foreground opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 hover:text-foreground data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
        triggerSize="sm"
        iconSize={15}
        extraMenuItems={
          offersAssignment && (
            <DropdownMenuItem
              className="data-disabled:pointer-events-auto"
              disabled={!!assignmentDisabledReason}
              title={assignmentDisabledReason}
              onClick={() => !assignmentDisabledReason && setAssigningWorkers(true)}
            >
              {assignment.menu}
            </DropdownMenuItem>
          )
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
        />
      )}
    </>
  );
}
