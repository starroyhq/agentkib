import { describe, expect, it } from "vitest";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { codexCopy, codexReason } from "@/features/conversation/features/sessions/codex-copy";
import { sessionContinuationCopy, sessionContinuationListState } from "@agentkib/session-ui";
import { managedControlCopy } from "@/features/conversation/features/sessions/managed-control-copy";

describe("Codex capability reasons", () => {
  const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  it.each(locales)("explains unconfirmed fork settings with recovery guidance in %s", (locale) => {
    for (const reason of ["native-model-unconfirmed", "native-effort-unconfirmed"]) {
      const explanation = codexReason(locale, reason);
      expect(explanation.technical).toBeUndefined();
      expect(explanation.text).not.toBe(codexReason(locale).text);
      expect(explanation.text).toContain("Codex");
    }
  });
  it.each(locales)("explains directory failures and projects view only in %s", (locale) => {
    for (const reason of [
      "codex-session-directory-unsafe",
      "codex-session-directory-missing",
      "codex-session-directory-not-directory",
      "codex-session-directory-unavailable",
      "codex-session-directory-unverified",
      "codex-context-outside-workspace",
      "codex-workspace-mismatch",
      "codex-sandbox-mismatch",
    ]) {
      expect(codexReason(locale, reason).technical).toBeUndefined();
      expect(codexReason(locale, reason).text).not.toBe(codexReason(locale).text);
      expect(
        sessionContinuationListState(
          { agent: "codex", continuation: { status: "unsupported", reason } },
          locale,
        ),
      ).toEqual({ label: sessionContinuationCopy(locale).viewOnly });
    }
  });
  it.each(locales)("explains ownership, version and installation failures in %s", (locale) => {
    const continuation = sessionContinuationCopy(locale);
    expect(codexReason(locale, "codex-owner-busy")).toEqual({
      text: continuation.busy("Codex"),
    });
    expect(codexReason(locale, "codex-cli-version-too-old")).toEqual({
      text: continuation.codexVersionTooOld,
    });
    const missing = codexReason(locale, "codex-cli-unavailable");
    expect(missing.technical).toBeUndefined();
    expect(missing.text).toContain("Codex CLI");
    expect(missing.text).not.toBe(codexReason(locale).text);
  });

  it.each([
    [
      "zh-CN",
      "无法确认 Codex 版本，目前仅可查看。请检查 Codex CLI 后刷新重试。",
      "无法确认这条会话是否正在 Codex 中使用，目前仅可查看。请刷新重试。",
    ],
    [
      "zh-TW",
      "無法確認 Codex 版本，目前僅可查看。請檢查 Codex CLI 後重新整理再試。",
      "無法確認這段對話是否正在 Codex 中使用，目前僅可查看。請重新整理再試。",
    ],
    [
      "en-US",
      "The Codex version could not be confirmed. This session is view only. Check Codex CLI, then refresh to retry.",
      "Could not confirm whether this session is in use in Codex. It remains view only. Refresh to retry.",
    ],
    [
      "ja-JP",
      "Codex のバージョンを確認できないため、この会話は閲覧のみです。Codex CLI を確認してから再読み込みしてください。",
      "この会話が Codex で使用中か確認できないため、閲覧のみです。再読み込みしてお試しください。",
    ],
  ] as const)(
    "keeps failed version and owner checks view only with specific recovery advice in %s",
    (locale, version, ownership) => {
      expect(codexReason(locale, "codex-cli-version-unavailable")).toEqual({ text: version });
      expect(codexReason(locale, "codex-owner-check-unavailable")).toEqual({ text: ownership });
      expect(version).not.toBe(codexReason(locale, "codex-cli-version-too-old").text);
      expect(ownership).not.toBe(codexReason(locale, "codex-owner-busy").text);
      expect(version).not.toBe(codexReason(locale, "control-outcome-unconfirmed").text);
    },
  );

  it.each([
    ["zh-CN", "待发队列", "检查会话状态"],
    ["zh-TW", "待發佇列", "檢查對話狀態"],
    ["en-US", "Queued messages", "Inspect session state"],
    ["ja-JP", "送信待ちキュー", "会話の状態を確認"],
  ] as const)("describes the managed queue and inspection in %s", (locale, queue, inspect) => {
    const copy = codexCopy[locale];
    expect(copy.queue).toBe(queue);
    expect(copy.inspect).toBe(inspect);
    expect(copy.composerHint + copy.queueTooLarge).not.toMatch(
      /原客户端|原客戶端|original.client|元のクライアント/i,
    );
  });

  it("retains approval scope and original-client context labels", () => {
    expect(codexCopy["en-US"]).toMatchObject({
      native: "Original-client approval options",
      accepted: "Request accepted; check the original client for its current state",
      context: "Original-client context",
    });
  });

  it.each(locales)("keeps automatic continuation recovery actionable in %s", (locale) => {
    const removedWorkflow =
      /原客户端|原客戶端|original.client|元のクライアント|交给|交給|交还|交還|handed over|引き渡|恢复执行|恢復執行|resume execution|実行を再開/i;
    for (const reason of [
      "codex-connection-failed",
      "codex-owner-changed",
      "session-already-managed",
      "session-released",
      "recovery-required",
      "native-session-unconfirmed",
      "session-state-unavailable",
      "control-outcome-unconfirmed",
    ]) {
      expect(codexReason(locale, reason).text).not.toMatch(removedWorkflow);
    }
    for (const key of ["access", "protocol"] as const) {
      expect(managedControlCopy[locale][key]).not.toMatch(/交接|handing over|引き渡/i);
    }
    expect(dictionaries[locale].controlUnconfirmed).not.toMatch(removedWorkflow);
    expect(dictionaries[locale].uncertain).not.toMatch(removedWorkflow);
  });

  it.each([
    ["zh-CN", "已保存请求", "不会自动重发", "勿重复提交"],
    ["zh-TW", "已儲存請求", "不會自動重傳", "勿重複提交"],
    ["en-US", "saved request", "not be sent again automatically", "do not resubmit"],
    ["ja-JP", "保存済みリクエスト", "自動で再送しません", "再送しないでください"],
  ] as const)(
    "requires checking an unknown outcome without resending in %s",
    (locale, request, noAutomaticResend, noResubmit) => {
      const reason = codexReason(locale, "control-outcome-unconfirmed").text;
      expect(reason).toContain(request);
      expect(reason).toContain(noAutomaticResend);
      expect(reason).toContain(noResubmit);
      expect(dictionaries[locale].controlUnconfirmed).toContain(noResubmit);
      expect(dictionaries[locale].uncertain).toContain(request);
    },
  );
  it.each(locales)(
    "explains state restrictions without reporting a read failure in %s",
    (locale) => {
      const stateUnavailable = codexReason(locale, "session-state-unavailable");
      for (const reason of [
        "session-busy",
        "session-requires-running-turn",
        "no-active-turn",
        "session-already-managed",
        "session-not-archived",
        "session-archived",
        "session-released",
        "recovery-required",
        "native-session-unconfirmed",
        "native-operation-not-integrated",
        "codex-protocol-incompatible",
        "codex-connection-failed",
        "codex-owner-changed",
        "session-compacting",
      ]) {
        const explanation = codexReason(locale, reason);
        expect(explanation.technical).toBeUndefined();
        expect(explanation.text).not.toBe(stateUnavailable.text);
        expect(explanation.text).not.toBe(codexReason(locale).text);
      }
    },
  );

  it.each(locales)("reuses specific installation and original-client advice in %s", (locale) => {
    expect(codexReason(locale, "handoff-required")).toEqual({
      text: dictionaries[locale].unavailable,
    });
    expect(codexReason(locale, "unverified-installation")).toEqual({
      text: dictionaries[locale].unverifiedInstallation,
    });
    expect(codexReason(locale, "open-in-original-client")).toEqual({
      text: dictionaries[locale].openOriginalClient,
    });
  });

  it("preserves technical details for unknown reasons", () => {
    expect(codexReason("zh-CN", "future-reason").technical).toBe("future-reason");
  });
});

describe("reasons a Claude session was stopped for", () => {
  const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  const codes = ["claude-background-task", "claude-unrequested-turn", "claude-protocol-violation"];
  // The session stays read-only in AgentKib and cannot be resumed there, so the copy must not
  // promise an action that does not exist. Each language names the Claude Code terminal.
  const unavailableActions = /Ask Claude|Reopen|重新打开|重新開啟|让 Claude|讓 Claude|開き直/;
  const terminal: Record<Locale, string> = {
    "zh-CN": "Claude Code 终端",
    "zh-TW": "Claude Code 終端機",
    "en-US": "Claude Code terminal",
    "ja-JP": "Claude Code のターミナル",
  };

  it.each(locales.flatMap((locale) => codes.map((code) => [locale, code] as const)))(
    "explains %s %s and points to the Claude Code terminal, not an action AgentKib lacks",
    (locale, code) => {
      const { text, technical } = codexReason(locale, code);
      expect(technical).toBeUndefined();
      expect(text).not.toBe(codexReason(locale).text);
      expect(text).toContain(terminal[locale]);
      expect(text).not.toMatch(unavailableActions);
    },
  );

  it.each(locales)("keeps the three explanations apart in %s", (locale) => {
    expect(new Set(codes.map((code) => codexReason(locale, code).text)).size).toBe(3);
  });

  it.each(locales)(
    "splits `<code>: <detail>` into the explanation and the technical text in %s",
    (locale) => {
      expect(
        codexReason(locale, "claude-unrequested-turn: Claude result outside an active turn"),
      ).toEqual({
        text: codexReason(locale, "claude-unrequested-turn").text,
        technical: "Claude result outside an active turn",
      });
      expect(codexReason(locale, "claude-background-task: ").technical).toBeUndefined();
    },
  );

  it("does not take a similar-looking reason for one of the codes", () => {
    for (const reason of [
      "claude-background-tasks: x",
      "claude-background-task:x",
      "x claude-background-task: y",
      ": claude-background-task",
    ]) {
      const explained = codexReason("en-US", reason);
      expect(explained.text).toBe(codexReason("en-US").text);
      expect(explained.technical).toBe(reason);
    }
  });

  it("keeps general unknown outcomes separate from stopped Claude sessions", () => {
    expect(codexReason("en-US", "control-outcome-unconfirmed")).toEqual({
      text: "The previous outcome is unconfirmed. Refresh to check the saved request; do not resubmit. It will not be sent again automatically.",
    });
    expect(codexReason("en-US", "codex-connection-failed").technical).toBeUndefined();
    expect(codexReason("en-US", "Claude process exited (1)").technical).toBe(
      "Claude process exited (1)",
    );
  });
});

describe("a managed Claude turn that failed authentication", () => {
  const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
  // The session stays usable, so the copy must not say read-only; it names the fixes that work
  // for a managed process: logging in, the settings env block, and apiKeyHelper.
  const readOnly = /只读|唯讀|read-only|読み取り専用/;
  const sendAgain: Record<Locale, string> = {
    "zh-CN": "重新发送",
    "zh-TW": "重新傳送",
    "en-US": "send again",
    "ja-JP": "再送信",
  };

  it.each(locales)("explains the fixes and that sending again works in %s", (locale) => {
    const { text, technical } = codexReason(locale, "claude-auth-failed");
    expect(technical).toBeUndefined();
    expect(text).not.toBe(codexReason(locale).text);
    for (const part of ["/login", "~/.claude/settings.json", "env", "apiKeyHelper", "export"])
      expect(text).toContain(part);
    expect(text).toContain(sendAgain[locale]);
    expect(text).not.toMatch(readOnly);
  });

  it("keeps the CLI's detail as is, underscores included", () => {
    const reason =
      "claude-auth-failed: Invalid API key · Fix external API key (HTTP 401); key source: ANTHROPIC_API_KEY";
    expect(codexReason("en-US", reason)).toEqual({
      text: codexReason("en-US", "claude-auth-failed").text,
      technical: "Invalid API key · Fix external API key (HTTP 401); key source: ANTHROPIC_API_KEY",
    });
  });

  it("refers to the computer running AgentKib on the Web", () => {
    expect(codexReason("zh-CN", "claude-auth-failed", "web").text).toContain(
      "运行 AgentKib 的电脑的终端",
    );
    expect(codexReason("en-US", "claude-auth-failed", "web").text).toContain(
      "in a terminal on the computer running AgentKib",
    );
  });
});
