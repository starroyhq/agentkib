import { useState } from "react";
import type { Live } from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";

const copy = {
  "zh-CN": {
    local: "在 AgentKib 中继续",
    remote: "转到 AgentKib 继续",
    detail:
      "这会停掉当前轮次并结束电脑上的 Claude Code 终端会话。AgentKib 会继续同一条会话，Claude 可以再次发出需要你处理的请求。",
    busy: "终端会话仍在运行。",
    close: "取消",
  },
  "zh-Hant": {
    local: "在 AgentKib 中繼續",
    remote: "轉到 AgentKib 繼續",
    detail:
      "這會停止目前輪次並結束電腦上的 Claude Code 終端會話。AgentKib 會繼續同一個會話，Claude 可以再次發出需要你處理的要求。",
    busy: "終端會話仍在執行。",
    close: "取消",
  },
  "en-US": {
    local: "Continue in AgentKib",
    remote: "Move to AgentKib",
    detail:
      "This stops the current turn and ends the Claude Code terminal session on your computer. AgentKib continues the same session, where Claude can ask again.",
    busy: "The terminal session is still running.",
    close: "Cancel",
  },
  "ja-JP": {
    local: "AgentKib で続ける",
    remote: "AgentKib に移して続ける",
    detail:
      "現在のターンを停止し、コンピューター上の Claude Code ターミナルセッションを終了します。AgentKib で同じセッションが続き、Claude が必要な質問や承認を再度表示できます。",
    busy: "ターミナルセッションは実行中です。",
    close: "キャンセル",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

export function ClaudeTerminalHandover({
  locale,
  live,
  local,
  ready,
  localAvailable,
  remoteAvailable,
  onAdopt,
  onTransfer,
}: {
  locale: InteractionLocale;
  live?: Live;
  local: boolean;
  ready: boolean;
  localAvailable: boolean;
  remoteAvailable: boolean;
  onAdopt: () => unknown;
  onTransfer: (turnId: string | undefined) => unknown;
}) {
  const { components } = useSessionPlatform();
  const { Button, SessionDialog } = components;
  const [confirm, setConfirm] = useState<string>();
  const state = live?.terminalHandover;
  const t = copy[locale];
  if (!live || !state) return null;
  if (local)
    return (
      <Button
        type="button"
        variant="outline"
        disabled={!ready || !localAvailable || !state.available}
        title={!state.available && state.reason === "claude-owner-busy" ? t.busy : undefined}
        onClick={onAdopt}
      >
        {t.local}
      </Button>
    );
  if (
    !remoteAvailable ||
    state.remoteAvailable !== true ||
    live.executionMode !== "claude-follower"
  )
    return null;
  // A confirmation belongs to the exact terminal connection and turn the person saw.
  const authority = JSON.stringify([
    live.sessionId,
    live.runtimeBootId,
    live.connectionGeneration,
    live.turnId,
    live.revision,
  ]);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!ready}
        onClick={() => setConfirm(authority)}
      >
        {t.remote}
      </Button>
      {confirm === authority && (
        <SessionDialog title={t.remote} closeLabel={t.close} onClose={() => setConfirm(undefined)}>
          <p className="text-sm text-muted-foreground">{t.detail}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirm(undefined)}>
              {t.close}
            </Button>
            <Button
              type="button"
              disabled={!ready}
              onClick={() => {
                setConfirm(undefined);
                void onTransfer(live.turnId ?? undefined);
              }}
            >
              {t.remote}
            </Button>
          </div>
        </SessionDialog>
      )}
    </>
  );
}
