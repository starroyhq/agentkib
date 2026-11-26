import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { RUNTIME_METHODS } from "../../generated/runtime-protocol";
import type { RuntimeHost } from "../runtime-host";
import { registerRuntimeIpc } from "./runtime";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/fixture/desktop" },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

const event = {} as IpcMainInvokeEvent;
const request = vi.fn();
const trusted = vi.fn();
const methods = [
  ["agentkib:mcp:connection-info", RUNTIME_METHODS.mcpConnectionInfo],
  ["agentkib:mcp:plan-connection", RUNTIME_METHODS.planMcpConnection],
  ["agentkib:mcp:verify-connection", RUNTIME_METHODS.verifyMcpConnection],
] as const;

function handler(channel: string) {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error("Missing IPC handler");
  return call[1];
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  request.mockReset();
  trusted.mockReset();
  registerRuntimeIpc({
    dataDir: "/trusted/desktop/data",
    runtime: () => ({ request }) as unknown as RuntimeHost,
    assertTrustedRenderer: trusted,
    withRuntimeCapabilities: (value) => value,
  });
});

describe("MCP connection IPC", () => {
  it.each(methods)("forwards %s with only the selected workspace and Agent", (channel, method) => {
    handler(channel)(event, "workspace", "cursor", { url: "http://untrusted.example/mcp" });

    expect(trusted).toHaveBeenCalledExactlyOnceWith(event);
    expect(request).toHaveBeenCalledExactlyOnceWith(method, {
      workspaceId: "workspace",
      targetAgent: "cursor",
    });
  });

  it.each(methods)("rejects invalid identity inputs to %s", (channel) => {
    expect(() => handler(channel)(event, "", "cursor")).toThrow("workspaceId");
    expect(() => handler(channel)(event, { workspaceId: "workspace" }, "cursor")).toThrow(
      "workspaceId",
    );
    expect(() => handler(channel)(event, "workspace", "unknown-agent")).toThrow(
      "Unsupported agent",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each(methods)("checks renderer trust before forwarding %s", (channel) => {
    trusted.mockImplementationOnce(() => {
      throw new Error("Untrusted renderer");
    });

    expect(() => handler(channel)(event, "workspace", "cursor")).toThrow("Untrusted renderer");
    expect(request).not.toHaveBeenCalled();
  });
});
