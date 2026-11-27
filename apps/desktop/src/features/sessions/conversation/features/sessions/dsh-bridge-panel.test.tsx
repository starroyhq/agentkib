// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render } from "../../desktop-reader-test-utils";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshBridgePanel } from "@agentkib/session-ui";

const request = vi.fn();

const connected = {
  supported: true,
  listening: true,
  runtimes: [
    {
      runtimeId: "runtime-1",
      dshVersion: "0.2.1-rc.5",
      compatibility: "verified",
      sessionController: true,
      sessions: 1,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("agentkibDesktop", { claude: { request } });
  vi.useFakeTimers();
  request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DeepSeek Harness connection panel", () => {
  it("keeps the last status while a control turns reads away, and reports a real failure", async () => {
    request.mockResolvedValueOnce(connected);
    render(<DshBridgePanel locale="en-US" />);
    await act(async () => undefined);
    expect(
      screen.getByText("Connected to 1 running DeepSeek Harness instance"),
    ).toBeInTheDocument();
    // A rename is being admitted: the host answers the status read with operation_busy.
    request.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'agentkib:claude:request': HttpError: operation_busy",
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      screen.getByText("Connected to 1 running DeepSeek Harness instance"),
    ).toBeInTheDocument();
    request.mockRejectedValueOnce(new Error("bridge stopped"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      screen.queryByText("Connected to 1 running DeepSeek Harness instance"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install the AgentKib plugin" }));
    expect(screen.getByRole("button", { name: "Copy directory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy directory" })).not.toHaveAttribute("title");
  });

  it("keeps registered controls visible before the first read and on an unsupported platform", async () => {
    request.mockResolvedValue({ supported: false, reason: "platform-unsupported" });
    render(<DshBridgePanel locale="en-US" />);
    fireEvent.click(screen.getByRole("button", { name: "Install the AgentKib plugin" }));
    expect(screen.getByRole("button", { name: "Copy directory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeDisabled();

    await act(async () => undefined);
    const reason = "Only macOS is supported for now.";
    for (const name of ["Copy directory", "Copy command"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute("title");
    }
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "dsh-bridge-status" });
  });

  it("shows an unverified DSH version as just its version", async () => {
    request.mockResolvedValueOnce({
      ...connected,
      runtimes: [
        { ...connected.runtimes[0], dshVersion: "0.2.2-rc.1", compatibility: "unverified" },
      ],
    });
    render(<DshBridgePanel locale="en-US" />);
    await act(async () => undefined);
    // A feature this DSH lacks says so where it is used, not here.
    expect(screen.getByText("Version 0.2.2-rc.1")).toBeInTheDocument();
    expect(screen.queryByText(/not been verified/)).toBeNull();
  });

  const install = {
    pluginDirectory: "/fixture/AgentKib/dsh-bridge",
    installInstructions:
      "# DeepSeek Harness\ndsh plugin --profile web add '/fixture/AgentKib/dsh-bridge'",
  };

  it("keeps the installation steps folded while a DSH is connected, and copies from them", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    request.mockResolvedValue({ ...connected, ...install });
    render(<DshBridgePanel locale="en-US" />);
    await act(async () => undefined);
    expect(screen.queryByText(install.pluginDirectory)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install the AgentKib plugin" }));
    expect(screen.getByText(install.pluginDirectory)).toBeInTheDocument();
    // The command, without the comment line above it.
    expect(
      screen.getByText("dsh plugin --profile web add '/fixture/AgentKib/dsh-bridge'"),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy directory" }));
    });
    expect(writeText).toHaveBeenCalledWith(install.pluginDirectory);
    // The button says so for a moment, then offers to copy again.
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("button", { name: "Copy directory" })).toBeInTheDocument();
  });

  it("opens the installation steps when no DSH is connected and AgentKib cannot start one", async () => {
    request.mockResolvedValue({
      supported: true,
      listening: true,
      runtimes: [],
      autoStart: { available: false, phase: "stopped", failure: null },
      ...install,
    });
    render(<DshBridgePanel locale="en-US" />);
    await act(async () => undefined);
    expect(screen.getByText(install.pluginDirectory)).toBeInTheDocument();
    expect(screen.getByText(/^DeepSeek Harness was not found/)).toBeVisible();
    cleanup();
    // AgentKib starts one when needed: installing is optional again.
    request.mockResolvedValue({
      supported: true,
      listening: true,
      runtimes: [],
      autoStart: { available: true, phase: "stopped", failure: null },
      ...install,
    });
    render(<DshBridgePanel locale="en-US" />);
    await act(async () => undefined);
    expect(
      screen.getByText(
        "DeepSeek Harness is not running. AgentKib starts it in the background when needed.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(install.pluginDirectory)).toBeNull();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
