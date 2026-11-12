// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import {
  CodexComposerControls,
  type ComposerControlsHandle,
} from "../conversation/features/sessions/codex-session-controls";
import { useSession } from "../conversation/features/sessions/session-context";
import { codexCopy } from "../conversation/features/sessions/codex-copy";

vi.mock("../conversation/features/sessions/session-context", () => ({ useSession: vi.fn() }));
const copy = codexCopy["en-US"];
let state: ReturnType<typeof useSession>;
let props: Parameters<typeof CodexComposerControls>[0];

/**
 * Next-turn settings that offer plan mode: DeepSeek Harness's collaboration mode, or Claude
 * Code's permission mode. [selected] is the mode the next turn runs in.
 */
const settings = (claude: boolean, selected: "default" | "plan"): CodexSessionSettings => {
  const unavailable = { available: false, reason: "operation-unavailable" };
  const modes = [
    { id: "default" as const, name: "Default" },
    { id: "plan" as const, name: "Plan" },
  ];
  return {
    sessionId: "session",
    revision: 1,
    available: true,
    executionMode: claude ? "claude-managed" : "dsh-follower",
    current: claude
      ? { modelId: "model-a", effort: "low", permissionMode: "default" }
      : { modelId: "model-a", effort: "low", mode: "default" },
    selected: claude ? { permissionMode: selected } : { mode: selected },
    defaults: {},
    writable: {
      model: { available: true },
      effort: { available: true },
      mode: claude ? unavailable : { available: true },
      policy: unavailable,
      serviceTier: unavailable,
      restoreDefaults: unavailable,
      ...(claude ? { permissionMode: { available: true } } : {}),
    },
    options: {
      models: [{ id: "model-a", name: "Model A", efforts: ["low"], serviceTierIds: [] }],
      policies: [],
      serviceTiers: [],
      ...(claude ? { permissionModes: modes } : { collaborationModes: modes }),
    },
  };
};

function session(claude: boolean, selected: "default" | "plan") {
  state = {
    selected: "session",
    current: { id: "session", agent: claude ? "claude-code" : "deepseek-harness" },
    locale: "en-US",
    online: true,
    busy: false,
    usageEpoch: "observation-a",
    access: { bootId: "boot", device: { id: "device", accessMode: "full" } },
    live: {
      sessionId: "session",
      status: "idle",
      revision: 1,
      executionMode: claude ? "claude-managed" : "dsh-follower",
    },
    capabilities: {
      sessionId: "session",
      features: { settings: { available: true }, "settings-state": { available: true } },
    },
    client: {
      sessionSettings: vi.fn(async () => settings(claude, selected)),
      sessionGoals: vi.fn(async () => ({ sessionId: "session", available: false, revision: 1 })),
      sessionResources: vi.fn(async () => ({ sessionId: "session", revision: 1, resources: [] })),
    },
    codexAction: vi.fn(async () => ({ accepted: true })),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
}

beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
});
afterEach(cleanup);

describe("plan mode in the Web composer, as on the desktop", () => {
  it("shows beside the settings while on, and turns off there", async () => {
    session(false, "plan");
    const onPlan = vi.fn();
    render(<CodexComposerControls {...props} onPlan={onPlan} />);
    const chip = await screen.findByRole("button", { name: copy.planOn });
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: true, available: true }));
    fireEvent.click(chip);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { mode: "default" }),
    );
  });

  it("says so when it could not turn off", async () => {
    session(false, "plan");
    vi.mocked(state.codexAction).mockRejectedValue(new Error("offline"));
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.planOn }));
    expect(await screen.findByRole("status")).toHaveTextContent(copy.planExitFailed);
  });

  it("is Claude Code's permission mode there", async () => {
    session(true, "plan");
    render(<CodexComposerControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: copy.planOn }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { permissionMode: "default" }),
    );
  });

  it("turns on from the composer's /plan, and shows nothing while off", async () => {
    session(false, "default");
    const onPlan = vi.fn();
    const controls = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} controlsRef={controls} onPlan={onPlan} />);
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: true }));
    expect(screen.queryByRole("button", { name: copy.planOn })).not.toBeInTheDocument();
    let entered = false;
    act(() => {
      entered = controls.current!.plan();
    });
    expect(entered).toBe(true);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { mode: "plan" }),
    );
  });

  it("cannot turn on from a disabled composer", async () => {
    session(false, "default");
    const onPlan = vi.fn();
    const controls = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls {...props} disabled controlsRef={controls} onPlan={onPlan} />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: false }));
    expect(controls.current!.plan()).toBe(false);
    expect(state.codexAction).not.toHaveBeenCalled();
  });
});
