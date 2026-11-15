// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexReason } from "./codex-copy";
import { DevinTurnNotice } from "./devin-turn-notice";

afterEach(cleanup);

describe("DevinTurnNotice", () => {
  it("explains a missing login and opens Devin CLI's own login on this computer", async () => {
    const devinTerminal = vi.fn(async () => ({ terminal: "Terminal.app" }));
    render(
      <DevinTurnNotice
        reason="devin-login-required"
        locale="en-US"
        client={{ devinTerminal }}
        sessionId="session-1"
      />,
    );
    expect(screen.getByText(codexReason("en-US", "devin-login-required").text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log in to Devin CLI in a terminal" }));
    expect(await screen.findByText(/Opened in Terminal\.app/)).toBeTruthy();
    expect(devinTerminal).toHaveBeenCalledWith({ action: "login", sessionId: "session-1" });
  });

  it("offers to trust the workspace, and only explains without a way to open a terminal", () => {
    const view = render(
      <DevinTurnNotice reason="devin-workspace-untrusted" locale="en-US" workspaceId="w" />,
    );
    expect(screen.getByText(codexReason("en-US", "devin-workspace-untrusted").text)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <DevinTurnNotice
        reason="devin-workspace-untrusted"
        locale="en-US"
        client={{ devinTerminal: vi.fn() }}
        workspaceId="w"
      />,
    );
    expect(screen.getByRole("button", { name: "Trust this workspace in a terminal" })).toBeTruthy();
  });

  it("stays out of the way for other reasons", () => {
    const { container } = render(<DevinTurnNotice reason="session-busy" locale="en-US" />);
    expect(container.textContent).toBe("");
  });
});
