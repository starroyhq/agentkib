import {
  ApiError,
  type Access,
  type SessionCapabilities,
  type WebClient,
} from "@agentkib/web-client";
import { useEffect, useRef, useState } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { claudeConnectionCopy } from "./connection-copy";

const recoveryCopy = {
  "zh-CN": {
    refresh: "刷新状态",
    notVerified: "暂未核对",
    owner: "Claude Code 仍在运行",
    exitOwner: "退出 Claude Code 后再核对",
    ownerUnconfirmed: "无法核实 Claude Code 进程状态",
    pending: "仍有操作待核对",
    busy: "会话正忙",
    cleanup: "进程退出未确认，仅供查看",
    stopped: "会话已停止，仅供查看",
  },
  "zh-Hant": {
    refresh: "重新整理狀態",
    notVerified: "暫未核對",
    owner: "Claude Code 仍在執行",
    exitOwner: "結束 Claude Code 後再核對",
    ownerUnconfirmed: "無法確認 Claude Code 程序狀態",
    pending: "仍有操作待核對",
    busy: "對話忙碌中",
    cleanup: "程序尚未確認結束，僅供查看",
    stopped: "對話已停止，僅供查看",
  },
  "en-US": {
    refresh: "Refresh status",
    notVerified: "Unable to verify yet",
    owner: "Claude Code is still running",
    exitOwner: "Quit Claude Code, then verify again",
    ownerUnconfirmed: "Claude Code process state could not be verified",
    pending: "An operation still needs verification",
    busy: "Session is busy",
    cleanup: "Process exit unconfirmed. Read-only",
    stopped: "Session stopped. Read-only",
  },
  "ja-JP": {
    refresh: "状態を更新",
    notVerified: "まだ確認できません",
    owner: "Claude Code は実行中です",
    exitOwner: "Claude Code を終了してから再確認",
    ownerUnconfirmed: "Claude Code のプロセス状態を確認できません",
    pending: "未確認の操作があります",
    busy: "セッションは処理中です",
    cleanup: "プロセスの終了は未確認です。閲覧のみ",
    stopped: "セッションは停止しました。閲覧のみ",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

function unavailableStatus(
  reason: string | undefined,
  copy: (typeof recoveryCopy)[InteractionLocale],
) {
  switch (reason) {
    case "claude-owner-check-unavailable":
      return copy.cleanup;
    case "claude-background-task":
    case "claude-unrequested-turn":
    case "claude-protocol-violation":
      return copy.stopped;
    default:
      return undefined;
  }
}

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
    kind,
    components: { Button },
  } = useSessionPlatform();
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string>();
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!visible) return null;
  const canRefresh = access.status === "approved";
  const feature =
    capabilities?.sessionId === sessionId && capabilities.executionMode === "claude-managed"
      ? capabilities.features.reconcile
      : undefined;
  const canReconcile =
    canRefresh &&
    access.protocolVersion === 2 &&
    access.experimentalEnabled &&
    access.device?.manage &&
    feature?.available === true;
  const copy = claudeConnectionCopy[locale];
  const recovery = recoveryCopy[locale];
  const disabledReason =
    feature?.available === false ? unavailableStatus(feature.reason, recovery) : undefined;
  const status = disabledReason ?? refusalStatus(failure) ?? copy.managedUnconfirmed;

  function refusalStatus(reason: string | undefined) {
    switch (reason) {
      case undefined:
        return undefined;
      case "claude-owner-busy":
      case "claude-background-session-running":
        return kind === "desktop" ? recovery.exitOwner : recovery.owner;
      case "session-busy":
        return recovery.busy;
      case "control-outcome-unconfirmed":
        return recovery.pending;
      case "claude-owner-check-unavailable":
        return recovery.ownerUnconfirmed;
      default:
        return recovery.notVerified;
    }
  }

  async function recover() {
    if (!canRefresh || pending.current || (canReconcile && busy)) return;
    pending.current = true;
    setChecking(true);
    let refusal: string | undefined;
    try {
      if (canReconcile) {
        const result = await client.managedAction("reconcile", {
          agent: "claude-code",
          bootId: access.bootId,
          sessionId,
          requestId: crypto.randomUUID(),
        });
        if (result.reconciled !== true) refusal = result.reason ?? "unavailable";
      }
    } catch (error) {
      refusal = error instanceof ApiError ? (error.reason ?? error.code) : "unavailable";
    }
    try {
      // A lost reply can still have settled the fence. Only the refreshed state decides.
      if (mounted.current) await refresh();
    } catch {
      refusal ??= "unavailable";
    } finally {
      pending.current = false;
      if (mounted.current) {
        setFailure(refusal);
        setChecking(false);
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-3 text-xs text-muted-foreground">
      <span role="status">{status}</span>
      {canRefresh && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={checking || (canReconcile && busy)}
          onClick={() => void recover()}
        >
          {canReconcile ? copy.reconcileOutcome : recovery.refresh}
        </Button>
      )}
    </div>
  );
}
