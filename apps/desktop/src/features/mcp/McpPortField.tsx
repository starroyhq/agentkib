import { useEffect, useId, useRef, useState } from "react";
import { DelayedSpinner } from "@agentkib/session-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/core/useI18n";

function parsePort(value: string): number | undefined {
  const port = Number(value);
  return value.trim() && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export function McpPortField({
  port,
  disabled = false,
  onCommit,
}: {
  port: number;
  disabled?: boolean;
  onCommit: (port: number) => Promise<number | undefined>;
}) {
  const { tr } = useI18n();
  const id = useId();
  const pending = useRef(false);
  const alive = useRef(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    sourcePort: port,
    confirmedPort: port,
    value: String(port),
    attempted: false,
    unconfirmed: false,
  });
  if (draft.sourcePort !== port) {
    const acknowledged =
      draft.value === String(draft.confirmedPort) || parsePort(draft.value) === port;
    setDraft({
      ...draft,
      sourcePort: port,
      confirmedPort: port,
      value: acknowledged ? String(port) : draft.value,
      attempted: acknowledged ? false : draft.attempted,
      unconfirmed: acknowledged ? false : draft.unconfirmed,
    });
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invalid = draft.attempted && parsePort(draft.value) === undefined;
  const commit = async () => {
    if (pending.current || disabled) return;
    const nextPort = parsePort(draft.value);
    setDraft((current) => ({ ...current, attempted: true }));
    if (nextPort === undefined) return;
    if (nextPort === draft.confirmedPort) {
      setDraft((current) => ({
        ...current,
        value: String(nextPort),
        attempted: false,
        unconfirmed: false,
      }));
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      const confirmedPort = await onCommit(nextPort);
      if (!alive.current) return;
      setDraft((current) => ({
        ...current,
        confirmedPort: confirmedPort ?? current.confirmedPort,
        value: confirmedPort === nextPort ? String(nextPort) : current.value,
        attempted: false,
        unconfirmed: confirmedPort !== nextPort,
      }));
    } catch {
      // The host reports the cause; an interrupted request may still have changed the port.
      if (alive.current) setDraft((current) => ({ ...current, unconfirmed: true }));
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="grid gap-2" aria-busy={saving}>
      <Label htmlFor={id} className="flex items-center gap-2">
        {tr("mcp.port")}
        <span aria-hidden className="size-3.5">
          <DelayedSpinner active={saving} />
        </span>
      </Label>
      <Input
        id={id}
        className="w-32"
        type="number"
        min="1"
        max="65535"
        step="1"
        value={draft.value}
        disabled={disabled || saving}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint ${id}-current${invalid ? ` ${id}-error` : ""}${draft.unconfirmed ? ` ${id}-unconfirmed` : ""}`}
        onChange={(event) =>
          setDraft((current) => ({ ...current, value: event.target.value, unconfirmed: false }))
        }
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft((current) => ({
              ...current,
              value: String(current.confirmedPort),
              attempted: false,
              unconfirmed: false,
            }));
          }
        }}
      />
      <p id={`${id}-hint`} className="max-w-64 text-xs text-muted-foreground">
        {tr("mcp.portHint")}
      </p>
      <p id={`${id}-current`} className="text-xs text-muted-foreground">
        {tr("mcp.portCurrent", { port: draft.confirmedPort })}
      </p>
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive-text">
          {tr("mcp.portInvalid")}
        </p>
      )}
      {draft.unconfirmed && (
        <p id={`${id}-unconfirmed`} className="max-w-64 text-xs text-destructive-text">
          {tr("mcp.portUnconfirmed")}
        </p>
      )}
    </div>
  );
}
