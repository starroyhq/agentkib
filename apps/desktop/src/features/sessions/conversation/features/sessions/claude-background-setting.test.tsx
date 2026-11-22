// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render } from "../../desktop-reader-test-utils";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackgroundSetting } from "@agentkib/session-ui";

const request = vi.fn();

const status = (backgroundTasks: Record<string, unknown>) => ({
  backgroundTasks: {
    enabled: true,
    available: true,
    reason: null,
    minimumVersion: "2.1.299",
    cliVersion: "2.1.323",
    ...backgroundTasks,
  },
});
const label = "Let Claude Code run tasks in the background";

beforeEach(() => {
  vi.stubGlobal("agentkibDesktop", { claude: { request } });
  request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Claude Code background tasks setting", () => {
  it("reads the setting and writes a change", async () => {
    request.mockResolvedValueOnce(status({}));
    render(<ClaudeBackgroundSetting locale="en-US" />);
    await act(async () => undefined);
    expect(request).toHaveBeenLastCalledWith({ operation: "background-tasks" });
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(screen.getByText(/Quitting AgentKib stops them/)).toBeInTheDocument();
    request.mockResolvedValueOnce(status({ enabled: false }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(request).toHaveBeenLastCalledWith({ operation: "background-tasks", enabled: false });
    expect(screen.getByRole("switch", { name: label })).not.toBeChecked();
  });

  it("says why it cannot be turned on", async () => {
    request.mockResolvedValueOnce(
      status({ available: false, reason: "claude-cli-too-old", cliVersion: "2.1.263" }),
    );
    render(<ClaudeBackgroundSetting locale="en-US" />);
    await act(async () => undefined);
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute(
      "title",
      "Requires Claude Code 2.1.299 or later (this computer has 2.1.263).",
    );
    expect(screen.queryByText(/Requires Claude Code/)).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps the switch disabled after a bridge failure (synchronous: %s)",
    async (synchronous) => {
      const error = new Error("Electron preload bridge is unavailable");
      if (synchronous)
        request.mockImplementationOnce(() => {
          throw error;
        });
      else request.mockRejectedValueOnce(error);
      render(<ClaudeBackgroundSetting locale="en-US" />);
      const toggle = screen.getByRole("switch", { name: label });
      expect(toggle).toHaveAttribute("title", "Reading settings.");
      await act(async () => undefined);
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(toggle).toHaveAttribute(
        "title",
        "The current runtime does not provide a background task setting.",
      );
      fireEvent.click(toggle);
      expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "background-tasks" });
    },
  );
});
