// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "../../desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSessionOperations } from "./desktop-session-operations";
import { SessionPanelsContext } from "@agentkib/session-ui";
import { claudeConnectionCopy } from "@agentkib/session-ui";
import { sessionProviderDeclaration } from "@agentkib/web-client";
import { conversationWords } from "@/core/i18n";
import type { SessionController } from "../../desktop-session-controller";
let session: SessionController;
vi.mock("../../desktop-session-context", () => ({ useSession: () => session }));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  SessionTools: ({ open, shortcuts }: { open: boolean; shortcuts: ReactNode }) =>
    open ? <section>{shortcuts}</section> : null,
}));
const requestBridge = vi.fn();
const permissionReason = "This device does not have session management permission.";
const backgroundLabel = "Let Claude Code run tasks in the background";
const dshTitle = "DeepSeek Harness connection";
function terminalWizard() {
  return screen.queryByRole("dialog", { name: claudeConnectionCopy[session.locale].title });
}
function View({ revision = 0 }: { revision?: number }) {
  const [open, setOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  return (
    <SessionPanelsContext
      value={{
        actionsOpen: open,
        setActionsOpen: setOpen,
        filesOpen: false,
        setFilesOpen: vi.fn(),
        terminalOpen,
        setTerminalOpen,
      }}
    >
      <button onClick={() => setTerminalOpen(true)}>Open terminal directly</button>
      <DesktopSessionOperations
        open={open}
        onOpenChange={(value) => {
          if (revision >= 0) setOpen(value);
        }}
      />
    </SessionPanelsContext>
  );
}
function setManage(manage: boolean) {
  session = {
    ...session,
    access: { ...session.access!, device: { ...session.access!.device!, manage } },
  };
}
beforeEach(() => {
  document.documentElement.dataset.platform = "macos";
  vi.stubGlobal("agentkibDesktop", { claude: { request: requestBridge } });
  requestBridge.mockReset();
  requestBridge.mockImplementation(async ({ operation }: { operation: string }) => {
    if (operation === "background-tasks")
      return { backgroundTasks: { available: true, enabled: true, minimumVersion: "2.1.299" } };
    if (operation === "dsh-bridge-status")
      return { supported: true, autoStart: { available: true }, runtimes: [] };
    return {};
  });
  session = {
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    locale: "zh-CN",
    t: conversationWords("zh-CN"),
    online: false,
    access: { status: "approved", device: { manage: true, id: "test-device" } },
    choose: vi.fn(),
    formatCatalogTime: vi.fn(),
    setModal: vi.fn(),
    refresh: vi.fn(),
  } as unknown as SessionController;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Claude terminal setup entry", () => {
  it.each(["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const)(
    "keeps the terminal dialog independent of session actions in %s",
    (locale) => {
      session.locale = locale;
      session.t = conversationWords(locale);
      render(<View />);
      expect(terminalWizard()).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `${claudeConnectionCopy[locale].title}…` }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(terminalWizard()).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: session.t.close }));
      expect(terminalWizard()).not.toBeInTheDocument();
    },
  );
  it.each(["linux", "win32", undefined] as const)(
    "keeps terminal setup absent when the host is %s",
    (hostPlatform) => {
      if (hostPlatform) document.documentElement.dataset.platform = hostPlatform;
      else delete document.documentElement.dataset.platform;
      render(<View />);
      expect(screen.queryByRole("button", { name: "连接终端…" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
      expect(terminalWizard()).not.toBeInTheDocument();
    },
  );
  it("opens directly from the occupied choice signal and closes on session changes", () => {
    const view = render(<View />);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(terminalWizard()).toBeVisible();
    session.selected = "another";
    session.current = { ...session.current!, id: "another" };
    view.rerender(<View revision={1} />);
    expect(terminalWizard()).not.toBeInTheDocument();
  });
  it("does not expose local terminal setup for Codex or devices without management access", () => {
    const view = render(<View />);
    setManage(false);
    view.rerender(<View revision={1} />);
    expect(screen.queryByRole("button", { name: "连接终端…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(terminalWizard()).not.toBeInTheDocument();
    setManage(true);
    session.current = { ...session.current!, agent: "codex" };
    view.rerender(<View revision={2} />);
    expect(screen.queryByRole("button", { name: "连接终端…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(terminalWizard()).not.toBeInTheDocument();
  });
});

describe("registered host settings", () => {
  it.each(["devin", "antigravity"] as const)(
    "shows the existing %s Project Agent outside execution controls",
    async (agent) => {
      session.locale = "en-US";
      session.t = conversationWords("en-US");
      session.current = { ...session.current!, agent };
      requestBridge.mockResolvedValue({
        capable: true,
        lead: {
          sessionId: session.selected,
          paused: false,
          scope: { approvals: [], maxAutoTurns: 25 },
          workers: [],
          pendingReports: 0,
        },
      });
      render(<View />);
      expect(await screen.findByRole("heading", { name: "Project Agent" })).toBeVisible();
      expect(requestBridge).toHaveBeenCalledWith({
        operation: "lead-status",
        sessionId: session.selected,
      });
    },
  );

  it("omits the DSH switch and gates copying installation information on management access", async () => {
    session.locale = "en-US";
    session.current = { ...session.current!, agent: "deepseek-harness" };
    const view = render(<View />);
    // The full actions come from SessionTools (mocked here as its header).
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: dshTitle })).toBeInTheDocument();
    await waitFor(() =>
      expect(requestBridge).toHaveBeenCalledWith({ operation: "dsh-bridge-status" }),
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    requestBridge.mockClear();
    setManage(false);
    view.rerender(<View revision={1} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Install the AgentKib plugin"));
    for (const name of ["Copy directory", "Copy command"]) {
      const copy = screen.getByRole("button", { name });
      expect(copy).toBeDisabled();
      expect(copy).toHaveAttribute("title", permissionReason);
    }
    expect(requestBridge).not.toHaveBeenCalled();
  });

  it("keeps the Claude background setting disabled without a management grant", async () => {
    session.locale = "en-US";
    const view = render(<View />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: backgroundLabel })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    requestBridge.mockClear();
    setManage(false);
    view.rerender(<View revision={1} />);
    const toggle = screen.getByRole("switch", { name: backgroundLabel });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("title", permissionReason);
    fireEvent.click(toggle);
    expect(requestBridge).not.toHaveBeenCalled();

    setManage(true);
    session.current = { ...session.current!, agent: "codex" };
    view.rerender(<View revision={2} />);
    expect(screen.queryByRole("switch", { name: backgroundLabel })).not.toBeInTheDocument();
  });

  it("uses the selected session's declared connection and ignores another session's declaration", () => {
    session.locale = "en-US";
    session.capabilities = {
      sessionId: session.selected,
      features: {},
      provider: {
        ...sessionProviderDeclaration("claude-code")!,
        connection: { kind: "plugin-bridge" },
      },
    } as SessionController["capabilities"];
    const view = render(<View />);
    expect(screen.getByRole("heading", { name: dshTitle })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: backgroundLabel })).not.toBeInTheDocument();

    session.capabilities = { ...session.capabilities!, sessionId: "other" };
    view.rerender(<View revision={1} />);
    expect(screen.getByRole("switch", { name: backgroundLabel })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: dshTitle })).not.toBeInTheDocument();
  });
});
