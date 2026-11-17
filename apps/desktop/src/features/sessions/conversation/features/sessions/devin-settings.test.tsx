// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "./codex-session-controls";
import { codexCopy } from "./codex-copy";
import { composerModelCopy } from "./composer-model-copy";
import { useSession } from "./session-context";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
afterEach(cleanup);

function renderControls({
  running = false,
  writable = true,
  readRevision = 3,
  hasModel = false,
  usage,
}: {
  running?: boolean;
  writable?: boolean;
  readRevision?: number;
  hasModel?: boolean;
  usage?: CodexSessionSettings["usage"];
} = {}) {
  let settings: CodexSessionSettings = {
    sessionId: "devin-session",
    revision: readRevision,
    available: true,
    applicationStatus: "confirmed",
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
              serviceTierIds: ["priority"],
              variants: [
                { id: "sol-low", effort: "low", maxContextTokens: 1_000_000 },
                { id: "sol-low-priority", effort: "low", serviceTierId: "priority" },
              ],
            },
          ]
        : [],
      policies: [],
      serviceTiers: hasModel ? [{ id: "priority", name: "Fast" }] : [],
      permissionModes: [
        { id: "accept-edits", name: "accept-edits" },
        { id: "auto", name: "auto" },
      ],
    },
  };
  const sessionSettings = vi.fn(async () => settings);
  const codexAction = vi.fn(async (_action: string, fields: CodexSessionSettings["current"]) => {
    settings = { ...settings, revision: 4, current: { ...settings.current, ...fields } };
    return { accepted: true, completed: true };
  });
  vi.mocked(useSession).mockReturnValue({
    selected: settings.sessionId,
    current: { id: settings.sessionId, agent: "devin" },
    locale: "en-US",
    online: true,
    busy: false,
    access: { bootId: "boot", device: { id: "device", accessMode: "full", advancedControl: true } },
    live: {
      sessionId: settings.sessionId,
      status: running ? "running" : "idle",
      revision: 3,
      executionMode: "devin-print",
    },
    capabilities: {
      sessionId: settings.sessionId,
      features: { "settings-state": { available: true }, settings: { available: !running } },
    },
    client: { sessionSettings },
    codexAction,
  } as unknown as ReturnType<typeof useSession>);
  render(
    <CodexComposerControls
      resources={[]}
      setResources={vi.fn()}
      openPhoneFiles={vi.fn()}
      disabled={false}
    />,
  );
  return { codexAction, sessionSettings };
}

const permissionTrigger = () => screen.findByRole("button", { name: /permissions.*accept edits/i });

describe("permissions in an existing Devin conversation", () => {
  it("applies a mode from the composer menu without opening the old settings window", async () => {
    const { codexAction } = renderControls();
    const user = userEvent.setup();
    await user.click(await permissionTrigger());

    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Approve all")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: /^Read-only auto/ }));

    await waitFor(() =>
      expect(codexAction).toHaveBeenCalledExactlyOnceWith("settings", { permissionMode: "auto" }),
    );
    expect(
      await screen.findByRole("button", { name: /permissions.*read-only auto/i }),
    ).toBeVisible();
  });

  it.each([
    ["while Devin is running", { running: true }],
    ["when the permission field is read-only", { writable: false }],
  ] as const)("cannot change modes %s", async (_description, options) => {
    const { codexAction } = renderControls(options);
    const trigger = await permissionTrigger();
    expect(trigger).toBeDisabled();
    await userEvent.setup().click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(codexAction).not.toHaveBeenCalled();
  });

  it("does not apply a choice from a stale settings revision", async () => {
    const { codexAction, sessionSettings } = renderControls({ readRevision: 2 });
    const user = userEvent.setup();
    const trigger = await permissionTrigger();
    await user.click(trigger);
    const item = await screen.findByRole("menuitem", { name: /^Read-only auto/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(sessionSettings).toHaveBeenCalledWith("devin-session", "devin");
    expect(codexAction).not.toHaveBeenCalled();
  });
});

describe("the model in an existing Devin conversation", () => {
  it("shows the context capacity and writes Fast using the selected native tier", async () => {
    const { codexAction } = renderControls({ hasModel: true });
    const copy = composerModelCopy["en-US"];
    const user = userEvent.setup();
    const ring = await screen.findByRole("img", { name: codexCopy["en-US"].contextUsage });
    await waitFor(() =>
      expect(ring).toHaveAccessibleDescription(
        /The native interface does not currently provide.*Model context limit of 1,000,000 tokens/,
      ),
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
      expect(codexAction).toHaveBeenCalledExactlyOnceWith("settings", {
        serviceTierId: "priority",
      }),
    );
  });

  it("uses the shared ring for an explicitly historical model request", async () => {
    renderControls({
      hasModel: true,
      usage: {
        available: true,
        state: "stale",
        historical: true,
        reason: "devin-last-model-request",
        usedTokens: 40_000,
        contextWindow: 1_000_000,
      },
    });
    const ring = await screen.findByRole("img", { name: codexCopy["en-US"].contextUsage });
    await waitFor(() =>
      expect(ring).toHaveAccessibleDescription(/last model request.*4% used.*40K \/ 1M tokens/),
    );
    expect(ring.querySelector("circle[pathLength]")).toHaveAttribute("stroke-dasharray", "4 100");
  });
});
