// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  pushPolicyVersion = supported ? 2 : undefined,
  workerResults,
  fullAccess = true,
  failRead = false,
  failWrite = false,
}: {
  supported?: boolean;
  pushPolicyVersion?: 1 | 2;
  workerResults?: boolean;
  fullAccess?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
} = {}) {
  let policy: NotificationPolicy = {
    enabled: true,
    categories: { approval: true, question: true, completed: true, failed: true },
    onlyAway: true,
    quietHours: null,
    ...(pushPolicyVersion === 2 ? { workerResults: workerResults ?? false } : {}),
  };
  const request = vi.fn<DesktopConversationBridge["request"]>(async (route, body) => {
    if (route === "access" || route === "access?pushPolicyVersion=2")
      return reply({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "test",
        bootId: "boot",
        ...(pushPolicyVersion !== undefined ? { pushPolicyVersion } : {}),
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
    applyExternalPatch: (patch: NotificationPolicyPatch) => {
      policy = { ...policy, ...patch, categories: { ...policy.categories, ...patch.categories } };
    },
  };
}

describe("desktop notification policy", () => {
  it("leaves settings unavailable on a host with no versioned policy and renders no Save button", async () => {
    const { request } = fixture({ supported: false });
    await screen.findByText("Notification settings are unavailable.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(request.mock.calls.map(([route]) => route)).toEqual(["access?pushPolicyVersion=2"]);
  });

  it("omits Worker results on a version 1 host while keeping existing switches editable", async () => {
    const { request } = fixture({ pushPolicyVersion: 1 });
    const user = userEvent.setup();
    const completed = await screen.findByRole("switch", { name: "Completed turns" });
    expect(completed.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Worker results" })).toBeNull();
    expect(request.mock.calls[0]?.[0]).toBe("access?pushPolicyVersion=2");

    await user.click(completed);
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", {
        categories: { completed: false },
      }),
    );
  });

  it("shows Worker results off by default on a version 2 host, saves immediately without hint copy, and survives v1 edits", async () => {
    const { request, applyExternalPatch } = fixture({ pushPolicyVersion: 2 });
    const user = userEvent.setup();
    const workerSwitch = await screen.findByRole("switch", { name: "Worker results" });
    expect(workerSwitch.getAttribute("aria-checked")).toBe("false");
    expect(workerSwitch.hasAttribute("aria-describedby")).toBe(false);

    // Confirm the switch sits right next to Completed / Failed turns.
    const switches = screen.getAllByRole("switch");
    const failedIdx = switches.indexOf(screen.getByRole("switch", { name: "Failed turns" }));
    const workerIdx = switches.indexOf(workerSwitch);
    expect(workerIdx).toBe(failedIdx + 1);

    await user.click(workerSwitch);
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", { workerResults: true }),
    );
    await waitFor(() => expect(workerSwitch.getAttribute("aria-checked")).toBe("true"));

    // Simulate an older client updating another field without sending workerResults.
    applyExternalPatch({ categories: { failed: false } });
    request.mockClear();
    await act(async () => {
      fireEvent(window, new Event("focus"));
      expect(request.mock.calls).toEqual([["push/policy", undefined]]);
      await request.mock.results[0]!.value;
    });
    expect(workerSwitch.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Failed turns" }).getAttribute("aria-checked")).toBe(
      "false",
    );

    await user.click(workerSwitch);
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", { workerResults: false }),
    );
    await waitFor(() => expect(workerSwitch.getAttribute("aria-checked")).toBe("false"));
  });

  it("disables Worker results on read-only devices and reverts on save failure", async () => {
    fixture({ pushPolicyVersion: 2, fullAccess: false });
    const readOnlySwitch = await screen.findByRole("switch", { name: "Worker results" });
    expect(readOnlySwitch.getAttribute("aria-checked")).toBe("false");
    expect(readOnlySwitch.hasAttribute("data-disabled")).toBe(true);
    cleanup();

    fixture({ pushPolicyVersion: 2, failWrite: true });
    const user = userEvent.setup();
    const workerSwitch = await screen.findByRole("switch", { name: "Worker results" });
    await user.click(workerSwitch);
    await screen.findByText("Could not save notification settings.");
    await waitFor(() => expect(workerSwitch.getAttribute("aria-checked")).toBe("false"));
  });

  it("applies each switch immediately via a single-field patch without a Save button", async () => {
    const { request, replacePolicy } = fixture();
    const user = userEvent.setup();
    const approvals = await screen.findByRole("switch", { name: "Approvals" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    // Another device disables completed turns before this device toggles approvals.
    replacePolicy({
      categories: { approval: true, question: true, completed: false, failed: true },
    });
    await user.click(approvals);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("push/policy", {
        categories: { approval: false },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Completed turns" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );

    await user.click(screen.getByRole("switch", { name: "Notify only when I'm away" }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", {
        onlyAway: false,
      }),
    );
  });

  it("validates quiet hours locally and applies valid intervals and clearing immediately", async () => {
    const { request } = fixture();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", {
        quietHours: { start: "22:00", end: "08:00" },
      }),
    );

    const start = screen.getByLabelText<HTMLInputElement>("Quiet hours start");
    expect(start.value).toBe("22:00");
    request.mockClear();
    fireEvent.change(start, { target: { value: "08:00" } });
    await screen.findByText("Choose different start and end times.");
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(start, { target: { value: "21:30" } });
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", {
        quietHours: { start: "21:30", end: "08:00" },
      }),
    );

    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("push/policy", { quietHours: null }),
    );
  });

  it("refreshes the policy on focus when idle", async () => {
    const { request, replacePolicy } = fixture();
    await screen.findByRole("switch", { name: "Approvals" });
    const approval = screen.getByRole("switch", { name: "Approvals" });
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    replacePolicy({
      categories: { approval: false, question: true, completed: true, failed: true },
    });
    request.mockClear();
    await act(async () => {
      fireEvent(window, new Event("focus"));
      expect(request.mock.calls).toEqual([["push/policy", undefined]]);
      await request.mock.results[0]!.value;
    });
    expect(approval.getAttribute("aria-checked")).toBe("false");
  });

  it("shows policy values without enabling writes for a device lacking settings authority", async () => {
    const { request } = fixture({ fullAccess: false });
    const enabled = await screen.findByRole("switch", {
      name: "Send notifications from this computer",
    });
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    expect(enabled.hasAttribute("data-disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(request.mock.calls.filter(([route]) => route === "push/policy")).toEqual([
      ["push/policy", undefined],
    ]);
  });

  it("retries a failed read and reverts the switch when the host refuses a write", async () => {
    fixture({ failRead: true, failWrite: true });
    const user = userEvent.setup();
    await screen.findByText("Could not read notification settings.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const failedSwitch = await screen.findByRole("switch", { name: "Failed turns" });
    await user.click(failedSwitch);
    await screen.findByText("Could not save notification settings.");
    await waitFor(() => expect(failedSwitch.getAttribute("aria-checked")).toBe("true"));
  });
});
