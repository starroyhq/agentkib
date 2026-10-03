// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));

import { createIpcRegistrar } from "./registrar";
import type { DesktopRuntimeHost } from "../runtime-host";

const trusted = { sender: "trusted" } as unknown as IpcMainInvokeEvent;
const untrusted = { sender: "other" } as unknown as IpcMainInvokeEvent;

describe("createIpcRegistrar", () => {
  const request = vi.fn(async (_method: string, params: unknown) => params);
  const params = vi.fn((id: unknown) => ({ id }));
  const registrar = createIpcRegistrar({
    assertTrustedRenderer: (event) => {
      if (event !== trusted) throw new Error("Rejected IPC from an unknown renderer");
    },
    runtime: () => ({ request }) as unknown as DesktopRuntimeHost,
  });

  beforeEach(() => {
    handlers.clear();
    request.mockClear();
    params.mockClear();
  });

  it("rejects untrusted senders before validating params or calling the runtime", () => {
    registrar.forward("agentkib:test", "test.method", params);
    expect(() => handlers.get("agentkib:test")!(untrusted, "id")).toThrow("unknown renderer");
    expect(params).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards validated params to the runtime method", async () => {
    registrar.forward("agentkib:test", "test.method", params);
    await expect(handlers.get("agentkib:test")!(trusted, "id")).resolves.toEqual({ id: "id" });
    expect(request).toHaveBeenCalledWith("test.method", { id: "id" });
  });

  it("sends an empty object when no params builder is given", async () => {
    registrar.forward("agentkib:empty", "test.empty");
    await handlers.get("agentkib:empty")!(trusted);
    expect(request).toHaveBeenCalledWith("test.empty", {});
  });

  it("passes the event and arguments to custom handlers", () => {
    const handler = vi.fn(() => "ok");
    registrar.handle("agentkib:custom", handler);
    expect(handlers.get("agentkib:custom")!(trusted, 1, 2)).toBe("ok");
    expect(handler).toHaveBeenCalledWith(trusted, 1, 2);
  });
});
