// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { UsageLimitAutoContinueSetting } from "./UsageLimitAutoContinueSetting";

const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request } }) }));

const label = "Continue automatically after a usage limit resets";

beforeAll(() => initializeI18n("en-US"));
beforeEach(() => request.mockReset());
afterEach(cleanup);

describe("usage limit auto-continue setting", () => {
  it("reads the setting and writes a change", async () => {
    request.mockResolvedValueOnce({ autoContinue: true });
    render(<UsageLimitAutoContinueSetting />);
    await act(async () => undefined);
    expect(request).toHaveBeenLastCalledWith({ operation: "usage-limit-auto-continue" });
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toBeChecked();
    request.mockResolvedValueOnce({ autoContinue: false });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "usage-limit-auto-continue",
      enabled: false,
    });
    expect(screen.getByRole("switch", { name: label })).not.toBeChecked();
  });

  it("stays on and disabled when the host does not answer", async () => {
    request.mockRejectedValueOnce(new Error("claude-managed-unavailable"));
    render(<UsageLimitAutoContinueSetting />);
    await act(async () => undefined);
    const toggle = screen.getByRole("switch", { name: label });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
  });
});
