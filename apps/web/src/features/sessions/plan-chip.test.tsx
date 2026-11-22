// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls, type ComposerControlsHandle } from "@agentkib/session-ui";
import type { useSession } from "../conversation/features/sessions/session-context";
import { codexCopy } from "../conversation/codex-copy";
import { sessionAgentCopy } from "@agentkib/session-ui";
import { planModeCopy } from "@agentkib/session-ui";

const copy = codexCopy["en-US"];
let state: ReturnType<typeof useSession>;
let props: Omit<Parameters<typeof CodexComposerControls>[0], "session">;

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
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
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
      prepareSessionSettings: vi.fn(async () => settings(claude, selected)),
      sessionGoals: vi.fn(async () => ({ sessionId: "session", available: false, revision: 1 })),
      sessionResources: vi.fn(async () => ({ sessionId: "session", revision: 1, resources: [] })),
    },
    codexAction: vi.fn(async () => ({ accepted: true })),
    control: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
}

beforeEach(() => {
  props = { resources: [], setResources: vi.fn(), openPhoneFiles: vi.fn(), disabled: false };
});
afterEach(cleanup);

async function openAdd() {
  fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
  return within(await screen.findByRole("dialog", { name: copy.addContext }));
}

async function openPlan() {
  const add = await openAdd();
  return add.findByRole("button", { name: planModeCopy("en-US").title });
}

describe("plan mode in the Web composer", () => {
  it.each(["idle", "running"])(
    "switches off from Add with a writable DSH mode while %s",
    async (status) => {
      session(false, "plan");
      state.live = { ...state.live!, status };
      const onPlan = vi.fn();
      render(<CodexComposerControls session={state} {...props} onPlan={onPlan} />);
      const plan = await openPlan();
      await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: true, available: true }));
      expect(plan).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(plan);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: copy.addContext })).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(state.codexAction).toHaveBeenCalledWith("settings", { mode: "default" }),
      );
    },
  );

  it("says so when it could not turn off", async () => {
    session(false, "plan");
    vi.mocked(state.codexAction).mockRejectedValue(new Error("offline"));
    render(<CodexComposerControls session={state} {...props} />);
    const cancel = await screen.findByRole("button", { name: "Exit Plan mode" });
    fireEvent.click(cancel);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(cancel).toBeVisible();
    expect(await openPlan()).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Claude Plan out of permissions while writing its native permission mode", async () => {
    session(true, "plan");
    render(<CodexComposerControls session={state} {...props} />);
    const permissions = sessionAgentCopy["en-US"].permission;
    fireEvent.click(await screen.findByRole("button", { name: permissions }));
    const permissionMenu = within(await screen.findByRole("menu", { name: permissions }));
    expect(permissionMenu.queryByRole("menuitem", { name: "Plan" })).not.toBeInTheDocument();
    expect(permissionMenu.getByRole("menuitem", { name: /^Manual approval/ })).not.toHaveAttribute(
      "aria-current",
      "true",
    );
    fireEvent.keyDown(permissionMenu.getByRole("menuitem", { name: /^Manual approval/ }), {
      key: "Escape",
    });
    const plan = await openPlan();
    await waitFor(() => expect(plan).toBeEnabled());
    fireEvent.click(plan);
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { permissionMode: "default" }),
    );
  });

  it("turns on from the composer's /plan while Add shows the toggle as off", async () => {
    session(false, "default");
    const onPlan = vi.fn();
    const controls = createRef<ComposerControlsHandle>();
    render(
      <CodexComposerControls session={state} {...props} controlsRef={controls} onPlan={onPlan} />,
    );
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: true }));
    expect(await openPlan()).toHaveAttribute("aria-pressed", "false");
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
    render(
      <CodexComposerControls
        session={state}
        {...props}
        disabled
        controlsRef={controls}
        onPlan={onPlan}
      />,
    );
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: false }));
    expect(controls.current!.plan()).toBe(false);
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("accepts /plan while already active even when the host does not offer Execute", async () => {
    session(false, "plan");
    const projected = settings(false, "plan");
    projected.options.collaborationModes = [{ id: "plan", name: "Plan" }];
    vi.mocked(state.client.sessionSettings).mockResolvedValue(projected);
    const controls = createRef<ComposerControlsHandle>();
    render(<CodexComposerControls session={state} {...props} controlsRef={controls} />);
    expect(await openPlan()).toBeDisabled();
    expect(controls.current!.plan()).toBe(true);
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("clears only the saved Codex mode when the native catalog no longer offers it", async () => {
    session(false, "plan");
    const unchanged = { modelId: "model-a", effort: "low", policyId: "current" };
    const previous = settings(false, "plan");
    let projected: CodexSessionSettings = {
      ...previous,
      executionMode: "codex-managed",
      current: { ...unchanged, mode: "plan" },
      selected: { ...unchanged, mode: "plan" },
      applicationStatus: "confirmed",
      options: { ...previous.options, collaborationModes: [] },
    };
    state.current = { ...state.current!, agent: "codex" };
    state.live = { ...state.live!, executionMode: "codex-managed" };
    state.client.sessionSettings = vi.fn(async () => projected);
    const unavailable = { available: false };
    state.client.codexGoals = vi.fn(async () => ({
      sessionId: "session",
      available: false,
      revision: 1,
      actions: { set: unavailable, pause: unavailable, resume: unavailable, clear: unavailable },
    }));
    state.client.codexContextOptions = vi.fn(async () => ({
      sessionId: "session",
      revision: 1,
      resources: [],
    }));
    vi.mocked(state.codexAction).mockImplementation(async () => {
      projected = { ...projected, revision: 2, selected: unchanged };
      state.live = { ...state.live!, revision: 2 };
      return { accepted: true } as Awaited<ReturnType<typeof state.codexAction>>;
    });
    const onPlan = vi.fn();
    render(<CodexComposerControls session={state} {...props} onPlan={onPlan} />);
    await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith({ on: true, available: false }));
    const add = await openAdd();
    expect(add.getByRole("button", { name: planModeCopy("en-US").title })).toBeDisabled();
    fireEvent.click(add.getByRole("button", { name: planModeCopy("en-US").clear }));
    await waitFor(() => {
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { mode: null });
      expect(onPlan).toHaveBeenLastCalledWith({ on: false, available: false });
      expect(screen.queryByRole("dialog", { name: copy.addContext })).not.toBeInTheDocument();
    });
    expect(state.control).not.toHaveBeenCalled();
    expect(
      (await openAdd()).queryByRole("button", { name: planModeCopy("en-US").clear }),
    ).not.toBeInTheDocument();
  });
});
