import { useMutation, useQuery } from "@tanstack/react-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/core/api";
import type { NativeImportOperation, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { sessionHandoffTargets } from "./session-handoff-targets";
import { CursorBridgePanel } from "./CursorBridgePanel";

/** Persisted operations make an interrupted import recoverable after app restart. */
export function NativeImportRecoveryPanel({
  workspaceId,
  readableSourceIds = [],
  onReview,
  onOpenSession,
  workspace,
}: {
  workspaceId: string;
  readableSourceIds?: string[];
  onReview?: (operation: NativeImportOperation) => void;
  onOpenSession?: (sessionId: string) => void;
  workspace?: WorkspaceSummary;
}) {
  const { tr, localizeMessage } = useI18n();
  const queryClient = useOptionalQueryClient();
  const queryKey = ["native-import-operations", workspaceId];
  const operationsQuery = useQuery(
    {
      ...queryDefaults,
      queryKey,
      queryFn: () => api.nativeImportOperations(workspaceId),
      staleTime: 0,
    },
    queryClient,
  );
  const [connectionOperationId, setConnectionOperationId] = useState<string>();
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [workspaceId],
  );
  const recovery = useMutation(
    {
      mutationFn: ({
        request,
      }: {
        operation: NativeImportOperation;
        workspaceId: string;
        request: ReturnType<typeof api.launchSessionHandoff>;
      }) => request,
      onSuccess: (_result, variables) =>
        queryClient.invalidateQueries({
          queryKey: ["native-import-operations", variables.workspaceId],
        }),
    },
    queryClient,
  );
  const busyId = recovery.isPending
    ? recovery.variables?.operation.launch_request.operation_id
    : undefined;
  const rawError =
    recovery.variables?.workspaceId === workspaceId && recovery.error
      ? recovery.error
      : operationsQuery.error;
  const error = rawError ? localizeMessage(rawError) : "";
  const recover = async (operation: NativeImportOperation) => {
    if (locked.current) return;
    locked.current = true;
    const startedIn = generation.current;
    try {
      const request = api.launchSessionHandoff(operation.launch_request);
      const receipt = await recovery.mutateAsync({ operation, workspaceId, request });
      if (receipt?.session_id && generation.current === startedIn)
        onOpenSession?.(receipt.session_id);
    } catch {
      /* Display mutation.error. */
    } finally {
      locked.current = false;
    }
  };
  const operations = (operationsQuery.data ?? []).filter((item) => item.status !== "launched");
  if (!operations.length && !error) return null;
  const connectionOperation = operations.find(
    (operation) =>
      operation.launch_request.operation_id === connectionOperationId &&
      operation.binding_id &&
      operation.launch_request.target_agent === "cursor",
  );
  return (
    <section
      className="m-5 grid gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
      aria-label={tr("handoff.recovery.title")}
    >
      <strong>{tr("handoff.recovery.title")}</strong>
      <p className="text-xs text-muted-foreground">{tr("handoff.recovery.detail")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      {operations.map((operation) => (
        <div
          key={operation.launch_request.operation_id}
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <div>
            <span>
              {sessionHandoffTargets.find(
                ([agent]) => agent === operation.launch_request.target_agent,
              )?.[1] ?? operation.launch_request.target_agent}
            </span>
            <span className="ml-2 text-xs text-muted-foreground">
              {tr(`handoff.recovery.${operation.status}`)}
            </span>
            {operation.target_session_id && (
              <code className="block text-xs">{operation.target_session_id}</code>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {workspace?.id === workspaceId &&
              operation.binding_id &&
              operation.launch_request.target_agent === "cursor" && (
                <Button
                  variant="outline"
                  disabled={busyId !== undefined}
                  onClick={() => setConnectionOperationId(operation.launch_request.operation_id)}
                >
                  {tr("handoff.cursor.reconnect")}
                </Button>
              )}
            <Button
              variant="outline"
              disabled={
                busyId !== undefined ||
                (operation.status === "prepared" &&
                  (!onReview || !readableSourceIds.includes(operation.source_session_id)))
              }
              title={
                operation.status === "prepared" &&
                !readableSourceIds.includes(operation.source_session_id)
                  ? tr("handoff.recovery.sourceUnavailable")
                  : undefined
              }
              onClick={() =>
                operation.status === "prepared" ? onReview?.(operation) : void recover(operation)
              }
            >
              {tr(
                busyId === operation.launch_request.operation_id
                  ? "common.loading"
                  : operation.status === "prepared"
                    ? "handoff.recovery.review"
                    : operation.status === "verified"
                      ? "handoff.recovery.open"
                      : "handoff.recovery.check",
              )}
            </Button>
          </div>
        </div>
      ))}
      {workspace?.id === workspaceId && connectionOperation?.binding_id && (
        <CursorBridgePanel
          key={`${workspaceId}:${connectionOperation.launch_request.operation_id}`}
          workspace={workspace}
          bindingId={connectionOperation.binding_id}
          fixedBinding
          disabled={busyId !== undefined}
          onBindingChange={() => {}}
          onStatusChange={() => {}}
        />
      )}
      {!operations.length && error && (
        <Button variant="outline" onClick={() => void operationsQuery.refetch()}>
          {tr("handoff.recovery.reload")}
        </Button>
      )}
    </section>
  );
}
