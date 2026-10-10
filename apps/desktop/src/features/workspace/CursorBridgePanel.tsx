import { useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "@/core/api";
import type { CursorBridgeStatus, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { withAsyncCleanup } from "@/lib/utils";

export function CursorBridgePanel({
  workspace,
  bindingId,
  disabled,
  onBindingChange,
  onStatusChange,
  fixedBinding = false,
}: {
  workspace: WorkspaceSummary;
  bindingId: string;
  disabled: boolean;
  onBindingChange(id: string): void;
  onStatusChange(status: CursorBridgeStatus | undefined): void;
  fixedBinding?: boolean;
}) {
  const { tr, localizeMessage } = useI18n();
  const [pending, setPending] = useState(false);
  const [actionError, setError] = useState<unknown>("");
  const [challengeState, setChallenge] = useState<{
    value: string;
    expires: number;
    before: string[];
    bindingId?: string;
  }>();
  const [seconds, setSeconds] = useState(0);
  const [bundleVersion, setBundleVersion] = useState("");
  const active = useRef(true);
  const pendingRef = useRef(false);
  const statusChange = useRef(onStatusChange);
  useEffect(() => {
    statusChange.current = onStatusChange;
  }, [onStatusChange]);
  const queryClient = useOptionalQueryClient();
  const observerId = useId();
  const statusQuery = useQuery(
    {
      ...queryDefaults,
      queryKey: ["cursor-bridge-status", workspace.id, observerId],
      queryFn: async ({ signal }) => {
        const next = await api.cursorBridge({ action: "status", workspaceId: workspace.id });
        if (!("bindings" in next)) throw new Error("Invalid Cursor bridge status");
        signal.throwIfAborted();
        return next;
      },
      enabled: !workspace.remote,
      staleTime: 0,
      gcTime: 0,
      refetchInterval: challengeState ? 2000 : false,
    },
    queryClient,
  );
  const status = workspace.remote ? undefined : statusQuery.data;
  const challenge =
    challengeState &&
    !status?.bindings.some(
      (binding) => binding.connected && !challengeState.before.includes(binding.id),
    )
      ? challengeState
      : undefined;
  const error = actionError || statusQuery.error || "";
  const refetch = statusQuery.refetch;
  const refresh = useCallback(async () => {
    if (!workspace.remote) await refetch({ throwOnError: true, cancelRefetch: false });
  }, [refetch, workspace.remote]);
  useEffect(() => {
    active.current = true;
    statusChange.current(undefined);
    return () => {
      active.current = false;
    };
  }, [workspace.id, workspace.remote]);
  useEffect(() => {
    statusChange.current(status);
    if (status)
      setChallenge((current) =>
        current &&
        status.bindings.some((binding) => binding.connected && !current.before.includes(binding.id))
          ? undefined
          : current,
      );
  }, [status]);
  useEffect(() => {
    if (!challenge) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((challenge.expires - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining) setChallenge(undefined);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  const act = async (action: () => Promise<void>) => {
    if (pendingRef.current || disabled || workspace.remote) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await action();
        } catch (reason) {
          if (active.current) setError(reason);
        }
      },
      () => {
        pendingRef.current = false;
        if (active.current) setPending(false);
      },
    );
  };
  const connect = (selectedId?: string) =>
    act(async () => {
      const next = await api.cursorBridge({
        action: "connect",
        workspaceId: workspace.id,
        ...(selectedId ? { bindingId: selectedId } : {}),
      });
      if (!active.current) return;
      if (!("challenge" in next)) throw new Error("Invalid Cursor bridge connection response");
      setChallenge({
        value: next.challenge,
        expires: Date.now() + Math.min(next.expires_in_seconds, 120) * 1000,
        before: status?.bindings.filter((b) => b.connected).map((b) => b.id) ?? [],
        bindingId: selectedId,
      });
    });
  const reveal = () =>
    act(async () => {
      const bundle = await api.cursorBridgeBundle();
      await api.revealCursorBridgeBundle();
      if (active.current) setBundleVersion(bundle.version);
    });
  const selected = status?.bindings.find((binding) => binding.id === bindingId);

  return (
    <div className="col-span-full grid gap-3 rounded-lg border border-border p-3 text-xs">
      <p className="m-0 text-muted-foreground">{tr("handoff.cursor.install")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || pending || !!workspace.remote}
          onClick={() => void reveal()}
        >
          {tr("handoff.cursor.revealBundle")}
        </Button>
        {!fixedBinding && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending || !status?.supported}
            onClick={() => void connect()}
          >
            {tr("handoff.cursor.connect")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || pending || !!workspace.remote}
          onClick={() => void act(refresh)}
        >
          {tr("handoff.cursor.refresh")}
        </Button>
      </div>
      {bundleVersion && (
        <span>{tr("handoff.cursor.bundleVerified", { version: bundleVersion })}</span>
      )}
      {status && !status.supported && (
        <p className="m-0 text-muted-foreground">{tr("handoff.cursor.platformUnavailable")}</p>
      )}
      {workspace.remote && (
        <p className="m-0 text-muted-foreground">{tr("handoff.cursor.localOnly")}</p>
      )}
      {challenge && (
        <div className="grid gap-2 rounded-md bg-muted/40 p-3">
          <span>{tr("handoff.cursor.challengeInstruction", { seconds })}</span>
          <Textarea
            readOnly
            aria-label={tr("handoff.cursor.challenge")}
            className="font-mono text-xs"
            value={challenge.value}
            spellCheck={false}
          />
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={disabled || pending}
            onClick={() =>
              void act(async () => {
                if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                await navigator.clipboard.writeText(challenge.value);
              })
            }
          >
            {tr("handoff.cursor.copyChallenge")}
          </Button>
        </div>
      )}
      <Label className="grid gap-1.5 text-xs text-muted-foreground">
        {tr("handoff.cursor.window")}
        <Select
          value={bindingId || null}
          disabled={disabled || pending || !status?.supported || fixedBinding}
          onValueChange={(value) => {
            if (value !== null) onBindingChange(String(value));
          }}
        >
          <SelectTrigger aria-label={tr("handoff.cursor.window")}>
            <SelectValue>
              {selected
                ? `${selected.profile} · ${selected.id.slice(0, 8)} · Cursor ${selected.version}`
                : tr("handoff.cursor.selectWindow")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{tr("handoff.cursor.window")}</SelectLabel>
              {status?.bindings.map((binding) => (
                <SelectItem key={binding.id} value={binding.id}>
                  {binding.profile} · {binding.id.slice(0, 8)} · Cursor {binding.version} ·{" "}
                  {tr(
                    binding.connected ? "handoff.cursor.connected" : "handoff.cursor.disconnected",
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Label>
      <span className="break-all text-muted-foreground">
        {tr("handoff.cursor.boundWorkspace", { path: workspace.path })}
      </span>
      {selected && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || pending}
            onClick={() => void connect(selected.id)}
          >
            {tr("handoff.cursor.reconnect")}
          </Button>
          {!fixedBinding && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() =>
                void act(async () => {
                  await api.cursorBridge({
                    action: "disconnect",
                    workspaceId: workspace.id,
                    bindingId: selected.id,
                  });
                  if (!active.current) return;
                  setChallenge((current) =>
                    current?.bindingId === selected.id ? undefined : current,
                  );
                  await refresh();
                })
              }
            >
              {tr("handoff.cursor.disconnect")}
            </Button>
          )}
        </div>
      )}
      {error !== "" && (
        <p role="alert" className="m-0 text-destructive">
          {localizeMessage(error)}
        </p>
      )}
    </div>
  );
}
