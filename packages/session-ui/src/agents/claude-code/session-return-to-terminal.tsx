import {
  ApiError,
  settledReceipt,
  type Access,
  type Live,
  type ManagedActionResult,
  type SessionCapabilities,
  type WebClient,
} from "@agentkib/web-client";
import { useEffect, useRef, useState } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";

const copy = {
  "zh-CN": {
    release: "交回终端",
    released: "已交回终端",
    unknown: "交回结果未确认",
    check: "核对交回结果",
    failed: "暂时无法交回终端",
  },
  "zh-Hant": {
    release: "交還終端",
    released: "已交還終端",
    unknown: "交還結果未確認",
    check: "核對交還結果",
    failed: "暫時無法交還終端",
  },
  "en-US": {
    release: "Return to terminal",
    released: "Returned to terminal",
    unknown: "Return to terminal unconfirmed",
    check: "Check return status",
    failed: "Could not return to terminal",
  },
  "ja-JP": {
    release: "ターミナルに戻す",
    released: "ターミナルに戻しました",
    unknown: "ターミナルに戻したか未確認",
    check: "引き渡し結果を確認",
    failed: "ターミナルに戻せませんでした",
  },
};

type PendingRelease = {
  sessionId: string;
  requestId: string;
  runtimeBootId?: string;
  expectedRevision: number;
  kind: "release";
};

function completed(result: ManagedActionResult | null | undefined, entry: PendingRelease) {
  return (
    result?.accepted === true &&
    result.completed === true &&
    result.requestId === entry.requestId &&
    result.sessionId === entry.sessionId
  );
}

export function ClaudeReturnToTerminal({
  access,
  capabilities,
  live,
  client,
  locale,
  busy,
  explainReason,
  refresh,
}: {
  access: Access;
  capabilities?: SessionCapabilities;
  live: Live;
  client: WebClient;
  locale: InteractionLocale;
  busy: boolean;
  explainReason: (reason: string) => string;
  refresh: () => Promise<void>;
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<PendingRelease>();
  const [failure, setFailure] = useState<string>();
  const [finished, setFinished] = useState(false);
  const active = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const canManage =
    access.status === "approved" &&
    access.protocolVersion === 2 &&
    access.experimentalEnabled === true &&
    access.device?.manage === true;
  const feature =
    capabilities?.returnToTerminal === true &&
    capabilities.sessionId === live.sessionId &&
    capabilities.executionMode === "claude-managed"
      ? capabilities.features.release
      : undefined;
  const canRelease =
    feature?.available === true &&
    live.status === "idle" &&
    Number.isSafeInteger(live.revision) &&
    live.revision >= 0;
  const words = copy[locale];
  if (!canManage || live.status === "released" || (!feature && !pending && !finished)) return null;

  const fail = (reason?: string) => setFailure(reason ? explainReason(reason) : words.failed);

  async function run() {
    if (active.current || finished || busy || (!pending && !canRelease)) return;
    active.current = true;
    setWorking(true);
    setFailure(undefined);
    let settled = false;
    try {
      if (pending) {
        // Only read the old request's receipt. An unknown outcome never resubmits the release.
        const receipt = await client.receipt(pending.requestId);
        if (!mounted.current || !receipt.found) return;
        if (
          receipt.recovery !== "legacy-prepared" &&
          (receipt.executionMode !== "claude-managed" ||
            receipt.expectedRevision !== pending.expectedRevision ||
            (pending.runtimeBootId !== undefined &&
              receipt.runtimeBootId !== pending.runtimeBootId))
        )
          return;
        const proof = settledReceipt(receipt, pending);
        if (proof === "accepted" && completed(receipt.ack, pending)) {
          setFinished(true);
          setPending(undefined);
        } else if (proof === "not-dispatched") {
          setPending(undefined);
          fail(
            receipt.recovery === "legacy-prepared"
              ? undefined
              : (receipt.ack?.reason ?? receipt.ack?.error),
          );
        }
        settled = true;
      } else {
        const entry: PendingRelease = {
          sessionId: live.sessionId,
          requestId: crypto.randomUUID(),
          expectedRevision: live.revision,
          runtimeBootId: live.runtimeBootId,
          kind: "release",
        };
        try {
          const result = await client.managedAction("release", {
            sessionId: entry.sessionId,
            requestId: entry.requestId,
            expectedRevision: entry.expectedRevision,
            agent: "claude-code",
            bootId: access.bootId,
          });
          if (!mounted.current) return;
          if (result.controlOutcome === "accepted" && completed(result, entry)) setFinished(true);
          else setPending(entry);
        } catch (error) {
          if (!mounted.current) return;
          if (error instanceof ApiError && error.controlOutcome === "not-dispatched")
            fail(error.reason ?? error.code);
          else setPending(entry);
        }
        settled = true;
      }
    } catch {
      // The original result is still unknown. Keep the read-only receipt action available.
    } finally {
      if (settled && mounted.current) await refresh().catch(() => undefined);
      active.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-end gap-2 px-3 text-xs text-muted-foreground">
      {(finished || pending || failure) && (
        <span role="status">{finished ? words.released : pending ? words.unknown : failure}</span>
      )}
      {!finished && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={working || busy || (!pending && !canRelease)}
          title={
            feature?.available === false && feature.reason
              ? explainReason(feature.reason)
              : undefined
          }
          onClick={() => void run()}
        >
          {pending ? words.check : words.release}
        </Button>
      )}
    </div>
  );
}
