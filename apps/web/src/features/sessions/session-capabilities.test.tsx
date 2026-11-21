import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type CodexCapabilities, type Live } from "@agentkib/web-client";
import { useSessionCapabilities } from "@agentkib/session-ui";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
const capabilities: CodexCapabilities = {
  sessionId: "source",
  status: "idle",
  executionMode: "codex-managed",
  features: { fork: { available: true } },
};
function fixture() {
  const client = new WebClient();
  const first = deferred<CodexCapabilities>();
  const second = deferred<CodexCapabilities>();
  const read = vi
    .spyOn(client, "sessionCapabilities")
    .mockResolvedValue(capabilities)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = renderHook(() =>
    useSessionCapabilities({
      client,
      selected: "source",
      agent: "codex",
      epoch: 0,
      access: {
        status: "approved",
        csrfToken: "synthetic",
        bootId: "boot",
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { id: "device", name: "Fixture", send: true, approve: true, manage: true },
      } satisfies Access,
      live: {
        sessionId: "source",
        revision: 1,
        status: "idle",
        executionMode: "codex-managed",
        sendEnabled: true,
        approvals: [],
      } satisfies Live,
    }),
  );
  return { ...view, first, second, read };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("capability read lifetime", () => {
  it("shares an in-flight read but starts a new read after it settles, keeping the display snapshot", async () => {
    const host = fixture();
    const pending = host.result.current.verifyCapabilities();
    expect(host.result.current.verifyCapabilities()).toBe(pending);
    expect(host.read).toHaveBeenCalledOnce();
    await act(async () => {
      host.first.resolve(capabilities);
      await pending;
    });
    const fresh = host.result.current.verifyCapabilities();
    expect(fresh).not.toBe(pending);
    expect(host.read).toHaveBeenCalledTimes(2);
    expect(host.result.current.capabilities).toEqual(capabilities);
    expect(host.result.current.verifyCapabilities()).toBe(fresh);
    await act(async () => {
      host.second.resolve(capabilities);
      await fresh;
    });
  });

  it("discards a response from an executor that no longer owns the selected session", async () => {
    const host = fixture();
    const pending = host.result.current.verifyCapabilities();
    await act(async () => {
      host.first.resolve({ ...capabilities, executionMode: "codex-follower" });
      expect(await pending).toBeUndefined();
    });
    expect(host.result.current.capabilities).toBeUndefined();
  });

  it("does not let a late aborted read clear a newer read with the same key", async () => {
    const host = fixture();
    const obsolete = host.result.current.verifyCapabilities();
    act(() => host.result.current.clearCapabilities());
    const current = host.result.current.verifyCapabilities();
    expect(current).not.toBe(obsolete);
    expect(host.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      host.first.resolve(capabilities);
      await obsolete;
    });
    expect(host.result.current.verifyCapabilities()).toBe(current);
    expect(host.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      host.second.resolve(capabilities);
      await current;
    });
    expect(host.result.current.capabilities).toEqual(capabilities);
  });
});
