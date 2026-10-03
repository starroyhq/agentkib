import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { registerRuntimeIpc } from "./runtime";
import { verifiedCursorBridgeBundle } from "../cursor-bridge-bundle";
import type { DesktopRuntimeHost } from "../runtime-host";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/trusted/desktop" },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock("../cursor-bridge-bundle", () => ({ verifiedCursorBridgeBundle: vi.fn() }));
const event = {} as IpcMainInvokeEvent;
const request = vi.fn();
const trusted = vi.fn();
function handler(channel: string) {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error("Missing IPC handler");
  return call[1];
}
beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  request.mockReset();
  trusted.mockReset();
  vi.mocked(shell.showItemInFolder).mockReset();
  vi.mocked(verifiedCursorBridgeBundle).mockReset().mockResolvedValue({
    id: "agentkib.cursor-bridge",
    version: "0.1.0",
    sha256: "synthetic",
    path: "/trusted/desktop/build/cursor-bridge/agentkib.cursor-bridge.vsix",
  });
  registerRuntimeIpc({
    runtime: () => ({ request }) as unknown as DesktopRuntimeHost,
    assertTrustedRenderer: trusted,
    withRuntimeCapabilities: (value) => value,
  });
});
describe("local Cursor bridge IPC", () => {
  it("omits an absent binding identity from status requests", () => {
    handler("agentkib:workspace:cursor-bridge")(event, {
      action: "status",
      workspaceId: "workspace",
    });
    expect(request).toHaveBeenCalledWith("workspace.cursorBridge", {
      action: "status",
      workspaceId: "workspace",
    });
  });
  it("allows explicit reconnect identity and only the fixed runtime method", () => {
    handler("agentkib:workspace:cursor-bridge")(event, {
      action: "connect",
      workspaceId: "workspace",
      bindingId: "binding",
    });
    expect(trusted).toHaveBeenCalledWith(event);
    expect(request).toHaveBeenCalledWith("workspace.cursorBridge", {
      action: "connect",
      workspaceId: "workspace",
      bindingId: "binding",
    });
  });
  it.each([
    { action: "status", workspaceId: "workspace", bindingId: "binding" },
    { action: "connect", workspaceId: "workspace", path: "/external/request.json" },
    { action: "import", workspaceId: "workspace" },
    { action: "disconnect", workspaceId: "workspace" },
  ])("rejects extra paths and unsupported request fields %j", (input) => {
    expect(() => handler("agentkib:workspace:cursor-bridge")(event, input)).toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it("reveals only the verified development resource, ignoring renderer paths", async () => {
    await handler("agentkib:cursor:reveal-bridge-bundle")(event, "/external/evil.vsix");
    expect(app.isPackaged).toBe(false);
    expect(verifiedCursorBridgeBundle).toHaveBeenCalledWith(
      path.join("/trusted/desktop", "build", "cursor-bridge"),
    );
    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      "/trusted/desktop/build/cursor-bridge/agentkib.cursor-bridge.vsix",
    );
  });
  it("does not reveal an artifact which fails verification", async () => {
    vi.mocked(verifiedCursorBridgeBundle).mockRejectedValue(new Error("hash mismatch"));
    await expect(handler("agentkib:cursor:reveal-bridge-bundle")(event)).rejects.toThrow(
      "hash mismatch",
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
