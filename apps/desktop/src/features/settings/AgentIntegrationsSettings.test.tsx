// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { AgentIntegrationsSettings } from "./AgentIntegrationsSettings";
import { SettingsSection, settingsTargetId } from "./components/SettingsLayout";
import { useSettingsTargetFocus } from "./useSettingsTargetFocus";
import type { SettingsTarget } from "./SettingsSidebar";

beforeEach(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Content({ target }: { target: SettingsTarget }) {
  useSettingsTargetFocus(target, "integrations", false);
  return (
    <AgentIntegrationsSettings
      target={target}
      onTargetChange={() => undefined}
      agents={<p>Agent details</p>}
    >
      <SettingsSection title="Local service" target="integrations-mcp">
        <p>MCP details</p>
      </SettingsSection>
      <SettingsSection title="Gateway" target="integrations-gateways">
        <p>Gateway details</p>
      </SettingsSection>
      <SettingsSection title="Obsidian" target="integrations-obsidian">
        <p>Vault details</p>
      </SettingsSection>
    </AgentIntegrationsSettings>
  );
}

describe("Agent and integrations settings", () => {
  it("anchors the Agent destination at the page title so navigation does not scroll away its tabs", () => {
    render(<Content target="integrations-agents" />);
    const target = document.getElementById(settingsTargetId("integrations-agents"))!;
    expect(
      target.contains(screen.getByRole("heading", { name: tr("settings.section.integrations") })),
    ).toBe(true);
  });

  it("returns to integrations when a controlled Agent target is cleared by history navigation", () => {
    const onTargetChange = vi.fn();
    const view = render(
      <AgentIntegrationsSettings
        target="integrations-agents"
        onTargetChange={onTargetChange}
        agents={<p>Agent details</p>}
      >
        <p>MCP details</p>
      </AgentIntegrationsSettings>,
    );
    view.rerender(
      <AgentIntegrationsSettings
        target={undefined}
        onTargetChange={onTargetChange}
        agents={<p>Agent details</p>}
      >
        <p>MCP details</p>
      </AgentIntegrationsSettings>,
    );
    expect(screen.getByText("MCP details")).toBeTruthy();
    expect(screen.queryByText("Agent details")).toBeNull();
  });

  it("allows local tab switching without a navigation controller", () => {
    render(
      <AgentIntegrationsSettings target="integrations-agents" agents={<p>Agent details</p>}>
        <p>MCP details</p>
      </AgentIntegrationsSettings>,
    );
    fireEvent.click(screen.getByRole("tab", { name: tr("settings.integrationsTab") }));
    expect(screen.getByText("MCP details")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: tr("nav.agents") }));
    expect(screen.getByText("Agent details")).toBeTruthy();
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders separate tabs and preserved integrations in %s",
    async (locale) => {
      await initializeI18n(locale);
      const onTargetChange = vi.fn();
      const view = render(
        <AgentIntegrationsSettings
          target="integrations-agents"
          onTargetChange={onTargetChange}
          agents={<p>Agent details</p>}
        >
          <p>MCP details</p>
        </AgentIntegrationsSettings>,
      );
      expect(
        screen.getByRole("heading", { name: tr("settings.section.integrations") }),
      ).toBeTruthy();
      expect(
        screen.getByRole("tab", { name: tr("nav.agents") }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText("Agent details")).toBeTruthy();
      expect(screen.queryByText("MCP details")).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: tr("settings.integrationsTab") }));
      expect(onTargetChange).toHaveBeenCalledExactlyOnceWith("integrations-mcp");
      view.rerender(
        <AgentIntegrationsSettings
          target="integrations-mcp"
          onTargetChange={onTargetChange}
          agents={<p>Agent details</p>}
        >
          <p>MCP details</p>
        </AgentIntegrationsSettings>,
      );
      expect(screen.getByText("MCP details")).toBeTruthy();
      expect(screen.queryByText("Agent details")).toBeNull();
    },
  );

  it.each([
    undefined,
    "integrations-mcp",
    "integrations-gateways",
    "integrations-obsidian",
  ] as const)("preserves the old integrations destination %s", (target) => {
    render(
      <AgentIntegrationsSettings target={target} agents={<p>Agent details</p>}>
        <p>MCP details</p>
        <p>Gateway details</p>
        <p>Vault details</p>
      </AgentIntegrationsSettings>,
    );
    expect(screen.getByText("MCP details")).toBeTruthy();
    expect(screen.getByText("Gateway details")).toBeTruthy();
    expect(screen.getByText("Vault details")).toBeTruthy();
    expect(screen.queryByText("Agent details")).toBeNull();
  });

  it("reveals the integration destination before moving focus and cancels stale frames", () => {
    const scheduled = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduled.set(++id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((cancelled) => {
      scheduled.delete(cancelled);
    });
    const matchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    try {
      const view = render(<Content target="integrations-agents" />);
      view.rerender(<Content target="integrations-gateways" />);
      const target = document.getElementById(settingsTargetId("integrations-gateways"))!;
      const scroll = vi.spyOn(target, "scrollIntoView");
      expect(screen.queryByText("Agent details")).toBeNull();
      expect(scheduled.size).toBe(1);
      for (const callback of scheduled.values()) callback(0);
      expect(document.activeElement).toBe(target);
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: "auto", block: "start" });
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    }
  });
});
