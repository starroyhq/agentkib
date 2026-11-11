import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { dictionaries } from "@/features/conversation/i18n";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { SessionLayout } from "./session-layout";

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: "/sessions" }),
  Outlet: () => null,
  Navigate: () => null,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/providers/environment", () => ({ useEnvironment: () => ({ hosted: false }) }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  useSession: vi.fn(),
}));
vi.mock("@/features/conversation/features/sessions/session-dialogs", () => ({
  SessionDialogs: () => null,
}));
vi.mock("@/features/connection/pairing-page", () => ({ PairingPage: () => null }));

let state: ReturnType<typeof useSession>;
beforeEach(() => {
  state = {
    access: { status: "approved" },
    connection: { type: "lan-http" },
    origin: "http://192.0.2.10:1422",
    error: "unavailable",
    sessions: [],
    incompatible: false,
    refresh: vi.fn(),
    setIncompatible: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("LAN error instructions", () => {
  it.each([
    ["zh-CN", "电脑上的 AgentKib"],
    ["zh-TW", "電腦上的 AgentKib"],
    ["en-US", "AgentKib on your computer"],
    ["ja-JP", "コンピューター上の AgentKib"],
  ] as const)("identifies the computer application in general errors in %s", (locale, app) => {
    state.t = dictionaries[locale];
    state.locale = locale;
    state.connection = { type: "same-origin" };
    const view = render(<SessionLayout />);
    expect(screen.getByRole("alert")).toHaveTextContent(state.t.error);
    expect(screen.getByRole("alert")).toHaveTextContent(app);
    expect(screen.getByRole("alert").textContent).not.toMatch(/桌面|デスクトップ|\bdesktop\b/i);
    expect(view.container.textContent).not.toMatch(/桌面|デスクトップ|\bdesktop\b/i);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["zh-CN", "电脑上的 AgentKib"],
    ["zh-TW", "電腦上的 AgentKib"],
    ["en-US", "AgentKib on your computer"],
    ["ja-JP", "コンピューター上の AgentKib"],
  ] as const)(
    "identifies the computer application for failure and incompatible protocol in %s",
    (locale, app) => {
      state.t = dictionaries[locale];
      const view = render(<SessionLayout />);
      expect(screen.getByRole("alert")).toHaveTextContent(app);
      expect(screen.getByRole("alert")).toHaveTextContent(state.t.lanFailure);
      state.incompatible = true;
      view.rerender(<SessionLayout />);
      expect(screen.getByRole("alert")).toHaveTextContent(app);
      expect(screen.getByRole("alert")).toHaveTextContent(state.t.lanIncompatible);
      fireEvent.click(screen.getByRole("button", { name: state.t.retry }));
      expect(state.setIncompatible).toHaveBeenCalledWith(false);
      expect(state.refresh).toHaveBeenCalledWith(true);
    },
  );
});
