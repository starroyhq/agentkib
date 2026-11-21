import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type HistorySearchStatus } from "@agentkib/web-client";
import { HistorySearchPanel, historyAccessScope, historyCopy } from "@agentkib/session-ui";
import { render } from "@/features/conversation/web-reader-test-utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Web content search settings instructions", () => {
  it.each([
    [
      "zh-CN",
      "正文索引未开启，请联系电脑所有者，在电脑上的 AgentKib“设置 → 隐私 → 会话正文搜索”中启用。",
      "仅运行 AgentKib 的电脑",
    ],
    [
      "zh-Hant",
      "正文索引未開啟，請聯絡電腦擁有者，在電腦上的 AgentKib「設定 → 隱私 → 對話正文搜尋」中啟用。",
      "僅執行 AgentKib 的電腦",
    ],
    [
      "en-US",
      "Conversation content indexing is off. Ask the owner of the computer running AgentKib to enable it in AgentKib under Settings → Privacy → Conversation content search.",
      "Only the computer running AgentKib",
    ],
    [
      "ja-JP",
      "本文のインデックスは無効です。コンピューターの所有者に、コンピューター上の AgentKib の「設定 → プライバシー → 会話本文の検索」で有効にするよう依頼してください。",
      "AgentKib を実行しているコンピューターのみ",
    ],
  ] as const)(
    "points to AgentKib settings on the computer in %s without invalid navigation or index mutation",
    async (locale, disabled, local) => {
      const grant: Access = {
        protocolVersion: 2,
        status: "approved",
        csrfToken: "test",
        bootId: "boot",
        experimentalEnabled: true,
        historySearch: true,
        historySearchScope: "scope",
        device: { id: "browser", name: "Browser", send: false, approve: false },
      };
      const status: HistorySearchStatus = {
        enabled: false,
        generation: "index",
        bytes: 0,
        limitBytes: 10000,
        budgetExceeded: false,
        coverage: {
          total: 0,
          ready: 0,
          building: 0,
          partial: 0,
          stale: 0,
          unavailable: 0,
          limitations: [],
        },
      };
      const client = new WebClient(vi.fn());
      vi.spyOn(client, "access").mockResolvedValue(grant);
      vi.spyOn(client, "catalog").mockResolvedValue({ indexEnabled: true, sessions: [] });
      vi.spyOn(client, "historyStatus").mockResolvedValue(status);
      const configure = vi.spyOn(client, "historyConfigure");
      const clear = vi.spyOn(client, "historyClear");
      const rebuild = vi.spyOn(client, "historyRebuild");
      const search = vi.spyOn(client, "historySearch");
      render(
        <HistorySearchPanel client={client} locale={locale} scope={historyAccessScope(grant)} />,
      );
      expect(await screen.findByText(disabled)).toBeVisible();
      expect(screen.getByText(local)).toBeVisible();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(screen.getByRole("button", { name: historyCopy[locale].search })).toBeDisabled();
      expect(configure).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    },
  );
});
