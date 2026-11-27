// @vitest-environment node
import { REMOTE_ERROR_CONTRACT } from "@agentkib/runtime-protocol";
import { expect, it, vi } from "vitest";
import { RuntimeRequestError } from "../runtime-host";
import { dispatchClaude, requestSessionWithTerminalDisplay } from "./claude-dispatch";

it("keeps the live read working when a same-version runtime rejects the display field", async () => {
  const input = { host: { request: { operation: "live", sessionId: "session" } } };
  const live = { status: "running", sendEnabled: false };
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(
      new RuntimeRequestError({
        code: -32602,
        message: "Invalid method parameters",
        data: {
          detail: '[{"code":"unrecognized_keys","keys":["terminalDisplay"],"path":["host"]}]',
        },
      }),
    )
    .mockResolvedValueOnce(live);
  await expect(requestSessionWithTerminalDisplay(invoke, true, input)).resolves.toEqual(live);
  expect(invoke.mock.calls).toEqual([
    [{ host: { ...input.host, terminalDisplay: true } }],
    [input],
  ]);
});

const params = {
  operation: "send",
  requestId: "request",
  sessionId: "session",
  deviceId: "owner",
  runtimeBootId: "boot",
};
it.each(["web-busy", "stale-Claude-revision", "claude-bridge-disconnected"])(
  "confirms a %s preflight rejection without retrying the mutation",
  async (message) => {
    const invoke = vi.fn().mockRejectedValue(new RuntimeRequestError({ code: -32000, message }));
    const receipt = vi.fn().mockResolvedValue({ found: false, requestId: "request" });
    expect(await dispatchClaude(invoke, receipt, params)).toMatchObject({
      accepted: false,
      requestId: "request",
      runtimeBootId: "boot",
      controlOutcome: "not-dispatched",
      reason: message,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledExactlyOnceWith({ requestId: "request", deviceId: "owner" });
  },
);
it("never labels an existing same-ID execution as not dispatched because another attempt was busy", async () => {
  const invoke = vi
    .fn()
    .mockRejectedValue(new RuntimeRequestError({ code: -32000, message: "web-busy" }));
  for (const prior of [
    { found: true, requestId: "request", status: "unknown" },
    { found: false, requestId: "different" },
  ]) {
    await expect(dispatchClaude(invoke, async () => prior, params)).rejects.toThrow("web-busy");
  }
});
it("does not infer safe rejection from an untyped transport error or failed receipt lookup", async () => {
  const receipt = vi.fn().mockRejectedValue(new Error("disconnected"));
  await expect(
    dispatchClaude(
      async () => {
        throw new Error("web-busy");
      },
      receipt,
      params,
    ),
  ).rejects.toThrow("web-busy");
  expect(receipt).not.toHaveBeenCalled();
  await expect(
    dispatchClaude(
      async () => {
        throw new RuntimeRequestError({ code: -32000, message: "web-busy" });
      },
      receipt,
      params,
    ),
  ).rejects.toThrow("disconnected");
});
it("keeps an unrecognized runtime error unconfirmed even when a receipt was not found", async () => {
  const error = new RuntimeRequestError({ code: -32000, message: "runtime-exited" });
  const invoke = vi.fn().mockRejectedValue(error);
  const receipt = vi.fn().mockResolvedValue({ found: false, requestId: "request" });
  await expect(dispatchClaude(invoke, receipt, params)).rejects.toBe(error);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(receipt).not.toHaveBeenCalled();
});

it("exposes the foreground refusal only for handover and with an absent matching receipt", async () => {
  const { code, ipc } = REMOTE_ERROR_CONTRACT.claudeTerminalForegroundUnconfirmed;
  const error = new RuntimeRequestError({
    code: ipc.rpcCode,
    message: "AgentKib command failed",
    data: { detail: ipc.detail },
  });
  const invoke = vi.fn().mockRejectedValue(error);
  const missing = vi.fn().mockResolvedValue({ found: false, requestId: params.requestId });
  const handover = { ...params, operation: "handover-terminal" };
  await expect(dispatchClaude(invoke, missing, params)).rejects.toBe(error);
  expect(missing).not.toHaveBeenCalled();
  for (const prior of [
    { found: true, requestId: params.requestId, status: "unknown" },
    { found: false, requestId: "another-request" },
  ]) {
    await expect(dispatchClaude(invoke, async () => prior, handover)).rejects.toBe(error);
  }
  await expect(dispatchClaude(invoke, missing, handover)).resolves.toMatchObject({
    controlOutcome: "not-dispatched",
    reason: code,
  });
});
