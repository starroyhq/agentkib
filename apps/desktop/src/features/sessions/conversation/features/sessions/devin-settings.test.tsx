// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionProviderCapabilities, type SessionSettings } from "@agentkib/web-client";
import { SessionComposerControls } from "@agentkib/session-ui";
import { sessionCopy } from "../../session-copy";
import { composerModelCopy } from "@agentkib/session-ui";
import type { useSession } from "../../desktop-session-context";

afterEach(cleanup);

function renderControls({
  running = false,
  writable = true,
  readRevision = 3,
  hasModel = false,
  fastTier = "priority",
  provider,
  usage,
  liveUsage,
}: {
  running?: boolean;
  writable?: boolean;
  readRevision?: number;
  hasModel?: boolean;
  fastTier?: string;
  provider?: SessionSettings["provider"];
  usage?: SessionSettings["usage"];
  liveUsage?: SessionSettings["usage"];
} = {}) {
  let settings: SessionSettings = {
    sessionId: "devin-session",
    revision: readRevision,
    available: true,
    applicationStatus: "confirmed",
    provider,
    usage,
    current: {
      permissionMode: "accept-edits",
      ...(hasModel ? { modelId: "sol", effort: "low", maxContextTokens: 1_000_000 } : {}),
    },
    defaults: { permissionMode: "accept-edits" },
    writable: {
      model: { available: hasModel },
      effort: { available: hasModel },
      mode: { available: false },
      policy: { available: false },
      permissionMode: { available: writable },
      serviceTier: { available: hasModel },
      restoreDefaults: { available: false },
    },
    options: {
      models: hasModel
        ? [
            {
              id: "sol",
              name: "Sol",
              efforts: ["low"],
              serviceTierIds: [fastTier],
              variants: [
                { id: "sol-low", effort: "low", maxContextTokens: 1_000_000 },
                { id: "sol-low-fast", effort: "low", serviceTierId: fastTier },
              ],
            },
          ]
        : [],
      policies: [],
      serviceTiers: hasModel ? [{ id: fastTier, name: "Fast" }] : [],
      permissionModes: [
        { id: "accept-edits", name: "accept-edits" },
        { id: "auto", name: "auto" },
      ],
    },
  };
  const sessionSettings = vi.fn(async () => settings);
  const runSessionAction = vi.fn(async (_action: string, fields: SessionSettings["current"]) => {
    settings = { ...settings, revision: 4, current: { ...settings.current, ...fields } };
    return { accepted: true, completed: true };
  });
  const state = {
    selected: settings.sessionId,
    current: { id: settings.sessionId, agent: "devin" },
    locale: "en-US",
    online: true,
    busy: false,
    access: {
      status: "approved",
      bootId: "boot",
      device: { id: "device", accessMode: "full", advancedControl: true },
    },
    live: {
      sessionId: settings.sessionId,
      status: running ? "running" : "idle",
      revision: 3,
      executionMode: "devin-print",
      usage: liveUsage,
    },
    capabilities: {
      sessionId: settings.sessionId,
      features: { "settings-state": { available: true }, settings: { available: !running } },
    },
    client: { sessionSettings },
    runSessionAction,
  } as unknown as ReturnType<typeof useSession>;
  render(
    <SessionComposerControls
      session={state}
      resources={[]}
      setResources={vi.fn()}
      openPhoneFiles={vi.fn()}
      disabled={false}
    />,
  );
  return { runSessionAction, sessionSettings };
}

const permissionTrigger = () => screen.findByRole("button", { name: /permissions.*accept edits/i });

describe("permissions in an existing Devin conversation", () => {
  it("applies a mode from the composer menu without opening the old settings window", async () => {
    const { runSessionAction } = renderControls();
    const user = userEvent.setup();
    await user.click(await permissionTrigger());

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByText("Applies next turn. Devin can’t ask while running."),
    ).not.toBeInTheDocument();
    expect(within(menu).queryByText("Approve all")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /^Read only/ }));

    await waitFor(() =>
      expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
        permissionMode: "auto",
      }),
    );
    expect(await screen.findByRole("button", { name: /permissions.*read only/i })).toBeVisible();
  });

  it.each([
    ["while Devin is running", { running: true }],
    ["when the permission field is read-only", { writable: false }],
  ] as const)("cannot change modes %s", async (_description, options) => {
    const { runSessionAction } = renderControls(options);
    const trigger = await permissionTrigger();
    if ("running" in options) {
      expect(trigger).toBeDisabled();
      await userEvent.click(trigger);
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(runSessionAction).not.toHaveBeenCalled();
      return;
    }
    expect(trigger).toBeEnabled();
    await userEvent.setup().click(trigger);
    const menu = await screen.findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: /^Read only/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.setup().click(item);
    expect(runSessionAction).not.toHaveBeenCalled();
  });

  it("does not apply a choice from a stale settings revision", async () => {
    const { runSessionAction, sessionSettings } = renderControls({ readRevision: 2 });
    const user = userEvent.setup();
    const trigger = await permissionTrigger();
    await user.click(trigger);
    const item = await screen.findByRole("menuitem", { name: /^Read only/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(sessionSettings).toHaveBeenCalledWith("devin-session", "devin");
    expect(runSessionAction).not.toHaveBeenCalled();
  });
});

describe("the model in an existing Devin conversation", () => {
  it("does not show live tokens as last-request usage when neither the last count nor the model limit is known", async () => {
    renderControls({
      liveUsage: { available: true, state: "ready", usedTokens: 35, contextWindow: 100 },
    });
    expect(await permissionTrigger()).toBeEnabled();
    expect(
      screen.queryByRole("img", { name: sessionCopy["en-US"].contextUsage }),
    ).not.toBeInTheDocument();
  });
  it("shows the context capacity and writes Fast using the selected native tier", async () => {
    const provider = sessionProviderCapabilities("devin")!;
    const { runSessionAction } = renderControls({
      hasModel: true,
      fastTier: "turbo",
      provider: { ...provider, models: { ...provider.models, fastTierIds: ["turbo"] } },
    });
    const copy = composerModelCopy["en-US"];
    const user = userEvent.setup();
    const ring = await screen.findByRole("img", { name: sessionCopy["en-US"].contextUsage });
    await waitFor(() =>
      expect(ring).toHaveAccessibleDescription("Model context limit of 1,000,000 tokens"),
    );
    expect(ring).not.toHaveTextContent("1M");
    expect(ring.querySelector("circle[pathLength]")).toBeNull();
    await user.hover(ring);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Model context limit of 1,000,000 tokens",
    );
    await user.click(
      await screen.findByRole("button", { name: `${copy.chooseEffort}: Sol · Low` }),
    );
    await user.click(await screen.findByRole("button", { name: copy.fast }));
    await waitFor(() =>
      expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
        serviceTierId: "turbo",
      }),
    );
  });

  it("uses the last request in the shared ring when the provider does not report live usage", async () => {
    renderControls({
      hasModel: true,
      usage: {
        available: true,
        state: "stale",
        historical: true,
        usedTokens: 40_000,
        contextWindow: 1_000_000,
      },
      liveUsage: {
        available: true,
        state: "ready",
        usedTokens: 350_000,
        contextWindow: 1_000_000,
      },
    });
    const ring = await screen.findByRole("img", { name: sessionCopy["en-US"].contextUsage });
    await waitFor(() =>
      expect(ring).toHaveAccessibleDescription(
        "4% used (96% remaining) 40,000 / 1,000,000 tokens used",
      ),
    );
    expect(ring.querySelector("circle[pathLength]")).toHaveAttribute("stroke-dasharray", "4 100");
  });
});
