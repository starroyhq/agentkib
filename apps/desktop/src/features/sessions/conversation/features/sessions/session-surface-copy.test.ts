import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { sessionCopyForSurface, sessionReason } from "../../session-copy";
import { managedControlCopyForSurface } from "@agentkib/session-ui";
import { claudeConnectionCopyForSurface, surfaceText, artifactCopy } from "@agentkib/session-ui";

const locales = ["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const;

describe("session copy identifies the computer and application", () => {
  it.each([
    ["zh-CN", "这台电脑上的 AgentKib", "电脑上的 AgentKib"],
    ["zh-Hant", "這台電腦上的 AgentKib", "電腦上的 AgentKib"],
    ["en-US", "AgentKib on this computer", "AgentKib on your computer"],
    ["ja-JP", "このコンピューター上の AgentKib", "コンピューター上の AgentKib"],
  ] as const)(
    "names the application for settings and connection operations without repetitive copy in %s",
    (locale, desktopApp, webApp) => {
      for (const key of ["access", "experimental", "management"] as const) {
        expect(managedControlCopyForSurface(locale)[key]).toContain(desktopApp);
        expect(managedControlCopyForSurface(locale, "web")[key]).toContain(webApp);
      }
      expect(claudeConnectionCopyForSurface(locale).localOnly).toContain(desktopApp);
      expect(claudeConnectionCopyForSurface(locale, "web").localOnly).toContain(webApp);
      expect(claudeConnectionCopyForSurface(locale, "web").disconnected).not.toContain(webApp);
      expect(sessionReason(locale, "permission_denied").text).toContain(desktopApp);
      expect(sessionReason(locale, "permission_denied", "web").text).toContain(webApp);
      expect(sessionReason(locale, "control-disabled").text).toContain(desktopApp);
      expect(sessionReason(locale, "control-disabled", "web").text).toContain(webApp);
      expect(artifactCopy(locale).authorize).toContain(desktopApp);
      expect(artifactCopy(locale, "web").authorize).toContain(webApp);
      expect(artifactCopy(locale, "web")).toBe(artifactCopy(locale, "web"));
    },
  );
  it.each(locales)("keeps desktop and browser instructions distinct in %s", (locale) => {
    const desktop = sessionCopyForSurface(locale);
    const expected = {
      "zh-CN": ["这台电脑", "运行 AgentKib 的电脑", "电脑上的 AgentKib"],
      "zh-Hant": ["這台電腦", "執行 AgentKib 的電腦", "電腦上的 AgentKib"],
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
    expect(sessionCopyForSurface(locale)).toBe(desktop);
    expect(sessionCopyForSurface(locale, "web")).toBe(sessionCopyForSurface(locale, "web"));
    expect(claudeConnectionCopyForSurface(locale, "web").generate).not.toMatch(
      /一次性|一回限り|one-time/,
    );
  });

  it.each(locales)(
    "preserves raw diagnostic details and unknown-result protection in %s",
    (locale) => {
      const detail = "unrecognized-source: this computer / 主机 / ホスト / AgentKib中文";
      expect(sessionReason(locale, detail, "web").technical).toBe(detail);
      expect(sessionReason(locale, `claude-protocol-violation: ${detail}`, "web").technical).toBe(
        detail,
      );
      expect(managedControlCopyForSurface(locale, "web").protocol).toContain("AgentKib");
      expect(sessionReason(locale, "control-outcome-unconfirmed", "web").text).toBe(
        sessionReason(locale, "control-outcome-unconfirmed").text,
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
    expect(surfaceText("請在桌面端批准存取。", "web", "zh-Hant")).toBe(
      "請在電腦上的 AgentKib 批准存取。",
    );
  });

  it("uses a single shared presentation implementation for both platforms", () => {
    const implementations = {
      "managed-control-copy.ts": "conversation/sessions/managed-control-copy.ts",
      "session-display-state.ts": "conversation/sessions/session-display-state.ts",
      "claude-session-banner.ts": "agents/claude-code/connection-notice.ts",
      "session-outcome-action.tsx": "conversation/sessions/session-outcome-action.tsx",
      "managed-error-copy.ts": "conversation/sessions/managed-error-copy.ts",
    };
    for (const [filename, path] of Object.entries(implementations)) {
      const desktop = new URL(filename, import.meta.url);
      const web = new URL(
        `../../../../../../../web/src/features/conversation/features/sessions/${filename}`,
        import.meta.url,
      );
      const shared = new URL(
        `../../../../../../../../packages/session-ui/src/${path}`,
        import.meta.url,
      );
      expect(existsSync(shared), filename).toBe(true);
      expect(existsSync(desktop), filename).toBe(false);
      expect(existsSync(web), filename).toBe(false);
    }
  });
});
