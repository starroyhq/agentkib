// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { ComposerModelPicker } from "./composer-model-picker";
import { composerModelCopy } from "./composer-model-copy";
import { composerTerm } from "./composer-layout-copy";

type Props = ComponentProps<typeof ComposerModelPicker>;
const copy = composerModelCopy["en-US"];

function settings(): CodexSessionSettings {
  return {
    sessionId: "session",
    available: true,
    revision: 3,
    status: "idle",
    current: { modelId: "sol", effort: "low" },
    defaults: { modelId: "sol", effort: "medium" },
    writable: {
      model: { available: true },
      effort: { available: true },
      serviceTier: { available: true },
      restoreDefaults: { available: true },
      mode: { available: false },
      policy: { available: false },
    },
    options: {
      models: [
        {
          id: "sol",
          name: "GPT Sol",
          efforts: ["low", "medium", "high", "ultra"],
          defaultEffort: "medium",
          serviceTierIds: ["fast"],
        },
        {
          id: "terra",
          name: "GPT Terra",
          efforts: ["low", "high"],
          defaultEffort: "high",
          serviceTierIds: [],
        },
        {
          id: "compatible",
          name: "Compatible model",
          efforts: ["low", "ultra"],
          defaultEffort: "low",
          serviceTierIds: ["fast"],
        },
      ],
      serviceTiers: [{ id: "fast", name: "Fast" }],
      policies: [],
    },
  };
}

let props: Props;
beforeEach(() => {
  // jsdom has no layout; BaseUI measures the control before exposing the range input.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.hasAttribute("data-index") ? 28 : 240;
      return {
        left: 0,
        right: width,
        width,
        top: 0,
        bottom: 28,
        height: 28,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
  );
  props = {
    locale: "en-US",
    settings: settings(),
    selection: { modelId: "sol", effort: "low" },
    disabled: false,
    saving: false,
    onOpen: vi.fn(),
    onChange: vi.fn(async () => undefined),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPicker() {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`^${composerModelCopy[props.locale].chooseEffort}:`),
    }),
  );
  return screen.findByRole("dialog");
}

async function openModels() {
  const popup = await openPicker();
  fireEvent.click(
    within(popup).getByRole("button", {
      name: `${composerModelCopy[props.locale].chooseModel}: GPT Sol`,
    }),
  );
  return screen.findByRole("dialog", { name: composerModelCopy[props.locale].chooseModel });
}

describe("composer model picker", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "uses the verified model list and localized controls in %s",
    async (locale) => {
      props.locale = locale;
      render(<ComposerModelPicker {...props} />);
      const trigger = screen.getByRole("button", {
        name: `${composerModelCopy[locale].chooseEffort}: GPT Sol · ${composerTerm(locale, "low")}`,
      });
      expect(trigger).toHaveTextContent("GPT Sol");
      expect(trigger).toHaveTextContent(composerTerm(locale, "low"));
      const popup = await openPicker();
      expect(trigger).toHaveTextContent(composerModelCopy[locale].chooseEffort);
      expect(trigger).not.toHaveTextContent("GPT Sol");
      expect(
        within(popup).getByRole("button", { name: composerModelCopy[locale].fast }),
      ).toBeEnabled();
      expect(
        within(popup).getByRole("button", { name: composerModelCopy[locale].reset }),
      ).toBeEnabled();
      expect(
        within(popup).getByRole("slider", { name: composerModelCopy[locale].chooseEffort }),
      ).toHaveAttribute("aria-valuetext", composerTerm(locale, "low"));
      fireEvent.click(
        within(popup).getByRole("button", {
          name: `${composerModelCopy[locale].chooseModel}: GPT Sol`,
        }),
      );
      const models = await screen.findByRole("dialog", {
        name: composerModelCopy[locale].chooseModel,
      });
      expect(within(models).getByText(composerModelCopy[locale].recommended)).toBeVisible();
      expect(within(models).getByRole("button", { name: "GPT Sol" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(within(models).getByRole("button", { name: "GPT Terra" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(props.onOpen).toHaveBeenCalledOnce();
      expect(props.onChange).not.toHaveBeenCalled();
    },
  );

  it("previews slider movement and writes only once when the gesture commits", async () => {
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const thumb = within(popup).getByRole("slider", { name: copy.chooseEffort });
    const control = thumb.parentElement!.parentElement!;
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 240,
      width: 240,
      top: 0,
      bottom: 28,
      height: 28,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    control.setPointerCapture = vi.fn();
    control.hasPointerCapture = vi.fn(() => true);
    control.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 80, clientY: 14 });
    fireEvent.pointerMove(document, { buttons: 1, clientX: 230, clientY: 14 });
    expect(thumb).toHaveAttribute("aria-valuetext", "Ultra");
    expect(popup).toHaveAttribute("data-peak");
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, { button: 0, buttons: 0, clientX: 230, clientY: 14 });
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "ultra" }),
    );
  });

  it.each([undefined, "unlisted-effort"])(
    "can explicitly select the leftmost effort when the current effort is %s",
    async (effort) => {
      props.selection = { modelId: "sol", effort };
      render(<ComposerModelPicker {...props} />);
      const popup = await openPicker();
      const thumb = within(popup).getByRole("slider", { name: copy.chooseEffort });
      const control = thumb.parentElement!.parentElement!;
      control.setPointerCapture = vi.fn();
      control.hasPointerCapture = vi.fn(() => true);
      control.releasePointerCapture = vi.fn();
      expect(thumb).toHaveAttribute("aria-valuetext", copy.effortUnknown);
      fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 14, clientY: 14 });
      expect(props.onChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(control, { button: 0, buttons: 0, clientX: 14, clientY: 14 });
      await waitFor(() =>
        expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "low" }),
      );
    },
  );

  it.each(["{Home}", "{ArrowLeft}"])(
    "can explicitly select the first unknown effort with %s",
    async (key) => {
      props.selection = { modelId: "sol" };
      render(<ComposerModelPicker {...props} />);
      const popup = await openPicker();
      const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
      slider.focus();
      await userEvent.setup().keyboard(key);
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "low" });
    },
  );

  it("does not save the first effort when an unknown selection is dragged to a different stop", async () => {
    props.selection = { modelId: "sol" };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
    const control = slider.parentElement!.parentElement!;
    control.setPointerCapture = vi.fn();
    control.hasPointerCapture = vi.fn(() => true);
    control.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 14, clientY: 14 });
    fireEvent.pointerMove(document, { buttons: 1, clientX: 230, clientY: 14 });
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(control, { button: 0, buttons: 0, clientX: 230, clientY: 14 });
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "ultra" }),
    );
  });

  it("does not save a known first effort again after a click or minimum key", async () => {
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
    const control = slider.parentElement!.parentElement!;
    control.setPointerCapture = vi.fn();
    control.hasPointerCapture = vi.fn(() => true);
    control.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 14, clientY: 14 });
    fireEvent.pointerUp(control, { button: 0, buttons: 0, clientX: 14, clientY: 14 });
    slider.focus();
    await userEvent.setup().keyboard("{Home}{ArrowLeft}");
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("does not select the unknown first effort for a cancelled pointer gesture", async () => {
    props.selection = { modelId: "sol" };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
    const control = slider.parentElement!.parentElement!;
    control.setPointerCapture = vi.fn();
    control.hasPointerCapture = vi.fn(() => true);
    control.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 14, clientY: 14 });
    fireEvent.pointerCancel(control, { button: 0, buttons: 0, clientX: 14, clientY: 14 });
    fireEvent.pointerUp(control, { button: 0, buttons: 0, clientX: 14, clientY: 14 });
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("does not use unknown first-stop recovery to bypass read-only settings", async () => {
    props.selection = { modelId: "sol" };
    props.settings!.writable.effort = { available: false, reason: "session-busy" };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
    const control = slider.parentElement!.parentElement!;
    fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 14, clientY: 14 });
    fireEvent.pointerUp(control, { button: 0, buttons: 0, clientX: 14, clientY: 14 });
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("supports keyboard selection and Escape dismissal without an extra save", async () => {
    const user = userEvent.setup();
    render(<ComposerModelPicker {...props} />);
    await user.tab();
    await user.keyboard("{Enter}");
    const popup = await screen.findByRole("dialog");
    const slider = within(popup).getByRole("slider", { name: copy.chooseEffort });
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "medium" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(props.onChange).toHaveBeenCalledOnce();
  });

  it("uses the advertised fast tier and clears it with null", async () => {
    const view = render(<ComposerModelPicker {...props} />);
    await openPicker();
    const fast = screen.getByRole("button", { name: copy.fast });
    expect(fast).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(fast);
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceTierId: "fast" }),
    );
    props = {
      ...props,
      settings: { ...props.settings!, revision: 4 },
      selection: { ...props.selection, serviceTierId: "fast" },
    };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(fast).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-fast");
    fireEvent.click(fast);
    await waitFor(() => expect(props.onChange).toHaveBeenLastCalledWith({ serviceTierId: null }));
    expect(props.onChange).toHaveBeenCalledTimes(2);
  });

  it("uses the actual Codex priority id for Fast and reflects native priority readback", async () => {
    props.settings!.options.serviceTiers = [
      { id: "priority", name: "Fast", description: "2x speed" },
    ];
    props.settings!.options.models[0].serviceTierIds = ["priority"];
    const view = render(<ComposerModelPicker {...props} />);
    await openPicker();
    const fast = screen.getByRole("button", { name: copy.fast });
    expect(fast).toBeEnabled();
    fireEvent.click(fast);
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceTierId: "priority" }),
    );
    props = { ...props, selection: { ...props.selection, serviceTierId: "priority" } };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(fast).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["missing-global-tier", "missing-model-tier", "read-only-tier"])(
    "does not invent fast support for %s",
    async (kind) => {
      if (kind === "missing-global-tier") props.settings!.options.serviceTiers = [];
      else if (kind === "missing-model-tier") props.settings!.options.models[0].serviceTierIds = [];
      else props.settings!.writable.serviceTier = { available: false, reason: "session-busy" };
      render(<ComposerModelPicker {...props} />);
      await openPicker();
      const fast = screen.getByRole("button", { name: copy.fast });
      expect(fast).toBeDisabled();
      fireEvent.click(fast);
      expect(props.onChange).not.toHaveBeenCalled();
    },
  );

  it.each(["reset-icon", "default-model"])(
    "restores the actual defaults from %s",
    async (entry) => {
      render(<ComposerModelPicker {...props} />);
      if (entry === "reset-icon") {
        const popup = await openPicker();
        fireEvent.click(within(popup).getByRole("button", { name: copy.reset }));
      } else {
        const popup = await openModels();
        fireEvent.click(
          within(popup).getByRole("button", { name: new RegExp(`^${copy.defaultModel}`) }),
        );
      }
      await waitFor(() =>
        expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ restoreDefaults: true }),
      );
    },
  );

  it("replaces incompatible effort and clears incompatible tier when changing model", async () => {
    props.selection = { modelId: "sol", effort: "ultra", serviceTierId: "fast" };
    render(<ComposerModelPicker {...props} />);
    const popup = await openModels();
    fireEvent.click(within(popup).getByRole("button", { name: "GPT Terra" }));
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({
        model: "terra",
        effort: "high",
        serviceTierId: null,
      }),
    );
  });

  it("keeps compatible choices without sending redundant changes", async () => {
    props.selection = { modelId: "sol", effort: "ultra", serviceTierId: "fast" };
    render(<ComposerModelPicker {...props} />);
    const popup = await openModels();
    fireEvent.click(within(popup).getByRole("button", { name: "Compatible model" }));
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ model: "compatible" }),
    );
  });

  it("does not write when selecting the already selected model", async () => {
    render(<ComposerModelPicker {...props} />);
    const popup = await openModels();
    fireEvent.click(within(popup).getByRole("button", { name: "GPT Sol" }));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("keeps one anchored popup across page transitions and reopens at the effort page", async () => {
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const positioner = popup.parentElement;
    fireEvent.click(within(popup).getByRole("button", { name: "Select model: GPT Sol" }));
    expect(await screen.findByRole("dialog", { name: copy.chooseModel })).toBe(popup);
    expect(popup.parentElement).toBe(positioner);
    fireEvent.click(within(popup).getByRole("button", { name: "GPT Sol" }));
    expect(await screen.findByRole("dialog", { name: /^Select reasoning effort:/ })).toBe(popup);
    expect(within(popup).getByRole("slider")).toHaveAttribute("aria-valuetext", "Low");
    fireEvent.click(within(popup).getByRole("button", { name: "Select model: GPT Sol" }));
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reopened = await openPicker();
    expect(within(reopened).getByRole("button", { name: copy.fast })).toBeEnabled();
    expect(within(reopened).queryByRole("button", { name: "GPT Terra" })).not.toBeInTheDocument();
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it.each(["disabled", "saving", "unavailable", "running-readonly"])(
    "keeps settings readable but cannot write while %s",
    async (kind) => {
      if (kind === "disabled") props.disabled = true;
      if (kind === "saving") props.saving = true;
      if (kind === "unavailable") props.settings!.available = false;
      if (kind === "running-readonly") {
        props.settings!.status = "running";
        for (const key of ["model", "effort", "serviceTier", "restoreDefaults"] as const)
          props.settings!.writable[key] = { available: false, reason: "session-busy" };
      }
      render(<ComposerModelPicker {...props} />);
      const popup = await openPicker();
      const fast = within(popup).getByRole("button", { name: copy.fast });
      const reset = within(popup).getByRole("button", { name: copy.reset });
      expect(fast).toBeDisabled();
      expect(reset).toBeDisabled();
      expect(within(popup).getByRole("slider")).toBeDisabled();
      fireEvent.click(fast);
      fireEvent.click(reset);
      fireEvent.click(within(popup).getByRole("button", { name: "Select model: GPT Sol" }));
      const models = await screen.findByRole("dialog", { name: copy.chooseModel });
      expect(within(models).getByRole("button", { name: "GPT Terra" })).toBeDisabled();
      expect(props.onChange).not.toHaveBeenCalled();
    },
  );

  it("deduplicates all changes during an async save and reopening never resends", async () => {
    let finish!: () => void;
    props.onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ComposerModelPicker {...props} />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: copy.fast }));
    fireEvent.click(screen.getByRole("button", { name: copy.fast }));
    fireEvent.click(screen.getByRole("button", { name: copy.reset }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceTierId: "fast" });
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: copy.reset }));
    expect(props.onChange).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
    });
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await openPicker();
    expect(props.onChange).toHaveBeenCalledOnce();
  });

  it("shows unknown settings and a read-only status without fabricating models", async () => {
    props = { ...props, settings: undefined, selection: undefined, status: "Read back required" };
    render(<ComposerModelPicker {...props} />);
    expect(
      screen.getByRole("button", { name: `${copy.chooseEffort}: ${copy.unknown}` }),
    ).toHaveTextContent(copy.unknown);
    const popup = await openPicker();
    expect(within(popup).getByRole("status")).toHaveTextContent("Read back required");
    expect(within(popup).queryByRole("slider")).not.toBeInTheDocument();
    expect(within(popup).getByRole("button", { name: copy.fast })).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
