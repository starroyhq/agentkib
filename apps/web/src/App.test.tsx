import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { Transcript, groupEvents, SafeMarkdown } from "@agentkib/session-ui";
import { WebClient, ApiError, type ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "./i18n";
const event = (
  id: string,
  kind: ConversationEvent["kind"],
  extra: Partial<ConversationEvent> = {},
): ConversationEvent => ({
  id,
  kind,
  attachment_count: 0,
  truncated: false,
  content: id,
  ...extra,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("safe transcript", () => {
  it("only folds explicit complete turns and leaves final/unclassified visible", () => {
    const events = [
      event("user", "user-message", { turn_id: "t" }),
      event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "t", tool_name: "exec" }),
      event("unknown", "agent-message", { turn_id: "t" }),
      event("final", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ];
    render(
      <Transcript
        events={events}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.queryByText("comment")).not.toBeInTheDocument();
    expect(screen.getByText("final")).toBeVisible();
    expect(screen.getByText("unknown")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Execution process/ }));
    expect(screen.getByText("comment")).toBeVisible();
  });
  it("keeps incomplete commentary and failed tools visible", () => {
    render(
      <Transcript
        events={[
          event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
          event("tool", "tool-summary", { turn_id: "t", tool_name: "exec", tool_status: "failed" }),
        ]}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.getByText("comment")).toBeVisible();
    expect(screen.getByRole("button", { name: /exec/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Execution process/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  it("does not group across unknown boundaries", () => {
    const result = groupEvents([
      event("a", "user-message", { turn_id: "t" }),
      event("b", "agent-message"),
      event("c", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ]);
    expect(result).toHaveLength(3);
    expect(result.every((g) => !g.complete)).toBe(true);
  });
  it("retains disclosure choice when earlier records complete a turn", () => {
    const end = [
      event("tool", "tool-summary", { turn_id: "t" }),
      event("final", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
    ];
    const { rerender } = render(
      <Transcript events={end} labels={dictionaries["en-US"]} onTool={() => {}} locale="en-US" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Execution process/ }));
    rerender(
      <Transcript
        events={[
          event("user", "user-message", { turn_id: "t" }),
          event("comment", "agent-message", { turn_id: "t", message_phase: "commentary" }),
          ...end,
        ]}
        labels={dictionaries["en-US"]}
        onTool={() => {}}
        locale="en-US"
      />,
    );
    expect(screen.getByText("comment")).toBeVisible();
  });
  it("does not load remote images or dangerous links", () => {
    const { container } = render(
      <SafeMarkdown
        text={
          "![tracker](https://tracker.example/a) [bad](javascript:alert(1)) [good](https://example.com) <script>alert(1)</script>"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  });
  it("does not fold commentary when paging warns about missing records", () => {
    const g = groupEvents(
      [
        event("u", "user-message", { turn_id: "t" }),
        event("c", "agent-message", { turn_id: "t", message_phase: "commentary" }),
        event("f", "agent-message", { turn_id: "t", message_phase: "final_answer" }),
      ],
      true,
    );
    expect(g[0].segments[1].process).toBe(false);
  });
});
describe("browser client", () => {
  it.each(["not-dispatched", "unknown", undefined, "invalid"])(
    "only preserves recognized control outcome %s",
    async (controlOutcome) => {
      const client = new WebClient(
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ code: "permission_denied", controlOutcome }, { status: 403 }),
          ),
      );
      await expect(client.request("send", {})).rejects.toMatchObject({
        code: "permission_denied",
        controlOutcome: controlOutcome === "invalid" ? undefined : controlOutcome,
      });
    },
  );
  it("uses same origin cookies and CSRF without automatic mutation retries", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new WebClient(transport);
    client.csrfToken = "csrf";
    await client.request("send", { text: "hello" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": "csrf" },
    });
  });
  it("does not leak proxy HTML as error text", async () => {
    const c = new WebClient(
      vi.fn().mockResolvedValue(new Response("<html>secret</html>", { status: 503 })),
    );
    await expect(c.request("access")).rejects.toEqual(new ApiError(503, "request_failed"));
  });
  it("encodes cursor rather than accepting URL fragments", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    await new WebClient(fetcher).events("a&b", "c#d");
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/web/v1/events?sessionId=a%26b&limit=50&cursor=c%23d",
    );
  });
});
class FakeEvents {
  static instances: FakeEvents[] = [];
  listeners: Record<string, (e: Event) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEvents.instances.push(this);
  }
  addEventListener(name: string, fn: (e: Event) => void) {
    this.listeners[name] = fn;
  }
  emit(name: string, value: unknown) {
    this.listeners[name]?.(new MessageEvent(name, { data: JSON.stringify(value) }));
  }
}
function mockServer(initial = "approved", availability = "readable") {
  let access = {
    status: initial,
    csrfToken: "x",
    bootId: "b",
    experimentalEnabled: false,
    device: { id: "d", name: "Browser", send: false, approve: false },
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/access")) return Response.json(access);
    if (path.includes("/catalog"))
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: "w", name: "test", path: "/projects/test" }],
        sessions: [
          {
            id: "s",
            title: "Test session",
            workspace_id: "w",
            agent: "codex",
            availability,
          },
        ],
      });
    if (path.includes("/events"))
      return Response.json({ events: [event("Secret history", "agent-message")], warnings: [] });
    if (path.includes("/live"))
      return Response.json({
        sessionId: "s",
        status: "idle",
        revision: 1,
        sendEnabled: false,
        approvals: [],
      });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", FakeEvents);
  return {
    fetcher,
    setAccess: (value: typeof access) => {
      access = value;
    },
  };
}
describe("Web access UI", () => {
  it.each([undefined, "", "   ", "Saved summary"])(
    "explains tool summary content %s",
    async (content) => {
      const server = mockServer();
      const original = server.fetcher.getMockImplementation()!;
      server.fetcher.mockImplementation(async (url) => {
        if (String(url).includes("/events"))
          return Response.json({
            events: [
              event("tool", "tool-summary", {
                tool_name: "Bash",
                tool_status: "failed",
                content,
                truncated: true,
              }),
            ],
            warnings: [],
          });
        return original(url);
      });
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
      fireEvent.click(await screen.findByRole("button", { name: /Bash/ }));
      const dialog = screen.getByRole("dialog", { name: "工具摘要" });
      expect(dialog).toHaveTextContent(
        content?.trim() ? content : dictionaries["zh-CN"].toolSummaryUnavailable,
      );
      expect(dialog).toHaveTextContent(dictionaries["zh-CN"].truncated);
      expect(dialog).not.toHaveTextContent("历史只读");
    },
  );
  it("refreshes background pending markers and clears them after another client answers", async () => {
    const { fetcher } = mockServer();
    const original = fetcher.getMockImplementation()!;
    let pending = false;
    fetcher.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes("/catalog"))
        return Response.json({
          indexEnabled: true,
          workspaces: [{ id: "w", name: "test", path: "/projects/test" }],
          sessions: ["s", "other"].map((id) => ({
            id,
            title: id,
            workspace_id: "w",
            agent: "codex",
            availability: "readable",
          })),
        });
      if (path.includes("/live")) {
        const id = new URL(path, "http://localhost").searchParams.get("sessionId")!;
        return Response.json({
          sessionId: id,
          status: "idle",
          revision: 1,
          sendEnabled: false,
          approvals: [],
          questions: id === "s" && pending ? [{ requestId: "q" }] : [],
        });
      }
      return original(url);
    });
    const ticks: (() => void)[] = [];
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      if (delay === 4000) ticks.push(callback);
      return interval(callback, 60000);
    }) as typeof setInterval);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Codex · s" }));
    await screen.findByText("Secret history");
    fireEvent.click(screen.getByRole("button", { name: "Codex · other" }));
    await screen.findByText("Secret history");
    expect(screen.getByRole("button", { name: "Codex · other" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    pending = true;
    await act(async () => {
      ticks.forEach((tick) => tick());
    });
    expect(await screen.findByLabelText("等待处理")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    pending = false;
    await act(async () => {
      ticks.forEach((tick) => tick());
    });
    await waitFor(() => expect(screen.queryByLabelText("等待处理")).not.toBeInTheDocument());
    // A stream reset clears state without changing the approved access status.
    act(() => FakeEvents.instances.at(-1)!.emit("unavailable", {}));
    await act(async () => {
      ticks.forEach((tick) => tick());
    });
    fireEvent.click(await screen.findByRole("button", { name: "Codex · s" }));
    await screen.findByText("Secret history");
    fireEvent.click(screen.getByRole("button", { name: "Codex · other" }));
    await screen.findByText("Secret history");
    pending = true;
    await act(async () => {
      ticks.forEach((tick) => tick());
    });
    expect(await screen.findByLabelText("等待处理")).toBeVisible();
  });
  it("keeps live updates and revocation active when the selected session is clicked again", async () => {
    mockServer();
    render(<App />);
    const entry = await screen.findByRole("button", { name: /Test session/ });
    fireEvent.click(entry);
    await screen.findByText("Secret history");
    fireEvent.click(entry);
    act(() =>
      FakeEvents.instances.at(-1)!.emit("snapshot", {
        sessionId: "s",
        status: "running",
        revision: 2,
        sendEnabled: false,
        approvals: [],
      }),
    );
    expect(screen.getByText("实时状态 · 运行中")).toBeVisible();
    act(() => FakeEvents.instances.at(-1)!.emit("access-ended", {}));
    expect(screen.getByText("远程访问已结束")).toBeVisible();
    expect(screen.queryByText("Secret history")).toBeNull();
  });
  it("does not open metadata-only entries or request history/live state", async () => {
    const { fetcher } = mockServer("approved", "metadata-only");
    const before = FakeEvents.instances.length;
    render(<App />);
    fireEvent.click(await screen.findByText("目录选项"));
    fireEvent.change(screen.getByLabelText("记录类型"), { target: { value: "metadata" } });
    const entry = await screen.findByRole("button", { name: /Test session/ });
    expect(entry).toBeDisabled();
    fireEvent.click(entry);
    expect(fetcher.mock.calls.every(([url]) => !/\/(events|live|stream)/.test(String(url)))).toBe(
      true,
    );
    expect(FakeEvents.instances).toHaveLength(before);
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
  });
  function controlServer() {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    const normal = async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: true },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      return original(url);
    };
    server.fetcher.mockImplementation(normal);
    return { ...server, normal };
  }
  async function openDraft() {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "draft" } });
  }
  it.each(["permission_denied", "stale_boot"])(
    "uses dispatch evidence rather than %s to classify a rejection",
    async (code) => {
      const server = controlServer();
      let release!: (response: Response) => void;
      let rejected = false;
      server.fetcher.mockImplementation(async (url) => {
        if (String(url).endsWith("/send")) {
          rejected = true;
          return Response.json({ code, controlOutcome: "not-dispatched" }, { status: 409 });
        }
        if (rejected && String(url).endsWith("/access"))
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return server.normal(url);
      });
      await openDraft();
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await screen.findByText(dictionaries["zh-CN"].notDispatched);
      expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
      expect(screen.getByText("Secret history")).toBeVisible();
      act(() =>
        FakeEvents.instances.at(-1)!.emit("snapshot", {
          sessionId: "s",
          status: "idle",
          revision: 2,
          sendEnabled: true,
          approvals: [],
        }),
      );
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      await act(async () => release(await server.normal("/access")));
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send")),
      ).toHaveLength(1);
    },
  );
  it.each([
    ["permission_denied", "unknown"],
    ["stale_boot", "unknown"],
    ["permission_denied", undefined],
    ["stale_boot", undefined],
    ["duplicate_request", "unknown"],
    ["outcome_unknown", "unknown"],
  ])("retains uncertainty for %s with evidence %s", async (code, controlOutcome) => {
    const server = controlServer();
    server.fetcher.mockImplementation(async (url) =>
      String(url).endsWith("/send")
        ? Response.json({ code, controlOutcome }, { status: 409 })
        : server.normal(url),
    );
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(dictionaries["zh-CN"].uncertain);
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
  it("clears private state when rejection refresh discovers revoked access", async () => {
    const server = controlServer();
    let rejected = false;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/send")) {
        rejected = true;
        return Response.json(
          { code: "permission_denied", controlOutcome: "not-dispatched" },
          { status: 403 },
        );
      }
      if (rejected && String(url).endsWith("/access"))
        return Response.json({ code: "access_ended" }, { status: 403 });
      return server.normal(url);
    });
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("远程访问已结束");
    expect(screen.queryByText("Secret history")).toBeNull();
    expect(screen.queryByText(dictionaries["zh-CN"].notDispatched)).toBeNull();
  });
  it("keeps a definite rejection definite when its state refresh fails", async () => {
    const server = controlServer();
    let rejected = false;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/send")) {
        rejected = true;
        return Response.json(
          { code: "stale_boot", controlOutcome: "not-dispatched" },
          { status: 409 },
        );
      }
      if (rejected && String(url).endsWith("/access")) throw new TypeError("offline");
      return server.normal(url);
    });
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alert");
    expect(screen.getByText(dictionaries["zh-CN"].notDispatched)).toBeVisible();
    expect(screen.queryByText(dictionaries["zh-CN"].uncertain)).toBeNull();
    act(() =>
      FakeEvents.instances.at(-1)!.emit("snapshot", {
        sessionId: "s",
        status: "idle",
        revision: 2,
        sendEnabled: true,
        approvals: [],
      }),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
  });
  it.each(["not-dispatched", "unknown"])(
    "classifies approval outcome %s without resubmission",
    async (controlOutcome) => {
      const server = controlServer();
      server.fetcher.mockImplementation(async (url) => {
        if (String(url).endsWith("/approve"))
          return Response.json(
            {
              code: "permission_denied",
              controlOutcome,
            },
            { status: 403 },
          );
        if (String(url).includes("/live"))
          return Response.json({
            sessionId: "s",
            status: "awaiting-approval",
            revision: 2,
            sendEnabled: false,
            approvals: [
              {
                requestId: 42,
                turnId: "t",
                method: "item/commandExecution/requestApproval",
                command: ["true"],
                supported: true,
                availableDecisions: ["accept"],
              },
            ],
          });
        return server.normal(url);
      });
      await openDraft();
      fireEvent.click(screen.getByRole("button", { name: "等待审批" }));
      fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
      await screen.findByText(
        dictionaries["zh-CN"][controlOutcome === "not-dispatched" ? "notDispatched" : "uncertain"],
      );
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
      ).toHaveLength(1);
      expect(screen.getByText("Secret history")).toBeVisible();
    },
  );
  it("defers busy access polling without erasing history or trusting stream snapshots", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const server = controlServer();
    await openDraft();
    let reserved = true;
    server.fetcher.mockImplementation(async (url) =>
      reserved && String(url).endsWith("/access")
        ? Response.json({ code: "operation_busy" }, { status: 409 })
        : server.normal(url),
    );
    const poll = interval.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    await act(async () => {
      poll();
    });
    expect(screen.getByText("Secret history")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    act(() =>
      FakeEvents.instances.at(-1)!.emit("snapshot", {
        sessionId: "s",
        status: "idle",
        revision: 2,
        sendEnabled: true,
        approvals: [],
      }),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    reserved = false;
    await act(async () => {
      poll();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      0,
    );
  });
  it("does not unlock an uncertain legacy-host outcome during automatic polling", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const server = controlServer();
    server.fetcher.mockImplementation(async (url) =>
      String(url).endsWith("/send")
        ? Response.json({ code: "permission_denied" }, { status: 403 })
        : server.normal(url),
    );
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(dictionaries["zh-CN"].uncertain);
    const poll = interval.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    await act(async () => {
      poll();
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );
  });
  it("requires a new manual refresh after a pending send becomes uncertain", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const server = controlServer();
    await openDraft();
    let finishSend!: (response: Response) => void;
    let finishAccess!: (response: Response) => void;
    let deferAccess = true;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/send"))
        return new Promise<Response>((resolve) => {
          finishSend = resolve;
        });
      if (deferAccess && String(url).endsWith("/access")) {
        deferAccess = false;
        return new Promise<Response>((resolve) => {
          finishAccess = resolve;
        });
      }
      return server.normal(url);
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(finishSend).toBeTypeOf("function"));
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(finishAccess).toBeTypeOf("function"));
    await act(async () => {
      finishSend(Response.json({ code: "permission_denied" }, { status: 403 }));
    });
    await screen.findByText(dictionaries["zh-CN"].uncertain);
    await act(async () => {
      finishAccess(await server.normal("/access"));
    });
    const poll = interval.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    await act(async () => {
      poll();
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  });
  it.each([false, true])(
    "finishes a superseded manual access refresh (uncertain: %s)",
    async (uncertain) => {
      const interval = vi.spyOn(globalThis, "setInterval");
      const server = controlServer();
      await openDraft();
      if (uncertain) {
        server.fetcher.mockImplementation(async (url) =>
          String(url).endsWith("/send")
            ? Response.json({ code: "permission_denied" }, { status: 403 })
            : server.normal(url),
        );
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await screen.findByText(dictionaries["zh-CN"].uncertain);
      }
      let release!: (response: Response) => void;
      let firstAccess = true;
      server.fetcher.mockImplementation(async (url) => {
        if (firstAccess && String(url).endsWith("/access")) {
          firstAccess = false;
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return server.normal(url);
      });
      fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
      await waitFor(() => expect(release).toBeTypeOf("function"));
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      const poll = interval.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
      await act(async () => {
        poll();
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
      await act(async () => {
        release(await server.normal("/access"));
      });
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
      expect(screen.getByLabelText("发送消息")).toHaveValue("draft");
    },
  );
  it("does not let an older refresh unlock controls after a newer busy poll", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const server = controlServer();
    await openDraft();
    let release!: (response: Response) => void;
    let reserved = false;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).includes("/live"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (reserved && String(url).endsWith("/access"))
        return Response.json({ code: "operation_busy" }, { status: 409 });
      return server.normal(url);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    reserved = true;
    const poll = interval.mock.calls.find(([, delay]) => delay === 4000)![0] as () => void;
    await act(async () => {
      poll();
    });
    await act(async () => {
      release(await server.normal("/live"));
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("Secret history")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["openclaw", "hermes", "grok-build"])(
    "reads %s history without offering experimental sending",
    async (agent) => {
      const server = mockServer();
      const original = server.fetcher.getMockImplementation()!;
      server.fetcher.mockImplementation(async (url) => {
        if (String(url).endsWith("/access"))
          return Response.json({
            status: "approved",
            csrfToken: "x",
            bootId: "b",
            experimentalEnabled: true,
            device: { id: "d", name: "Browser", send: true, approve: true },
          });
        if (String(url).includes("/catalog"))
          return Response.json({
            indexEnabled: true,
            workspaces: [{ id: "w", name: "test", path: "/projects/test" }],
            sessions: [
              {
                id: "s",
                title: "Test session",
                workspace_id: "w",
                agent,
                availability: "readable",
              },
            ],
          });
        if (String(url).includes("/live"))
          return Response.json({
            sessionId: "s",
            status: "unsupported",
            sendEnabled: false,
            approvals: [],
          });
        return original(url);
      });
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
      expect(await screen.findByText("Secret history")).toBeVisible();
      expect(screen.queryByLabelText("发送消息")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
      expect(screen.getByText(dictionaries["zh-CN"].readOnly)).toBeVisible();
    },
  );
  it("shows the command directory and only owner-offered approval decisions", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: false, approve: true },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "awaiting-approval",
          revision: 2,
          sendEnabled: false,
          approvals: [
            {
              requestId: 42,
              turnId: "t",
              method: "item/commandExecution/requestApproval",
              cwd: "/tmp/qa",
              command: ["true"],
              environmentId: "local",
              proposedExecpolicyAmendment: ["/usr/bin/true"],
              supported: true,
              availableDecisions: ["accept", "cancel"],
            },
          ],
        });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    fireEvent.click(await screen.findByRole("button", { name: "等待审批" }));
    expect(screen.getByText("/tmp/qa")).toBeVisible();
    expect(screen.getByText("执行环境：主机本机")).toBeVisible();
    expect(screen.getByText("当前浏览器未获发送权限")).toBeVisible();
    expect(screen.queryByText("当前浏览器仅可读取")).toBeNull();
    expect(screen.getByText(/允许一次不会保存此规则/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /持久放行/ })).toBeNull();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeEnabled();
    const approvalDialog = screen.getByRole("dialog", { name: "等待审批" });
    expect(approvalDialog.querySelector(".dialog-body")).toHaveAttribute("tabindex", "0");
    expect(approvalDialog.querySelector(".dialog-footer")).toContainElement(
      screen.getByRole("button", { name: "允许一次" }),
    );
    expect(approvalDialog.querySelector(".dialog-body")).not.toContainElement(
      screen.getByRole("button", { name: "允许一次" }),
    );
    expect(screen.getByRole("button", { name: "取消轮次" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "等待审批" }));
    expect(screen.getByRole("dialog", { name: "等待审批" })).toBeVisible();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeEnabled();
    act(() =>
      FakeEvents.instances.at(-1)!.emit("snapshot", {
        sessionId: "s",
        status: "running",
        revision: 3,
        sendEnabled: false,
        approvals: [
          {
            requestId: 42,
            turnId: "t",
            method: "item/commandExecution/requestApproval",
            cwd: "/tmp/qa",
            command: ["different-command"],
            supported: true,
            availableDecisions: ["accept", "cancel"],
          },
        ],
      }),
    );
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消轮次" })).toBeNull();
    expect(screen.getByText(/此审批无法安全处理/)).toBeVisible();
    act(() => FakeEvents.instances.at(-1)!.emit("access-ended", {}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("/tmp/qa")).toBeNull();
  });
  it("requires exactly eight digits and explains grant scope", async () => {
    mockServer("unpaired");
    render(<App />);
    await screen.findByText("用桌面端授权这个浏览器");
    const code = screen.getByLabelText("配对码");
    fireEvent.change(code, { target: { value: "123456" } });
    expect(screen.getByRole("button", { name: "请求连接" })).toBeDisabled();
    fireEvent.change(code, { target: { value: "12345678" } });
    expect(screen.getByRole("button", { name: "请求连接" })).toBeEnabled();
    expect(screen.getByText(/全部已登记及以后新增/)).toBeVisible();
  });
  it("keeps the pairing page after an invalid pairing code", async () => {
    const server = mockServer("unpaired");
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/pair"))
        return Response.json({ code: "invalid_pairing_code" }, { status: 403 });
      return original(url);
    });
    render(<App />);
    const code = await screen.findByLabelText("配对码");
    fireEvent.change(code, { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "请求连接" }));
    await screen.findByRole("alert");
    expect(screen.getByText("用桌面端授权这个浏览器")).toBeVisible();
    expect(screen.queryByText("远程访问已结束")).toBeNull();
  });
  it("does not offer control without independent grants", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    expect(await screen.findByText("Secret history")).toBeVisible();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: /停止|中断/ })).toBeNull();
  });
  it("clears history and dialogs immediately on access-ended", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    FakeEvents.instances.at(-1)!.emit("access-ended", {});
    await waitFor(() => expect(screen.queryByText("Secret history")).toBeNull());
    expect(screen.getByText("远程访问已结束")).toBeVisible();
  });
  it("clears private history when the stream reports unavailable", async () => {
    mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    act(() => FakeEvents.instances.at(-1)!.emit("unavailable", {}));
    expect(screen.queryByText("Secret history")).toBeNull();
    expect(screen.queryByRole("button", { name: /Test session/ })).toBeNull();
  });
  it("clears history and catalog when indexing is disabled", async () => {
    const server = mockServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) =>
      String(url).endsWith("/catalog")
        ? Response.json({ sessions: [], indexEnabled: false })
        : original(url),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await screen.findByText("历史索引未开启");
    expect(screen.queryByText("Secret history")).toBeNull();
    expect(screen.queryByRole("button", { name: /Test session/ })).toBeNull();
  });
  it("provides all UI strings in four locales", () => {
    for (const words of Object.values(dictionaries)) {
      expect(Object.keys(words).sort()).toEqual(Object.keys(dictionaries["en-US"]).sort());
      expect(Object.values(words).every((v) => v.length > 0)).toBe(true);
    }
  });
  it("disables experimental sending immediately on stream disconnect", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    act(() => FakeEvents.instances.at(-1)!.onerror?.());
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
  it("never retries a failed send and marks outcome uncertain", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      if (String(url).endsWith("/send")) throw new TypeError("offline");
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/结果未确认/);
    expect(
      server.fetcher.mock.calls.filter((call) => String(call[0]).endsWith("/send")),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("keeps approved access after a permission error and disables sending", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      if (String(url).endsWith("/send"))
        return Response.json({ code: "permission_denied" }, { status: 403 });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/结果未确认/);
    expect(screen.getByText("Secret history")).toBeVisible();
    expect(screen.queryByText("远程访问已结束")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it.each([
    ["ASCII character limit", "x".repeat(16_000)],
    ["Chinese UTF-8 byte limit", "中".repeat(5_461) + "x"],
    ["emoji UTF-8 byte limit", "😀".repeat(4_096)],
  ])("validates the %s before sending", async (_label, boundary) => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: false },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "idle",
          revision: 1,
          sendEnabled: true,
          approvals: [],
        });
      if (String(url).endsWith("/send")) return Response.json({ accepted: true });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText("Secret history");
    const input = screen.getByLabelText("发送消息") as HTMLTextAreaElement;
    expect(input.maxLength).toBe(16_000);
    fireEvent.change(input, { target: { value: boundary + "x" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.submit(input.closest("form")!);
    expect(
      server.fetcher.mock.calls.filter((call) => String(call[0]).endsWith("/send")),
    ).toHaveLength(0);
    fireEvent.change(input, { target: { value: boundary } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(input).toHaveValue(""));
    const requests = server.fetcher.mock.calls.filter((call) => String(call[0]).endsWith("/send"));
    expect(requests).toHaveLength(1);
    expect(server.fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/send$/),
      expect.objectContaining({ body: expect.stringContaining(JSON.stringify(boundary)) }),
    );
  });

  it.each([
    [
      "leading ASCII spaces",
      " ".repeat(385) + "😀".repeat(4_000),
      " ".repeat(384) + "😀".repeat(4_000),
    ],
    [
      "trailing ASCII spaces",
      "😀".repeat(4_000) + " ".repeat(8_000),
      "😀".repeat(4_000) + " ".repeat(384),
    ],
    [
      "leading multibyte whitespace",
      "\u3000".repeat(129) + "😀".repeat(4_000),
      "\u3000".repeat(128) + "😀".repeat(4_000),
    ],
    [
      "trailing multibyte whitespace",
      "😀".repeat(4_000) + "\u3000".repeat(129),
      "😀".repeat(4_000) + "\u3000".repeat(128),
    ],
  ])(
    "counts %s in the full draft limit while sending trimmed text",
    async (_label, oversized, boundary) => {
      const server = controlServer();
      server.fetcher.mockImplementation(async (url) =>
        String(url).endsWith("/send") ? Response.json({ accepted: true }) : server.normal(url),
      );
      await openDraft();
      const input = screen.getByLabelText("发送消息") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: oversized } });
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send")),
      ).toHaveLength(0);
      expect(input).toHaveValue(oversized);
      fireEvent.change(input, { target: { value: boundary } });
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(input).toHaveValue(""));
      const requests = server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"));
      expect(requests).toHaveLength(1);
      const options = (requests[0] as unknown as [unknown, RequestInit])[1];
      expect(JSON.parse(options.body as string).text).toBe(boundary.trim());
    },
  );
  it.each([" ", "\u3000", " \u3000 \t"])("rejects whitespace-only draft %j", async (draft) => {
    const server = controlServer();
    await openDraft();
    const input = screen.getByLabelText("发送消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: draft } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      0,
    );
  });
  it.each([
    ["unverified-installation", dictionaries["zh-CN"].unverifiedInstallation],
    ["open-in-original-client", dictionaries["zh-CN"].openOriginalClient],
    ["future-reason", dictionaries["zh-CN"].unavailable],
  ])(
    "renders accurate unavailable advice for %s without enabling control",
    async (reason, copy) => {
      const server = mockServer();
      const original = server.fetcher.getMockImplementation()!;
      server.fetcher.mockImplementation(async (url) => {
        if (String(url).endsWith("/access"))
          return Response.json({
            status: "approved",
            csrfToken: "x",
            bootId: "b",
            experimentalEnabled: true,
            device: { id: "d", name: "Browser", send: true, approve: true },
          });
        if (String(url).includes("/live"))
          return Response.json({
            sessionId: "s",
            status: "unavailable",
            reason,
            revision: null,
            sendEnabled: false,
            approvals: [],
          });
        return original(url);
      });
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
      await screen.findByText(copy, { exact: false });
      fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      if (reason !== "open-in-original-client")
        expect(
          screen.queryByText(dictionaries["zh-CN"].openOriginalClient),
        ).not.toBeInTheDocument();
    },
  );
  it("explains the host control fence without suggesting reopening restores control", async () => {
    const server = mockServer();
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/access"))
        return Response.json({
          status: "approved",
          csrfToken: "x",
          bootId: "b",
          experimentalEnabled: true,
          device: { id: "d", name: "Browser", send: true, approve: true },
        });
      if (String(url).includes("/live"))
        return Response.json({
          sessionId: "s",
          status: "outcome-unknown",
          reason: "control-outcome-unconfirmed",
          revision: null,
          sendEnabled: false,
          approvals: [],
        });
      return original(url);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
    await screen.findByText(/本次主机运行期间已禁用控制/);
    expect(screen.queryByText("请在官方客户端打开此会话")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
