import type { InteractionLocale } from "./interaction-model";

/**
 * Why a Devin turn did not run, explained under the composer: Devin CLI's own refusals, which
 * AgentKib does not work around.
 */
export const DEVIN_TURN_REASONS: readonly string[] = [
  "devin-login-required",
  "devin-workspace-untrusted",
  "devin-cli-unavailable",
  "devin-run-failed",
  "devin-session-not-found",
  "session-open-elsewhere",
  "attachments-unsupported",
];

/** The reasons the person resolves in Devin CLI itself, which the desktop opens in a terminal. */
export function devinTerminalAction(reason?: string | null): "login" | "trust" | undefined {
  if (reason === "devin-login-required") return "login";
  if (reason === "devin-workspace-untrusted") return "trust";
  return undefined;
}

const copy = {
  "zh-CN": {
    login: "在终端登录 Devin CLI",
    trust: "在终端信任这个工作区",
    opened: "已在 {terminal} 中打开，完成后回到这里再发送。",
    failed: "没能打开终端。",
  },
  "zh-Hant": {
    login: "在終端機登入 Devin CLI",
    trust: "在終端機信任這個工作區",
    opened: "已在 {terminal} 中開啟，完成後回到這裡再傳送。",
    failed: "無法開啟終端機。",
  },
  "en-US": {
    login: "Log in to Devin CLI in a terminal",
    trust: "Trust this workspace in a terminal",
    opened: "Opened in {terminal}. When you are done, come back and send again.",
    failed: "The terminal could not be opened.",
  },
  "ja-JP": {
    login: "ターミナルで Devin CLI にログイン",
    trust: "ターミナルでこのワークスペースを信頼",
    opened: "{terminal} で開きました。終わったらここに戻って送信し直してください。",
    failed: "ターミナルを開けませんでした。",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;

export function devinTerminalCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}
