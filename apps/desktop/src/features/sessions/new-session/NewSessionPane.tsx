import { useNavigate } from "@tanstack/react-router";
import { managedAgentOf } from "@agentkib/web-client";
import { useHomeInstallations, useHomeWorkspaces } from "@/features/home/home-query";
import { useSessionHub } from "../SessionHubContext";
import { useSessionViewStore } from "../session-view-store";
import { NewSessionComposer } from "./NewSessionComposer";
import { useAddWorkspace } from "./use-add-workspace";
import { useOpenWhenListed } from "./use-open-when-listed";

/** The sessions page's "New session": the composer alone, in the middle of the page. */
export function NewSessionPane() {
  const hub = useSessionHub();
  const navigate = useNavigate();
  const addWorkspace = useAddWorkspace();
  // Sessions start only on this computer, in a registered workspace.
  const workspaces = useHomeWorkspaces();
  const from = useSessionViewStore((state) => state.creatingFrom);
  const installations = useHomeInstallations();
  const notInstalled = new Set(
    (installations.data ?? []).filter((item) => !item.installed).map((item) => item.agent),
  );
  const agent = from ? managedAgentOf(from.agent) : null;
  // Selecting it keeps this page in creation until the outer route agrees on it.
  const openWhenListed = useOpenWhenListed(hub.sessions, (session) => {
    useSessionViewStore.getState().revealSession(session);
    hub.select(session.id);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 max-[600px]:p-4">
      <div className="w-full max-w-3xl">
        <NewSessionComposer
          placement="page"
          workspaces={workspaces.data ?? []}
          notInstalled={notInstalled}
          initial={
            from ? { workspaceId: from.workspaceId, ...(agent ? { agent } : {}) } : undefined
          }
          onCreated={openWhenListed}
          onAddWorkspace={addWorkspace}
          onOpenSettings={() =>
            void navigate({ to: "/settings", search: { settingsSection: "tools" } })
          }
        />
      </div>
    </div>
  );
}
