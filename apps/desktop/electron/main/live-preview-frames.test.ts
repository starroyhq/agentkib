import { describe, expect, it, vi } from "vitest";
import type { WebContents, WebFrameMain } from "electron";
import {
  allowLocalPreviewFraming,
  framableHeaders,
  localPreviewFrameResponse,
} from "./live-preview-frames";

const window = {} as WebContents;
const other = {} as WebContents;
const top = { parent: null } as unknown as WebFrameMain;
const panelFrame = { parent: top } as unknown as WebFrameMain;
const nestedFrame = { parent: panelFrame } as unknown as WebFrameMain;
const forbidding = {
  "Content-Type": ["text/html"],
  "X-Frame-Options": ["DENY"],
  "Content-Security-Policy": ["default-src 'self'; frame-ancestors 'none'"],
};
const details = (overrides: Partial<Parameters<typeof localPreviewFrameResponse>[0]> = {}) => ({
  url: "http://localhost:8000/admin/",
  resourceType: "subFrame" as const,
  frame: panelFrame,
  webContents: window,
  responseHeaders: forbidding,
  ...overrides,
});
const isPreviewWindow = (contents: WebContents) => contents === window;

describe("framableHeaders", () => {
  it("drops X-Frame-Options and frame-ancestors and keeps every other directive", () => {
    expect(framableHeaders(forbidding)).toEqual({
      "Content-Type": ["text/html"],
      "Content-Security-Policy": ["default-src 'self'"],
    });
    expect(framableHeaders({ "x-frame-options": ["SAMEORIGIN"] })).toEqual({});
  });
  it("handles several policies in one header and directive names in any case", () => {
    expect(
      framableHeaders({
        "content-security-policy": [
          "script-src 'self'; FRAME-ANCESTORS https://a.example, frame-ancestors 'self'",
          "img-src data:",
        ],
      }),
    ).toEqual({ "content-security-policy": ["script-src 'self'", "img-src data:"] });
  });
  it("removes a policy left empty and the header when no policy remains", () => {
    expect(
      framableHeaders({
        "Content-Security-Policy": ["frame-ancestors 'none'", "frame-ancestors 'self';"],
        Vary: ["Accept"],
      }),
    ).toEqual({ Vary: ["Accept"] });
  });
  it("changes nothing for pages that allow framing or only report it", () => {
    expect(framableHeaders({ "Content-Security-Policy": ["default-src 'self'"] })).toBeUndefined();
    expect(
      framableHeaders({ "Content-Security-Policy-Report-Only": ["frame-ancestors 'none'"] }),
    ).toBeUndefined();
    expect(framableHeaders({ "Content-Type": ["text/html"] })).toBeUndefined();
  });
});

describe("localPreviewFrameResponse", () => {
  it("lets the main window frame a localhost page that forbids framing", () => {
    expect(localPreviewFrameResponse(details(), isPreviewWindow)).toEqual({
      responseHeaders: {
        "Content-Type": ["text/html"],
        "Content-Security-Policy": ["default-src 'self'"],
      },
    });
    expect(
      localPreviewFrameResponse(details({ url: "https://localhost:5173/" }), isPreviewWindow),
    ).toHaveProperty("responseHeaders");
  });
  it.each([
    ["a frame inside the previewed page", { frame: nestedFrame }],
    ["the window's own document", { resourceType: "mainFrame" as const, frame: top }],
    ["a script", { resourceType: "script" as const }],
    ["a frame that is gone", { frame: null }],
    ["another window", { webContents: other }],
    ["a request without a window", { webContents: undefined }],
    ["AgentKib's own 127.0.0.1 servers", { url: "http://127.0.0.1:8000/" }],
    ["a host that only starts with localhost", { url: "http://localhost.example:8000/" }],
    ["a response without headers", { responseHeaders: undefined }],
  ])("keeps the headers of %s", (_name, overrides) => {
    expect(localPreviewFrameResponse(details(overrides), isPreviewWindow)).toEqual({});
  });
  it("registers one listener for localhost on every port and answers it", () => {
    const onHeadersReceived = vi.fn();
    allowLocalPreviewFraming({ webRequest: { onHeadersReceived } } as never, isPreviewWindow);
    expect(onHeadersReceived).toHaveBeenCalledOnce();
    const [filter, listener] = onHeadersReceived.mock.calls[0]!;
    expect(filter).toEqual({ urls: ["http://localhost/*", "https://localhost/*"] });
    const callback = vi.fn();
    listener(details(), callback);
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        "Content-Type": ["text/html"],
        "Content-Security-Policy": ["default-src 'self'"],
      },
    });
  });
});
