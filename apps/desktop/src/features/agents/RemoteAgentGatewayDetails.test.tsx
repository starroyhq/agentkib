// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { RemoteGatewaySummary } from "@/core/types";
import { RemoteAgentGatewayDetails } from "./RemoteAgentGatewayDetails";

const gateway: RemoteGatewaySummary = {
  id: "fixture",
  kind: "hermes",
  name: "Demo gateway",
  url: "http://127.0.0.1:9999",
  auth_kind: "none",
  has_credentials: false,
  state: "connected",
  capabilities: [],
  session_count: 0,
  workspaces: [],
  assets: [],
};
beforeEach(() => initializeI18n("en-US"));
afterEach(cleanup);
describe("Agent remote gateway data", () => {
  it("retains gateway connection state and partial-support guidance without empty data cards", () => {
    render(<RemoteAgentGatewayDetails gateways={[gateway]} />);
    expect(screen.getByText("Demo gateway")).toBeTruthy();
    expect(screen.getByText(tr("gateway.state.connected"))).toBeTruthy();
    expect(screen.getByText(tr("gateway.hermesPartial"))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: tr("gateway.remoteWorkspaces") })).toBeNull();
    expect(screen.queryByRole("heading", { name: tr("gateway.remoteAssets") })).toBeNull();
  });
  it("shows actual remote workspaces and assets using their original remote paths", () => {
    render(
      <RemoteAgentGatewayDetails
        gateways={[
          {
            ...gateway,
            workspaces: [
              {
                id: "workspace",
                name: "Remote project",
                path: "/fixture/home/project",
                session_count: 1,
              },
            ],
            assets: [
              {
                id: "asset",
                kind: "instruction",
                name: "Remote guide",
                path: "/fixture/home/AGENTS.md",
                size: 1,
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: tr("gateway.remoteWorkspaces") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: tr("gateway.remoteAssets") })).toBeTruthy();
    expect(screen.getByText("/fixture/home/project")).toBeTruthy();
    expect(screen.getByText("/fixture/home/AGENTS.md")).toBeTruthy();
  });
});
