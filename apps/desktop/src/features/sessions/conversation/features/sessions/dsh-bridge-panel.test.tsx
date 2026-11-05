// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.queryByText("AgentKib's connection service is not running.")).toBeNull();
    expect(
      screen.getByText("Connected to 1 running DeepSeek Harness instance"),
    ).toBeInTheDocument();
    request.mockRejectedValueOnce(new Error("bridge stopped"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("AgentKib's connection service is not running.")).toBeInTheDocument();
  });
});
