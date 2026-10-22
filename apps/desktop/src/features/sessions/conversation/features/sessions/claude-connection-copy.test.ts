import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claudeConnectionCopy,
  claudeConnectionCopyForSurface,
  claudeConnectionReason,
} from "./claude-connection-copy";

const cases = [
  {
    locale: "zh-CN",
    install: "安装插件（只需一次）",
    paste: "在终端粘贴并回车",
    connected: "已连接终端",
    badge: "已连接",
    copyOptions: "更多复制选项",
    expired: "连接码已过期",
    unsupported: "连接终端目前只支持 macOS",
    statusUnavailable: "暂时无法核实终端连接状态，请稍后检查连接。",
    webApp: "电脑上的 AgentKib",
    oldGuide: "打开连接指引",
  },
  {
    locale: "zh-TW",
    install: "安裝外掛（只需一次）",
    paste: "在終端貼上並按下 Enter",
    connected: "已連接終端",
    badge: "已連線",
    copyOptions: "更多複製選項",
    expired: "連線碼已過期",
    unsupported: "連接終端目前僅支援 macOS",
    statusUnavailable: "暫時無法核實終端連線狀態，請稍後檢查連線。",
    webApp: "電腦上的 AgentKib",
    oldGuide: "開啟連線指引",
  },
  {
    locale: "en-US",
    install: "Install the plugin (once)",
    paste: "Paste into the terminal and press Enter",
    connected: "Terminal connected",
    badge: "Connected",
    copyOptions: "More copy options",
    expired: "Connection code expired",
    unsupported: "Connecting a terminal is currently supported only on macOS",
    statusUnavailable:
      "The terminal connection status cannot be checked right now. Check the connection again shortly.",
    webApp: "AgentKib on your computer",
    oldGuide: "Open the connection guide",
  },
  {
    locale: "ja-JP",
    install: "プラグインをインストール（初回のみ）",
    paste: "ターミナルに貼り付けて Enter を押す",
    connected: "ターミナルに接続済み",
    badge: "接続済み",
    copyOptions: "その他のコピー操作",
    expired: "接続コードの期限切れ",
    unsupported: "ターミナル接続は現在 macOS のみ対応です",
    statusUnavailable:
      "ターミナルの接続状態を現在確認できません。しばらくしてから接続を確認してください。",
    webApp: "コンピューター上の AgentKib",
    oldGuide: "接続ガイドを開き",
  },
] as const;

describe("terminal connection guide copy", () => {
  it.each(cases)("provides the approved steps and state labels in $locale", (expected) => {
    const copy = claudeConnectionCopy[expected.locale];
    expect(copy.installStep).toBe(expected.install);
    expect(copy.pasteStep).toBe(expected.paste);
    expect(copy.connectedTitle).toBe(expected.connected);
    expect(copy.connectedBadge).toBe(expected.badge);
    expect(copy.copyOptions).toBe(expected.copyOptions);
    expect(copy.expiredTitle).toBe(expected.expired);
    expect(copy.unsupportedTitle).toBe(expected.unsupported);
    expect(copy.statusUnavailable).toBe(expected.statusUnavailable);
    expect(copy.platformVersion).toContain("{version}");
    expect(copy.platformVersion).toMatch(/更高|later|以降|以上/);
    expect(copy.expiresAt.replace("{time}", "10:42")).toContain("10:42");
    expect(copy.generateStep).toBe(copy.generate);
    expect(copy.generate).not.toMatch(/一次性|one-time|一回限り/);
    expect(copy.clearConnection).toMatch(/…$/);
    expect(copy.clearConnectionInfo).toContain("AgentKib");
    expect(copy.clearConnectionInfo).toMatch(/凭据|憑據|credentials|認証情報/);
    expect(copy.clearConnectionInfo).toMatch(/未使用|unused/);
    expect(copy.clearConnectionInfo).toMatch(
      /终端照常运行|終端照常執行|terminal keeps running|ターミナルは実行を続け/,
    );
  });

  it.each(cases)("keeps the browser-only guide out of desktop copy in $locale", (expected) => {
    const desktop = claudeConnectionCopyForSurface(expected.locale);
    const web = claudeConnectionCopyForSurface(expected.locale, "web");
    expect(desktop).toBe(claudeConnectionCopy[expected.locale]);
    expect(desktop.disconnected).not.toContain(expected.oldGuide);
    expect(web.disconnected).toContain(expected.oldGuide);
    expect(web.disconnected).toContain(expected.webApp);
    expect(claudeConnectionReason(expected.locale, "claude-bridge-not-connected", "web")).toBe(
      web.disconnected,
    );
    expect(web).toBe(claudeConnectionCopyForSurface(expected.locale, "web"));
  });

  it.each(cases)("distinguishes compatibility reasons in $locale", ({ locale }) => {
    const copy = claudeConnectionCopy[locale];
    expect(copy.cliTooOld).toContain("{version}");
    expect(copy.cliTooOld).toContain("{minimum}");
    expect(copy.pluginOutdated).toMatch(/第 1|step 1|手順 1/);
    expect(copy.missingCapabilities).toContain("{version}");
    expect(copy.unverifiedVersion).toContain("{version}");
  });

  it.each(cases)(
    "formats observed versions without exposing invalid diagnostics in $locale",
    ({ locale }) => {
      const copy = claudeConnectionCopy[locale];
      expect(
        claudeConnectionReason(locale, "bridge-cli-too-old", "desktop", { cliVersion: "2.1.300" }),
      ).toBe(copy.cliTooOld.replace("{version}", "2.1.300").replace("{minimum}", "2.1.301"));
      expect(
        claudeConnectionReason(locale, "bridge-capabilities-missing", "web", {
          cliVersion: "2.1.307",
        }),
      ).toBe(copy.missingCapabilities.replace("{version}", "2.1.307"));
      expect(claudeConnectionReason(locale, "bridge-plugin-update-required", "web")).toBe(
        copy.pluginOutdated,
      );
      expect(claudeConnectionReason(locale, "bridge-cli-unsupported", "desktop")).toBe(
        copy.cliUnsupported,
      );
      const invalid = claudeConnectionReason(locale, "bridge-capabilities-missing", "desktop", {
        cliVersion: "/private/sensitive-diagnostic",
      });
      expect(invalid).toBe(copy.missingCapabilities.replace("{version}", copy.unknownVersion));
      expect(invalid).not.toContain("/private/");
    },
  );

  it("keeps every language's keys and placeholders aligned", () => {
    const baseline = claudeConnectionCopy["zh-CN"];
    for (const { locale } of cases) {
      const copy = claudeConnectionCopy[locale];
      expect(Object.keys(copy).sort()).toEqual(Object.keys(baseline).sort());
      for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
        expect(copy[key].trim(), `${locale}.${key}`).not.toBe("");
        expect(copy[key].match(/\{\w+\}/g) ?? [], `${locale}.${key}`).toEqual(
          baseline[key].match(/\{\w+\}/g) ?? [],
        );
      }
    }
  });

  it.each(cases)("preserves the existing error reason mapping in $locale", ({ locale }) => {
    const copy = claudeConnectionCopy[locale];
    for (const [reason, expected] of [
      ["expired-bridge-challenge", copy.expired],
      ["invalid-bridge-challenge", copy.invalidCode],
      ["bridge-version-mismatch", copy.versionMismatch],
      ["bridge-identity-mismatch", copy.identityMismatch],
      ["native-identity-changed", copy.identityMismatch],
      ["unsupported-native-identity", copy.identityMismatch],
      ["claude-bridge-not-connected", copy.disconnected],
      ["claude-bridge-disconnected", copy.lost],
      ["claude-terminal-approval", copy.approval],
      ["claude-bridge-event-gap", copy.gap],
      ["claude-follower-turn-unconfirmed", copy.turnUnconfirmed],
      ["claude-terminal-permission-unconfirmed", copy.permissionUnconfirmed],
      ["claude-terminal-question", copy.question],
      ["claude-follower-send-unverified", copy.sendUnverified],
      ["claude-follower-attachments-unavailable", copy.attachments],
      ["claude-bridge-binding-limit", copy.connectionLimit],
      ["bridge-request-rejected", copy.connectionRejected],
      ["platform-unsupported", copy.platformUnsupported],
      ["claude-bridge-unavailable", copy.bridgeUnavailable],
    ]) {
      expect(claudeConnectionReason(locale, reason)).toBe(expected);
    }
    expect(claudeConnectionReason(locale, "unrecognized-private-detail")).toBeUndefined();
  });

  it("keeps desktop and Web connection presentation mirrored", () => {
    const desktop = readFileSync(new URL("./claude-connection-copy.ts", import.meta.url), "utf8");
    const web = readFileSync(
      new URL(
        "../../../../../../../web/src/features/conversation/features/sessions/claude-connection-copy.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(desktop).toBe(web);
  });
});
