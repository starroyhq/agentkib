import type { Access, SessionCapabilities, WebClient } from "@agentkib/web-client";
import { useEffect, useRef, useState } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { claudeConnectionCopy } from "./connection-copy";

export function ClaudeSessionReconcile({
  visible,
  sessionId,
  access,
  capabilities,
  client,
  busy,
  locale,
  refresh,
}: {
  visible: boolean;
  sessionId: string;
  access: Access;
  capabilities?: SessionCapabilities;
  client: WebClient;
  busy: boolean;
  locale: InteractionLocale;
  refresh: () => Promise<void>;
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!visible) return null;
  const canReconcile =
    access.status === "approved" &&
    access.protocolVersion === 2 &&
    access.experimentalEnabled &&
    access.device?.manage &&
    capabilities?.sessionId === sessionId &&
    capabilities.executionMode === "claude-managed" &&
    capabilities.features.reconcile?.available === true;
  const copy = claudeConnectionCopy[locale];

  async function reconcile() {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    try {
      await client.managedAction("reconcile", {
        agent: "claude-code",
        bootId: access.bootId,
        sessionId,
        requestId: crypto.randomUUID(),
      });
    } catch {
      // A lost reply can still have settled the fence. Only the refreshed state decides.
    } finally {
      try {
        if (mounted.current) await refresh();
      } finally {
        pending.current = false;
        if (mounted.current) setChecking(false);
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-3 text-xs text-muted-foreground">
      <span role="status">{copy.managedUnconfirmed}</span>
      {canReconcile && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || checking}
          onClick={() => void reconcile()}
        >
          {copy.reconcileOutcome}
        </Button>
      )}
    </div>
  );
}
