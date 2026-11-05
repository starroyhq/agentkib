import { describe, expect, it, vi } from "vitest";
import { CostObservation, requireLocalCostProvider } from "./cost-observation";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";

function setup() {
  const request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => undefined);
  const observation = new CostObservation(() => ({ request }));
  return { request, observation };
}

describe("cost page observations", () => {
  it("coalesces a provider switch before dispatch", async () => {
    const { observation, request } = setup();
    const first = observation.observe(1, "codex");
    await observation.observe(1, "claude");
    await first;
    expect(request.mock.calls).toEqual([
      [RUNTIME_METHODS.observeLocalCosts, { provider: "claude" }],
    ]);
  });

  it("orders a late acknowledgement before the latest observation", async () => {
    const { observation, request } = setup();
    let finish!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = observation.observe(1, "codex");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const second = observation.observe(1, "claude");
    finish();
    await Promise.all([first, second]);
    expect(request.mock.calls.at(-1)).toEqual([
      RUNTIME_METHODS.observeLocalCosts,
      { provider: "claude" },
    ]);
  });

  it("releases observations on renderer destruction, retaining other owners", async () => {
    const { observation, request } = setup();
    await observation.observe(1, "codex");
    await observation.observe(2, "claude");
    observation.forget(2);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.observeLocalCosts,
        { provider: "codex" },
      ]),
    );
    observation.forget(1);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.observeLocalCosts,
        { provider: null },
      ]),
    );
  });

  it("clears foreground observation while hidden and restores it", async () => {
    const { observation, request } = setup();
    await observation.observe(1, "codex");
    observation.setActive(false);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.observeLocalCosts,
        { provider: null },
      ]),
    );
    observation.setActive(true);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.observeLocalCosts,
        { provider: "codex" },
      ]),
    );
  });

  it("replays the latest provider after runtime restart without dispatching to the old runtime", async () => {
    const { observation, request } = setup();
    observation.setRuntimeAvailable(false);
    await observation.observe(1, "codex");
    await observation.observe(1, "claude");
    expect(request).not.toHaveBeenCalled();
    observation.setRuntimeAvailable(true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(RUNTIME_METHODS.observeLocalCosts, {
        provider: "claude",
      }),
    );
  });

  it("validates supported providers", () => {
    expect(requireLocalCostProvider("codex")).toBe("codex");
    for (const value of [undefined, null, "cursor", "../claude", {}, 0])
      expect(() => requireLocalCostProvider(value)).toThrow("Unsupported local cost provider");
  });
});
