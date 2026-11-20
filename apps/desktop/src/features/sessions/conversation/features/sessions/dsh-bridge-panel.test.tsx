// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshBridgePanel } from "./dsh-bridge-panel";

const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request } }) }));
vi.mock("./session-context", () => ({ useSession: () => ({ locale: "en-US" }) }));

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
  vi.useFakeTimers();
  request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DeepSeek Harness connection panel", () => {
  const switchName = "Start DeepSeek Harness when needed";
  const serviceUnavailable = "AgentKib's connection service is not running.";

  it("keeps the last status while a control turns reads away, and reports a real failure", async () => {
    request.mockResolvedValueOnce(connected);
    render(<DshBridgePanel />);
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
    expect(screen.getByRole("switch", { name: switchName })).not.toHaveAttribute(
      "title",
      serviceUnavailable,
    );
    expect(
      screen.getByText("Connected to 1 running DeepSeek Harness instance"),
    ).toBeInTheDocument();
    request.mockRejectedValueOnce(new Error("bridge stopped"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const toggle = screen.getByRole("switch", { name: switchName });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("title", serviceUnavailable);
    expect(screen.queryByText(serviceUnavailable)).not.toBeInTheDocument();
  });

  it("keeps registered controls visible before the first read and on an unsupported platform", async () => {
    request.mockResolvedValue({ supported: false, reason: "platform-unsupported" });
    render(<DshBridgePanel />);
    const toggle = screen.getByRole("switch", { name: switchName });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("title", "Reading connection settings.");
    fireEvent.click(screen.getByRole("button", { name: "Install the AgentKib plugin" }));
    expect(screen.getByRole("button", { name: "Copy directory" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeDisabled();

    await act(async () => undefined);
    const reason = "Only macOS is supported for now.";
    expect(toggle).toHaveAttribute("title", reason);
    for (const name of ["Copy directory", "Copy command"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", reason);
    }
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "dsh-bridge-status" });
  });

  it("shows an unverified DSH version as just its version", async () => {
    request.mockResolvedValueOnce({
      ...connected,
      runtimes: [
        { ...connected.runtimes[0], dshVersion: "0.2.2-rc.1", compatibility: "unverified" },
      ],
    });
    render(<DshBridgePanel />);
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
    render(<DshBridgePanel />);
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
      autoStart: { enabled: true, available: false, phase: "stopped", failure: null },
      ...install,
    });
    render(<DshBridgePanel />);
    await act(async () => undefined);
    expect(screen.getByText(install.pluginDirectory)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: switchName })).not.toHaveAttribute("aria-disabled");
    cleanup();
    // AgentKib starts one when needed: installing is optional again.
    request.mockResolvedValue({
      supported: true,
      listening: true,
      runtimes: [],
      autoStart: { enabled: true, available: true, phase: "stopped", failure: null },
      ...install,
    });
    render(<DshBridgePanel />);
    await act(async () => undefined);
    expect(screen.queryByText(install.pluginDirectory)).toBeNull();
  });
});
