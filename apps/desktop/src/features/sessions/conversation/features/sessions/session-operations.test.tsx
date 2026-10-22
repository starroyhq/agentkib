// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionOperations } from "./session-operations";
import { SessionPanelsContext } from "./session-panels";
import { claudeConnectionCopy } from "./claude-connection-copy";
import { conversationWords } from "@/core/i18n";
import type { SessionController } from "./use-session-controller";
let session: SessionController;
vi.mock("./session-context", () => ({ useSession: () => session }));
vi.mock("./managed-tasks", () => ({
  ManagedTasks: ({ renderContent }: { renderContent: (content: ReactNode) => ReactNode }) =>
    renderContent(null),
}));
vi.mock("./codex-tools", () => ({
  CodexTools: ({ open, shortcuts }: { open: boolean; shortcuts: ReactNode }) =>
    open ? <section>{shortcuts}</section> : null,
}));
vi.mock("./claude-bridge-panel", () => ({
  ClaudeBridgePanel: ({ onClose }: { onClose?: () => void }) => (
    <section role="dialog" aria-label={claudeConnectionCopy[session.locale].title}>
      <p>Terminal wizard</p>
      <button onClick={onClose}>Close terminal</button>
    </section>
  ),
}));
vi.mock("../../components/dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
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
      <SessionOperations
        open={open}
        onOpenChange={(value) => {
          if (revision >= 0) setOpen(value);
        }}
      />
    </SessionPanelsContext>
  );
}
beforeEach(() => {
  document.documentElement.dataset.platform = "macos";
  session = {
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    locale: "zh-CN",
    t: conversationWords("zh-CN"),
    access: { device: { manage: true } },
    setModal: vi.fn(),
    refresh: vi.fn(),
  } as unknown as SessionController;
});
afterEach(cleanup);
describe("Claude terminal setup entry", () => {
  it.each(["zh-CN", "zh-TW", "ja-JP", "en-US"] as const)(
    "keeps the terminal dialog independent of session actions in %s",
    (locale) => {
      session.locale = locale;
      session.t = conversationWords(locale);
      render(<View />);
      expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: `${claudeConnectionCopy[locale].title}…` }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(
        screen.getByRole("dialog", { name: claudeConnectionCopy[locale].title }),
      ).toHaveTextContent("Terminal wizard");
      fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
      expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
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
      expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
    },
  );
  it("opens directly from the occupied choice signal and closes on session changes", () => {
    const view = render(<View />);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(screen.getByText("Terminal wizard")).toBeVisible();
    session.selected = "another";
    session.current = { ...session.current!, id: "another" };
    view.rerender(<View revision={1} />);
    expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
  });
  it("does not expose local terminal setup for Codex or devices without management access", () => {
    const view = render(<View />);
    session.access!.device!.manage = false;
    view.rerender(<View revision={1} />);
    expect(screen.queryByRole("button", { name: "连接终端…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
    session.access!.device!.manage = true;
    session.current = { ...session.current!, agent: "codex" };
    view.rerender(<View revision={2} />);
    expect(screen.queryByRole("button", { name: "连接终端…" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal directly" }));
    expect(screen.queryByText("Terminal wizard")).not.toBeInTheDocument();
  });
});
