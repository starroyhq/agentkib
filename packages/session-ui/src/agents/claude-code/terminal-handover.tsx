import { useState } from "react";
import type { Live } from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import type { SessionSurface } from "../../session-surface-copy";
import { useSessionPlatform } from "../../session-platform";

const copy = {
  "zh-CN": {
    local: "在 AgentKib 中继续",
    force: "结束终端并接管",
    detail:
      "这会停掉当前轮次并结束当前 Claude Code 终端会话。AgentKib 会继续同一条会话，Claude 可以再次发出需要你处理的请求。",
    webDetail:
      "这会停掉当前轮次并结束电脑上正在运行的 Claude Code 终端会话，随后由 AgentKib 接管同一条会话，你可以直接在这里继续处理。",
    close: "取消",
  },
  "zh-Hant": {
    local: "在 AgentKib 中繼續",
    force: "結束終端並接管",
    detail:
      "這會停止目前輪次並結束目前的 Claude Code 終端會話。AgentKib 會繼續同一個會話，Claude 可以再次發出需要你處理的要求。",
    webDetail:
      "這會停止目前輪次並結束電腦上執行中的 Claude Code 終端會話，隨後由 AgentKib 接管同一個會話，你可以直接在這裡繼續處理。",
    close: "取消",
  },
  "en-US": {
    local: "Continue in AgentKib",
    force: "End terminal session and take over",
    detail:
      "This stops the current turn and ends the current Claude Code terminal session. AgentKib continues the same session, where Claude can ask again.",
    webDetail:
      "This stops the current turn and ends the active Claude Code terminal session on the computer, then continues the same session here so you can respond directly.",
    close: "Cancel",
  },
  "ja-JP": {
    local: "AgentKib で続ける",
    force: "ターミナルを終了して引き継ぐ",
    detail:
      "現在のターンを停止し、現在の Claude Code ターミナルセッションを終了します。AgentKib で同じセッションが続き、Claude が必要な質問や承認を再度表示できます。",
    webDetail:
      "現在のターンを停止し、コンピューター上の Claude Code ターミナルセッションを終了します。その後ここで同じセッションを引き継ぎ、そのまま対応できます。",
    close: "キャンセル",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

export function ClaudeTerminalHandover({
  locale,
  surface,
  size,
  live,
  ready,
  localAvailable,
  forceAvailable,
  onAdopt,
  onTransfer,
}: {
  locale: InteractionLocale;
  surface?: SessionSurface;
  size?: "sm" | "default";
  live?: Live;
  ready: boolean;
  localAvailable: boolean;
  forceAvailable: boolean;
  unavailableReason?: string;
  onAdopt: () => unknown;
  onTransfer: (turnId: string | undefined) => unknown;
}) {
  const { kind, components } = useSessionPlatform();
  const { Button, SessionDialog } = components;
  const [confirm, setConfirm] = useState<string>();
  const state = live?.terminalHandover;
  const t = copy[locale];
  const effectiveSurface = surface ?? kind;
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
        size={size}
        className="shrink-0"
        disabled={!ready || !available}
        onClick={() => {
          if (force) setConfirm(authority);
          else void onAdopt();
        }}
      >
        {force ? t.force : t.local}
      </Button>
      {force && confirm === authority && (
        <SessionDialog title={t.force} closeLabel={t.close} onClose={() => setConfirm(undefined)}>
          <p className="text-sm text-muted-foreground">
            {effectiveSurface === "web" ? t.webDetail : t.detail}
          </p>
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
