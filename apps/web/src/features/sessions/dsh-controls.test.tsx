// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerGoalCopy } from "@agentkib/session-ui";
import {
  sessionProviderCapabilities,
  type CodexGoalState,
  type CodexSessionSettings,
} from "@agentkib/web-client";
import { CodexComposerControls } from "../conversation/features/sessions/codex-session-controls";
import { useSession } from "../conversation/features/sessions/session-context";
import { codexCopy, codexReason } from "../conversation/features/sessions/codex-copy";

vi.mock("../conversation/features/sessions/session-context", () => ({ useSession: vi.fn() }));
const copy = codexCopy["en-US"];
const codexReasonText = (code: string) => codexReason("en-US", code, "web").text;
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];
// The executor reports whether its settings are writable at the current revision.
const settings = (running: boolean): CodexSessionSettings => ({
  sessionId: "session",
  revision: 1,
  available: true,
  executionMode: "dsh-follower",
  current: { modelId: "deepseek/deepseek-chat", effort: "low", policyId: "workspace-write" },
  defaults: { modelId: "deepseek/deepseek-chat" },
  writable: {
    model: running ? { available: false, reason: "session-busy" } : { available: true },
    effort: running ? { available: false, reason: "session-busy" } : { available: true },
    mode: { available: false, reason: "operation-unavailable" },
    policy: running ? { available: false, reason: "session-busy" } : { available: true },
    serviceTier: { available: false, reason: "operation-unavailable" },
    restoreDefaults: { available: !running },
  },
  options: {
    models: [
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat",
        efforts: ["low", "high"],
        serviceTierIds: [],
      },
    ],
    policies: [
      { id: "read-only", name: "Read only · ask when needed" },
      {
        id: "workspace-write",
        name: "Workspace write · ask when needed",
        description: "Can write inside the workspace.",
      },
      { id: "danger-full-access", name: "Full access · no approval prompts" },
    ],
    serviceTiers: [],
  },
});
const goal: CodexGoalState = {
  sessionId: "session",
  available: true,
  revision: 1,
  budget: "rounds",
  goal: {
    objective: "Ship it",
    status: "blocked",
    rounds: { used: 3, limit: 256 },
    detail: "Which branch should I release from?",
  },
  actions: {
    set: { available: true },
    pause: { available: false, reason: "goal-action-unavailable" },
    resume: { available: true },
    clear: { available: true },
  },
};

beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
  const features = Object.fromEntries(
    ["settings", "settings-state", "goal", "goal-set", "goal-resume", "goal-clear"].map((name) => [
      name,
      { available: true },
    ]),
  );
  state = {
    selected: "session",
    current: { id: "session", agent: "deepseek-harness" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "observation-a",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "running", revision: 1, executionMode: "dsh-follower" },
    capabilities: { sessionId: "session", features },
    client: {
      sessionSettings: vi.fn(async () => settings(true)),
      sessionGoals: vi.fn(async () => goal),
      sessionResources: vi.fn(async () => ({ sessionId: "session", revision: 1, resources: [] })),
    },
    codexAction: vi.fn(async () => ({ accepted: true })),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("DeepSeek Harness controls", () => {
  it("keeps model and permission controls gray until the executor becomes idle", async () => {
    const provider = sessionProviderCapabilities("deepseek-harness");
    vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...settings(true), provider });
    state.access = { ...state.access!, status: "approved" };
    state.access.device!.advancedControl = true;
    state.capabilities!.features.settings = { available: false, reason: "session-busy" };
    state.live!.usage = {
      available: true,
      state: "ready",
      usedTokens: 700,
      contextWindow: 1000,
    };
    const view = render(<CodexComposerControls {...props} />);
    const model = await screen.findByRole("button", { name: /DeepSeek Chat/ });
    fireEvent.click(model);
    expect(screen.getByRole("button", { name: "Reset default model" })).toBeDisabled();
    expect(within(screen.getByRole("dialog")).queryByRole("status")).not.toBeInTheDocument();
    // DSH has no collaboration mode or service tier to offer.
    expect(screen.queryByLabelText(copy.mode)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.serviceTier)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: copy.contextUsage })).toHaveAccessibleDescription(
      expect.stringContaining("70%"),
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("70%");
    expect(screen.getByRole("dialog")).not.toHaveTextContent(copy.contextUnknown);
    fireEvent.click(model);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${copy.executionPolicy}`) }));
    // The host text is English only; clients show DSH's preset wording by id.
    await waitFor(() =>
      expect(screen.getByText(/^Can write inside the workspace and permitted/)).toBeVisible(),
    );
    const policy = await screen.findByRole("menuitem", { name: /^Read only/i });
    expect(policy).toHaveAttribute("aria-disabled", "true");
    expect(within(screen.getByRole("menu")).queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(policy);
    expect(state.codexAction).not.toHaveBeenCalled();

    vi.mocked(state.client.sessionSettings).mockResolvedValue({
      ...settings(false),
      provider,
      revision: 2,
    });
    state.live = { ...state.live!, status: "idle", revision: 2 };
    state.capabilities!.features.settings = { available: true };
    view.rerender(<CodexComposerControls {...props} />);
    await waitFor(() => expect(policy).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(policy);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { policyId: "read-only" }),
    );
  });

  it("shows a goal bounded by rounds, why it stopped, and asks for no token budget", async () => {
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByText("3 / 256")).toBeVisible();
    expect(screen.getByText("Which branch should I release from?")).toBeVisible();
    expect(screen.queryByLabelText(copy.goalBudget)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.goalUsage)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.goalResume }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledWith("goal-resume", {}));
    // A blocked goal cannot be paused, and the panel offers no pausing to explain.
    expect(screen.queryByText(codexReasonText("goal-action-unavailable"))).not.toBeInTheDocument();
  });

  it("explains nothing about pausing, resuming or clearing while there is no goal", async () => {
    const unavailable = { available: false, reason: "goal-action-unavailable" };
    state.client.sessionGoals = vi.fn(async () => ({
      ...goal,
      goal: undefined,
      actions: {
        set: { available: true },
        pause: unavailable,
        resume: unavailable,
        clear: unavailable,
      },
    }));
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByLabelText(copy.goalObjective)).toBeVisible();
    expect(screen.getByRole("button", { name: copy.goalCreate })).toBeInTheDocument();
    expect(screen.queryByText(codexReasonText("goal-action-unavailable"))).not.toBeInTheDocument();
  });

  it("keeps an unconfirmed staged goal editable after a single automatic submission", async () => {
    state.controlReady = true;
    state.live = { ...state.live!, status: "idle" };
    vi.mocked(state.client.sessionGoals).mockResolvedValue({ ...goal, goal: undefined });
    vi.mocked(state.codexAction).mockResolvedValue(undefined);
    const onStartupGoalHandled = vi.fn();
    render(
      <CodexComposerControls
        {...props}
        startupGoal={{ value: { objective: "Ship it" }, apply: true }}
        onStartupGoalHandled={onStartupGoalHandled}
      />,
    );
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("goal-set", {
        objective: "Ship it",
        intent: "start",
        tokenBudget: null,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByLabelText(copy.goalObjective)).toHaveValue("Ship it");
    expect(onStartupGoalHandled).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.codexAction).toHaveBeenCalledTimes(1);
  });

  it("discards an inherited goal draft and clears its local editor without a host action", async () => {
    vi.mocked(state.client.sessionGoals).mockResolvedValue({ ...goal, goal: undefined });
    const onStartupGoalDiscarded = vi.fn();
    const view = render(
      <CodexComposerControls
        {...props}
        startupGoal={{ value: { objective: "Ship it" }, apply: false }}
        onStartupGoalDiscarded={onStartupGoalDiscarded}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    fireEvent.change(await screen.findByLabelText(copy.goalObjective), {
      target: { value: "Revised goal" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.close }));
    fireEvent.click(screen.getByRole("button", { name: composerGoalCopy("en-US").clearDraft }));
    expect(onStartupGoalDiscarded).toHaveBeenCalledOnce();

    view.rerender(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
    expect(await screen.findByLabelText(copy.goalObjective)).toHaveValue("");
    expect(state.codexAction).not.toHaveBeenCalled();
  });
});
