import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, DesktopConversationApi } from "../api";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));
await import("./index");
const conversation = electron.exposeInMainWorld.mock.calls.find(
  ([name]) => name === "desktopConversation",
)![1] as DesktopConversationApi;
const desktop = electron.exposeInMainWorld.mock.calls.find(
  ([name]) => name === "agentkibDesktop",
)![1] as DesktopApi;

beforeEach(() => {
  electron.invoke.mockReset().mockResolvedValue(undefined);
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

describe("desktop path display preload", () => {
  it("reads only the local display context without accepting a renderer path", async () => {
    const context = { homeDirectory: "/fixture/home" };
    electron.invoke.mockResolvedValueOnce(context);
    expect(await desktop.paths.displayContext()).toBe(context);
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith("agentkib:paths:display-context");
  });
});

describe("MCP connection preload", () => {
  it.each([
    ["connectionInfo", "agentkib:mcp:connection-info"],
    ["planConnection", "agentkib:mcp:plan-connection"],
    ["verifyConnection", "agentkib:mcp:verify-connection"],
  ] as const)("forwards %s with the selected workspace and Agent", async (method, channel) => {
    const result = { marker: method };
    electron.invoke.mockResolvedValueOnce(result);

    expect(await desktop.mcp[method]("workspace", "cursor")).toBe(result);
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(channel, "workspace", "cursor");
  });
});

describe("desktop conversation preload", () => {
  it("forwards a read nonce and cancellation without replacing mutation receipt IDs", async () => {
    await conversation.request("/history/search", { query: "needle" }, "nonce");
    await conversation.cancelRead("nonce");
    await conversation.request("/send", { requestId: "receipt", text: "input" });
    expect(electron.invoke.mock.calls).toEqual([
      ["agentkib:conversation:request", "/history/search", { query: "needle" }, "nonce"],
      ["agentkib:conversation:cancel-read", "nonce"],
      ["agentkib:conversation:request", "/send", { requestId: "receipt", text: "input" }],
    ]);
  });

  it("forwards the applied subscription cursor to the bounded ACK route", async () => {
    await conversation.acknowledge("subscription", "cursor");
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
      "agentkib:conversation:acknowledge",
      "subscription",
      "cursor",
    );
  });

  it.each(["session", ""])(
    "acknowledges control invalidation after synchronously notifying %j",
    async (sessionId) => {
      const listener = vi.fn((id: string) => {
        expect(id).toBe(sessionId);
        expect(electron.invoke).not.toHaveBeenCalled();
      });
      const stop = conversation.onControlChanged(listener);
      const [channel, receive] = electron.on.mock.calls[0];
      expect(channel).toBe("agentkib:conversation:control-changed");
      receive({}, { sessionId, notificationId: "notification" });
      expect(listener).toHaveBeenCalledExactlyOnceWith(sessionId);
      expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
        "agentkib:conversation:acknowledge-control",
        "notification",
      );
      stop();
      expect(electron.removeListener).toHaveBeenCalledExactlyOnceWith(channel, receive);
    },
  );

  it("releases a control notification even if its listener throws", () => {
    const failure = new Error("consumer failed");
    conversation.onControlChanged(() => {
      throw failure;
    });
    const receive = electron.on.mock.calls[0][1];
    expect(() => receive({}, { sessionId: "session", notificationId: "notification" })).toThrow(
      failure,
    );
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
      "agentkib:conversation:acknowledge-control",
      "notification",
    );
  });

  it("does not retry a failed control notification acknowledgement", async () => {
    electron.invoke.mockRejectedValueOnce(new Error("renderer disconnected"));
    conversation.onControlChanged(vi.fn());
    const receive = electron.on.mock.calls[0][1];
    receive({}, { sessionId: "session", notificationId: "notification" });
    await Promise.resolve();
    expect(electron.invoke).toHaveBeenCalledOnce();
  });
});
