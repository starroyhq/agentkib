import { DelayedSpinner } from "@agentkib/session-ui";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/core/useI18n";
import type { AppliedWorkspaceChanges } from "./workspace-store";
import { WorkspaceChangeDiff } from "./WorkspaceChangeDiff";
import { appliedChangeCopy } from "./applied-change-copy";
import { doctorIssueTitle } from "./doctor-presentation";

export function AppliedChangesNotice({
  result,
  onDismiss,
  verificationText,
  onDoctor,
}: {
  result: AppliedWorkspaceChanges;
  onDismiss: () => void;
  verificationText?: string;
  onDoctor?: () => void;
}) {
  const { tr, locale } = useI18n();
  const copy = appliedChangeCopy(locale);
  const [open, setOpen] = useState(false);
  const diagnosis = result.diagnosis;
  const healthy =
    diagnosis?.status === "complete" && diagnosis.issues.length === 0 && !diagnosis.remaining;
  useEffect(() => {
    if (healthy) toast.success(copy.noNewIssues, { duration: 3000, id: result.changeSet.id });
  }, [copy.noNewIssues, healthy, result.changeSet.id]);
  const needsDoctor =
    diagnosis?.status === "failed" ||
    Boolean(diagnosis && (diagnosis.issues.length > 0 || diagnosis.remaining));
  return (
    <>
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
      >
        <Check size={17} className="text-emerald-600" />
        <div className="grid flex-1 gap-1">
          <span>
            {result.diagnosis
              ? copy.applied(result.applied.length)
              : tr("changes.appliedSummary", { count: result.applied.length })}
          </span>
          {verificationText && <span>{verificationText}</span>}
          {result.diagnosis && (
            <>
              {result.diagnosis.status === "checking" && (
                <span role="status" aria-label={copy.checking}>
                  <DelayedSpinner active />
                </span>
              )}
              {result.diagnosis.status === "failed" && <span>{copy.failed}</span>}
              {result.diagnosis.status === "complete" &&
                !healthy &&
                Boolean(result.diagnosis.resolved) && (
                  <span>{copy.complete(result.diagnosis.resolved!)}</span>
                )}
              {result.diagnosis.status === "complete" &&
                result.diagnosis.remaining !== undefined &&
                result.diagnosis.remaining > result.diagnosis.issues.length && (
                  <span className="text-warning">
                    {copy.remainingIssues(result.diagnosis.remaining)}
                  </span>
                )}
              {result.diagnosis.issues.length > 0 && (
                <div className="grid gap-1 text-warning">
                  <span>
                    {result.diagnosis.resolved === undefined
                      ? copy.currentIssues(result.diagnosis.issues.length)
                      : copy.newIssues(result.diagnosis.issues.length)}
                  </span>
                  {result.diagnosis.issues.map((issue) => (
                    <span key={issue.id}>{doctorIssueTitle(issue, locale, tr)}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {onDoctor && needsDoctor && (
          <Button variant="outline" size="sm" onClick={onDoctor}>
            {copy.doctor}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {tr("changes.viewApplied")}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={tr("common.close")} onClick={onDismiss}>
          <X size={15} />
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogTitle>{tr("changes.viewApplied")}</DialogTitle>
          <DialogDescription>{tr("changes.appliedReadOnly")}</DialogDescription>
          <div className="grid gap-4">
            {result.applied.map((target) => {
              const change = result.changeSet.changes.find((item) => item.target === target);
              return (
                <section className="grid min-w-0 gap-2" key={target}>
                  <h3 className="break-all text-sm font-medium">{target}</h3>
                  {change && <WorkspaceChangeDiff before={change.before} after={change.after} />}
                </section>
              );
            })}
            {result.backupDir && (
              <p className="grid gap-1 text-xs text-muted-foreground">
                <span>{tr("changes.backupDirectory")}</span>
                <code className="break-all">{result.backupDir}</code>
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
