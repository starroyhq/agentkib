import { describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { NativeMemoryObservation } from "./native-memory-observation";
function setup() {
  const request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => undefined);
  return { request, observation: new NativeMemoryObservation(() => ({ request })) };
}
describe("native memory desktop observations", () => {
  it("coalesces navigation before dispatch and releases the final owner", async () => {
    const { request, observation } = setup();
    const first = observation.observe(1, true);
    await observation.observe(1, false);
    await first;
    expect(request.mock.calls).toEqual([[RUNTIME_METHODS.nativeMemoryObserve, { active: false }]]);
    await observation.observe(1, true);
    await observation.observe(2, true);
    observation.forget(1);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.nativeMemoryObserve,
        { active: true },
      ]),
    );
    observation.forget(2);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.nativeMemoryObserve,
        { active: false },
      ]),
    );
  });
  it("pauses hidden windows and restores the latest observation after runtime restart", async () => {
    const { request, observation } = setup();
    observation.setRuntimeAvailable(false);
    await observation.observe(1, true);
    expect(request).not.toHaveBeenCalled();
    observation.setActive(false);
    observation.setRuntimeAvailable(true);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.nativeMemoryObserve,
        { active: false },
      ]),
    );
    observation.setActive(true);
    await vi.waitFor(() =>
      expect(request.mock.calls.at(-1)).toEqual([
        RUNTIME_METHODS.nativeMemoryObserve,
        { active: true },
      ]),
    );
  });
  it("serializes a late acknowledgement before a newer inactive observation", async () => {
    const { request, observation } = setup();
    let finish!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = observation.observe(1, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const last = observation.observe(1, false);
    finish();
    await Promise.all([first, last]);
    expect(request.mock.calls).toEqual([
      [RUNTIME_METHODS.nativeMemoryObserve, { active: true }],
      [RUNTIME_METHODS.nativeMemoryObserve, { active: false }],
    ]);
  });
});
