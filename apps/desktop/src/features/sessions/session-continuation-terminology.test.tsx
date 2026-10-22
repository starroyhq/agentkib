// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createContext, useContext, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReader } from "@/features/sessions/conversation/features/sessions/session-reader";
import { SessionPanelsContext } from "@/features/sessions/conversation/features/sessions/session-panels";
import type { SessionController } from "@/features/sessions/conversation/features/sessions/use-session-controller";
import { conversationWords } from "@/core/i18n";
import { claudeConnectionCopy } from "@/features/sessions/conversation/features/sessions/claude-connection-copy";

type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";
let session: SessionController;
const FixtureContext = createContext<SessionController | null>(null);
vi.mock("@/features/sessions/conversation/features/sessions/session-context", () => ({
  useSession: () => useContext(FixtureContext)!,
}));
vi.mock("@/features/sessions/conversation/features/sessions/session-navigation", () => ({
  useSessionNavigate: () => vi.fn(),
}));
vi.mock("@/features/sessions/conversation/features/sessions/context-usage", () => ({
  ContextUsageGauge: () => null,
}));
vi.mock("@/features/sessions/conversation/features/sessions/artifact-browser", () => ({
  ArtifactBrowser: () => null,
}));
vi.mock("@/features/sessions/conversation/features/sessions/session-transcript", () => ({
  SessionTranscript: () => null,
}));
vi.mock("@/features/sessions/conversation/features/history/history-search-controls", () => ({
  HistoryReferenceChips: () => null,
}));

// Product acceptance literals deliberately do not come from the dictionaries being tested.
const wording = [
  {
    locale: "zh-CN",
    draftHint: "草稿已保留，回到这里后会恢复。",
    placeholder: "继续这条会话…",
    terminalHint: "审批和提问在终端中处理",
    choice: "这条会话正在 Claude Code 中使用。为避免两边同时写入，请选择：",
    fork: "分支会话并继续",
    forkHint: "原会话不受影响，新会话会标“分支自 Original”",
    back: "回 Claude Code 继续",
    returned: "这条会话在 AgentKib 中只读，Claude Code 那边关闭后会自动恢复",
    watch: "在终端中继续这条会话，这里会同步显示",
    terminalControls: "消息发送和停止请在终端处理，AgentKib 会同步显示。",
    ended: "后台进程已结束，下次发送时会自动继续",
    conflict: "你在 Claude Code 里打开了这条会话，AgentKib 已停止，避免两边同时写入",
    windows: "Windows 上暂不支持在这里继续 Claude Code 会话",
    oldCodex: "Codex 版本过低，升级后可以在这里继续",
    queue: "待发队列",
    terminalTitle: "连接终端",
    resumeQueue: "恢复队列",
    queueRecovery: "队列不会自动继续。请先核对上次操作结果，再恢复队列。",
    legacy:
      /^(交给 AgentKib|交还原客户端|执行管理|待交接|由 AgentKib 执行|已交还原客户端|已连接原会话|仅查看历史|恢复执行|连接原 Claude 终端|管理原终端连接)$/,
  },
  {
    locale: "zh-TW",
    draftHint: "草稿已保留，回到這裡後會恢復。",
    placeholder: "繼續這段對話…",
    terminalHint: "核准和提問在終端中處理",
    choice: "這段對話正在 Claude Code 中使用。為避免兩邊同時寫入，請選擇：",
    fork: "分支對話並繼續",
    forkHint: "原對話不受影響，新對話會標「分支自 Original」",
    back: "回 Claude Code 繼續",
    returned: "這段對話在 AgentKib 中為唯讀，Claude Code 那邊關閉後會自動恢復",
    watch: "在終端中繼續這段對話，這裡會同步顯示",
    terminalControls: "訊息傳送和停止請在終端處理，AgentKib 會同步顯示。",
    ended: "背景程序已結束，下次傳送訊息時會自動繼續",
    conflict: "你在 Claude Code 裡開啟了這段對話，AgentKib 已停止，避免兩邊同時寫入",
    windows: "Windows 上暫不支援在這裡繼續 Claude Code 對話",
    oldCodex: "Codex 版本過舊，升級後可以在這裡繼續",
    queue: "待發佇列",
    terminalTitle: "連接終端",
    resumeQueue: "恢復佇列",
    queueRecovery: "佇列不會自動繼續。請先核對上次操作結果，再恢復佇列。",
    legacy:
      /^(交給 AgentKib|交還原客戶端|執行管理|待交接|由 AgentKib 執行|已交還原客戶端|已連接原對話|僅查看歷史|恢復執行|連接原 Claude 終端機|管理原終端機連線)$/,
  },
  {
    locale: "en-US",
    draftHint: "Your draft is kept and will be restored when you return here.",
    placeholder: "Continue this session…",
    terminalHint: "Handle approvals and questions in the terminal",
    choice: "This session is in use in Claude Code. To avoid both sides writing at once, choose:",
    fork: "Fork and continue",
    forkHint: 'The original session stays as is. The new one is marked "Forked from Original".',
    back: "Continue in Claude Code",
    returned:
      "This session is view only in AgentKib. You can continue here once it's closed in Claude Code.",
    watch: "Continue this session in the terminal. It stays in sync here.",
    terminalControls:
      "Send messages and stop turns in the terminal. AgentKib keeps the session in sync.",
    ended:
      "The background process ended. It will resume automatically when you send your next message.",
    conflict:
      "You opened this session in Claude Code. AgentKib stopped to avoid both sides writing at once.",
    windows: "Continuing Claude Code sessions here isn't supported on Windows yet",
    oldCodex: "Your Codex version is too old. Update it to continue here.",
    queue: "Queued messages",
    terminalTitle: "Connect terminal",
    resumeQueue: "Resume queue",
    queueRecovery:
      "The queue will not continue automatically. Check the previous outcome before resuming the queue.",
    legacy:
      /^(Hand over to AgentKib|Return to original client|Execution management|Handoff required|Executed by AgentKib|Returned to original client|Connected to original session|History only|Resume execution|Connect original Claude terminal|Manage original terminal connection)$/,
  },
  {
    locale: "ja-JP",
    draftHint: "下書きを保存しています。ここに戻ると復元されます。",
    placeholder: "この会話を続ける…",
    terminalHint: "承認と質問はターミナルで対応してください",
    choice: "この会話は Claude Code で使用中です。同時に書き込まれないよう、操作を選んでください：",
    fork: "会話を分岐して続ける",
    forkHint: "元の会話には影響しません。新しい会話には「Original から分岐」と表示されます。",
    back: "Claude Code で続ける",
    returned:
      "この会話は AgentKib では閲覧のみです。Claude Code 側で閉じると、ここで続けられるようになります。",
    watch: "この会話はターミナルで続けてください。ここにも同期して表示されます。",
    terminalControls:
      "メッセージの送信とターンの停止はターミナルで行ってください。AgentKib に同期して表示されます。",
    ended: "バックグラウンドプロセスを終了しました。次のメッセージ送信時に自動で続行します。",
    conflict:
      "Claude Code でこの会話が開かれたため、同時に書き込まれないよう AgentKib を停止しました。",
    windows: "Windows では、ここで Claude Code の会話を続ける機能はまだ使えません",
    oldCodex: "Codex のバージョンが古いため、更新するとここで続けられます。",
    queue: "送信待ちキュー",
    terminalTitle: "ターミナルに接続",
    resumeQueue: "キューを再開",
    queueRecovery:
      "キューは自動的に続行されません。前回の操作結果を確認してからキューを再開してください。",
    legacy:
      /^(AgentKib に引き渡す|元のクライアントに戻す|実行管理|引き継ぎ待ち|AgentKib が実行|元のクライアントに返却済み|元の会話に接続済み|履歴の閲覧のみ|実行を再開|元の Claude ターミナルに接続|元のターミナル接続を管理)$/,
  },
] as const;

function setLocale(locale: Locale) {
  session.locale = locale;
  session.t = conversationWords(locale);
}
function redraw(view: ReturnType<typeof render>) {
  // Production context publishes immutable snapshots; give memoized consumers a new identity.
  session = { ...session, live: { ...session.live! } };
  view.rerender(<View snapshot={session} />);
}
function expectNoExecutionHandoff(locale: Locale, root: HTMLElement = document.body) {
  const legacy = wording.find((item) => item.locale === locale)!.legacy;
  expect(within(root).queryByRole("button", { name: legacy })).not.toBeInTheDocument();
  expect(within(root).queryByText(legacy)).not.toBeInTheDocument();
  expect(within(root).queryByRole("checkbox")).not.toBeInTheDocument();
}
function View({ snapshot }: { snapshot: SessionController }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <FixtureContext value={snapshot}>
      <SessionPanelsContext
        value={{ filesOpen: false, setFilesOpen: vi.fn(), actionsOpen, setActionsOpen }}
      >
        <button onClick={() => setActionsOpen(true)}>Inspect session actions</button>
        <SessionReader />
      </SessionPanelsContext>
    </FixtureContext>
  );
}
beforeEach(() => {
  sessionStorage.clear();
  window.localStorage?.clear();
  delete document.documentElement.dataset.platform;
  const queue = vi.fn(async () => ({ sessionId: "session", data: [] }));
  session = {
    selected: "session",
    currentTitle: "Original",
    origin: "http://localhost",
    embedded: true,
    current: {
      id: "session",
      workspace_id: "workspace",
      title: "Original",
      agent: "claude-code",
      origin: "interactive",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
    sessions: [],
    locale: "zh-CN",
    online: true,
    controlReady: true,
    canSend: true,
    canStop: false,
    busy: false,
    message: "Unsent draft",
    setMessage: vi.fn(),
    setHistoryReferences: vi.fn(),
    historyReferences: [],
    access: {
      status: "approved",
      protocolVersion: 2,
      csrfToken: "test",
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", name: "Device", send: true, approve: true, manage: true },
    },
    live: {
      sessionId: "session",
      executionMode: "claude-managed",
      executionLocation: null,
      status: "idle",
      sendEnabled: true,
      revision: 1,
      approvals: [],
      questions: [],
    },
    capabilities: {
      sessionId: "session",
      status: "idle",
      executionMode: "claude-managed",
      features: {
        send: { available: true },
        adopt: { available: true },
        resume: { available: true },
        fork: { available: true },
        rename: { available: true },
        archive: { available: true },
        inspect: { available: true },
        "queue-list": { available: true },
      },
    },
    page: { events: [], warnings: [] },
    liveContentVersion: 0,
    scroll: { current: null },
    setModal: vi.fn(),
    refresh: vi.fn(async () => {}),
    earlier: vi.fn(),
    control: vi.fn(),
    codexAction: vi.fn(),
    forkContinuation: vi.fn(),
    checkContinuation: vi.fn(),
    client: {
      request: vi.fn(async () => ({ available: true, models: [], workspaces: [] })),
      codexQueue: queue,
      sessionQueue: queue,
      codexResumeCommand: vi.fn(async () => ({
        available: true,
        command: "codex resume fixture",
        shell: "posix",
        runOn: "host",
      })),
      claudeResumeCommand: vi.fn(async () => ({
        available: true,
        command: "claude --resume fixture",
        shell: "posix",
        runOn: "host",
      })),
    },
  } as unknown as SessionController;
  setLocale("zh-CN");
});
afterEach(cleanup);

describe("visible session continuation terminology", () => {
  it.each(wording)(
    "keeps terminal stopping in the terminal and preserves managed stop in $locale",
    (expected) => {
      setLocale(expected.locale);
      session.canSend = false;
      // A stale consumer may retain an older canStop projection during a refresh.
      session.canStop = true;
      Object.assign(session.live!, {
        executionMode: "claude-follower",
        executionLocation: "terminal",
        status: "running",
        terminalSend: false,
        sendEnabled: false,
        stopEnabled: true,
        turnId: "terminal-turn",
      });
      const view = render(<View snapshot={session} />);
      expect(screen.getByText(expected.watch)).toBeVisible();
      expect(screen.queryByRole("button", { name: session.t.stop })).not.toBeInTheDocument();
      expect(session.control).not.toHaveBeenCalled();
      expect(claudeConnectionCopy[expected.locale].sendUnverified).toBe(expected.terminalControls);
      expect(claudeConnectionCopy[expected.locale].releasedInfo).toBe(expected.ended);

      Object.assign(session.live!, { terminalSend: true });
      redraw(view);
      expect(screen.getByText(expected.terminalHint)).toBeVisible();
      expect(screen.queryByRole("button", { name: session.t.stop })).not.toBeInTheDocument();
      expect(session.control).not.toHaveBeenCalled();

      Object.assign(session.live!, {
        executionMode: "claude-managed",
        executionLocation: "agentkib",
      });
      redraw(view);
      fireEvent.click(screen.getByRole("button", { name: session.t.stop }));
      expect(session.control).toHaveBeenCalledExactlyOnceWith("stop");
    },
  );

  it.each(wording)(
    "keeps specification wording through Claude state changes in $locale",
    (expected) => {
      setLocale(expected.locale);
      const view = render(<View snapshot={session} />);
      expect(screen.getByRole("textbox", { name: session.t.message })).toHaveAttribute(
        "placeholder",
        expected.placeholder,
      );
      expectNoExecutionHandoff(expected.locale);

      Object.assign(session.live!, {
        executionMode: "claude-follower",
        executionLocation: "terminal",
      });
      redraw(view);
      expect(screen.getAllByText(expected.terminalHint)).toHaveLength(1);
      expect(screen.getByRole("textbox", { name: session.t.message })).toHaveValue("Unsent draft");
      expectNoExecutionHandoff(expected.locale);

      // The released plugin cannot take messages from here yet: the terminal is only followed.
      Object.assign(session.live!, { sendEnabled: false, terminalSend: false });
      session.canSend = false;
      redraw(view);
      expect(screen.getAllByText(expected.watch)).toHaveLength(1);
      expect(screen.queryByText(expected.terminalHint)).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: session.t.message })).not.toBeInTheDocument();
      expectNoExecutionHandoff(expected.locale);

      Object.assign(session.live!, {
        executionMode: "claude-managed",
        executionLocation: "external",
        ownershipReason: "claude-owner-busy",
        sendEnabled: false,
      });
      session.canSend = false;
      redraw(view);
      expect(screen.getByText(expected.choice)).toBeVisible();
      expect(screen.getByText(expected.draftHint)).toBeVisible();
      expect(screen.getByText(expected.forkHint)).toBeVisible();
      expect(screen.getByRole("button", { name: expected.fork })).toBeVisible();
      expect(screen.getByRole("button", { name: expected.back })).toBeVisible();
      expect(screen.queryByRole("textbox", { name: session.t.message })).not.toBeInTheDocument();
      expectNoExecutionHandoff(expected.locale);

      // Going back to the other client only says where to continue; it offers no resume command.
      fireEvent.click(screen.getByRole("button", { name: expected.back }));
      expect(screen.getAllByText(expected.returned)).toHaveLength(1);
      expect(screen.getByText(expected.draftHint)).toBeVisible();
      expect(screen.queryByText(expected.choice)).not.toBeInTheDocument();
      expect(session.client.claudeResumeCommand).not.toHaveBeenCalled();

      Object.assign(session.live!, {
        executionLocation: null,
        ownershipReason: null,
        sendEnabled: true,
        continuationNotice: "background-ended",
      });
      session.canSend = true;
      redraw(view);
      expect(screen.getAllByText(expected.ended)).toHaveLength(1);
      expect(screen.getByRole("textbox", { name: session.t.message })).toHaveValue("Unsent draft");
      expect(screen.queryByText(expected.choice)).not.toBeInTheDocument();

      Object.assign(session.live!, {
        executionLocation: "external",
        ownershipReason: "owner-opened-elsewhere",
        sendEnabled: false,
        continuationNotice: "owner-opened-elsewhere",
      });
      session.canSend = false;
      redraw(view);
      expect(screen.getAllByText(expected.conflict)).toHaveLength(1);
      expect(screen.getByText(expected.choice)).toBeVisible();
      expect(screen.getByText(expected.draftHint)).toBeVisible();
      expectNoExecutionHandoff(expected.locale);
    },
  );

  it.each(wording)(
    "uses one actionable unsupported-platform/version reason in $locale",
    async (expected) => {
      setLocale(expected.locale);
      session.canSend = false;
      Object.assign(session.live!, {
        status: "unsupported",
        reason: "platform-unsupported",
        sendEnabled: false,
      });
      const view = render(<View snapshot={session} />);
      expect(screen.getAllByText(expected.windows)).toHaveLength(1);
      expect(screen.queryByRole("textbox", { name: session.t.message })).not.toBeInTheDocument();
      expectNoExecutionHandoff(expected.locale);

      session.current = { ...session.current!, agent: "codex" };
      Object.assign(session.live!, {
        executionMode: "codex-managed",
        reason: "codex-cli-version-too-old",
      });
      redraw(view);
      expect(screen.getAllByText(expected.oldCodex)).toHaveLength(1);
      expect(screen.queryByText(expected.windows)).not.toBeInTheDocument();
      expectNoExecutionHandoff(expected.locale);
    },
  );

  it.each(wording)(
    "keeps both Agents' queue and actions free of execution handoff entries in $locale",
    async (expected) => {
      setLocale(expected.locale);
      document.documentElement.dataset.platform = "macos";
      const view = render(<View snapshot={session} />);
      fireEvent.click(screen.getByRole("button", { name: "Inspect session actions" }));
      const actions = await screen.findByRole("dialog");
      expect(
        within(actions).queryByRole("button", { name: `${expected.terminalTitle}…` }),
      ).not.toBeInTheDocument();
      expect(within(actions).getByRole("heading", { name: expected.queue })).toBeVisible();
      expectNoExecutionHandoff(expected.locale, actions);
      expect(session.codexAction).not.toHaveBeenCalled();
      expect(session.client.request).not.toHaveBeenCalled();

      session.current = { ...session.current!, agent: "codex" };
      Object.assign(session.live!, { executionMode: "codex-managed" });
      redraw(view);
      const codexActions = await screen.findByRole("dialog");
      expect(within(codexActions).getByRole("heading", { name: expected.queue })).toBeVisible();
      expectNoExecutionHandoff(expected.locale, codexActions);
      expect(session.codexAction).not.toHaveBeenCalled();
    },
  );

  it.each(wording)(
    "preserves receipt checking before explicit queue recovery in $locale",
    async (expected) => {
      setLocale(expected.locale);
      vi.mocked(session.client.sessionQueue).mockResolvedValue({
        sessionId: "session",
        data: [],
        paused: true,
        requiresResume: true,
      });
      session.capabilities!.features["queue-resume"] = {
        available: false,
        reason: "control-outcome-unconfirmed",
      };
      render(<View snapshot={session} />);
      fireEvent.click(screen.getByRole("button", { name: "Inspect session actions" }));
      const actions = await screen.findByRole("dialog");
      expect(await within(actions).findByText(expected.queueRecovery)).toBeVisible();
      expect(within(actions).getByRole("button", { name: expected.resumeQueue })).toBeDisabled();
      expectNoExecutionHandoff(expected.locale, actions);
      expect(session.codexAction).not.toHaveBeenCalled();
    },
  );

  it("switches a mounted composer across all four locales without losing the draft or restoring old gates", () => {
    const view = render(<View snapshot={session} />);
    const composer = screen.getByRole("textbox", { name: session.t.message });
    for (const expected of wording) {
      setLocale(expected.locale);
      redraw(view);
      expect(screen.getByRole("textbox", { name: session.t.message })).toBe(composer);
      expect(composer).toHaveAttribute("placeholder", expected.placeholder);
      expect(composer).toHaveValue("Unsent draft");
      expectNoExecutionHandoff(expected.locale);
    }
    expect(session.control).not.toHaveBeenCalled();
    expect(session.forkContinuation).not.toHaveBeenCalled();
  });
});
