import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { WebClient, type ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "@/features/conversation/i18n";
import { useSessionController } from "@/features/conversation/features/sessions/use-session-controller";
import { SessionDialogs } from "@/features/conversation/features/sessions/session-dialogs";

const state = vi.hoisted(() => ({ modal: undefined as unknown }));
vi.mock("@/features/conversation/features/sessions/use-session-live", () => ({
  useSessionLive: ({
    streamReady,
    selected,
    setControlReady,
  }: {
    streamReady: { current: boolean };
    selected: string;
    setControlReady: (ready: boolean) => void;
  }) => {
    useEffect(() => {
      streamReady.current = !!selected;
      setControlReady(!!selected);
    }, [streamReady, selected, setControlReady]);
  },
}));
vi.mock("@/features/conversation/features/preferences/use-appearance", () => ({
  useAppearance: () => {},
}));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => ({ modal: state.modal, t: dictionaries["zh-CN"], locale: "zh-CN" }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("production session guidance", () => {
  const t = dictionaries["zh-CN"];
  vi.spyOn(WebClient.prototype, "stream").mockImplementation(() => () => {});
  it.each([
    ["handoff-required", t.unavailable],
    ["open-in-original-client", t.openOriginalClient],
    ["unverified-installation", t.unverifiedInstallation],
    ["platform-unsupported", t.unsupportedControl],
    ["provider-unsupported", t.unsupportedControl],
    ["private runtime error", t.unavailable],
    ["control-outcome-unconfirmed", t.controlUnconfirmed],
  ])("maps live reason %s in the controller", async (reason, expected) => {
    vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
      status: "approved",
      protocolVersion: 2,
      csrfToken: "test",
      bootId: "boot",
      experimentalEnabled: false,
    });
    vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
      indexEnabled: true,
      sessions: [
        {
          id: "test",
          workspace_id: "w",
          agent: "codex",
          availability: "readable",
          archived: false,
          sidechain: false,
        },
      ],
    });
    vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
    vi.spyOn(WebClient.prototype, "live").mockResolvedValue({
      status: "unavailable",
      reason,
      sessionId: "test",
      revision: 1,
      sendEnabled: false,
      approvals: [],
    });
    const { result } = renderHook(() => useSessionController({}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.choose("test"));
    expect(result.current.liveText).toBe(expected);
  });

  it.each([undefined, "", "   ", "  saved tool content  "])(
    "renders tool summary content %s in the dialog",
    (content) => {
      state.modal = {
        id: "tool",
        kind: "tool-summary",
        content,
        truncated: true,
        attachment_count: 0,
      } satisfies ConversationEvent;
      render(<SessionDialogs />);
      expect(screen.getByRole("dialog")).toHaveTextContent(
        content?.trim() ? content.trim() : t.toolSummaryUnavailable,
      );
      expect(screen.getByText(t.truncated)).toBeVisible();
      expect(screen.queryByText(t.history)).not.toBeInTheDocument();
      if (content?.trim()) expect(document.querySelector("pre")?.textContent).toBe(content);
    },
  );

  it.each([false, true])(
    "shows unknown DSH status and honors the explicit send grant (%s)",
    async (sendEnabled) => {
      vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "test",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "device", name: "Browser", send: true, approve: false },
      });
      vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
        indexEnabled: true,
        sessions: [
          {
            id: "dsh-session",
            workspace_id: "workspace",
            agent: "deepseek-harness",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
      vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
      vi.spyOn(WebClient.prototype, "live").mockResolvedValue({
        sessionId: "dsh-session",
        status: "unsupported",
        reason: "dsh-native-status-unknown",
        revision: 4,
        sendEnabled,
        stopEnabled: false,
        approvals: [],
        executionMode: "dsh-follower",
      });
      const { result } = renderHook(() => useSessionController({}));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      await act(() => result.current.choose("dsh-session"));
      expect(result.current.liveText).toBe("实时状态未知");
      expect(result.current.canSend).toBe(sendEnabled);
      expect(result.current.canStop).toBe(false);
    },
  );

  it.each(["running", "waiting-approval"])(
    "stops the exact active Antigravity turn while %s",
    async (status) => {
      vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "test",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "device", name: "Browser", send: true, approve: false },
      });
      vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
        indexEnabled: true,
        sessions: [
          {
            id: "antigravity-session",
            workspace_id: "workspace",
            agent: "antigravity",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
      vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
      vi.spyOn(WebClient.prototype, "live").mockResolvedValue({
        sessionId: "antigravity-session",
        status,
        revision: 4,
        turnId: '"prompt-4"',
        sendEnabled: false,
        stopEnabled: true,
        approvals: [],
        executionMode: "acp-managed",
      });
      const request = vi
        .spyOn(WebClient.prototype, "request")
        .mockResolvedValue({ accepted: true });
      const { result } = renderHook(() => useSessionController({}));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      await act(() => result.current.choose("antigravity-session"));
      expect(result.current.canStop).toBe(true);
      await act(() => result.current.control("stop"));
      expect(request).toHaveBeenCalledWith(
        "stop",
        expect.objectContaining({
          sessionId: "antigravity-session",
          bootId: "boot",
          expectedRevision: 4,
          turnId: '"prompt-4"',
        }),
      );
    },
  );
});
