import { useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { DelayedSpinner } from "@agentkib/session-ui";
import { Button } from "@agentkib/ui/button";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { withAsyncCleanup } from "@/lib/utils";

// The parent keys this component by scope and configuration so a probe cannot
// show tools from a previous workspace or an overwritten server.
export function McpRuntimeProbe({
  serverId,
  project,
  onProbed,
}: {
  serverId: string;
  project?: string;
  onProbed: () => Promise<void>;
}) {
  const { tr, localizeMessage } = useI18n();
  const active = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<string[]>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const probe = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setTools(undefined);
    setError(undefined);
    await withAsyncCleanup(
      async () => {
        try {
          const result = await api.probeMcpRuntime(serverId, project);
          if (!active.current) return;
          setTools(result.map((tool) => tool.name));
          await onProbed();
        } catch (reason) {
          if (active.current) setError(reason);
        }
      },
      () => {
        pending.current = false;
        if (active.current) setBusy(false);
      },
    );
  };
  return (
    <div className="grid gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void probe()}>
        <span aria-hidden className="size-3.5">
          <DelayedSpinner active={busy} />
        </span>
        {tr("mcp.probe")}
      </Button>
      {tools && (
        <div role="status" className="grid gap-1 text-xs">
          <strong>{tr("mcp.probeResult", { count: tools.length })}</strong>
          <ul className="grid gap-1">
            {tools.map((tool) => (
              <li key={tool}>
                <code className="break-all">{tool}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="flex items-start gap-1 text-xs text-destructive-text">
          <CircleAlert size={13} className="shrink-0" />
          {localizeMessage(error)}
        </p>
      )}
    </div>
  );
}
