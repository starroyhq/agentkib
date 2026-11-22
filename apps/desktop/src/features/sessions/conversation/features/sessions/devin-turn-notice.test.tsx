// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DevinTurnNotice, SessionPlatformProvider } from "@agentkib/session-ui";
import { WebClient } from "@agentkib/web-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopSessionPlatform } from "../../session-platform";
import { codexReason } from "../../codex-copy";

const client = new WebClient();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Notice({
  reason,
  sessionId,
  workspaceId,
  terminal = true,
}: {
  reason: string;
  sessionId?: string;
  workspaceId?: string;
  terminal?: boolean;
}) {
  const platform = useDesktopSessionPlatform(client);
  return (
    <SessionPlatformProvider
      platform={
        platform.kind === "desktop" && !terminal
          ? { ...platform, openTerminal: undefined }
          : platform
      }
    >
      <DevinTurnNotice
        reason={reason}
        reasonCopy={codexReason}
        locale="en-US"
        sessionId={sessionId}
        workspaceId={workspaceId}
      />
    </SessionPlatformProvider>
  );
}

describe("DevinTurnNotice", () => {
  it("explains a missing login and opens Devin CLI's own login on this computer", async () => {
    const devinTerminal = vi
      .spyOn(client, "devinTerminal")
      .mockResolvedValue({ terminal: "Terminal.app" });
    render(<Notice reason="devin-login-required" sessionId="session-1" />);
    expect(screen.getByText(codexReason("en-US", "devin-login-required").text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log in to Devin CLI in a terminal" }));
    expect(await screen.findByText(/Opened in Terminal\.app/)).toBeTruthy();
    expect(devinTerminal).toHaveBeenCalledWith({ action: "login", sessionId: "session-1" });
  });

  it("offers to trust the workspace, and only explains without a way to open a terminal", () => {
    const view = render(
      <Notice reason="devin-workspace-untrusted" workspaceId="w" terminal={false} />,
    );
    expect(screen.getByText(codexReason("en-US", "devin-workspace-untrusted").text)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<Notice reason="devin-workspace-untrusted" workspaceId="w" />);
    expect(screen.getByRole("button", { name: "Trust this workspace in a terminal" })).toBeTruthy();
  });

  it("stays out of the way for other reasons", () => {
    const { container } = render(<Notice reason="session-busy" />);
    expect(container.textContent).toBe("");
  });
});
