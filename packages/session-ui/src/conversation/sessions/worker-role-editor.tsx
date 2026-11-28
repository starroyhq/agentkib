import type { WorkerRole, WorkerRoleInput } from "@agentkib/web-client";
import { useState, type ReactNode } from "react";
import type { ProjectAgentCopy } from "../../project-agent-copy";
import { useSessionPlatform } from "../../session-platform";
import {
  sanitizeSingleLineRoleLabel,
  validateWorkerRoleDraft,
  WORKER_ROLE_LIMITS,
  workerRolePresets,
} from "../../worker-role-presets";
import { OperationGroup, OperationRow } from "./operation-layout";

export function WorkerRoleEditor({
  locale,
  copy,
  workerName,
  currentRole,
  editable,
  busy,
  touchTarget,
  errorNotice,
  onSave,
  onClear,
  onCancel,
}: {
  locale: string;
  copy: ProjectAgentCopy;
  workerName: string;
  currentRole?: WorkerRole;
  editable: boolean;
  busy: boolean;
  touchTarget?: string;
  errorNotice?: ReactNode;
  onSave: (role: WorkerRoleInput) => Promise<boolean>;
  onClear: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const { Button, Input, Textarea } = useSessionPlatform().components;
  const presets = workerRolePresets(locale);
  const [label, setLabel] = useState(currentRole?.label ?? "");
  const [description, setDescription] = useState(currentRole?.description ?? "");
  const trimmedLabelLen = sanitizeSingleLineRoleLabel(label).trim().length;
  const trimmedDescLen = description.trim().length;
  const validation = validateWorkerRoleDraft(label, description);
  const canSubmit = editable && !busy && validation.valid;
  const canClear = editable && !busy && !!currentRole;

  const textareaProps = {
    rows: 4,
    maxLength: WORKER_ROLE_LIMITS.descriptionMax,
    value: description,
    disabled: !editable || busy,
    placeholder: copy.roleDescriptionPlaceholder,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value),
  };

  return (
    <OperationGroup title={copy.roleEditTitle(workerName)}>
      <OperationRow className="block">
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">{copy.rolePresetsLabel}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={copy.rolePresetsLabel}>
            {presets.map((preset) => {
              const active =
                sanitizeSingleLineRoleLabel(label).trim() === preset.label &&
                description.trim() === preset.description;
              return (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  className={touchTarget}
                  disabled={!editable || busy}
                  aria-pressed={active}
                  onClick={() => {
                    setLabel(preset.label);
                    setDescription(preset.description);
                  }}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
        </div>
      </OperationRow>
      <OperationRow className="block">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{copy.roleLabelField}</span>
            <span className="tabular-nums">
              {trimmedLabelLen}/{WORKER_ROLE_LIMITS.labelMax}
            </span>
          </span>
          <Input
            type="text"
            maxLength={WORKER_ROLE_LIMITS.labelMax}
            value={label}
            disabled={!editable || busy}
            placeholder={copy.roleLabelPlaceholder}
            onChange={(event) => setLabel(sanitizeSingleLineRoleLabel(event.target.value))}
          />
        </label>
      </OperationRow>
      <OperationRow className="block">
        <label className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{copy.roleDescriptionField}</span>
            <span className="tabular-nums">
              {trimmedDescLen}/{WORKER_ROLE_LIMITS.descriptionMax}
            </span>
          </span>
          {Textarea ? (
            <Textarea {...textareaProps} className="min-h-24 resize-y text-sm" />
          ) : (
            <textarea
              {...textareaProps}
              className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          )}
        </label>
      </OperationRow>
      <OperationRow className="flex-wrap justify-end gap-2">
        {errorNotice && <div className="mr-auto min-w-0">{errorNotice}</div>}
        {currentRole && (
          <Button
            type="button"
            variant="ghost"
            className={
              touchTarget ? `${touchTarget} text-muted-foreground` : "text-muted-foreground"
            }
            disabled={!canClear}
            onClick={() => {
              if (!canClear) return;
              void onClear().then((done) => done && onCancel());
            }}
          >
            {copy.roleClear}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className={touchTarget}
          disabled={busy}
          onClick={onCancel}
        >
          {copy.cancel}
        </Button>
        <Button
          type="button"
          className={touchTarget}
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit || !validation.valid) return;
            void onSave(validation.input).then((done) => done && onCancel());
          }}
        >
          {copy.save}
        </Button>
      </OperationRow>
    </OperationGroup>
  );
}
