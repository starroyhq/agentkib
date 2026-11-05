// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ComposerModelPicker } from "./composer-model-picker";

function motion(name: string) {
  const animation = {
    animationName: name,
    playbackRate: 1,
    currentTime: 237,
    playState: "running" as AnimationPlayState,
    updatePlaybackRate: vi.fn(function (this: { playbackRate: number }, rate: number) {
      this.playbackRate = rate;
    }),
    pause: vi.fn(function (this: { playState: AnimationPlayState }) {
      this.playState = "paused";
    }),
    play: vi.fn(function (this: { playState: AnimationPlayState }) {
      this.playState = "running";
    }),
  };
  return animation;
}

let flow: ReturnType<typeof motion>;
let glow: ReturnType<typeof motion>;
let bob: ReturnType<typeof motion>;
let reduced: boolean;
let hidden: boolean;
let media: MediaQueryList;
let props: ComponentProps<typeof ComposerModelPicker>;
let originalAnimations: PropertyDescriptor | undefined;

beforeEach(() => {
  flow = motion("composer-fast-flow");
  glow = motion("composer-fast-spectrum");
  bob = motion("composer-particle-bob");
  originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.classList.contains("composer-effort-fill")) return [glow as unknown as Animation];
      if (this.classList.contains("composer-effort-flow")) return [flow as unknown as Animation];
      if (this.classList.contains("composer-effort-particle")) return [bob as unknown as Animation];
      return [];
    },
  });
  reduced = false;
  hidden = false;
  media = new EventTarget() as MediaQueryList;
  Object.defineProperty(media, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  props = {
    locale: "en-US",
    disabled: false,
    saving: false,
    selection: { modelId: "sol", effort: "high" },
    settings: {
      available: true,
      revision: 1,
      sessionId: "session",
      current: { modelId: "sol", effort: "high" },
      defaults: { modelId: "sol", effort: "low" },
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
          { id: "sol", name: "GPT Sol", efforts: ["low", "high"], serviceTierIds: ["priority"] },
        ],
        serviceTiers: [{ id: "priority", name: "Fast" }],
        policies: [],
      },
    },
    onOpen: vi.fn(),
    onChange: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalAnimations)
    Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

function open() {
  fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
  return screen.getByRole("dialog");
}

const tick = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("composer effort motion", () => {
  it("keeps irregular full-track particle coordinates and per-particle drift across Fast changes", () => {
    const view = render(<ComposerModelPicker {...props} />);
    const popup = open();
    const particles = Array.from(popup.querySelectorAll<HTMLElement>(".composer-effort-particle"));
    const count = particles.length / 2;
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThan(12);
    const first = particles.slice(0, count);
    const xs = first.map((particle) => parseFloat(particle.style.left)).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, index) => (x - xs[index]).toFixed(2));
    expect(new Set(gaps).size).toBeGreaterThan(8);
    expect(new Set(first.map((particle) => particle.style.top)).size).toBe(count);
    expect(new Set(first.map((particle) => particle.style.opacity)).size).toBeGreaterThan(8);
    expect(
      new Set(first.map((particle) => particle.style.getPropertyValue("--particle-bob-delay")))
        .size,
    ).toBe(count);
    expect(
      new Set(first.map((particle) => particle.style.getPropertyValue("--particle-bob-duration")))
        .size,
    ).toBe(count);
    for (let index = 0; index < count; index++)
      expect(
        parseFloat(particles[index + count].style.left) - parseFloat(first[index].style.left),
      ).toBeCloseTo(100);
    const styles = particles.map((particle) => particle.getAttribute("style"));
    props = { ...props, selection: { ...props.selection, serviceTierId: "priority" } };
    view.rerender(<ComposerModelPicker {...props} />);
    const accelerated = Array.from(
      popup.querySelectorAll<HTMLElement>(".composer-effort-particle"),
    );
    expect(accelerated).toEqual(particles);
    expect(accelerated.map((particle) => particle.getAttribute("style"))).toEqual(styles);
  });

  it("smoothly accelerates and decelerates the same animations without resetting their phase", async () => {
    const view = render(<ComposerModelPicker {...props} />);
    const popup = open();
    const particles = popup.querySelector(".composer-effort-flow");
    expect(flow.playbackRate).toBe(1);
    props = { ...props, selection: { ...props.selection, serviceTierId: "priority" } };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(flow.playbackRate).toBe(1);
    await waitFor(() => expect(flow.playbackRate).toBe(10), { timeout: 1600 });
    expect(flow.updatePlaybackRate.mock.calls.some(([rate]) => rate > 1 && rate < 10)).toBe(true);
    expect(glow.playbackRate).toBe(10);
    expect(bob.playbackRate).toBe(2);
    props = { ...props, selection: { ...props.selection, serviceTierId: undefined } };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(flow.playbackRate).toBe(10);
    await waitFor(() => expect(flow.playbackRate).toBe(1), { timeout: 1600 });
    expect(glow.playbackRate).toBe(1);
    expect(bob.playbackRate).toBe(1);
    expect(popup.querySelector(".composer-effort-flow")).toBe(particles);
    for (const animation of [flow, glow, bob]) expect(animation.currentTime).toBe(237);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("reverses from the current speed when Fast is disabled during acceleration", async () => {
    const view = render(<ComposerModelPicker {...props} />);
    open();
    props = { ...props, selection: { ...props.selection, serviceTierId: "priority" } };
    view.rerender(<ComposerModelPicker {...props} />);
    await waitFor(() => expect(flow.playbackRate).toBeGreaterThan(1));
    const speed = flow.playbackRate;
    expect(speed).toBeLessThan(10);
    props = { ...props, selection: { ...props.selection, serviceTierId: undefined } };
    view.rerender(<ComposerModelPicker {...props} />);
    expect(flow.playbackRate).toBe(speed);
    await waitFor(() => expect(flow.playbackRate).toBe(1), { timeout: 1600 });
    expect(flow.currentTime).toBe(237);
  });

  it("pauses all motion for reduced motion and resumes without sending a setting change", async () => {
    reduced = true;
    props.selection = { ...props.selection, serviceTierId: "priority" };
    render(<ComposerModelPicker {...props} />);
    open();
    for (const animation of [flow, glow, bob]) expect(animation.playState).toBe("paused");
    await tick(80);
    expect(flow.updatePlaybackRate).not.toHaveBeenCalled();
    act(() => {
      reduced = false;
      media.dispatchEvent(new Event("change"));
    });
    await waitFor(() => expect(flow.playbackRate).toBe(10), { timeout: 1600 });
    act(() => {
      reduced = true;
      media.dispatchEvent(new Event("change"));
    });
    const calls = flow.updatePlaybackRate.mock.calls.length;
    await tick(80);
    expect(flow.updatePlaybackRate).toHaveBeenCalledTimes(calls);
    for (const animation of [flow, glow, bob]) expect(animation.playState).toBe("paused");
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("stops frame work while hidden and cleans it up on close", async () => {
    props.selection = { ...props.selection, serviceTierId: "priority" };
    render(<ComposerModelPicker {...props} />);
    open();
    await waitFor(() => expect(flow.playbackRate).toBeGreaterThan(1));
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenCalls = flow.updatePlaybackRate.mock.calls.length;
    await tick(80);
    expect(flow.updatePlaybackRate).toHaveBeenCalledTimes(hiddenCalls);
    for (const animation of [flow, glow, bob]) expect(animation.playState).toBe("paused");
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(flow.playbackRate).toBe(10), { timeout: 1600 });
    fireEvent.click(screen.getByRole("button", { name: /^Select reasoning effort:/ }));
    const closedCalls = flow.updatePlaybackRate.mock.calls.length;
    await tick(80);
    expect(flow.updatePlaybackRate).toHaveBeenCalledTimes(closedCalls);
    for (const animation of [flow, glow, bob]) expect(animation.playState).toBe("paused");
  });

  it("keeps the picker usable without getAnimations support", () => {
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: undefined,
    });
    render(<ComposerModelPicker {...props} />);
    open();
    expect(screen.getByRole("button", { name: "Fast mode" })).toBeEnabled();
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
