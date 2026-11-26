// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { claudeConnectionCopy } from "@agentkib/session-ui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { ClaudeBridgePluginSettings } from "./ClaudeBridgePluginSettings";

const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request } }) }));

const copy = claudeConnectionCopy["en-US"];
const ready = {
  installedVersion: "0.5.9",
  bundledVersion: "0.5.9",
  status: "idle",
  automaticEnabled: true,
  canChangeAutomatic: true,
  installations: [
    { scope: "user", version: "0.5.9" },
    { scope: "project", version: "0.5.4", projectPath: "/fixture/project" },
    { scope: "local", version: "0.5.6", projectPath: "/fixture/local" },
  ],
};

function toggle() {
  return screen.getByRole("switch", { name: copy.pluginAutomatic });
}

beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Claude plugin installation settings", () => {
  it("reads each installation scope and lets the user turn automation off", async () => {
    let enabled = true;
    request.mockImplementation(async ({ operation, enabled: next }) => {
      if (operation === "bridge-plugin-auto-update") enabled = next;
      return { ...ready, automaticEnabled: enabled };
    });
    render(<ClaudeBridgePluginSettings />);

    expect(toggle()).toBeChecked();
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText(/0\.5\.4/)).toHaveTextContent(copy.pluginScopeProject);
    expect(screen.getByText(`${copy.pluginScopeUser} · 0.5.9`)).toBeVisible();
    expect(screen.getByText(`${copy.pluginScopeLocal} · 0.5.6`)).toBeVisible();
    expect(screen.getByTitle("/fixture/project")).toBeVisible();
    expect(screen.getByTitle("/fixture/local")).toBeVisible();
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull();

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(request).toHaveBeenCalledWith({
      operation: "bridge-plugin-auto-update",
      enabled: false,
    });
    expect(request).toHaveBeenCalledWith({ operation: "bridge-plugin-status" });
  });

  it("keeps the unavailable switch visible with the reason in a tooltip", async () => {
    request.mockResolvedValue({ ...ready, canChangeAutomatic: false, automaticEnabled: false });
    render(<ClaudeBridgePluginSettings />);

    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTitle(copy.pluginAutomaticUnavailable)).toContainElement(toggle());
    expect(screen.queryByText(copy.pluginAutomaticUnavailable)).toBeNull();
    fireEvent.click(toggle());
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "bridge-plugin-status" });
  });

  it("updates the scopes when migration completes", async () => {
    vi.useFakeTimers();
    request
      .mockResolvedValueOnce({
        ...ready,
        status: "updating",
        installations: [ready.installations[1]],
      })
      .mockResolvedValueOnce({
        ...ready,
        status: "updated",
        installations: [ready.installations[0]],
      });
    render(<ClaudeBridgePluginSettings />);
    await act(async () => undefined);
    expect(screen.getByRole("status")).toHaveTextContent(copy.pluginUpdating);
    expect(screen.getByText(`${copy.pluginScopeProject} · 0.5.4`)).toBeVisible();

    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(screen.getByText(`${copy.pluginScopeUser} · 0.5.9`)).toBeVisible();
    expect(screen.queryByText(`${copy.pluginScopeProject} · 0.5.4`)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(copy.pluginUpdated);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shows manual steps only as part of an installation failure", async () => {
    const command = "claude plugin install agentkib-bridge@agentkib-local --scope user";
    request.mockResolvedValue({
      ...ready,
      installedVersion: null,
      installations: [],
      status: "failed",
      reason: "Fixture marketplace could not be added",
      installInstructions: command,
    });
    render(<ClaudeBridgePluginSettings />);

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(copy.pluginAutomaticFailed);
    expect(failure).toHaveTextContent("Fixture marketplace could not be added");
    expect(failure).toHaveTextContent(command);
  });
});
