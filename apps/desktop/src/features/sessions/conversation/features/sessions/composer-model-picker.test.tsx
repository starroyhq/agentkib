// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, type ComponentProps } from "react";
import type { SessionSettings } from "@agentkib/web-client";
import { sessionCopy } from "../../session-copy";
import { ComposerModelPicker, type ComposerModelPickerHandle } from "@agentkib/session-ui";
import { composerModelCopy } from "@agentkib/session-ui";
import { composerTerm } from "@agentkib/session-ui";

type Props = ComponentProps<typeof ComposerModelPicker>;
const copy = composerModelCopy["en-US"];

function settings(): SessionSettings {
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
  return screen.findByRole("dialog", { name: composerModelCopy[props.locale].model });
}

describe("composer model picker", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
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
      expect(trigger).toHaveTextContent("GPT Sol");
      expect(trigger).toHaveTextContent(composerTerm(locale, "low"));
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
        name: composerModelCopy[locale].model,
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

  it("keeps a single effort and the service tier visible with their disabled reasons", async () => {
    const catalog = settings();
    catalog.options.models[0].efforts = ["high"];
    catalog.options.models[0].serviceTierIds = ["flex"];
    catalog.options.serviceTiers = [{ id: "flex", name: "Flex" }];
    catalog.writable.effort = { available: false };
    catalog.writable.serviceTier = { available: false };
    render(
      <ComposerModelPicker
        {...props}
        settings={catalog}
        writeDisabledReason={(field) =>
          field === "effort" ? "Effort is unavailable" : "Service tier is unavailable"
        }
      />,
    );

    const popup = within(await openPicker());
    const effort = popup.getByRole("button", { name: `${copy.chooseEffort}: High` });
    const tier = popup.getByRole("combobox", { name: copy.serviceTier });
    expect(effort).toBeDisabled();
    expect(effort).toHaveAttribute("title", "Effort is unavailable");
    expect(tier).toBeDisabled();
    expect(tier).toHaveAttribute("title", "Service tier is unavailable");
    fireEvent.click(effort);
    expect(props.onChange).not.toHaveBeenCalled();
  });

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

  it("opens either page through the same trigger without an extra open or save", async () => {
    const user = userEvent.setup();
    const pickerRef = createRef<ComposerModelPickerHandle>();
    const view = render(<ComposerModelPicker {...props} pickerRef={pickerRef} />);
    const trigger = screen.getByRole("button", { name: /^Select reasoning effort:/ });
    act(() => {
      pickerRef.current!.open("effort");
      pickerRef.current!.open("models");
    });
    const popup = await screen.findByRole("dialog", { name: copy.model });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", popup.id);
    act(() => pickerRef.current!.open("effort"));
    expect(screen.getByRole("dialog", { name: /^Select reasoning effort:/ })).toBe(popup);
    expect(props.onOpen).toHaveBeenCalledOnce();
    (await within(popup).findByRole("slider")).focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    act(() => pickerRef.current!.open("effort"));
    expect(await screen.findByRole("slider")).toBeVisible();
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    expect(props.onChange).not.toHaveBeenCalled();
    view.unmount();
    expect(pickerRef.current).toBeNull();
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

  it("preserves the advertised non-Fast tiers and can restore the standard tier", async () => {
    props.settings!.options.serviceTiers.push(
      { id: "flex", name: "Flex" },
      { id: "unavailable", name: "Unsupported on this model" },
    );
    props.settings!.options.models[0].serviceTierIds.push("flex");
    const view = render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const tier = within(popup).getByRole("combobox", { name: sessionCopy["en-US"].serviceTier });
    expect(within(tier).queryByRole("option", { name: "Unsupported on this model" })).toBeNull();
    expect(within(popup).getByRole("button", { name: copy.fast })).toBeEnabled();
    fireEvent.change(tier, { target: { value: "flex" } });
    await waitFor(() =>
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceTierId: "flex" }),
    );
    props.selection = { ...props.selection, serviceTierId: "flex" };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(tier).toHaveValue("flex");
    fireEvent.change(tier, { target: { value: "" } });
    await waitFor(() => expect(props.onChange).toHaveBeenLastCalledWith({ serviceTierId: null }));
    props.settings!.writable.serviceTier = { available: false, reason: "session-busy" };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(tier).toBeDisabled();
    fireEvent.change(tier, { target: { value: "" } });
    expect(props.onChange).toHaveBeenCalledTimes(2);
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
    expect(await screen.findByRole("dialog", { name: copy.model })).toBe(popup);
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
      expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
      fireEvent.click(fast);
      fireEvent.click(reset);
      fireEvent.click(within(popup).getByRole("button", { name: "Select model: GPT Sol" }));
      const models = await screen.findByRole("dialog", { name: copy.model });
      expect(within(models).getByRole("button", { name: "GPT Terra" })).toBeDisabled();
      expect(props.onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps a retained effort scale disabled while the catalog is missing", async () => {
    const loaded = props.settings!;
    const view = render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    expect(within(popup).getByRole("slider")).toBeEnabled();

    props.retainedEffortOptions = loaded.options.models[0];
    props.settings = { ...loaded, options: { ...loaded.options, models: [] } };
    view.rerender(<ComposerModelPicker {...props} />);
    const slider = within(popup).getByRole("slider");
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
    expect(within(popup).queryByRole("status")).not.toBeInTheDocument();
    fireEvent.keyDown(slider, { key: "End" });
    expect(props.onChange).not.toHaveBeenCalled();

    props.selection = { modelId: "terra" };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(within(popup).queryByRole("slider")).not.toBeInTheDocument();
  });

  it("deduplicates all changes during an async save and reopening never resends", async () => {
    let finish!: (accepted: boolean) => void;
    props.onChange = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ComposerModelPicker {...props} />);
    await openPicker();
    const fast = screen.getByRole("button", { name: copy.fast });
    fireEvent.click(fast);
    expect(fast).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /GPT Sol.*Fast mode/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: copy.fast }));
    fireEvent.click(screen.getByRole("button", { name: copy.reset }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ serviceTierId: "fast" });
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: copy.reset }));
    expect(props.onChange).toHaveBeenCalledOnce();
    await act(async () => {
      finish(false);
    });
    expect(screen.getByRole("button", { name: copy.fast })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: copy.fast })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await openPicker();
    expect(props.onChange).toHaveBeenCalledOnce();
  });

  it("previews a model, its effort and its tier until the authoritative settings arrive", async () => {
    let finish!: (accepted: boolean) => void;
    props.onChange = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    props.selection = { modelId: "sol", effort: "ultra", serviceTierId: "fast" };
    props.reportedSettings = { modelId: "sol", effort: "ultra" };
    const view = render(<ComposerModelPicker {...props} />);
    const models = await openModels();
    fireEvent.click(within(models).getByRole("button", { name: "GPT Terra" }));
    expect(
      screen.getByRole("button", { name: /Select reasoning effort: GPT Terra · High/ }),
    ).toBeVisible();
    const overview = await screen.findByRole("dialog", { name: /^Select reasoning effort:/ });
    expect(within(overview).getByRole("slider")).toHaveAttribute("aria-valuetext", "High");
    expect(within(overview).getByRole("button", { name: copy.fast })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(
      within(overview).getByRole("button", { name: `${copy.chooseModel}: GPT Terra` }),
    );
    expect(await within(models).findByRole("button", { name: "GPT Terra" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await act(async () => finish(true));
    expect(within(models).getByRole("button", { name: "GPT Terra" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    view.rerender(
      <ComposerModelPicker
        {...props}
        settings={{ ...props.settings!, revision: 2 }}
        reportedSettings={undefined}
        selection={{ modelId: "compatible", effort: "low" }}
      />,
    );
    expect(within(models).getByRole("button", { name: "Compatible model" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    view.rerender(<ComposerModelPicker {...props} />);
    expect(within(models).getByRole("button", { name: "GPT Sol" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(props.onChange).toHaveBeenCalledOnce();
  });

  it("shows the model's default effort where an agent reports none for it", async () => {
    props = { ...props, effortDefault: true, selection: { modelId: "sol" } };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    expect(within(popup).getByText(`${copy.defaultEffort} · Medium`)).toBeInTheDocument();
    expect(within(popup).getByRole("slider", { name: copy.chooseEffort })).toHaveAttribute(
      "aria-valuetext",
      `${copy.defaultEffort} · Medium`,
    );
    // Choosing another model keeps following that model's default.
    fireEvent.click(within(popup).getByRole("button", { name: `${copy.chooseModel}: GPT Sol` }));
    const models = await screen.findByRole("dialog", { name: copy.model });
    fireEvent.click(within(models).getByRole("button", { name: "GPT Terra" }));
    await waitFor(() => expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ model: "terra" }));
  });

  it("offers only the full reset when both resets are available", async () => {
    props = { ...props, clearEffort: true, effortDefault: true };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    expect(within(popup).queryByRole("button", { name: copy.useDefaultEffort })).toBeNull();
    fireEvent.click(within(popup).getByRole("button", { name: copy.reset }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ restoreDefaults: true });
  });

  it("uses the same reset button to clear effort when a full reset is unavailable", async () => {
    props = { ...props, clearEffort: true, effortDefault: true };
    props.settings!.writable.restoreDefaults = { available: false };
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    const reset = within(popup).getByRole("button", { name: copy.useDefaultEffort });
    expect(within(popup).queryByText(copy.useDefaultEffort)).not.toBeInTheDocument();
    fireEvent.click(reset);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: null });
  });

  it("can recover from an unsupported effort even if the model offers only one level", async () => {
    props.selection = { modelId: "sol", effort: "ultra" };
    props.settings!.options.models[0].efforts = ["low"];
    render(<ComposerModelPicker {...props} />);
    const popup = await openPicker();
    expect(within(popup).queryByRole("slider")).toBeNull();
    fireEvent.click(within(popup).getByRole("button", { name: `${copy.chooseEffort}: Low` }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ effort: "low" });
  });

  it("selects a listed model with only an effort known, without resetting it", async () => {
    props = { ...props, effortDefault: true, selection: { effort: "ultra" } };
    props.settings!.current = {};
    props.settings!.options.models[1].efforts = [];
    delete props.settings!.options.models[1].defaultEffort;
    render(<ComposerModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: copy.modelSettings }));
    const overview = await screen.findByRole("dialog", { name: copy.modelSettings });
    fireEvent.click(within(overview).getByRole("button", { name: copy.chooseModel }));
    const models = await screen.findByRole("dialog", { name: copy.model });
    fireEvent.click(within(models).getByRole("button", { name: "GPT Terra" }));
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ model: "terra" });
  });

  it("shows loading in the overview without presenting active settings", async () => {
    props = { ...props, settings: undefined, selection: undefined, loading: true };
    render(<ComposerModelPicker {...props} />);
    const trigger = screen.getByRole("button", { name: copy.modelSettings });
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog", { name: copy.modelSettings });
    expect(within(popup).getByRole("status")).toHaveTextContent(copy.readingModels);
    expect(within(popup).queryByRole("slider")).not.toBeInTheDocument();
    expect(within(popup).getByRole("button", { name: copy.reset })).toBeDisabled();
    expect(within(popup).getByRole("button", { name: copy.fast })).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "opens the overview before the model list when no model is known in %s",
    async (locale) => {
      const copy = composerModelCopy[locale];
      props = {
        ...props,
        locale,
        selection: {},
        settings: { ...settings(), current: {} },
      };
      render(<ComposerModelPicker {...props} />);
      const trigger = screen.getByRole("button", { name: copy.modelSettings });
      expect(trigger).toHaveTextContent(/^$/);
      fireEvent.click(trigger);
      const overview = await screen.findByRole("dialog", { name: copy.modelSettings });
      expect(within(overview).queryByText(copy.chooseModel)).not.toBeInTheDocument();
      fireEvent.click(within(overview).getByRole("button", { name: copy.chooseModel }));
      const models = await screen.findByRole("dialog", { name: copy.model });
      expect(within(models).queryByRole("slider")).not.toBeInTheDocument();
      const option = within(models).getByRole("button", { name: "GPT Sol" });
      expect(option).toHaveAttribute("aria-pressed", "false");
      expect(props.onChange).not.toHaveBeenCalled();
      fireEvent.click(option);
      expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ model: "sol", effort: "medium" });
    },
  );

  it("opens the settings overview for a displayed model without applying it", async () => {
    props.settings!.current = {};
    props.selection = {};
    props.displayFallback = { modelId: "sol", effort: "ultra" };
    render(<ComposerModelPicker {...props} />);

    const popup = await openPicker();
    const slider = within(popup).getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
    expect(slider).toBeDisabled();
    expect(within(popup).getByRole("button", { name: copy.fast })).toBeDisabled();
    expect(within(popup).queryByRole("button", { name: "GPT Terra" })).not.toBeInTheDocument();
    fireEvent.click(within(popup).getByRole("button", { name: `${copy.chooseModel}: GPT Sol` }));
    const models = await screen.findByRole("dialog", { name: copy.model });
    expect(within(models).getByRole("button", { name: "GPT Sol" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("always starts in the overview when the current model is unknown", async () => {
    const user = userEvent.setup();
    props.settings!.current = {};
    props.selection = {};
    render(<ComposerModelPicker {...props} />);

    const trigger = screen.getByRole("button", { name: copy.modelSettings });
    await user.click(trigger);
    const overview = await screen.findByRole("dialog", { name: copy.modelSettings });
    expect(within(overview).queryByRole("button", { name: "GPT Sol" })).not.toBeInTheDocument();
    expect(within(overview).queryByRole("slider")).not.toBeInTheDocument();

    await user.click(within(overview).getByRole("button", { name: copy.chooseModel }));
    const models = await screen.findByRole("dialog", { name: copy.model });
    expect(within(models).getByRole("button", { name: "GPT Sol" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: copy.modelSettings })).toBeVisible();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("opens the overview when the known model has no reasoning effort choices", async () => {
    props.settings!.options.models[0].efforts = [];
    props.selection = { modelId: "sol" };
    render(<ComposerModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: `${copy.chooseModel}: GPT Sol` }));
    const popup = await screen.findByRole("dialog", { name: copy.modelSettings });
    expect(
      within(popup).getByRole("button", { name: `${copy.chooseModel}: GPT Sol` }),
    ).toBeVisible();
    expect(within(popup).queryByText(copy.effortUnknown)).not.toBeInTheDocument();
    expect(within(popup).queryByRole("slider")).not.toBeInTheDocument();
  });

  it("keeps the reported model and Fast when the settings selection only has a policy", () => {
    render(
      <ComposerModelPicker
        {...props}
        selection={{ policyId: "workspace-write" }}
        reportedSettings={{ modelId: "sol", effort: "low", serviceTierId: "fast" }}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: /GPT Sol.*Fast mode/ })).toBeVisible();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("uses the cached label and Fast indicator until authoritative settings arrive", async () => {
    const value = { ...settings(), current: {} };
    const { rerender } = render(
      <ComposerModelPicker
        {...props}
        settings={undefined}
        selection={{}}
        displayFallback={{
          modelId: "sol",
          name: "Cached Sol",
          effort: "low",
          serviceTierId: "fast",
        }}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: `${copy.chooseEffort}: Cached Sol · Low · ${copy.fast}`,
    });
    expect(trigger).toHaveTextContent("Cached Sol");
    fireEvent.click(trigger);
    const popup = await screen.findByRole("dialog");
    const fast = within(popup).getByRole("button", { name: copy.fast });
    expect(fast).toHaveAttribute("aria-pressed", "true");
    expect(fast).toBeDisabled();
    expect(
      within(popup).getByRole("button", { name: `${copy.chooseModel}: Cached Sol` }),
    ).toBeVisible();

    rerender(
      <ComposerModelPicker
        {...props}
        settings={value}
        selection={{ modelId: "sol", effort: "low" }}
        displayFallback={{
          modelId: "sol",
          name: "Cached Sol",
          effort: "low",
          serviceTierId: "fast",
        }}
      />,
    );
    expect(
      within(popup).getByRole("button", { name: `${copy.chooseModel}: GPT Sol` }),
    ).toBeVisible();
    expect(fast).toHaveAttribute("aria-pressed", "false");
    expect(fast).toBeEnabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("shows current settings when there is no explicit selection", () => {
    const current = settings();
    const emptySelection = {
      ...props,
      selection: {},
      settings: { ...current, current: {} },
    };
    const { rerender } = render(<ComposerModelPicker {...emptySelection} />);
    expect(screen.getByRole("button", { name: copy.modelSettings })).toBeVisible();
    rerender(<ComposerModelPicker {...emptySelection} settings={current} />);
    expect(
      screen.getByRole("button", { name: `${copy.chooseEffort}: GPT Sol · Low` }),
    ).toBeVisible();
    expect(screen.queryByText(/Last used/)).not.toBeInTheDocument();
  });
});
