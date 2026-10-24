import { useState, type ReactNode } from "react";
import { AlertTriangle, FileCode2, LoaderCircle, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isClaudeGlobalConfig } from "@/core/claude-global-config";
import type { ChangeSet, FileChange } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { fileName } from "@/lib/path-display";
import { usePathDisplay } from "@/lib/usePathDisplay";
import {
  changeGroup,
  defaultPlanTarget,
  hasDeepSeekImportLimitation,
  planText,
  planFilePath,
  instructionPlanNotes,
  summarizePlanEdit,
} from "./change-plan-presentation";
import { WorkspaceChangeDiff } from "./WorkspaceChangeDiff";

export interface WorkspacePlanViewProps {
  changeSet: ChangeSet;
  origin: "standard" | "doctor";
  status: "ready" | "generating" | "stale" | "conflict" | "applied";
  plannedManifest?: string;
  baselineManifest?: string;
  homeIncluded: boolean;
  homeApproved: boolean;
  onHomeApprovalChange: (value: boolean) => void;
  disabled: boolean;
  busy: boolean;
  applying?: boolean;
  error?: string;
  onApply: () => void;
  onReject: () => void;
  onIncludeHome: () => void;
  onRegenerate: () => void;
  onResolveConflict: (choice: "disk" | "draft") => void;
  appliedNotice?: ReactNode;
  literalImportWarning?: boolean;
}

export function WorkspacePlanView(props: WorkspacePlanViewProps) {
  const { changeSet, status, origin, homeIncluded, homeApproved, disabled, busy } = props;
  const { locale, tr } = useI18n();
  const text = (key: Parameters<typeof planText>[1], count?: number) =>
    planText(locale, key, count);
  const displayPath = usePathDisplay();
  const [selection, setSelection] = useState<{ plan: string; target?: string }>({
    plan: changeSet.id,
    target: defaultPlanTarget(changeSet),
  });
  const selectedTarget =
    selection.plan === changeSet.id ? selection.target : defaultPlanTarget(changeSet);
  const selected =
    changeSet.changes.find((change) => change.target === selectedTarget) ??
    changeSet.changes.find((change) => change.target === defaultPlanTarget(changeSet));
  const edit = summarizePlanEdit(props.plannedManifest, props.baselineManifest);
  const details: string[] = [];
  if (edit?.added)
    details.push(
      `${text("added", edit.added)}${edit.addedPreview ? (locale === "zh-CN" || locale === "zh-TW" ? `（${edit.addedPreview}）` : ` (${edit.addedPreview})`) : ""}`,
    );
  if (edit?.removed) details.push(text("removed", edit.removed));
  if (edit?.otherSections.length) details.push(text("other", edit.otherSections.length));
  const summary =
    origin === "doctor"
      ? text(status === "applied" ? "repaired" : "repairing")
      : details.length
        ? `${text("edited")}${details.join(text("separator"))}`
        : text(status === "applied" ? "applied" : "synchronizing");
  const instructionNotes = instructionPlanNotes(changeSet);
  const hasChanges = changeSet.changes.length > 0;
  const readyEmpty = status === "ready" && !hasChanges;
  const awaitingFiles = status === "generating" && !hasChanges;
  const applying = props.applying ?? busy;
  const blocked = busy || applying || status === "generating";
  const canApply =
    status === "ready" &&
    !busy &&
    !applying &&
    !disabled &&
    !!changeSet.changes.length &&
    (!changeSet.requires_home_approval || homeApproved);
  const risk = (change: FileChange) => (
    <span
      tabIndex={0}
      title={text(
        change.risk === "high"
          ? "highTip"
          : change.risk === "medium"
            ? "mediumTip"
            : changeGroup(change) === "records"
              ? "lowRecordTip"
              : "lowFileTip",
      )}
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 text-xs",
        change.risk === "high"
          ? "text-destructive-text"
          : change.risk === "medium"
            ? "text-warning"
            : "text-muted-foreground",
      )}
    >
      {text(change.risk)}
    </span>
  );
  return (
    <section
      className="flex h-[calc(100dvh-15rem)] min-h-[24rem] flex-col gap-3"
      aria-label={tr("changes.title")}
    >
      <h2 className="sr-only">{tr("changes.title")}</h2>
      <p className="sr-only">
        {status === "applied" ? text("appliedReadOnly") : tr("changes.explanation")}
      </p>
      {status === "applied"
        ? props.appliedNotice
        : status !== "ready" && (
            <div
              role="status"
              className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
            >
              {status === "generating" ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <AlertTriangle size={16} />
              )}
              <span>{text(status)}</span>
              {status === "stale" && (
                <Button variant="outline" size="sm" onClick={props.onRegenerate} disabled={blocked}>
                  {text("regenerate")}
                </Button>
              )}
              {status === "conflict" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => props.onResolveConflict("disk")}
                    disabled={blocked}
                  >
                    {text("useDisk")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => props.onResolveConflict("draft")}
                    disabled={blocked}
                  >
                    {text("keepDraft")}
                  </Button>
                </>
              )}
            </div>
          )}
      <p className="shrink-0 text-sm leading-relaxed">
        {summary}
        {!awaitingFiles && status !== "applied" && (
          <>
            {text("separator")}
            {text("writes", changeSet.changes.length)}
          </>
        )}
      </p>
      {status !== "applied" && instructionNotes.adopted && (
        <p className="shrink-0 text-sm text-muted-foreground">{text("adoption")}</p>
      )}
      {status !== "applied" && instructionNotes.duplicateTargets.length > 0 && (
        <p
          role="note"
          className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
        >
          {text("overlap")} ·{" "}
          {instructionNotes.duplicateTargets
            .map((target) => planFilePath(changeSet.project_root, target) || fileName(target))
            .join(locale === "en-US" ? ", " : "、")}
        </p>
      )}
      {status !== "applied" &&
        (props.literalImportWarning ?? hasDeepSeekImportLimitation(changeSet)) && (
          <p
            role="note"
            className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
          >
            {text("compatibility")}
          </p>
        )}
      {status !== "applied" && changeSet.changes.some(isClaudeGlobalConfig) && (
        <p
          role="note"
          className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
        >
          {tr("changes.claudeGlobalConfigWarning")}
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(250px,.36fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <h2 className="shrink-0 border-b border-border px-4 py-3 text-sm font-medium">
            {text(status === "applied" ? "filesApplied" : "files")}
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="plan-files">
            {(["shared", "agents", "records"] as const).map((group) => {
              const files = changeSet.changes.filter((change) => changeGroup(change) === group);
              return (
                !!files.length && (
                  <div key={group} className="py-2">
                    <h3 className="px-4 pb-1 text-xs text-muted-foreground">{text(group)}</h3>
                    {files.map((change) => (
                      <Button
                        key={change.target}
                        variant="bare"
                        size="content"
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2 text-left",
                          change.target === selected?.target && "bg-muted",
                        )}
                        title={change.target}
                        aria-pressed={change.target === selected?.target}
                        onClick={() => setSelection({ plan: changeSet.id, target: change.target })}
                      >
                        <FileCode2 size={15} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm font-medium">
                            {planFilePath(changeSet.project_root, change.target) ||
                              fileName(change.target)}
                          </strong>
                          {planFilePath(changeSet.project_root, change.target) === undefined && (
                            <span className="block truncate text-xs font-normal text-muted-foreground">
                              {displayPath(change.target)}
                            </span>
                          )}
                        </span>
                        {risk(change)}
                      </Button>
                    ))}
                  </div>
                )
              );
            })}
          </div>
          <div className="shrink-0 border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onIncludeHome}
              aria-busy={blocked}
              disabled={blocked || homeIncluded || status === "applied" || status === "conflict"}
            >
              {text(homeIncluded ? "includedHome" : "includeHome")}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">{text("homeHint")}</p>
            {hasChanges && changeSet.requires_home_approval && (
              <Label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={homeApproved}
                  onCheckedChange={(value) => props.onHomeApprovalChange(value)}
                  disabled={blocked || status === "applied"}
                />
                {text("homeApproval")}
              </Label>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          {selected ? (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-medium" title={selected.target}>
                    {planFilePath(changeSet.project_root, selected.target) ||
                      fileName(selected.target)}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground" title={selected.target}>
                    {displayPath(selected.target)} · {tr(`status.scope.${selected.scope}`)}
                  </p>
                </div>
                {risk(selected)}
              </div>
              <div
                role="region"
                aria-label={
                  planFilePath(changeSet.project_root, selected.target) || fileName(selected.target)
                }
                className="min-h-0 flex-1 overflow-auto p-3 text-xs"
              >
                <WorkspaceChangeDiff
                  before={selected.before}
                  after={selected.after}
                  target={selected.target}
                />
              </div>
            </>
          ) : readyEmpty ? (
            <div className="grid flex-1 content-center justify-items-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <h3 className="font-medium text-foreground">{tr("changes.noFileChanges")}</h3>
              <p>{tr("changes.noFileChangesText")}</p>
            </div>
          ) : awaitingFiles ? (
            <LoaderCircle
              className="m-4 animate-spin text-muted-foreground"
              size={18}
              aria-hidden="true"
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">{text("empty")}</p>
          )}
        </div>
      </div>
      {props.error && (
        <p role="alert" className="shrink-0 text-sm text-destructive-text">
          {props.error}
        </p>
      )}
      <div
        data-testid="plan-actions"
        className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
      >
        {hasChanges && status !== "applied" && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={text("hashes")}
          >
            <ShieldCheck size={16} className="shrink-0" />
            <span>{text("backup")}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={props.onReject} disabled={blocked}>
            {readyEmpty || status === "applied" ? tr("common.back") : text("reject")}
          </Button>
          {!readyEmpty && status !== "applied" && (
            <Button
              onClick={() => {
                if (canApply) props.onApply();
              }}
              disabled={!canApply}
            >
              {text(applying ? "applying" : "apply", changeSet.changes.length)}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
