import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { managedControlCopyForSurface } from "./managed-control-copy";
import { claudeConnectionCopyForSurface } from "./claude-connection-copy";
import { surfaceText } from "./session-surface-copy";
import { managedText } from "./managed-copy";
import { artifactCopy } from "./artifact-copy";

const locales = ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const;

describe("session copy identifies the computer and application", () => {
  it.each([
    [
      "zh-CN",
      "这台电脑上的 AgentKib",
      "电脑上的 AgentKib",
      "请让电脑上的 AgentKib 保持运行。任务使用工作区权限，需要审批时等待你的确认。",
    ],
    [
      "zh-TW",
      "這台電腦上的 AgentKib",
      "電腦上的 AgentKib",
      "請讓電腦上的 AgentKib 保持執行。任務使用工作區權限，需要審批時等待你的確認。",
    ],
    [
      "en-US",
      "AgentKib on this computer",
      "AgentKib on your computer",
      "Keep AgentKib running on the computer running the Agent. Tasks use workspace access and request approval when needed.",
    ],
    [
      "ja-JP",
      "このコンピューター上の AgentKib",
      "コンピューター上の AgentKib",
      "コンピューター上の AgentKib を起動したままにしてください。タスクはワークスペースの権限を使用し、必要に応じて承認を待ちます。",
    ],
  ] as const)(
    "names the application for settings and connection operations without repetitive copy in %s",
    (locale, desktopApp, webApp, background) => {
      for (const key of ["access", "experimental", "management"] as const) {
        expect(managedControlCopyForSurface(locale)[key]).toContain(desktopApp);
        expect(managedControlCopyForSurface(locale, "web")[key]).toContain(webApp);
      }
      expect(claudeConnectionCopyForSurface(locale).localOnly).toContain(desktopApp);
      expect(claudeConnectionCopyForSurface(locale, "web").localOnly).toContain(webApp);
      expect(claudeConnectionCopyForSurface(locale, "web").disconnected).toContain(webApp);
      expect(codexReason(locale, "permission_denied").text).toContain(desktopApp);
      expect(codexReason(locale, "permission_denied", "web").text).toContain(webApp);
      expect(codexReason(locale, "control-disabled").text).toContain(desktopApp);
      expect(codexReason(locale, "control-disabled", "web").text).toContain(webApp);
      expect(artifactCopy(locale).authorize).toContain(desktopApp);
      expect(artifactCopy(locale, "web").authorize).toContain(webApp);
      expect(artifactCopy(locale, "web")).toBe(artifactCopy(locale, "web"));
      expect(
        managedText(
          locale,
          "Authorize a workspace in Web settings in AgentKib on this computer first.",
          "请先在这台电脑上的 AgentKib 的 Web 设置中授权工作区。",
        ),
      ).toContain(desktopApp);
      expect(
        managedText(
          locale,
          "Authorize a workspace in Web settings in AgentKib on this computer first.",
          "请先在这台电脑上的 AgentKib 的 Web 设置中授权工作区。",
          "web",
        ),
      ).toContain(webApp);
      expect(
        managedText(
          locale,
          "AgentKib must stay running on this computer (the computer running the Agent). Tasks use workspace access and request approval when needed.",
          "AgentKib 需要在这台电脑上保持运行。任务使用工作区权限，需要审批时等待你的确认。",
          "web",
        ),
      ).toBe(background);
    },
  );
  it.each(locales)("keeps desktop and browser instructions distinct in %s", (locale) => {
    const desktop = codexCopyForSurface(locale);
    const expected = {
      "zh-CN": ["这台电脑", "运行 AgentKib 的电脑", "电脑上的 AgentKib"],
      "zh-TW": ["這台電腦", "執行 AgentKib 的電腦", "電腦上的 AgentKib"],
      "en-US": ["this computer", "the computer running AgentKib", "AgentKib on your computer"],
      "ja-JP": [
        "このコンピューター",
        "AgentKib を実行しているコンピューター",
        "コンピューター上の AgentKib",
      ],
    }[locale];
    expect(managedControlCopyForSurface(locale).tool).toContain(expected[0]);
    expect(managedControlCopyForSurface(locale, "web").tool).toContain(expected[1]);
    expect(managedControlCopyForSurface(locale, "web").management).toContain(expected[2]);
    expect(codexCopyForSurface(locale)).toBe(desktop);
    expect(codexCopyForSurface(locale, "web")).toBe(codexCopyForSurface(locale, "web"));
    expect(claudeConnectionCopyForSurface(locale, "web").generate).not.toMatch(
      /一次性|一回限り|one-time/,
    );
  });

  it.each(locales)(
    "preserves raw diagnostic details and unknown-result protection in %s",
    (locale) => {
      const detail = "unrecognized-source: this computer / 主机 / ホスト / AgentKib中文";
      expect(codexReason(locale, detail, "web").technical).toBe(detail);
      expect(codexReason(locale, `claude-protocol-violation: ${detail}`, "web").technical).toBe(
        detail,
      );
      expect(managedControlCopyForSurface(locale, "web").protocol).toContain("AgentKib");
      expect(codexReason(locale, "control-outcome-unconfirmed", "web").text).toBe(
        codexReason(locale, "control-outcome-unconfirmed").text,
      );
    },
  );

  it.each(locales)("directs unsupported computers to a macOS computer in %s", (locale) => {
    const desktop = claudeConnectionCopyForSurface(locale).platformUnsupported;
    const web = claudeConnectionCopyForSurface(locale, "web").platformUnsupported;
    expect(desktop).toContain("macOS");
    expect(desktop).not.toMatch(/macOS (?:这台电脑|這台電腦|(?:の)?このコンピューター)/);
    expect(web).toContain("AgentKib");
  });

  it("does not introduce Simplified Chinese into the browser's Traditional Chinese copy", () => {
    expect(surfaceText("請在桌面端批准存取。", "web", "zh-TW")).toBe(
      "請在電腦上的 AgentKib 批准存取。",
    );
  });

  it("keeps the shared presentation implementations mirrored", () => {
    for (const filename of [
      "session-surface-copy.ts",
      "codex-copy.ts",
      "managed-control-copy.ts",
      "session-display-state.ts",
      "claude-session-banner.ts",
      "claude-connection-copy.ts",
      "claude-compatibility-note.tsx",
      "managed-copy.ts",
      "managed-error-copy.ts",
      "context-usage-copy.ts",
      "artifact-copy.ts",
      "../catalog/catalog-copy.ts",
      "claude-handoff.ts",
    ]) {
      const desktop = new URL(filename, import.meta.url);
      const web = new URL(
        `../../../../../../../web/src/features/conversation/features/sessions/${filename}`,
        import.meta.url,
      );
      const normalize = (source: string) =>
        source
          .replace('import type { SupportedLocale as Locale } from "@/core/types";', "")
          .replace('import type { Locale } from "../../i18n";', "");
      expect(normalize(readFileSync(desktop, "utf8")), filename).toBe(
        normalize(readFileSync(web, "utf8")),
      );
    }
  });
});
