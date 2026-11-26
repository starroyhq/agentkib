// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NotificationPolicy, NotificationPolicyPatch } from "@agentkib/runtime-protocol";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { initializeI18n } from "@/core/i18n";
import { NotificationPolicySettings } from "./NotificationPolicySettings";

const previous = window.desktopConversation;
beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  window.desktopConversation = previous;
});

function reply(body: unknown, status = 200): DesktopConversationResponse {
  return { body, status };
}

function fixture({
  supported = true,
  fullAccess = true,
  failRead = false,
  failWrite = false,
}: { supported?: boolean; fullAccess?: boolean; failRead?: boolean; failWrite?: boolean } = {}) {
  let policy: NotificationPolicy = {
    enabled: true,
    categories: { approval: true, question: true, completed: true, failed: true },
    onlyAway: true,
    quietHours: null,
  };
  const request = vi.fn<DesktopConversationBridge["request"]>(async (route, body) => {
    if (route === "access")
      return reply({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "test",
        bootId: "boot",
        ...(supported ? { pushPolicyVersion: 1 } : {}),
        device: { id: "desktop-local", name: "Desktop", accessMode: "full", settings: fullAccess },
      });
    if (route === "push/policy") {
      if (body === undefined) {
        if (failRead) {
          failRead = false;
          return reply({ error: "read_failed" }, 503);
        }
        return reply({ policy });
      }
      if (failWrite) return reply({ error: "permission_denied" }, 403);
      const patch = body as NotificationPolicyPatch;
      policy = { ...policy, ...patch, categories: { ...policy.categories, ...patch.categories } };
      return reply({ policy });
    }
    return reply({ error: "unexpected_test_request" }, 404);
  });
  window.desktopConversation = {
    request,
    upload: vi.fn(),
    subscribe: vi.fn(),
    acknowledge: vi.fn(),
    unsubscribe: vi.fn(),
    onEvent: vi.fn(),
    onUnavailable: vi.fn(),
    onControlChanged: vi.fn(),
  };
  render(<NotificationPolicySettings />);
  return {
    request,
    replacePolicy: (next: Partial<NotificationPolicy>) => {
      policy = { ...policy, ...next };
    },
  };
}

function saveButton() {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
}

describe("desktop notification policy", () => {
  it("leaves settings disabled on a host with no versioned policy", async () => {
    const { request } = fixture({ supported: false });
    await screen.findByText("Notification settings are unavailable.");
    expect(saveButton().disabled).toBe(true);
    expect(request.mock.calls.map(([route]) => route)).toEqual(["access"]);
  });

  it("reads the shared policy and saves only changed categories and timing", async () => {
    const { request, replacePolicy } = fixture();
    const user = userEvent.setup();
    const approvals = await screen.findByRole("switch", { name: "Approvals" });
    await user.click(approvals);
    await user.click(screen.getByRole("switch", { name: "Notify only when I'm away" }));
    expect(request.mock.calls.filter(([route]) => route === "push/policy")).toHaveLength(1);
    // Another device disables notifications for completed turns before this device saves.
    replacePolicy({
      categories: { approval: true, question: true, completed: false, failed: true },
    });
    await user.click(saveButton());
    await waitFor(() =>
      expect(saveButton().closest("form")?.getAttribute("aria-busy")).toBe("false"),
    );
    expect(screen.queryByText("Notification settings saved.")).toBeNull();
    expect(request).toHaveBeenLastCalledWith("push/policy", {
      categories: { approval: false },
      onlyAway: false,
    });
    expect(
      screen.getByRole("switch", { name: "Completed turns" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });

  it("validates quiet hours locally and clears them on an explicit save", async () => {
    const { request } = fixture();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Quiet hours" }));
    const start = screen.getByLabelText<HTMLInputElement>("Quiet hours start");
    expect(start.value).toBe("22:00");
    fireEvent.change(start, { target: { value: "08:00" } });
    await screen.findByText("Choose different start and end times.");
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(start, { target: { value: "21:30" } });
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() =>
      expect(saveButton().closest("form")?.getAttribute("aria-busy")).toBe("false"),
    );
    expect(screen.queryByText("Notification settings saved.")).toBeNull();
    expect(request).toHaveBeenLastCalledWith("push/policy", {
      quietHours: { start: "21:30", end: "08:00" },
    });
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await user.click(saveButton());
    await waitFor(() =>
      expect(saveButton().closest("form")?.getAttribute("aria-busy")).toBe("false"),
    );
    expect(screen.queryByText("Notification settings saved.")).toBeNull();
    expect(request).toHaveBeenLastCalledWith("push/policy", { quietHours: null });
  });

  it("updates the policy on focus while preserving in-progress edits", async () => {
    const { request, replacePolicy } = fixture();
    const approval = await screen.findByRole("switch", { name: "Approvals" });
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    replacePolicy({
      categories: { approval: false, question: true, completed: true, failed: true },
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(approval.getAttribute("aria-checked")).toBe("false"));
    const user = userEvent.setup();
    await user.click(approval);
    expect(saveButton().disabled).toBe(false);
    request.mockClear();
    fireEvent(window, new Event("focus"));
    expect(request).not.toHaveBeenCalled();
    expect(approval.getAttribute("aria-checked")).toBe("true");
  });

  it("shows policy values without enabling writes for a device lacking settings authority", async () => {
    const { request } = fixture({ fullAccess: false });
    const enabled = await screen.findByRole("switch", {
      name: "Send notifications from this computer",
    });
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    expect(enabled.hasAttribute("data-disabled")).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(request.mock.calls.filter(([route]) => route === "push/policy")).toEqual([
      ["push/policy", undefined],
    ]);
  });

  it("retries a failed read and preserves the draft when the host refuses a write", async () => {
    fixture({ failRead: true, failWrite: true });
    const user = userEvent.setup();
    await screen.findByText("Could not read notification settings.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(await screen.findByRole("switch", { name: "Failed turns" }));
    await user.click(saveButton());
    await screen.findByText("Could not save notification settings.");
    expect(screen.getByRole("switch", { name: "Failed turns" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(saveButton().disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("switch", { name: "Failed turns" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(saveButton().disabled).toBe(true);
  });
});
