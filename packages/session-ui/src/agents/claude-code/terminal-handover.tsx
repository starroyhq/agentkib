import { useState } from "react";
import type { Live } from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";

const copy = {
  "zh-CN": {
    local: "在 AgentKib 中继续",
    force: "结束终端并接管",
    detail:
      "这会停掉当前轮次并结束电脑上的 Claude Code 终端会话。AgentKib 会继续同一条会话，Claude 可以再次发出需要你处理的请求。",
    busy: "终端会话仍在运行。",
    close: "取消",
  },
  "zh-Hant": {
    local: "在 AgentKib 中繼續",
    force: "結束終端並接管",
    detail:
      "這會停止目前輪次並結束電腦上的 Claude Code 終端會話。AgentKib 會繼續同一個會話，Claude 可以再次發出需要你處理的要求。",
    busy: "終端會話仍在執行。",
    close: "取消",
  },
  "en-US": {
    local: "Continue in AgentKib",
    force: "End terminal session and take over",
    detail:
      "This stops the current turn and ends the Claude Code terminal session on your computer. AgentKib continues the same session, where Claude can ask again.",
    busy: "The terminal session is still running.",
    close: "Cancel",
  },
  "ja-JP": {
    local: "AgentKib で続ける",
    force: "ターミナルを終了して引き継ぐ",
    detail:
      "現在のターンを停止し、コンピューター上の Claude Code ターミナルセッションを終了します。AgentKib で同じセッションが続き、Claude が必要な質問や承認を再度表示できます。",
    busy: "ターミナルセッションは実行中です。",
    close: "キャンセル",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

export function ClaudeTerminalHandover({
  locale,
  live,
  ready,
  localAvailable,
  forceAvailable,
  unavailableReason,
  onAdopt,
  onTransfer,
}: {
  locale: InteractionLocale;
  live?: Live;
  ready: boolean;
  localAvailable: boolean;
  forceAvailable: boolean;
  unavailableReason?: string;
  onAdopt: () => unknown;
  onTransfer: (turnId: string | undefined) => unknown;
}) {
  const { components } = useSessionPlatform();
  const { Button, SessionDialog } = components;
  const [confirm, setConfirm] = useState<string>();
  const state = live?.terminalHandover;
  const t = copy[locale];
  if (!live || !state) return null;
  const force = !state.available && live.executionMode === "claude-follower";
  const available = force
    ? forceAvailable && state.remoteAvailable === true
    : localAvailable && state.available;
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
        className="disabled:pointer-events-auto"
        disabled={!ready || !available}
        title={available ? undefined : (unavailableReason ?? (force ? t.busy : undefined))}
        onClick={() => {
          if (force) setConfirm(authority);
          else void onAdopt();
        }}
      >
        {force ? t.force : t.local}
      </Button>
      {force && confirm === authority && (
        <SessionDialog title={t.force} closeLabel={t.close} onClose={() => setConfirm(undefined)}>
          <p className="text-sm text-muted-foreground">{t.detail}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirm(undefined)}>
              {t.close}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!ready || !available}
              onClick={() => {
                setConfirm(undefined);
                void onTransfer(live.turnId ?? undefined);
              }}
            >
              {t.force}
            </Button>
          </div>
        </SessionDialog>
      )}
    </>
  );
}
