// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGoalState, CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "../conversation/features/sessions/codex-session-controls";
import { useSession } from "../conversation/features/sessions/session-context";
import { codexCopy, codexReason } from "../conversation/features/sessions/codex-copy";

vi.mock("../conversation/features/sessions/session-context", () => ({ useSession: vi.fn() }));
const copy = codexCopy["en-US"];
const codexReasonText = (code: string) => codexReason("en-US", code, "web").text;
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];
// As the host projects a running DeepSeek Harness session: its model waits for the turn to end,
// its permission preset does not.
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
    policy: { available: true },
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
  it("switches the permission preset during a turn, while the model waits", async () => {
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /DeepSeek Chat/ }));
    // The label also holds the chosen preset's description.
    const policy = await screen.findByLabelText(new RegExp(`^${copy.executionPolicy}`));
    expect(policy).toBeEnabled();
    expect(screen.getByLabelText(copy.model)).toBeDisabled();
    // Only the model and its effort wait for the turn to end.
    expect(screen.getByText(copy.settingsWhileRunningModel)).toBeVisible();
    expect(screen.queryByText(copy.settingsWhileRunning)).not.toBeInTheDocument();
    expect(screen.getByText("Can write inside the workspace.")).toBeVisible();
    // DSH has no collaboration mode or service tier to offer.
    expect(screen.queryByLabelText(copy.mode)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.serviceTier)).not.toBeInTheDocument();
    fireEvent.change(policy, { target: { value: "read-only" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
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
});
