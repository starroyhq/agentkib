import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "@/features/conversation/features/sessions/codex-session-controls";
import { useSession } from "@/features/conversation/features/sessions/session-context";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));

const historicalSettings: CodexSessionSettings = {
  sessionId: "s",
  revision: 0,
  available: true,
  current: {},
  selected: {},
  historicalSettings: { modelId: "recorded-model", effort: "xhigh" },
  defaults: {},
  writable: {
    model: { available: true },
    effort: { available: true },
    mode: { available: false },
    policy: { available: false },
    serviceTier: { available: false },
    restoreDefaults: { available: false },
  },
  options: {
    models: [{ id: "recorded-model", efforts: ["xhigh"], serviceTierIds: [] }],
    policies: [],
    serviceTiers: [],
  },
  usage: { available: true, state: "stale", historical: true, usedTokens: 29, contextWindow: 100 },
};

let state: ReturnType<typeof useSession>;
const props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };

beforeEach(() => {
  state = {
    selected: "s",
    current: { id: "s", agent: "codex" },
    locale: "en-US",
    online: true,
    live: {
      sessionId: "s",
      status: "idle",
      revision: 0,
      usage: { available: true, state: "stale" },
    },
    access: {
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    capabilities: { sessionId: "s", features: { settings: { available: true } } },
    client: {
      codexSessionSettings: vi.fn(async () => historicalSettings),
      codexGoals: vi.fn(async () => undefined),
      codexContextOptions: vi.fn(async () => ({ resources: [] })),
    },
    codexAction: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});

afterEach(cleanup);

it("displays the recorded model and effort without selecting either for the next turn", async () => {
  render(<CodexComposerControls {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /Last used · recorded-model/ }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(/Last used · recorded-model/)).toHaveTextContent(/xhigh|Extra high/i);
  expect(dialog.getByLabelText("Model")).toHaveValue("");
  expect(dialog.getByLabelText("Reasoning effort")).toHaveValue("");
  expect(dialog.getByText(/Last recorded/)).toHaveTextContent("29 / 100 (29%)");
  expect(state.codexAction).not.toHaveBeenCalled();
});

it("keeps the recorded model readable when the catalog is unavailable and switches to live settings", async () => {
  vi.mocked(state.client.codexSessionSettings).mockResolvedValue({
    ...historicalSettings,
    available: false,
  });
  state.live = { ...state.live!, status: "unsupported", reason: "runtime_unavailable" };
  const view = render(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /Last used · recorded-model/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("29%");
  state.live = { ...state.live!, status: "running", reason: undefined };
  view.rerender(<CodexComposerControls {...props} />);
  expect(screen.queryByText(/Last used · recorded-model/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Context usage" })).not.toHaveTextContent("29%");
  state.live = {
    ...state.live!,
    settings: {
      ...historicalSettings,
      historicalSettings: undefined,
      current: { modelId: "live-model", effort: "low" },
    },
    usage: { available: true, state: "ready", usedTokens: 50, contextWindow: 100 },
  };
  view.rerender(<CodexComposerControls {...props} />);
  expect(await screen.findByRole("button", { name: /live-model/ })).toBeVisible();
  expect(screen.queryByText(/Last used · recorded-model/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("50%");
});
