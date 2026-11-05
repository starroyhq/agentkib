// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "./codex-session-controls";
import { useSession } from "./session-context";
import { codexCopy, codexReason } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];
const copy = codexCopy["en-US"];
const settings: CodexSessionSettings = {
  sessionId: "session",
  revision: 1,
  available: true,
  current: { modelId: "deepseek/deepseek-chat", effort: "low" },
  defaults: { modelId: "deepseek/deepseek-chat" },
  writable: {
    model: { available: true },
    effort: { available: true },
    restoreDefaults: { available: true },
    mode: { available: false },
    policy: { available: false },
    serviceTier: { available: false },
  },
  options: {
    models: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", efforts: ["low", "high"] },
      { id: "mock%2Flocal/m-1", name: "Mock One", efforts: [] },
    ],
    policies: [],
    serviceTiers: [],
  },
} as unknown as CodexSessionSettings;
beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
  state = {
    selected: "session",
    current: { id: "session", agent: "deepseek-harness" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "observation-a",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: {
      sessionId: "session",
      features: { settings: { available: true }, "settings-state": { available: true } },
    },
    client: {
      sessionSettings: vi.fn(async () => settings),
      sessionGoals: vi.fn(),
      sessionResources: vi.fn(),
      codexSessionSettings: vi.fn(),
      codexGoals: vi.fn(),
      codexContextOptions: vi.fn(),
    },
    codexAction: vi.fn(),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("DeepSeek Harness model settings in the composer", () => {
  it("reads DSH's own models through the managed route, and nothing Codex-only", async () => {
    render(<CodexComposerControls {...props} />);
    await waitFor(() =>
      expect(state.client.sessionSettings).toHaveBeenCalledWith("session", "deepseek-harness"),
    );
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek Chat/ }));
    expect(await screen.findByLabelText(copy.model)).toHaveTextContent("DeepSeek Chat");
    // Only the model and its effort: no Codex mode, service tier or execution policy rows.
    expect(screen.getByLabelText(copy.effort)).toBeInTheDocument();
    // A row's label also holds its reason text, so match the label's start.
    for (const label of [copy.mode, copy.serviceTier, copy.executionPolicy])
      expect(screen.queryByLabelText(label, { exact: false })).not.toBeInTheDocument();
    expect(state.client.codexSessionSettings).not.toHaveBeenCalled();
    expect(state.client.codexGoals).not.toHaveBeenCalled();
    // DSH has no goals, resources or attachments yet, so there is nothing to add.
    expect(state.client.sessionGoals).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: copy.addContext })).not.toBeInTheDocument();
  });

  it("says once, while a turn runs, that the settings wait for it", async () => {
    const busy = { available: false, reason: "session-busy" };
    state = {
      ...state,
      live: { sessionId: "session", status: "running", revision: 1 },
      capabilities: {
        sessionId: "session",
        features: { settings: busy, "settings-state": { available: true } },
      },
      client: {
        ...state.client,
        sessionSettings: vi.fn(async () => ({
          ...settings,
          writable: { ...settings.writable, model: busy, effort: busy },
        })),
      },
    } as unknown as ReturnType<typeof useSession>;
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek Chat/ }));
    expect(await screen.findByText(copy.settingsWhileRunning)).toBeInTheDocument();
    expect(screen.queryByText(codexReason("en-US", "session-busy").text)).not.toBeInTheDocument();
  });
});
