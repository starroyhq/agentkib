import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, parseLanOrigin, SseParser, WebClient } from "@agentkib/web-client";
import { HostedConnection } from "./HostedConnection";
import { SessionApp } from "./App";

const info = {
  protocolVersion: 1,
  transport: "lan",
  capabilities: { read: true, send: false, approve: false },
};
const access = {
  status: "unpaired",
  csrfToken: "csrf",
  bearerToken: "secret",
  bootId: "boot",
  experimentalEnabled: false,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});
describe("LAN target validation", () => {
  it.each([
    "http://10.0.0.1:1422",
    "http://172.16.0.1:1422",
    "http://172.31.255.255:65535",
    "http://192.168.1.10:1422",
  ])("accepts %s", (address) => expect(parseLanOrigin(address)).toBe(address));
  it.each([
    "https://192.168.1.1:1422",
    "http://localhost:1422",
    "http://127.0.0.1:1422",
    "http://8.8.8.8:1422",
    "http://172.32.0.1:1422",
    "http://192.168.001.1:1422",
    "http://3232235777:1422",
    "http://192.168.1.1:0",
    "http://192.168.1.1:65536",
    "http://192.168.1.1:1422/",
    "http://user@192.168.1.1:1422",
    "http://192.168.1.1:1422?q=a",
    "http://192.168.1.1:1422#x",
    "http://192.168.1.1",
  ])("rejects %s", (address) => expect(() => parseLanOrigin(address)).toThrow());
});
describe("hosted transport", () => {
  it("decodes split UTF-8 stream records and reconnects only the stream, never controls", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode('event: snapshot\r\ndata: {"status":"空闲"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(json({}, 401));
    const client = new WebClient(fetcher, "http://10.0.0.1:1422");
    await client.access();
    const event = vi.fn(),
      open = vi.fn(),
      error = vi.fn();
    const close = client.stream("s", { event, open, error });
    await vi.advanceTimersByTimeAsync(0);
    expect(event).toHaveBeenCalledWith("snapshot", '{"status":"空闲"}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(event).toHaveBeenCalledWith("access-ended", "");
    expect(fetcher.mock.calls.slice(2).map((call) => call[0])).toEqual([
      "http://10.0.0.1:1422/api/web/v1/stream?sessionId=s",
      "http://10.0.0.1:1422/api/web/v1/stream?sessionId=s",
    ]);
    close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("accepts a 3 MiB ASCII snapshot and bounds data by UTF-8 bytes", () => {
    const emit = vi.fn(),
      parser = new SseParser(emit);
    const data = "x".repeat(3 * 1024 * 1024);
    parser.push(`event: snapshot\ndata: ${data}\n\n`);
    expect(emit).toHaveBeenCalledWith("snapshot", data);
    expect(() => parser.push(`data: ${"文".repeat(1_500_000)}\n\n`)).toThrow("stream_too_large");
  });
  it("processes a fragmented 4 MiB frame with linear UTF-8 encoding work", () => {
    const encode = TextEncoder.prototype.encode;
    let encodedUnits = 0;
    const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
      this: TextEncoder,
      value = "",
    ) {
      encodedUnits += value.length;
      return encode.call(this, value);
    });
    try {
      const emit = vi.fn();
      const parser = new SseParser(emit);
      const data = "x".repeat(4 * 1024 * 1024);
      const frame = `event: snapshot\ndata: ${data}\n\n`;
      for (let offset = 0; offset < frame.length; offset += 1024)
        parser.push(frame.slice(offset, offset + 1024));
      expect(emit).toHaveBeenCalledExactlyOnceWith("snapshot", data);
      expect(encodedUnits).toBeLessThanOrEqual(frame.length * 2);
      parser.push("data: next\n\n");
      expect(emit).toHaveBeenLastCalledWith("message", "next");
    } finally {
      spy.mockRestore();
    }
  });
  it("preserves fragmented Unicode and rejects oversized unfinished lines", () => {
    const emit = vi.fn();
    const parser = new SseParser(emit);
    parser.push("data: 文\ud83d");
    parser.push("\ude00\r");
    parser.push("\n\n");
    expect(emit).toHaveBeenCalledWith("message", "文😀");
    parser.push("data: " + "x".repeat(4 * 1024 * 1024));
    expect(() => parser.push("x".repeat(1024))).toThrow("stream_too_large");
  });
  it("requires protocol check, keeps token out of Access and sends bearer and CSRF without cookies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({}));
    const client = new WebClient(fetcher, "http://192.168.1.10:1422");
    await expect(client.catalog()).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.access()).not.toHaveProperty("bearerToken");
    await client.request("pair", { code: "12345678" });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "http://192.168.1.10:1422/api/web/v1/info",
      "http://192.168.1.10:1422/api/web/v1/access",
      "http://192.168.1.10:1422/api/web/v1/pair",
    ]);
    expect(fetcher.mock.calls[2][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: "Bearer secret", "X-CSRF-Token": "csrf" },
    });
    client.reset();
    await expect(client.catalog()).rejects.toBeInstanceOf(ApiError);
    const second = new WebClient(fetcher, "http://192.168.1.10:1422");
    await expect(second.catalog()).rejects.toBeInstanceOf(ApiError);
  });
  it("does not access or control an incompatible backend", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ ...info, protocolVersion: 2 }));
    const client = new WebClient(fetcher, "http://10.0.0.1:1422");
    await expect(client.access()).rejects.toMatchObject({ code: "incompatible_protocol" });
    await expect(client.request("send", {})).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("serializes simultaneous access bootstrap", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(info)).mockResolvedValueOnce(json(access));
    const client = new WebClient(fetcher, "http://10.0.0.1:1422");
    await Promise.all([client.access(), client.access()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("parses chunked CRLF SSE and multi-line data without emitting incomplete records", () => {
    const emit = vi.fn(),
      parser = new SseParser(emit);
    parser.push("event: snap");
    parser.push("shot\r\ndata: {\r\n");
    parser.push("data: }\r\n\r");
    expect(emit).not.toHaveBeenCalled();
    parser.push("\n");
    expect(emit).toHaveBeenCalledWith("snapshot", "{\n}");
    parser.push("data: partial");
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it("opens authenticated fetch stream and ends on authorization failure without retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({}, 401));
    const client = new WebClient(fetcher, "http://10.0.0.1:1422");
    await client.access();
    const event = vi.fn(),
      open = vi.fn(),
      error = vi.fn();
    const close = client.stream("session", { event, open, error });
    await waitFor(() => expect(event).toHaveBeenCalledWith("access-ended", ""));
    expect(fetcher.mock.calls[2][1]).toMatchObject({
      headers: { Authorization: "Bearer secret" },
      credentials: "omit",
    });
    expect(open).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    close();
  });
});
describe("hosted connection UI", () => {
  it("keeps pairing credentials after a rejected pairing code", async () => {
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/pair")
          ? json({ code: "invalid_pairing_code" }, 403)
          : json(url.endsWith("/info") ? info : access),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<SessionApp origin="http://10.0.0.1:1422" />);
    await screen.findByLabelText("配对码");
    fireEvent.change(screen.getByLabelText("配对码"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "请求连接" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("配对码")).toBeInTheDocument();
    expect(screen.queryByText("远程访问已结束")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("配对码"), { target: { value: "87654321" } });
    fireEvent.click(screen.getByRole("button", { name: "请求连接" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter((call) => call[0].endsWith("/pair"))).toHaveLength(2),
    );
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith("/access"))).toHaveLength(1);
  });
  it("keeps loaded earlier history and scroll anchor on reconnect, but clears it when host identity changes", async () => {
    let handlers: Parameters<WebClient["stream"]>[1] | undefined;
    vi.spyOn(WebClient.prototype, "stream").mockImplementation((_id, next) => {
      handlers = next;
      return () => {};
    });
    let bootId = "boot",
      updated = false,
      anchorY = 40;
    const entry = (id: string) => ({
      id,
      kind: "agent-message",
      content: id,
      attachment_count: 0,
      truncated: false,
    });
    const fetcher = vi.fn((url: string) => {
      if (url.endsWith("/info")) return Promise.resolve(json(info));
      if (url.endsWith("/access"))
        return Promise.resolve(
          json({
            ...access,
            status: "approved",
            bootId,
            device: { id: "browser", name: "Browser", send: false, approve: false },
          }),
        );
      if (url.endsWith("/catalog"))
        return Promise.resolve(
          json({
            indexEnabled: true,
            workspaces: [{ id: "w", name: "test", path: "/projects/test" }],
            sessions: [
              {
                id: "session",
                title: "LAN session",
                workspace_id: "w",
                agent: "codex",
                availability: "readable",
              },
            ],
          }),
        );
      if (url.includes("/live?"))
        return Promise.resolve(
          json({
            sessionId: "session",
            status: "idle",
            revision: 1,
            approvals: [],
            sendEnabled: false,
          }),
        );
      if (url.includes("cursor="))
        return Promise.resolve(json({ events: [entry("Older loaded")], warnings: [] }));
      if (updated) anchorY = 60;
      return Promise.resolve(
        json({
          events: [entry("Latest loaded"), ...(updated ? [entry("New after reconnect")] : [])],
          warnings: [],
          next_cursor: "older",
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SessionApp origin="http://10.0.0.1:1422" />);
    fireEvent.click(await screen.findByRole("button", { name: /LAN session/ }));
    await screen.findByText("Latest loaded");
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await screen.findByText("Older loaded");
    const viewport = document.querySelector<HTMLElement>(".reader-scroll")!;
    expect(viewport).not.toBeNull();
    viewport.scrollTop = 70;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top = this.dataset.eventId === "Older loaded" ? anchorY : 0;
        return { top, bottom: top + 10 } as DOMRect;
      },
    );
    updated = true;
    act(() => {
      handlers?.error();
      handlers?.open();
    });
    await screen.findByText("New after reconnect");
    expect(screen.getByText("Older loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更早记录" })).not.toBeInTheDocument();
    await waitFor(() => expect(viewport.scrollTop).toBe(90));
    bootId = "new-boot";
    act(() => handlers?.open());
    await waitFor(() => expect(screen.queryByText("Older loaded")).not.toBeInTheDocument());
  });
  it("does not connect from a link until explicit risk consent; target switch erases pairing and requires new bootstrap", async () => {
    history.replaceState(null, "", "/#connect=http%3A%2F%2F192.168.1.10%3A1422");
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(json(url.endsWith("/info") ? info : access)),
    );
    vi.stubGlobal("fetch", fetcher);
    const storageWrite = vi.spyOn(window.Storage.prototype, "setItem");
    render(<HostedConnection />);
    expect(location.hash).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "连接桌面 AgentKib" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "连接桌面 AgentKib" }));
    await screen.findByText("用桌面端授权这个浏览器");
    fireEvent.change(screen.getByLabelText("配对码"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "更换连接 / 清空内容" }));
    expect(screen.queryByLabelText("配对码")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "连接桌面 AgentKib" }));
    await screen.findByText("用桌面端授权这个浏览器");
    expect(screen.getByLabelText("配对码")).toHaveValue("");
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith("/info"))).toHaveLength(2);
    expect(storageWrite).not.toHaveBeenCalled();
  });
});
