import { useI18n } from "@/core/useI18n";
import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The empty home's ways to add a first workspace, when the getting-started card is closed. */
export function WorkspaceAddActions({
  busy,
  onAddWorkspace,
  onAddRoot,
}: {
  busy: boolean;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <div className="grid gap-3 text-left">
      <div className="grid gap-1.5">
        <Button disabled={busy} aria-busy={busy} onClick={() => void onAddWorkspace()}>
          <FolderGit2 size={14} />
          {tr("home.addWorkspace")}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">{tr("home.addWorkspaceHint")}</p>
      </div>
      <div className="grid gap-1.5">
        <Button variant="outline" disabled={busy} onClick={() => void onAddRoot()}>
          {tr("home.addScanRoot")}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">{tr("home.addScanRootHint")}</p>
      </div>
    </div>
  );
}
