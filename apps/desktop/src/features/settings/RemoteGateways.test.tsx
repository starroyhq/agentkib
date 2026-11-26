// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { RemoteGatewaySummary } from "@/core/types";
import { RemoteGatewaysSettings } from "./RemoteGateways";

const gateway: RemoteGatewaySummary = {
  id: "gateway",
  name: "Example",
  kind: "hermes",
  url: "https://gateway.example.test",
  auth_kind: "none",
  has_credentials: false,
  state: "connected",
  capabilities: [],
  session_count: 0,
  workspaces: [],
  assets: [],
};

beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("refreshes gateways on entry and focus, and exposes a retry only for a failed gateway", () => {
  const refreshAll = vi.spyOn(api, "requestRefresh").mockImplementation(async () => {
    throw new Error("synthetic coordinator failure");
  });
  const refreshOne = vi.spyOn(api, "refreshRemoteGateway").mockResolvedValue(gateway);
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const view = (summary: RemoteGatewaySummary) => (
    <AppDialogProvider>
      <RemoteGatewaysSettings gateways={[summary]} onChanged={onChanged} />
    </AppDialogProvider>
  );
  const { rerender } = render(view(gateway));
  expect(refreshAll).toHaveBeenCalledExactlyOnceWith("gateways", false);
  expect(screen.queryByTitle(tr("gateway.refresh"))).toBeNull();
  expect(screen.queryByTitle(tr("sessions.retry"))).toBeNull();
  fireEvent(window, new Event("focus"));
  expect(refreshAll).toHaveBeenCalledTimes(2);

  rerender(view({ ...gateway, state: "error", last_error: "Unavailable" }));
  fireEvent.click(screen.getByTitle(tr("sessions.retry")));
  expect(refreshOne).toHaveBeenCalledExactlyOnceWith("gateway");
});
