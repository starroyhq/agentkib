// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { ClaudeSessionPanel } from "./ClaudeSessionPanel";
import type { Live } from "../../../../../packages/web-client/src/index";
import type { SessionStreamHandlers } from "@agentkib/web-client";
import { permissionModeCopy } from "@/features/sessions/conversation/features/sessions/permission-mode-copy";
import { sessionContinuationCopy } from "@agentkib/session-ui";
const conversationRequest = vi.hoisted(() => vi.fn());
import type { SupportedLocale as Locale } from "@/core/types";
vi.mock("@/core/api", () => ({ api: { claudeRequest: vi.fn() } }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale }) }));
vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("@/core/conversation-bridge", () => ({
  hasDesktopConversation: () => true,
  createDesktopConversationAdapter: () => ({
    request: async (...args: unknown[]) => {
      if (accessError) throw accessError;
      return conversationRequest(...args);
    },
    stream: (id: string, handlers: SessionStreamHandlers) => {
      const listeners = streams.get(id) ?? new Set<SessionStreamHandlers>();
      listeners.add(handlers);
      streams.set(id, listeners);
      queueMicrotask(() => {
        if (!listeners.has(handlers)) return;
        handlers.open();
        handlers.event(
          "session-event",
          JSON.stringify({
            protocolVersion: 2,
            subscriptionId: id || "catalog",
            sessionId: id,
            runtimeBootId: "boot",
            epoch: "epoch",
            seq: 0,
            cursor: `${id}:0`,
            type: "snapshot",
            payload: { live: { ...live, sessionId: id } },
          }),
        );
        handlers.event("session-ready", JSON.stringify({ cursor: `${id}:0` }));
      });
      return () => {
        listeners.delete(handlers);
        stopped(id);
      };
    },
  }),
}));
let live: Live;
let locale = "en-US";
let accessError: Error | undefined;
let streams: Map<string, Set<SessionStreamHandlers>>;
const stopped = vi.fn();
function notifyControl(sessionId = "session") {
  for (const handlers of streams.get(sessionId) ?? [])
    handlers.event("control-changed", JSON.stringify({ sessionId }));
}
function emitNative(seq: number, type: string, payload: unknown, sessionId = "session") {
  for (const handlers of streams.get(sessionId) ?? [])
    handlers.event(
      "session-event",
      JSON.stringify({
        protocolVersion: 2,
        subscriptionId: sessionId,
        sessionId,
        runtimeBootId: "boot",
        epoch: "epoch",
        seq,
        cursor: `${sessionId}:${seq}`,
        type,
        payload,
      }),
    );
}
const calls = (operation: string) =>
  vi.mocked(api.claudeRequest).mock.calls.filter(([value]) => value.operation === operation);
function mount(sessionId = "session") {
  return render(
    <ClaudeSessionPanel
      workspaceId="workspace"
      initialSessionId={sessionId || undefined}
      onClose={vi.fn()}
    />,
  );
}
async function enabled(element: HTMLElement) {
  await waitFor(() => expect(element).toBeEnabled());
  return element;
}
async function enterMessage(text: string) {
  fireEvent.change(await enabled(screen.getByLabelText("Message")), { target: { value: text } });
}
beforeEach(() => {
  localStorage.clear();
  locale = "en-US";
  accessError = undefined;
  streams = new Map();
  stopped.mockReset();
  conversationRequest.mockReset().mockImplementation(async (path) => {
    if (path === "managed/action") {
      live = {
        ...live,
        sessionId: "forked",
        executionLocation: null,
        ownershipReason: null,
        sendEnabled: true,
      };
      return { accepted: true, sessionId: "forked" };
    }
    if (String(path).startsWith("requests/"))
      return { found: false, requestId: String(path).slice(9) };
    if (String(path).startsWith("managed/resume-command?"))
      return { available: true, command: "claude --resume session", shell: "posix", runOn: "host" };
    return {
      protocolVersion: 2,
      status: "approved",
      bootId: "boot",
      csrfToken: "local",
      experimentalEnabled: true,
      device: { manage: true, send: true },
    };
  });
  vi.spyOn(globalThis, "setInterval");
  live = {
    sessionId: "session",
    status: "idle",
    revision: 1,
    sendEnabled: true,
    executionMode: "claude-managed",
    approvals: [],
    questions: [],
  };
  vi.mocked(api.claudeRequest)
    .mockReset()
    .mockImplementation(async (value) => {
      switch (value.operation) {
        case "options":
          return { available: true, workspaces: [{ id: "workspace", name: "Project" }] };
        case "catalog":
          return {
            indexEnabled: true,
            sessions: [
              {
                id: "session",
                workspace_id: "workspace",
                agent: "claude-code",
                title: "Synthetic session",
              },
            ],
          };
        case "live":
          return live;
        case "events":
          return {
            events: [{ id: "message", kind: "agent-message", content: "Synthetic history" }],
            warnings: [],
          };
        case "capabilities":
          return {
            sessionId: "session",
            features: {
              attachments: { available: live.sendEnabled === true },
              files: { available: true },
              fork: { available: true },
            },
          };
        case "files":
          return {
            directoryId: "root",
            entries: [
              {
                id: "artifact",
                name: "result.txt",
                kind: "file",
                previewKind: "text",
                revision: "v1",
              },
            ],
          };
        case "inspect":
          return { sessionId: "session", handoffFingerprint: "frozen-history" };
        case "receipt":
          return { found: false, requestId: value.requestId };
        default:
          return { accepted: true, sessionId: "session" };
      }
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Claude local owner panel", () => {
  it("explains an unverified installation with its reason code available in details", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "options"
        ? Promise.resolve({ available: false, reason: "unverified-installation", workspaces: [] })
        : original(value),
    );
    mount();
    const copy = (
      await import("@/features/sessions/conversation/features/sessions/codex-copy")
    ).codexReason("en-US", "unverified-installation");
    expect(await screen.findByText(copy.text)).toBeVisible();
    expect(screen.getByText("unverified-installation")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText("unverified-installation")).toBeVisible();
    expect(screen.getByRole("button", { name: "New Claude task" })).toBeDisabled();
  });
  it("keeps a failed focus precheck actionable and never dispatches a command", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "live" ? Promise.reject(new Error("inspect_failed")) : original(value),
    );
    fireEvent.focus(screen.getByLabelText("Message"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check session status. Refresh and retry.",
    );
    expect(screen.getByText("inspect_failed")).not.toBeVisible();
    expect(calls("send")).toHaveLength(0);
    expect(calls("adopt")).toHaveLength(0);
  });
  it("shares native usage and compaction state while preserving native stop", async () => {
    live = {
      ...live,
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 0, contextWindow: 100 },
    };
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "next" } });
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("0%");
    act(() =>
      emitNative(1, "state", {
        revision: 2,
        status: "running",
        turnId: "turn",
        sendEnabled: false,
        stopEnabled: true,
        activity: "compacting",
      }),
    );
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent(
      "Compacting context",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Return to original client" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    act(() => emitNative(2, "state", { revision: 3, activity: null }));
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent(
      "Awaiting update",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    act(() =>
      emitNative(3, "state", {
        revision: 4,
        usage: { available: true, state: "ready", reportId: 2, usedTokens: 4, contextWindow: 100 },
      }),
    );
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("4%");
  });
  it.each(["before", "after"])(
    "recovers an admission-busy history read when another session settles %s its response",
    async (settlement) => {
      mount();
      await screen.findByText("Synthetic history");
      await enabled(screen.getByLabelText("Message"));
      const pending = {
        requestId: crypto.randomUUID(),
        operation: "send",
        sessionId: "session",
        workspaceId: "workspace",
      };
      localStorage.setItem("agentkib:claude-owner-pending:v1:workspace", JSON.stringify(pending));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let reject!: (error: Error) => void;
      let busy = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation !== "events") return original(value);
        if (busy)
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        return Promise.resolve({
          events: [
            {
              id: "message",
              kind: "agent-message",
              content: "Recovered history",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        });
      });
      act(() => emitNative(1, "invalidate", { domains: ["history"] }));
      await waitFor(() => expect(reject).toBeTypeOf("function"));
      const settled = () => {
        for (const handlers of streams.get("") ?? [])
          handlers.event("control-changed", JSON.stringify({ sessionId: "another-session" }));
      };
      await act(async () => {
        if (settlement === "before") settled();
        busy = false;
        reject(new Error("Error invoking remote method 'claude:request': Error: operation_busy"));
      });
      if (settlement === "after") await act(async () => settled());
      expect(await screen.findByText("Recovered history")).toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!),
      ).toEqual(pending);
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("renegotiates a failed initial access read when explicitly refreshed", async () => {
    accessError = new Error("access_unavailable");
    mount();
    await screen.findByText("access_unavailable");
    expect(streams.get("session")).toBeUndefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    accessError = undefined;
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    await waitFor(() => expect(streams.get("session")?.size).toBe(1));
    await enterMessage("Ready after recovery");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  });
  it.each(["empty-replay", "baseline"])(
    "recovers idle controls after only the catalog subscription reconnects with %s",
    async (recovery) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      const detail = [...streams.get("session")!][0];
      const catalog = [...streams.get("")!][0];
      const historyReads = calls("events").length;
      const liveReads = calls("live").length;
      const capabilityReads = calls("capabilities").length;
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      expect(await screen.findByText("catalog_subscription_failed")).toBeInTheDocument();
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();

      await act(async () => {
        if (recovery === "baseline")
          emitNative(1, "snapshot", { live: { ...live, sessionId: "" } }, "");
        catalog.event(
          "session-ready",
          JSON.stringify({ cursor: recovery === "baseline" ? ":1" : ":0" }),
        );
        catalog.open();
      });
      await enabled(screen.getByLabelText("Message"));
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
      expect(calls("events")).toHaveLength(historyReads);
      expect(calls("live")).toHaveLength(liveReads);
      expect([...streams.get("session")!]).toEqual([detail]);
      expect(stopped).not.toHaveBeenCalledWith("session");
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("does not restore catalog readiness from a mismatched cursor", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const catalog = [...streams.get("")!][0];
    await act(async () => catalog.error(new Error("catalog_subscription_failed")));
    await act(async () => {
      catalog.event("session-ready", JSON.stringify({ cursor: "unapplied-cursor" }));
      catalog.open();
      // A healthy detail stream cannot prove that the separate catalog recovered.
      emitNative(1, "state", { revision: 2, sendEnabled: true });
    });
    expect(screen.getByText("catalog_subscription_failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    await act(async () => catalog.event("session-ready", JSON.stringify({ cursor: ":0" })));
    await enabled(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
  });
  it("ignores obsolete catalog errors and readiness after resynchronizing a gap", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const previous = [...streams.get("")!][0];
    const detail = [...streams.get("session")!][0];
    await act(async () => emitNative(2, "state", { revision: 2 }, ""));
    await waitFor(() => {
      expect(streams.get("")?.size).toBe(1);
      expect([...streams.get("")!][0]).not.toBe(previous);
    });
    await enabled(screen.getByRole("button", { name: "Send" }));
    const current = [...streams.get("")!][0];
    await act(async () => previous.error(new Error("obsolete_catalog_failure")));
    expect(screen.queryByText("obsolete_catalog_failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await act(async () => {
      current.error(new Error("current_catalog_failure"));
      previous.event("session-ready", JSON.stringify({ cursor: ":0" }));
    });
    expect(screen.getByText("current_catalog_failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => current.event("session-ready", JSON.stringify({ cursor: ":0" })));
    await enabled(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
    expect([...streams.get("session")!]).toEqual([detail]);
    expect(stopped).not.toHaveBeenCalledWith("session");
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["detail-stream", "metadata"])(
    "keeps the independent %s failure fenced after catalog recovery",
    async (failure) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      const detail = [...streams.get("session")!][0];
      const catalog = [...streams.get("")!][0];
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      if (failure === "metadata")
        vi.mocked(api.claudeRequest).mockImplementation((value) =>
          value.operation === "capabilities"
            ? Promise.reject(new Error("metadata_unavailable"))
            : original(value),
        );
      await act(async () => {
        if (failure === "detail-stream") detail.error(new Error("detail_disconnected"));
        else emitNative(1, "invalidate", { domains: ["catalog"] }, "");
      });
      if (failure === "metadata")
        expect(await screen.findByText("metadata_unavailable")).toBeInTheDocument();
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      const capabilityReads = calls("capabilities").length;
      await act(async () => {
        catalog.event(
          "session-ready",
          JSON.stringify({ cursor: failure === "metadata" ? ":1" : ":0" }),
        );
        catalog.open();
      });
      await waitFor(() => expect(calls("capabilities").length).toBeGreaterThan(capabilityReads));
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      if (failure === "metadata")
        expect(screen.getByText("metadata_unavailable")).toBeInTheDocument();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it.each([false, true])(
    "reconciles a missed receipt after catalog empty replay without replaying the command (settled=%s)",
    async (settled) => {
      const key = "agentkib:claude-owner-pending:v1:workspace";
      const pending = {
        requestId: crypto.randomUUID(),
        operation: "send",
        sessionId: "session",
        workspaceId: "workspace",
      };
      localStorage.setItem(key, JSON.stringify(pending));
      mount();
      await screen.findByText("Synthetic history");
      await waitFor(() => expect(calls("receipt").length).toBeGreaterThan(0));
      expect(screen.getByLabelText("Message")).toBeDisabled();
      const catalog = [...streams.get("")!][0];
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      if (settled)
        vi.mocked(api.claudeRequest).mockImplementation((value) =>
          value.operation === "receipt"
            ? Promise.resolve({ ...pending, found: true, status: "accepted" })
            : original(value),
        );
      const receiptReads = calls("receipt").length;
      await act(async () => {
        catalog.event("session-ready", JSON.stringify({ cursor: ":0" }));
        catalog.open();
      });
      await waitFor(() => expect(calls("receipt").length).toBeGreaterThan(receiptReads));
      if (settled) {
        await enabled(screen.getByLabelText("Message"));
        await enabled(screen.getByLabelText("Add images or files"));
        expect(localStorage.getItem(key)).toBeNull();
        await enterMessage("New command after confirmed receipt");
        await enabled(screen.getByRole("button", { name: "Send" }));
      } else {
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual(pending);
        expect(screen.getByLabelText("Message")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      }
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("applies native text without polling history and only unsubscribes on close", async () => {
    const view = mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    const reads = calls("events").length;
    const liveReads = calls("live").length;
    const capabilityReads = calls("capabilities").length;
    act(() => {
      emitNative(1, "text-delta", { itemId: "reply", turnId: "turn", text: "Native", offset: 0 });
      emitNative(2, "text-delta", { itemId: "reply", turnId: "turn", text: " reply", offset: 6 });
    });
    expect(await screen.findByText("Native reply")).toBeVisible();
    expect(calls("events")).toHaveLength(reads);
    expect(calls("live")).toHaveLength(liveReads);
    expect(calls("capabilities")).toHaveLength(capabilityReads);
    expect(
      vi.mocked(globalThis.setInterval).mock.calls.filter(([, delay]) => delay === 1000),
    ).toEqual([]);
    view.unmount();
    expect(stopped).toHaveBeenCalledWith("session");
    expect(stopped).toHaveBeenCalledWith("");
    expect(calls("stop")).toHaveLength(0);
    expect(calls("release")).toHaveLength(0);
  });
  it.each(["options", "catalog", "capabilities"])(
    "recovers idle controls after a transient %s failure through catalog events alone",
    async (operation) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let failed = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === operation && failed
          ? Promise.reject(new Error("transient_metadata_failure"))
          : original(value),
      );
      const listener = [...streams.get("session")!][0];
      const historyReads = calls("events").length;
      const liveReads = calls("live").length;
      await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
      expect(await screen.findByText("transient_metadata_failure")).toBeInTheDocument();
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      failed = false;
      await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
      await enabled(screen.getByLabelText("Message"));
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      await waitFor(() =>
        expect(screen.queryByText("transient_metadata_failure")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      expect([...streams.get("session")!]).toEqual([listener]);
      expect(stopped).not.toHaveBeenCalledWith("session");
      expect(calls("events")).toHaveLength(historyReads);
      expect(calls("live")).toHaveLength(liveReads);
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("keeps controls blocked during metadata failure while continuing to display native progress", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "options"
        ? Promise.reject(new Error("transient_metadata_failure"))
        : original(value),
    );
    await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
    expect(await screen.findByText("transient_metadata_failure")).toBeInTheDocument();
    await act(async () => {
      emitNative(1, "text-delta", { itemId: "reply", text: "Still observing", offset: 0 });
      emitNative(2, "state", { revision: 2, status: "idle", sendEnabled: true });
    });
    expect(await screen.findByText("Still observing")).toBeVisible();
    expect(screen.getByText("transient_metadata_failure")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    expect(calls("send")).toHaveLength(0);
  });
  it("keeps a failed full history refresh pending until a later catalog event completes that read", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let historyFailed = true;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "events" && historyFailed
        ? Promise.reject(new Error("history_refresh_failed"))
        : original(value),
    );
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    expect(await screen.findByText("history_refresh_failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    const failedReads = calls("events").length;
    await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
    await waitFor(() => expect(calls("events").length).toBeGreaterThan(failedReads));
    expect(screen.getByText("history_refresh_failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    historyFailed = false;
    await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
    await enabled(screen.getByLabelText("Message"));
    await enabled(screen.getByRole("button", { name: "Send" }));
    await enabled(screen.getByLabelText("Add images or files"));
    await waitFor(() =>
      expect(screen.queryByText("history_refresh_failed")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["stream", "control"])(
    "does not reopen controls after %s failure when metadata succeeds late or on a later event",
    async (failure) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Files and artifacts" })));
      await screen.findByRole("button", { name: "result.txt" });
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let release!: () => void;
      let deferCapabilities = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "live") return Promise.reject(new Error("host_offline"));
        if (value.operation === "capabilities" && deferCapabilities) {
          deferCapabilities = false;
          const result = original(value);
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        }
        return original(value);
      });
      await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
      await waitFor(() => expect(release).toBeTypeOf("function"));
      await act(async () => {
        if (failure === "control") notifyControl();
        else
          for (const handlers of streams.get("session") ?? [])
            handlers.error(new Error("host_offline"));
      });
      const expectDisconnected = () => {
        expect(screen.getByLabelText("Message")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        expect(screen.getByLabelText("Add images or files")).toBeDisabled();
        expect(
          screen.queryByRole("button", { name: "Files and artifacts" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("result.txt")).not.toBeInTheDocument();
        if (failure === "control") expect(screen.getByText("host_offline")).toBeInTheDocument();
      };
      expectDisconnected();
      await act(async () => release());
      expectDisconnected();
      const beforeReads = calls("capabilities").length;
      await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
      await waitFor(() => expect(calls("capabilities").length).toBeGreaterThan(beforeReads));
      expectDisconnected();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("restores attachments when a turn running on entry completes through the native stream", async () => {
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    const capabilityReads = calls("capabilities").length;
    live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
    await act(async () => {
      emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
      emitNative(2, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    await enabled(screen.getByLabelText("Message"));
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
    expect(calls("send")).toHaveLength(0);
  });
  it("updates attachments when another client starts and completes a turn", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Add images or files"));
    const capabilityReads = calls("capabilities").length;
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn", revision: 2 };
    await act(async () => {
      emitNative(1, "state", {
        status: "running",
        sendEnabled: false,
        turnId: "turn",
        revision: 2,
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    await waitFor(() => expect(screen.getByLabelText("Add images or files")).toBeDisabled());
    expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
    const runningCapabilityReads = calls("capabilities").length;
    live = { ...live, status: "idle", sendEnabled: true, revision: 3 };
    await act(async () => {
      emitNative(2, "state", { status: "idle", sendEnabled: true, revision: 3 });
      emitNative(3, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(2, "invalidate", { domains: ["catalog"] }, "");
    });
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(runningCapabilityReads);
    expect(calls("send")).toHaveLength(0);
  });
  it("retains a completion notification while the initial capabilities read is in flight", async () => {
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let settle!: () => void;
    let firstCapabilities = true;
    vi.mocked(api.claudeRequest).mockImplementation((value) => {
      if (value.operation !== "capabilities" || !firstCapabilities) return original(value);
      firstCapabilities = false;
      const result = original(value);
      return new Promise((resolve) => {
        settle = () => resolve(result);
      });
    });
    mount();
    await waitFor(() => expect(streams.get("session")?.size).toBe(1));
    expect(calls("capabilities").length).toBeGreaterThan(0);
    live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
    await act(async () => {
      emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
      emitNative(2, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    await act(async () => settle());
    await enabled(screen.getByLabelText("Message"));
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(1);
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["before", "after"])(
    "recovers admission-busy capabilities when another session settles %s the read response",
    async (settlement) => {
      live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
      mount();
      await screen.findByText("Synthetic history");
      await enabled(screen.getByLabelText("Message"));
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let reject!: (error: Error) => void;
      let busy = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "capabilities" && busy)
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        return original(value);
      });
      live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
      await act(async () => {
        emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
        emitNative(2, "invalidate", {
          domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
        });
        emitNative(1, "invalidate", { domains: ["catalog"] }, "");
      });
      await waitFor(() => expect(reject).toBeTypeOf("function"));
      const settled = () => {
        for (const handlers of streams.get("") ?? [])
          handlers.event("control-changed", JSON.stringify({ sessionId: "another-session" }));
      };
      await act(async () => {
        if (settlement === "before") settled();
        busy = false;
        reject(new Error("Error invoking remote method 'claude:request': Error: operation_busy"));
      });
      if (settlement === "after") await act(async () => settled());
      await enabled(screen.getByLabelText("Add images or files"));
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("resynchronizes a sequence gap before applying new native items", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    await act(async () =>
      emitNative(3, "text-delta", { itemId: "reply", text: "missing", offset: 0 }),
    );
    expect(stopped).toHaveBeenCalledWith("session");
    expect(screen.queryByText("missing")).not.toBeInTheDocument();
    act(() => emitNative(1, "text-delta", { itemId: "reply", text: "Recovered", offset: 0 }));
    expect(await screen.findByText("Recovered")).toBeVisible();
    expect(calls("send")).toHaveLength(0);
  });
  it("resolves an indexed history entry to its exact managed identity", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation(async (value) => {
      if (value.operation !== "catalog") return original(value);
      return {
        indexEnabled: true,
        sessions: [
          {
            id: "session",
            indexedSessionId: "history-id",
            workspace_id: "workspace",
            agent: "claude-code",
          },
        ],
      };
    });
    mount("history-id");
    await screen.findByText("Synthetic history");
    expect(calls("live")).toEqual([[{ operation: "live", sessionId: "session" }]]);
    expect(calls("events")).toEqual([[{ operation: "events", sessionId: "session" }]]);
  });
  it.each(["other-workspace", "ambiguous"])("rejects %s index mappings", async (kind) => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation(async (value) => {
      if (value.operation !== "catalog") return original(value);
      const row = {
        id: "session",
        indexedSessionId: "history-id",
        workspace_id: kind === "other-workspace" ? "other" : "workspace",
        agent: "claude-code",
      };
      return {
        indexEnabled: true,
        sessions: kind === "ambiguous" ? [row, { ...row, id: "second" }] : [row],
      };
    });
    mount("history-id");
    await screen.findByText("claude_session_unavailable");
    expect(calls("live")).toHaveLength(0);
    expect(calls("events")).toHaveLength(0);
    expect(streams.get("history-id")).toBeUndefined();
  });
  it("opens files from the session panel and clears them when host access is lost", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent(
      "Synthetic session",
    );
    expect(calls("files")).toHaveLength(0);
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Files and artifacts" })));
    await screen.findByRole("button", { name: "result.txt" });
    expect(calls("files")).toEqual([[{ operation: "files", sessionId: "session" }]]);
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "live" ? Promise.reject(new Error("host_offline")) : original(value),
    );
    await act(async () => notifyControl());
    expect(screen.queryByRole("button", { name: "Files and artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByText("result.txt")).not.toBeInTheDocument();
  });
  it("keeps idle status invisible and renders completed history only once", async () => {
    locale = "zh-CN";
    live = { ...live, streamText: "Synthetic history" };
    mount();
    await screen.findByText("Synthetic history");
    expect(screen.queryByText("空闲")).not.toBeInTheDocument();
    expect(screen.getAllByText("Synthetic history")).toHaveLength(1);
    expect(screen.queryByText("idle")).not.toBeInTheDocument();
  });

  it("prepares a new session without starting a model request", async () => {
    mount("");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New Claude task" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New Claude task" }));
    await waitFor(() => expect(calls("create")).toHaveLength(1));
    expect(calls("create")[0][0]).toMatchObject({
      workspaceId: "workspace",
      requestId: expect.any(String),
    });
    expect(calls("send")).toHaveLength(0);
  });
  it("compacts from the usage dialog as a message of its own and keeps the draft", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
    const dialog = await screen.findByRole("dialog", { name: "Context usage" });
    fireEvent.click(await enabled(within(dialog).getByRole("button", { name: "Compact context" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({
      sessionId: "session",
      text: "/compact",
      attachmentIds: [],
    });
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    expect(screen.getByLabelText("Message")).toHaveValue("Keep this draft");
    // Until history records it, the command shows as the pending message, not the draft.
    const pendingMessage = document.querySelector("[data-pending-user-message]");
    expect(pendingMessage).toHaveTextContent("/compact");
    expect(pendingMessage).not.toHaveTextContent("Keep this draft");
  });
  it.each([
    ["a turn is running", { status: "running", turnId: "turn" }, false, true],
    ["sending is unavailable", { sendEnabled: false }, false, false],
    ["the context is compacting", { activity: "compacting" }, false, false],
    ["the session has no message yet", {}, true, false],
  ] as const)("keeps compaction disabled while %s", async (_case, state, empty, afterTurn) => {
    live = { ...live, ...state } as Live;
    if (empty) {
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === "events"
          ? Promise.resolve({ events: [], warnings: [] })
          : original(value),
      );
    }
    mount();
    if (!empty) await screen.findByText("Synthetic history");
    // The usage dialog belongs to one observation; open it once the session has settled.
    await enabled(screen.getByLabelText("Message"));
    fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
    const dialog = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(dialog).getByRole("button", { name: "Compact context" })).toBeDisabled();
    expect(!!within(dialog).queryByText("You can compact once the current turn ends.")).toBe(
      afterTurn,
    );
    expect(calls("send")).toHaveLength(0);
  });
  it("offers no compaction for a connected terminal", async () => {
    live = { ...live, executionMode: "claude-follower", executionLocation: "terminal" };
    mount();
    await screen.findByText(sessionContinuationCopy("en-US").terminalHint);
    await enabled(screen.getByLabelText("Message"));
    fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
    const dialog = await screen.findByRole("dialog", { name: "Context usage" });
    expect(
      within(dialog).queryByRole("button", { name: "Compact context" }),
    ).not.toBeInTheDocument();
  });
  it("continues idle history directly without inspecting or adopting", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("continue directly");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ sessionId: "session", text: "continue directly" });
    expect(calls("inspect")).toHaveLength(0);
    expect(calls("adopt")).toHaveLength(0);
    expect(calls("release")).toHaveLength(0);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "explains connected terminal behavior without ownership controls in %s",
    async (language) => {
      locale = language;
      live = { ...live, executionMode: "claude-follower", executionLocation: "terminal" };
      mount();
      const copy = sessionContinuationCopy(language);
      expect(await screen.findByText(copy.terminalHint)).toBeVisible();
      expect(screen.getByText(copy.terminalConnected)).toBeVisible();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(calls("inspect")).toHaveLength(0);
      expect(calls("adopt")).toHaveLength(0);
      expect(calls("release")).toHaveLength(0);
    },
  );
  it("retains the connected terminal's verified send capability", async () => {
    live = {
      ...live,
      executionMode: "claude-follower",
      executionLocation: "terminal",
      status: "idle",
      sendEnabled: true,
      stopEnabled: false,
    };
    mount();
    await screen.findByText(sessionContinuationCopy("en-US").terminalHint);
    await enterMessage("continue in terminal");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ sessionId: "session" });
    expect(calls("adopt")).toHaveLength(0);
    expect(calls("release")).toHaveLength(0);
  });
  it.each(
    (["zh-CN", "zh-TW", "en-US", "ja-JP"] as const).flatMap((language) =>
      [false, true].map((terminalSend) => ({ language, terminalSend })),
    ),
  )(
    "hides follower stop and preserves managed stop in $language with terminalSend=$terminalSend",
    async ({ language, terminalSend }) => {
      locale = language;
      const stopLabel = language === "en-US" ? "Stop" : "停止";
      live = {
        ...live,
        executionMode: "claude-follower",
        executionLocation: "terminal",
        status: "running",
        terminalSend,
        sendEnabled: false,
        stopEnabled: true,
        turnId: "native-turn",
      };
      mount();
      const copy = sessionContinuationCopy(language);
      await screen.findByText(terminalSend ? copy.terminalHint : copy.terminalWatch);
      expect(screen.queryByRole("button", { name: stopLabel })).not.toBeInTheDocument();
      expect(calls("stop")).toHaveLength(0);

      live = {
        ...live,
        executionMode: "claude-managed",
        executionLocation: "agentkib",
        revision: 2,
      };
      act(() => emitNative(1, "state", { ...live }));
      fireEvent.click(await enabled(await screen.findByRole("button", { name: stopLabel })));
      await waitFor(() => expect(calls("stop")).toHaveLength(1));
      expect(calls("stop")[0][0]).toMatchObject({
        sessionId: "session",
        turnId: "native-turn",
      });
      expect(calls("adopt")).toHaveLength(0);
      expect(calls("release")).toHaveLength(0);
    },
  );
  it("preserves a draft across terminal connection and disconnection without confirmation", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("same draft");
    live = {
      ...live,
      executionMode: "claude-follower",
      executionLocation: "terminal",
      revision: 2,
    };
    act(() => emitNative(1, "state", live));
    expect(await screen.findByText(sessionContinuationCopy("en-US").terminalHint)).toBeVisible();
    expect(screen.getByLabelText("Message")).toHaveValue("same draft");
    live = { ...live, executionMode: "claude-managed", executionLocation: null, revision: 3 };
    act(() => emitNative(2, "state", live));
    expect(
      screen.queryByText(sessionContinuationCopy("en-US").terminalHint),
    ).not.toBeInTheDocument();
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ text: "same draft", expectedRevision: 3 });
    expect(calls("adopt")).toHaveLength(0);
  });
  it.each([
    ["while connected", "resolve"],
    ["while connected", "reject"],
    ["after disconnect", "resolve"],
    ["after disconnect", "reject"],
  ] as const)(
    "ignores a focus precheck settling %s with %s after terminal ownership changes",
    async (boundary, result) => {
      mount();
      await screen.findByText("Synthetic history");
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let finish!: (value: unknown) => void;
      let fail!: (reason: Error) => void;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === "live"
          ? new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            })
          : original(value),
      );
      fireEvent.focus(await enabled(screen.getByLabelText("Message")));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      live = {
        ...live,
        executionMode: "claude-follower",
        executionLocation: "terminal",
        revision: 2,
      };
      act(() => emitNative(1, "state", live));
      const disconnect = () => {
        live = { ...live, executionMode: "claude-managed", executionLocation: null, revision: 3 };
        act(() => emitNative(2, "state", live));
      };
      if (boundary === "after disconnect") disconnect();
      await act(async () => {
        if (result === "resolve")
          finish({
            ...live,
            revision: 1,
            executionLocation: "external",
            ownershipReason: "claude-owner-busy",
            sendEnabled: false,
          });
        else fail(new Error("inspect_failed"));
      });
      expect(
        screen.queryByText(sessionContinuationCopy("en-US").choice("Claude Code")),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      if (boundary === "while connected") disconnect();
      expect(screen.getByLabelText("Message")).toBeEnabled();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it.each(["released ownership", "connection generation"] as const)(
    "keeps draft and checks the current revision after %s changes",
    async (boundary) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("preserved on recycle");
      live = {
        ...live,
        revision: 2,
        ...(boundary === "released ownership"
          ? { status: "idle", executionLocation: null, continuationNotice: "background-ended" }
          : { connectionGeneration: "next-binding" }),
      };
      act(() => emitNative(1, "state", live));
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
      await waitFor(() => expect(calls("send")).toHaveLength(1));
      expect(calls("send")[0][0]).toMatchObject({
        text: "preserved on recycle",
        expectedRevision: 2,
      });
      expect(calls("adopt")).toHaveLength(0);
    },
  );
  it.each(["resolve", "reject"] as const)(
    "ignores a stale focus precheck %s after a worker is recycled",
    async (result) => {
      mount();
      await screen.findByText("Synthetic history");
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let finish!: (value: unknown) => void, fail!: (error: Error) => void;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === "live"
          ? new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            })
          : original(value),
      );
      fireEvent.focus(await enabled(screen.getByLabelText("Message")));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      live = { ...live, revision: 2, executionLocation: "agentkib" };
      act(() => emitNative(1, "state", live));
      live = {
        ...live,
        revision: 3,
        executionLocation: null,
        continuationNotice: "background-ended",
      };
      act(() => emitNative(2, "state", live));
      await act(async () => {
        if (result === "resolve")
          finish({
            ...live,
            revision: 1,
            executionLocation: "external",
            ownershipReason: "claude-owner-busy",
          });
        else fail(new Error("inspect_failed"));
      });
      expect(screen.getByText(sessionContinuationCopy("en-US").backgroundEnded)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.queryByText(sessionContinuationCopy("en-US").choice("Claude Code")),
      ).not.toBeInTheDocument();
      expect(calls("adopt")).toHaveLength(0);
    },
  );
  it("checks ownership on focus and restores the untouched draft after the owner exits", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("keep original text");
    live = {
      ...live,
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
    };
    fireEvent.focus(screen.getByLabelText("Message"));
    expect(
      await screen.findByText(sessionContinuationCopy("en-US").choice("Claude Code")),
    ).toBeVisible();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(calls("send")).toHaveLength(0);
    const poll = await waitFor(() => {
      const callback = vi
        .mocked(globalThis.setInterval)
        .mock.calls.find(([, delay]) => delay === 4000)?.[0];
      expect(callback).toBeTypeOf("function");
      return callback;
    });
    live = {
      ...live,
      revision: 2,
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
    };
    await act(async () => {
      if (typeof poll === "function") await poll();
    });
    expect(await screen.findByLabelText("Message")).toHaveValue("keep original text");
    expect(calls("adopt")).toHaveLength(0);
  });
  it("recovers a failed focus read after refresh without replaying a send", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("keep after failure");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let failed = true;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "live" && failed
        ? Promise.reject(new Error("inspect_failed"))
        : original(value),
    );
    fireEvent.focus(screen.getByLabelText("Message"));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    failed = false;
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    expect(await enabled(screen.getByLabelText("Message"))).toHaveValue("keep after failure");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["adopt", "release"] as const)(
    "reconciles an existing %s receipt once and never replays it",
    async (operation) => {
      const requestId = crypto.randomUUID();
      localStorage.setItem(
        "agentkib:claude-owner-pending:v1:workspace",
        JSON.stringify({ requestId, operation, workspaceId: "workspace", sessionId: "session" }),
      );
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === "receipt"
          ? Promise.resolve({
              found: true,
              requestId,
              operation,
              sessionId: "session",
              status: "accepted",
            })
          : original(value),
      );
      mount();
      await screen.findByText("Synthetic history");
      await enabled(screen.getByLabelText("Message"));
      expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBeNull();
      expect(calls(operation)).toHaveLength(0);
    },
  );
  it("keeps unknown legacy handoff receipts blocking controls without offering execution management", async () => {
    const requestId = crypto.randomUUID();
    localStorage.setItem(
      "agentkib:claude-owner-pending:v1:workspace",
      JSON.stringify({
        requestId,
        operation: "adopt",
        workspaceId: "workspace",
        sessionId: "session",
      }),
    );
    mount();
    await screen.findByText("Synthetic history");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(calls("adopt")).toHaveLength(0);
    expect(calls("inspect")).toHaveLength(0);
  });
  it("keeps sending and focus reads blocked while compacting", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("after compaction");
    act(() => emitNative(1, "state", { revision: 2, activity: "compacting" }));
    const reads = calls("live").length;
    fireEvent.focus(screen.getByLabelText("Message"));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(calls("live")).toHaveLength(reads);
    act(() => emitNative(2, "state", { revision: 3, activity: null }));
    await enabled(screen.getByRole("button", { name: "Send" }));
  });
  it("keeps the full draft after a not-dispatched send finds an external owner", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("owner raced this send");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "send"
        ? Promise.resolve({
            accepted: false,
            controlOutcome: "not-dispatched",
            error: "claude-owner-busy",
          })
        : original(value),
    );
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    expect(
      await screen.findByText(sessionContinuationCopy("en-US").choice("Claude Code")),
    ).toBeVisible();
    expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBeNull();
    live = {
      ...live,
      revision: 2,
      sendEnabled: true,
      executionLocation: null,
      ownershipReason: null,
    };
    act(() => emitNative(1, "state", live));
    expect(await screen.findByLabelText("Message")).toHaveValue("owner raced this send");
    expect(calls("send")).toHaveLength(1);
  });
  it("renders a mid-run ownership conflict once and an idle shutdown as subdued feedback", async () => {
    live = {
      ...live,
      executionLocation: "external",
      sendEnabled: false,
      ownershipReason: "owner-opened-elsewhere",
      continuationNotice: "owner-opened-elsewhere",
    };
    mount();
    await screen.findByText("Synthetic history");
    expect(screen.getAllByText(sessionContinuationCopy("en-US").ownerOpenedElsewhere)).toHaveLength(
      1,
    );
    expect(screen.getByText(sessionContinuationCopy("en-US").busy("Claude Code"))).toBeVisible();
    expect(screen.getByText(sessionContinuationCopy("en-US").choice("Claude Code"))).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    live = {
      ...live,
      revision: 2,
      executionLocation: null,
      ownershipReason: null,
      continuationNotice: "background-ended",
      sendEnabled: true,
    };
    act(() => emitNative(1, "state", live));
    expect(await screen.findByText(sessionContinuationCopy("en-US").backgroundEnded)).toBeVisible();
    expect(
      screen.queryByText(sessionContinuationCopy("en-US").busy("Claude Code")),
    ).not.toBeInTheDocument();
  });
  it("shows the submitted message and starting state while the first send is pending", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("show while starting");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(value),
    );
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    expect(await screen.findByText(sessionContinuationCopy("en-US").starting)).toBeVisible();
    expect(screen.getByLabelText("History")).toHaveTextContent("show while starting");
    expect(screen.getByLabelText("Message")).toHaveValue("show while starting");
    act(() =>
      emitNative(1, "item-upsert", {
        id: "native-user",
        kind: "user-message",
        content: "show while starting",
        attachment_count: 0,
        truncated: false,
      }),
    );
    expect(
      within(screen.getByLabelText("History")).getAllByText("show while starting"),
    ).toHaveLength(1);
    await act(async () => finish({ accepted: true, sessionId: "session" }));
    expect(await enabled(screen.getByLabelText("Message"))).toHaveValue("");
  });
  it.each([false, true])(
    "keeps an accepted prompt visible until its native echo arrives (older match=%s)",
    async (olderMatch) => {
      if (olderMatch) {
        const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
        vi.mocked(api.claudeRequest).mockImplementation((value) =>
          value.operation === "events"
            ? Promise.resolve({
                events: [
                  { id: "old-user", kind: "user-message", content: "accepted prompt" },
                  { id: "reply", kind: "agent-message", content: "Synthetic history" },
                ],
                warnings: [],
              })
            : original(value),
        );
      }
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("accepted prompt");
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
      await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
      expect(screen.getAllByText("accepted prompt")).toHaveLength(olderMatch ? 2 : 1);
      act(() =>
        emitNative(1, "item-upsert", {
          id: "current-user",
          kind: "user-message",
          content: "accepted prompt",
          attachment_count: 0,
          truncated: false,
        }),
      );
      expect(screen.getAllByText("accepted prompt")).toHaveLength(olderMatch ? 2 : 1);
    },
  );
  it("lets the user return to Claude Code and automatically restores their draft after exit", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("return later");
    live = {
      ...live,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    fireEvent.focus(screen.getByLabelText("Message"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: sessionContinuationCopy("en-US").returnTo("Claude Code"),
      }),
    );
    expect(
      screen.queryByText(sessionContinuationCopy("en-US").choice("Claude Code")),
    ).not.toBeInTheDocument();
    // The session is open in Claude Code already, so no resume command is offered here.
    expect(
      await screen.findByText(sessionContinuationCopy("en-US").returned("Claude Code")),
    ).toBeVisible();
    expect(screen.getByText(sessionContinuationCopy("en-US").draftPreserved)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: sessionContinuationCopy("en-US").copyCommand }),
    ).not.toBeInTheDocument();
    const poll = vi
      .mocked(globalThis.setInterval)
      .mock.calls.find(([, delay]) => delay === 4000)?.[0];
    live = {
      ...live,
      revision: 2,
      executionLocation: null,
      ownershipReason: null,
      sendEnabled: true,
    };
    await act(async () => {
      if (typeof poll === "function") await poll();
    });
    expect(await screen.findByLabelText("Message")).toHaveValue("return later");
    expect(calls("send")).toHaveLength(0);
  });
  it("restores a dismissed composer when the native owner exits and shows a later conflict again", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("native exit keeps draft");
    live = {
      ...live,
      revision: 2,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    act(() => emitNative(1, "state", live));
    fireEvent.click(
      await enabled(
        screen.getByRole("button", {
          name: sessionContinuationCopy("en-US").returnTo("Claude Code"),
        }),
      ),
    );
    live = {
      ...live,
      revision: 3,
      executionLocation: null,
      ownershipReason: null,
      sendEnabled: true,
    };
    act(() => emitNative(2, "state", live));
    expect(await screen.findByLabelText("Message")).toHaveValue("native exit keeps draft");
    live = {
      ...live,
      revision: 4,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    act(() => emitNative(3, "state", live));
    expect(
      await screen.findByText(sessionContinuationCopy("en-US").choice("Claude Code")),
    ).toBeVisible();
    expect(calls("send")).toHaveLength(0);
  });
  it("keeps the terminal wizard in session actions instead of the occupied-session choice", async () => {
    live = {
      ...live,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    const onConnectTerminal = vi.fn();
    render(
      <ClaudeSessionPanel
        workspaceId="workspace"
        initialSessionId="session"
        onClose={vi.fn()}
        onConnectTerminal={onConnectTerminal}
      />,
    );
    expect(
      await screen.findByText(sessionContinuationCopy("en-US").choice("Claude Code")),
    ).toBeVisible();
    // A connected terminal cannot take messages from here yet, so the choice does not promote it.
    expect(
      screen.queryByRole("button", { name: sessionContinuationCopy("en-US").installPlugin }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(
      await enabled(
        screen.getByRole("button", { name: sessionContinuationCopy("en-US").connectTerminal }),
      ),
    );
    expect(onConnectTerminal).toHaveBeenCalledExactlyOnceWith("session");
    expect(calls("adopt")).toHaveLength(0);
  });
  it("forks an occupied session and transfers the unsent draft exactly once", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("draft for fork");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    const sourceLive = {
      ...live,
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
    };
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "catalog"
        ? Promise.resolve({
            indexEnabled: true,
            sessions: [
              { id: "session", workspace_id: "workspace", agent: "claude-code", title: "Original" },
              {
                id: "forked",
                workspace_id: "workspace",
                agent: "claude-code",
                title: "Original (fork)",
              },
            ],
          })
        : value.operation === "live"
          ? Promise.resolve(
              value.sessionId === "forked" ? { ...live, sessionId: "forked" } : sourceLive,
            )
          : original(value),
    );
    fireEvent.focus(screen.getByLabelText("Message"));
    fireEvent.click(
      await enabled(
        await screen.findByRole("button", { name: sessionContinuationCopy("en-US").fork }),
      ),
    );
    expect(await screen.findByLabelText("Message")).toHaveValue("draft for fork");
    expect(
      conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
    ).toHaveLength(1);
    expect(conversationRequest).toHaveBeenCalledWith(
      "managed/action",
      expect.objectContaining({
        operation: "fork",
        agent: "claude-code",
        sessionId: "session",
        expectedRevision: 1,
        bootId: "boot",
      }),
      undefined,
    );
    await enterMessage("edited after fork");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    expect(await enabled(screen.getByLabelText("Message"))).toHaveValue("edited after fork");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ sessionId: "forked", text: "edited after fork" });
  });
  it("does not replay an uncertain fork after refresh", async () => {
    live = {
      ...live,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    const original = conversationRequest.getMockImplementation()!;
    conversationRequest.mockImplementation((path, ...args) =>
      path === "managed/action"
        ? Promise.reject(new Error("lost_fork_response"))
        : original(path, ...args),
    );
    mount();
    await screen.findByText("Synthetic history");
    fireEvent.click(
      await enabled(screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork })),
    );
    await screen.findByText("lost_fork_response");
    const saved = localStorage.getItem("agentkib:claude-owner-pending:v1:workspace");
    expect(saved).not.toBeNull();
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    await waitFor(() =>
      expect(
        conversationRequest.mock.calls.some(([path]) => String(path).startsWith("requests/")),
      ).toBe(true),
    );
    expect(
      conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork }),
    ).toBeDisabled();
    expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBe(saved);
  });
  it("keeps an undispatched fork's draft and allows a fresh explicit attempt", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("not dispatched fork");
    live = {
      ...live,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    fireEvent.focus(screen.getByLabelText("Message"));
    const original = conversationRequest.getMockImplementation()!;
    const { ApiError } = await import("@agentkib/web-client");
    conversationRequest.mockImplementation((path, ...args) =>
      path === "managed/action"
        ? Promise.reject(new ApiError(409, "stale-Claude-revision", "not-dispatched"))
        : original(path, ...args),
    );
    fireEvent.click(
      await enabled(
        await screen.findByRole("button", { name: sessionContinuationCopy("en-US").fork }),
      ),
    );
    await screen.findByRole("alert");
    expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBeNull();
    await enabled(screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork }));
    live = {
      ...live,
      revision: 2,
      executionLocation: null,
      ownershipReason: null,
      sendEnabled: true,
    };
    act(() => emitNative(1, "state", live));
    expect(await screen.findByLabelText("Message")).toHaveValue("not dispatched fork");
    expect(calls("send")).toHaveLength(0);
  });

  it.each([false, true])(
    "keeps fork attachments scoped to the new session (retry=%s)",
    async (failFirstCopy) => {
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let targetUploads = 0;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "upload") {
          if (value.sessionId === "forked" && ++targetUploads === 1 && failFirstCopy)
            return Promise.reject(new Error("upload_failed"));
          return Promise.resolve({
            id: value.sessionId === "forked" ? "target-upload" : "source-upload",
            name: "notes.txt",
            mime: "text/plain",
            size: 4,
            version: "v1",
          });
        }
        if (value.operation === "catalog")
          return Promise.resolve({
            indexEnabled: true,
            sessions: [
              { id: "session", workspace_id: "workspace", agent: "claude-code", title: "Original" },
              { id: "forked", workspace_id: "workspace", agent: "claude-code", title: "Fork" },
            ],
          });
        if (value.operation === "live" && value.sessionId === "forked")
          return Promise.resolve({
            ...live,
            sessionId: "forked",
            executionLocation: null,
            ownershipReason: null,
            sendEnabled: true,
          });
        if (value.operation === "capabilities" && value.sessionId === "forked")
          return Promise.resolve({
            sessionId: "forked",
            features: { attachments: { available: true }, fork: { available: true } },
          });
        if (value.operation === "send")
          return Promise.resolve({ accepted: true, sessionId: value.sessionId });
        return original(value);
      });
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("with attachment");
      const file = new File(["note"], "notes.txt", { type: "text/plain" });
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode("note").buffer,
      });
      fireEvent.change(await enabled(screen.getByLabelText("Add images or files")), {
        target: { files: [file] },
      });
      await screen.findByText("notes.txt");
      live = {
        ...live,
        executionLocation: "external",
        ownershipReason: "claude-owner-busy",
        sendEnabled: false,
      };
      act(() => emitNative(1, "state", live));
      fireEvent.click(
        await enabled(screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork })),
      );
      expect(await screen.findByLabelText("Message")).toHaveValue("with attachment");
      if (failFirstCopy) {
        expect(await screen.findByText("Attachment not uploaded")).toBeVisible();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        fireEvent.click(await enabled(screen.getByRole("button", { name: "Retry upload" })));
        await waitFor(() =>
          expect(screen.queryByText("Attachment not uploaded")).not.toBeInTheDocument(),
        );
      }
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
      await waitFor(() => expect(calls("send")).toHaveLength(1));
      expect(calls("send")[0][0]).toMatchObject({
        sessionId: "forked",
        text: "with attachment",
        attachmentIds: ["target-upload"],
      });
      expect(
        conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
      ).toHaveLength(1);
      expect(calls("upload").filter(([value]) => value.sessionId === "forked")).toHaveLength(
        failFirstCopy ? 2 : 1,
      );
    },
  );
  it.each([
    { first: "upload-failed", second: "accepted" },
    { first: "upload-failed", second: "unknown" },
    { first: "unknown", second: "accepted" },
  ] as const)(
    "keeps all same-name files through consecutive forks ($first → $second)",
    async ({ first, second }) => {
      const local = vi.mocked(api.claudeRequest).getMockImplementation()!;
      const bridge = conversationRequest.getMockImplementation()!;
      const branches = ["session", "first-branch", "second-branch"];
      const titles = ["Original", "First branch", "Second branch"];
      const proven = new Set<string>();
      const forks = new Map<string, { source: string; target: string }>();
      let forkCount = 0;
      const uploadPayload = (value: Record<string, unknown>) =>
        new TextDecoder().decode(value.bytes as Uint8Array);
      const uploadsFor = (id: string) =>
        calls("upload").filter(([value]) => value.sessionId === id);
      const selectBranch = (id: string) => {
        live = {
          ...live,
          sessionId: id,
          revision: 1,
          status: "idle",
          executionLocation: null,
          ownershipReason: null,
          sendEnabled: true,
        };
      };
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "catalog")
          return Promise.resolve({
            indexEnabled: true,
            sessions: branches.map((id, index) => ({
              id,
              workspace_id: "workspace",
              agent: "claude-code",
              title: titles[index],
            })),
          });
        if (value.operation === "capabilities")
          return Promise.resolve({
            sessionId: value.sessionId,
            features: { attachments: { available: true }, fork: { available: true } },
          });
        if (value.operation === "upload") {
          const payload = uploadPayload(value);
          if (value.sessionId === "first-branch" && payload === "second")
            return Promise.reject(new Error("upload_failed"));
          return Promise.resolve({
            id: `${value.sessionId}:${payload}`,
            name: "same-name.txt",
            mime: "text/plain",
            size: payload.length,
            version: "v1",
          });
        }
        if (value.operation === "send")
          return Promise.resolve({ accepted: true, sessionId: value.sessionId });
        return local(value);
      });
      conversationRequest.mockImplementation((path, body, ...rest) => {
        if (path === "managed/action") {
          const command = body as { requestId: string; sessionId: string };
          const target = branches[++forkCount];
          forks.set(command.requestId, { source: command.sessionId, target });
          if ((forkCount === 1 ? first : second) === "unknown")
            return Promise.reject(new Error("lost_fork_response"));
          selectBranch(target);
          return Promise.resolve({ accepted: true, sessionId: target });
        }
        if (String(path).startsWith("requests/")) {
          const requestId = String(path).slice(9);
          const entry = forks.get(requestId);
          if (entry && proven.has(requestId)) {
            selectBranch(entry.target);
            return Promise.resolve({
              found: true,
              requestId,
              operation: "fork",
              sessionId: entry.source,
              status: "accepted",
              ack: { accepted: true, sessionId: entry.target },
              completionObserved: true,
            });
          }
        }
        return bridge(path, body, ...rest);
      });
      const forkButton = () =>
        screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork });
      async function resolveUnknown(source: string, target: string) {
        await screen.findByText("lost_fork_response");
        const saved = localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!;
        const entry = JSON.parse(saved) as { requestId: string; sessionId: string };
        expect(entry.sessionId).toBe(source);
        expect(forkButton()).toBeDisabled();
        fireEvent.click(forkButton());
        const commandsBeforeRefresh = forkCount;
        fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
        await waitFor(() =>
          expect(
            conversationRequest.mock.calls.some(([path]) => path === `requests/${entry.requestId}`),
          ).toBe(true),
        );
        expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBe(saved);
        expect(forkCount).toBe(commandsBeforeRefresh);
        expect(uploadsFor(target)).toHaveLength(0);
        expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent(
          titles[branches.indexOf(source)],
        );
        proven.add(entry.requestId);
        fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
        expect(await screen.findByLabelText("Message")).toHaveValue("carry every draft file");
        expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBeNull();
      }
      function occupy(id: string) {
        live = {
          ...live,
          sessionId: id,
          revision: 2,
          executionLocation: "external",
          ownershipReason: "claude-owner-busy",
          sendEnabled: false,
        };
        act(() => emitNative(1, "state", live, id));
      }
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("carry every draft file");
      const files = ["first", "second"].map((content) => {
        const file = new File([content], "same-name.txt", { type: "text/plain" });
        Object.defineProperty(file, "arrayBuffer", {
          value: async () => new TextEncoder().encode(content).buffer,
        });
        return file;
      });
      fireEvent.change(await enabled(screen.getByLabelText("Add images or files")), {
        target: { files },
      });
      await waitFor(() => expect(screen.getAllByText("same-name.txt")).toHaveLength(2));
      await enabled(screen.getByLabelText("Message"));
      occupy("session");
      fireEvent.click(await enabled(forkButton()));
      if (first === "unknown") await resolveUnknown("session", "first-branch");
      expect(await enabled(await screen.findByLabelText("Message"))).toHaveValue(
        "carry every draft file",
      );
      expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent("First branch");
      expect(screen.getAllByRole("button", { name: "Retry upload" })).toHaveLength(
        first === "unknown" ? 2 : 1,
      );
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      occupy("first-branch");
      fireEvent.click(await enabled(forkButton()));
      if (second === "unknown") {
        await resolveUnknown("first-branch", "second-branch");
        expect(screen.getAllByRole("button", { name: "Retry upload" })).toHaveLength(2);
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        for (let remaining = 2; remaining > 0; remaining--) {
          fireEvent.click(
            await enabled(screen.getAllByRole("button", { name: "Retry upload" })[0]),
          );
          await waitFor(() =>
            expect(screen.queryAllByRole("button", { name: "Retry upload" })).toHaveLength(
              remaining - 1,
            ),
          );
        }
      }
      expect(await screen.findByLabelText("Message")).toHaveValue("carry every draft file");
      expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent("Second branch");
      expect(uploadsFor("second-branch").map(([value]) => uploadPayload(value))).toEqual([
        "first",
        "second",
      ]);
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
      await waitFor(() => expect(calls("send")).toHaveLength(1));
      expect(calls("send")[0][0]).toMatchObject({
        sessionId: "second-branch",
        text: "carry every draft file",
        attachmentIds: ["second-branch:first", "second-branch:second"],
      });
      expect(forkCount).toBe(2);
      expect(
        conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
      ).toHaveLength(2);
    },
  );

  it("moves a draft only after the original unknown fork receipt proves its target", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("recover fork draft");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "catalog"
        ? Promise.resolve({
            indexEnabled: true,
            sessions: [
              { id: "session", workspace_id: "workspace", agent: "claude-code", title: "Original" },
              { id: "forked", workspace_id: "workspace", agent: "claude-code", title: "Fork" },
            ],
          })
        : value.operation === "live" && value.sessionId === "forked"
          ? Promise.resolve({
              ...live,
              sessionId: "forked",
              executionLocation: null,
              ownershipReason: null,
              sendEnabled: true,
            })
          : original(value),
    );
    live = {
      ...live,
      executionLocation: "external",
      ownershipReason: "claude-owner-busy",
      sendEnabled: false,
    };
    act(() => emitNative(1, "state", live));
    const bridge = conversationRequest.getMockImplementation()!;
    let proven = false;
    conversationRequest.mockImplementation((path, ...args) =>
      path === "managed/action"
        ? Promise.reject(new Error("lost_fork_response"))
        : String(path).startsWith("requests/") && proven
          ? Promise.resolve({
              found: true,
              requestId: String(path).slice(9),
              operation: "fork",
              sessionId: "session",
              status: "accepted",
              ack: { accepted: true, sessionId: "forked" },
              completionObserved: true,
            })
          : bridge(path, ...args),
    );
    fireEvent.click(
      await enabled(screen.getByRole("button", { name: sessionContinuationCopy("en-US").fork })),
    );
    await screen.findByText("lost_fork_response");
    proven = true;
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    expect(await screen.findByLabelText("Message")).toHaveValue("recover fork draft");
    expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).toBeNull();
    expect(
      conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
    ).toHaveLength(1);
  });
  it.each([undefined, "session"])(
    "does not forget an accepted fork with an unproven target %s",
    async (target) => {
      const requestId = crypto.randomUUID();
      localStorage.setItem(
        "agentkib:claude-owner-pending:v1:workspace",
        JSON.stringify({
          requestId,
          operation: "fork",
          transport: "conversation",
          workspaceId: "workspace",
          sessionId: "session",
        }),
      );
      const original = conversationRequest.getMockImplementation()!;
      conversationRequest.mockImplementation((path, ...args) =>
        String(path).startsWith("requests/")
          ? Promise.resolve({
              found: true,
              requestId,
              operation: "fork",
              sessionId: "session",
              status: "accepted",
              ack: { sessionId: target },
              completionObserved: true,
            })
          : original(path, ...args),
      );
      mount();
      await screen.findByText("Synthetic history");
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")).not.toBeNull();
      expect(
        conversationRequest.mock.calls.filter(([path]) => path === "managed/action"),
      ).toHaveLength(0);
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows one Windows view-only reason in %s",
    async (language) => {
      locale = language;
      live = { ...live, status: "unsupported", reason: "platform-unsupported", sendEnabled: false };
      mount();
      await screen.findByText("Synthetic history");
      const copy = sessionContinuationCopy(language);
      expect(screen.getAllByText(copy.claudeWindowsUnsupported)).toHaveLength(1);
      expect(screen.getByText(copy.viewOnly)).toBeVisible();
      expect(screen.getByRole("button", { name: copy.copyCommand })).toBeVisible();
      expect(screen.queryByPlaceholderText(copy.placeholder)).not.toBeInTheDocument();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("keeps client versions inside session actions and details", async () => {
    live = { ...live, cliVersion: "2.1.302", model: "model-name" };
    mount();
    await screen.findByText("Synthetic history");
    expect(screen.queryByText(/2\.1\.302/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByText(/2\.1\.302/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Session details" }));
    expect(screen.getByText(/2\.1\.302/)).toBeVisible();
    expect(screen.getByText(/model-name/)).toBeVisible();
  });

  it("persists a lost send receipt across reopening and never replays it during refresh", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "send" ? Promise.reject(new Error("lost_response")) : original(value),
    );
    const view = mount();
    await screen.findByText("Synthetic history");
    await enterMessage("only once");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await screen.findByText("lost_response");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    view.unmount();
    mount();
    await screen.findByText("Synthetic history");
    await act(async () => notifyControl());
    expect(calls("send")).toHaveLength(1);
    expect(calls("receipt").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
  it("dismisses approvals without deciding and refuses a changed form after the other client responds", async () => {
    const approval = {
      requestId: "approval",
      turnId: "turn",
      method: "claude/can_use_tool",
      supported: true,
      availableDecisions: ["allow", "deny"],
      input: { command: "echo safe" },
    };
    live = {
      ...live,
      status: "waiting-approval",
      sendEnabled: false,
      turnId: "turn",
      approvals: [approval],
    };
    mount();
    await enabled(await screen.findByRole("button", { name: "Allow" }));
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Dismiss" })));
    expect(calls("approve")).toHaveLength(0);
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Review approval" })));
    live = { ...live, revision: 2, approvals: [] };
    await act(async () => notifyControl());
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(calls("approve")).toHaveLength(0);
  });
  it.each([false, true])(
    "keeps question presets and custom input consistent (multiSelect=%s)",
    async (multiSelect) => {
      live = {
        ...live,
        status: "waiting-input",
        sendEnabled: false,
        turnId: "turn",
        questions: [
          {
            requestId: "question",
            turnId: "turn",
            supported: true,
            questions: [
              {
                id: "color",
                question: "Choose a color",
                options: [{ label: "Blue" }, { label: "Green" }],
                multiSelect,
                allowCustom: true,
              },
            ],
          },
        ],
      };
      mount();
      const blue = await enabled(await screen.findByRole("checkbox", { name: "Blue" }));
      fireEvent.click(blue);
      const custom = screen.getByLabelText("Choose a color Custom answer");
      fireEvent.change(await enabled(custom), { target: { value: "Other color" } });
      if (multiSelect) expect(blue).toBeChecked();
      else expect(blue).not.toBeChecked();
      fireEvent.click(await enabled(screen.getByRole("checkbox", { name: "Green" })));
      expect(custom).toHaveValue(multiSelect ? "Other color" : "");
      const submit = screen.getByRole("button", { name: "Submit answers" });
      await enabled(submit);
      fireEvent.click(submit);
      await waitFor(() => expect(calls("answer")).toHaveLength(1));
      expect(calls("answer")[0][0]).toMatchObject({
        sessionId: "session",
        questionId: "question",
        turnId: "turn",
        answers: { color: multiSelect ? ["Blue", "Green", "Other color"] : ["Green"] },
      });
    },
  );

  it("sends uploaded file identity without requiring text or exposing renderer file paths", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "upload"
        ? Promise.resolve({
            id: "upload-1",
            name: "fixture.txt",
            mime: "text/plain",
            size: 3,
            version: "v1",
          })
        : original(value),
    );
    mount();
    await screen.findByText("Synthetic history");
    const file = new File(["abc"], "fixture.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("abc").buffer,
    });
    fireEvent.change(await enabled(screen.getByLabelText("Add images or files")), {
      target: { files: [file] },
    });
    await screen.findByText("fixture.txt");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ text: "", attachmentIds: ["upload-1"] });
    expect(calls("send")[0][0]).not.toHaveProperty("path");
  });
});

it("does not remove a newer pending identity when the previous panel's IPC response arrives late", async () => {
  const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
  const replies: ((value: unknown) => void)[] = [];
  let admitted = "";
  vi.mocked(api.claudeRequest).mockImplementation((value) => {
    if (value.operation === "send")
      return new Promise((resolve) => {
        replies.push(resolve);
      });
    if (value.operation === "receipt" && value.requestId === admitted)
      return Promise.resolve({
        found: true,
        requestId: admitted,
        operation: "send",
        sessionId: "session",
        status: "accepted",
      });
    return original(value);
  });
  const first = mount();
  await screen.findByText("Synthetic history");
  await enterMessage("first");
  fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
  await waitFor(() => expect(replies).toHaveLength(1));
  admitted = String(calls("send")[0][0].requestId);
  first.unmount();
  mount();
  await screen.findByText("Synthetic history");
  await enterMessage("second");
  fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
  await waitFor(() => expect(replies).toHaveLength(2));
  const newer = String(calls("send")[1][0].requestId);
  await act(async () => replies[0]({ accepted: true, sessionId: "session" }));
  expect(
    JSON.parse(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!).requestId,
  ).toBe(newer);
  await act(async () => replies[1]({ accepted: true, sessionId: "session" }));
});

describe("Claude local owner panel permission mode notice", () => {
  const languages: Locale[] = ["en-US", "zh-CN", "zh-TW", "ja-JP"];
  const keys = ["auto", "dontAsk", "bypassPermissions", "possiblyAuto", "previous"] as const;
  const shown = (text: string) =>
    screen.queryAllByRole("status").some((element) => element.textContent?.includes(text));
  const warnings: Array<[string, NonNullable<Live["permission"]>, Array<(typeof keys)[number]>]> = [
    ["auto", { mode: "auto" }, ["auto"]],
    ["dontAsk", { mode: "dontAsk" }, ["dontAsk"]],
    ["bypassPermissions", { mode: "bypassPermissions" }, ["bypassPermissions"]],
    ["an unknown mode with the version hint", { mode: null, possiblyAuto: true }, ["possiblyAuto"]],
    ["a previously observed auto mode", { mode: "auto", previous: true }, ["auto", "previous"]],
  ];
  const quiet: Array<[string, Live["permission"]]> = [
    ["default", { mode: "default" }],
    ["plan", { mode: "plan" }],
    ["acceptEdits", { mode: "acceptEdits" }],
    ["an unknown mode without a hint", { mode: null }],
    ["no permission field", undefined],
  ];

  it.each(
    languages.flatMap((code) =>
      warnings.map(([name, permission, expected]) => ({ code, name, permission, expected })),
    ),
  )("shows $name in $code in the owner panel", async ({ code, permission, expected }) => {
    locale = code;
    live = { ...live, permission };
    mount();
    await screen.findByText("Synthetic history");
    const copy = permissionModeCopy[code];
    await waitFor(() => expect(shown(copy[expected[0]!])).toBe(true));
    for (const key of keys) expect(shown(copy[key])).toBe(expected.includes(key));
  });

  it.each(quiet)("shows no notice for %s", async (_name, permission) => {
    live = { ...live, ...(permission ? { permission } : {}) };
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    for (const key of keys) expect(shown(permissionModeCopy["en-US"][key])).toBe(false);
  });

  it("follows native patches without disabling controls and drops the notice on an explicit clear", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    const copy = permissionModeCopy["en-US"];
    act(() => emitNative(1, "state", { revision: 2, permission: { mode: "auto" } }));
    await waitFor(() => expect(shown(copy.auto)).toBe(true));
    // A permission-only patch is display data: it does not pause the composer.
    expect(screen.getByLabelText("Message")).toBeEnabled();
    act(() => emitNative(2, "state", { revision: 3, permission: { mode: "bypassPermissions" } }));
    await waitFor(() => expect(shown(copy.bypassPermissions)).toBe(true));
    expect(shown(copy.auto)).toBe(false);
    act(() => emitNative(3, "state", { revision: 4, permission: { mode: "plan" } }));
    await waitFor(() => expect(shown(copy.bypassPermissions)).toBe(false));
    act(() =>
      emitNative(4, "state", { revision: 5, permission: { mode: "auto", previous: true } }),
    );
    await waitFor(() => expect(shown(copy.previous)).toBe(true));
    act(() => emitNative(5, "state", { revision: 6, permission: { mode: null } }));
    await waitFor(() => expect(shown(copy.auto)).toBe(false));
    expect(shown(copy.previous)).toBe(false);
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });
});

describe("Claude local owner panel translated controls", () => {
  const languages = [
    {
      locale: "zh-CN",
      session: "会话",
      history: "会话历史",
      create: "新建 Claude 任务",
      refresh: "刷新",
      message: "消息",
      files: "文件与产物",
      idle: "空闲",
      release: "交还原客户端",
      send: "发送",
      prepare: "交给 AgentKib",
      recheck: "重新检查原会话",
      handoff: "交给 AgentKib",
      confirmation: "我已停止原终端和其他客户端，按原 UUID 继续。",
      approval: "处理审批",
      allow: "允许",
      deny: "拒绝",
      dismiss: "收起",
      custom: "自定义回答",
      submit: "提交回答",
    },
    {
      locale: "zh-TW",
      session: "對話",
      history: "對話歷史",
      create: "新增 Claude 任務",
      refresh: "重新整理",
      message: "訊息",
      files: "檔案與產物",
      idle: "閒置",
      release: "交還原客戶端",
      send: "傳送",
      prepare: "交給 AgentKib",
      recheck: "重新檢查原對話",
      handoff: "交給 AgentKib",
      confirmation: "我已停止原終端機與其他客戶端，使用原 UUID 繼續。",
      approval: "處理審批",
      allow: "允許",
      deny: "拒絕",
      dismiss: "收合",
      custom: "自訂回答",
      submit: "提交回答",
    },
    {
      locale: "en-US",
      session: "Session",
      history: "History",
      create: "New Claude task",
      refresh: "Refresh",
      message: "Message",
      files: "Files and artifacts",
      idle: "Idle",
      release: "Return to original client",
      send: "Send",
      prepare: "Hand over to AgentKib",
      recheck: "Recheck original session",
      handoff: "Hand over to AgentKib",
      confirmation:
        "I have stopped the original terminal and other clients. Continue the same UUID.",
      approval: "Review approval",
      allow: "Allow",
      deny: "Deny",
      dismiss: "Dismiss",
      custom: "Custom answer",
      submit: "Submit answers",
    },
    {
      locale: "ja-JP",
      session: "会話",
      history: "会話履歴",
      create: "Claude タスクを新規作成",
      refresh: "更新",
      message: "メッセージ",
      files: "ファイルと成果物",
      idle: "待機中",
      release: "元のクライアントに戻す",
      send: "送信",
      prepare: "AgentKib に引き渡す",
      recheck: "元の会話を再確認",
      handoff: "AgentKib に引き渡す",
      confirmation: "元のターミナルと他のクライアントを停止しました。同じ UUID で続けます。",
      approval: "承認内容を確認",
      allow: "許可",
      deny: "拒否",
      dismiss: "閉じる",
      custom: "自由回答",
      submit: "回答を送信",
    },
  ] as const;

  it.each(languages)(
    "renders managed session controls in $locale without dispatching",
    async (expected) => {
      locale = expected.locale;
      mount();
      await screen.findByText("Synthetic history");
      expect(screen.getByRole("combobox", { name: expected.session })).toBeVisible();
      expect(screen.getByLabelText(expected.history)).toBeVisible();
      expect(screen.getByRole("button", { name: expected.create })).toBeVisible();
      expect(screen.getByRole("button", { name: expected.refresh })).toBeVisible();
      expect(await enabled(screen.getByLabelText(expected.message))).toBeVisible();
      expect(screen.queryByText(expected.idle)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: expected.files })).toBeVisible();
      expect(screen.queryByRole("button", { name: expected.release })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: expected.send })).toBeDisabled();
      expect(calls("create")).toHaveLength(0);
      expect(calls("send")).toHaveLength(0);
      expect(calls("release")).toHaveLength(0);
    },
  );

  it.each(languages)(
    "translates occupied choices without a confirmation gate in $locale",
    async (expected) => {
      locale = expected.locale;
      live = {
        ...live,
        executionLocation: "external",
        ownershipReason: "claude-owner-busy",
        sendEnabled: false,
      };
      mount();
      await screen.findByText("Synthetic history");
      const copy = sessionContinuationCopy(locale);
      expect(screen.getByText(copy.choice("Claude Code"))).toBeVisible();
      expect(screen.getByRole("button", { name: copy.fork })).toBeVisible();
      expect(screen.getByRole("button", { name: copy.returnTo("Claude Code") })).toBeVisible();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(calls("adopt")).toHaveLength(0);
      expect(calls("send")).toHaveLength(0);
    },
  );

  it.each(languages)(
    "translates native approval and custom-answer controls in $locale",
    async (expected) => {
      locale = expected.locale;
      live = {
        ...live,
        status: "waiting-approval",
        sendEnabled: false,
        turnId: "turn",
        approvals: [
          {
            requestId: "approval",
            turnId: "turn",
            method: "claude/can_use_tool",
            supported: true,
            availableDecisions: ["allow", "deny"],
            input: {},
          },
        ],
      };
      mount();
      await enabled(await screen.findByRole("button", { name: expected.allow }));
      expect(screen.getByRole("button", { name: expected.deny })).toBeVisible();
      expect(screen.getByRole("button", { name: expected.approval })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: expected.dismiss }));
      expect(calls("approve")).toHaveLength(0);
      live = {
        ...live,
        status: "waiting-input",
        revision: 2,
        approvals: [],
        questions: [
          {
            requestId: "question",
            turnId: "turn",
            supported: true,
            questions: [
              {
                id: "answer",
                question: "Choose a color",
                options: [{ label: "Blue" }],
                multiSelect: false,
                allowCustom: true,
              },
            ],
          },
        ],
      };
      await act(async () => notifyControl());
      const answer = await enabled(
        await screen.findByLabelText(`Choose a color ${expected.custom}`),
      );
      const submit = screen.getByRole("button", { name: expected.submit });
      expect(submit).toBeDisabled();
      fireEvent.change(answer, { target: { value: "Other color" } });
      expect(submit).toBeEnabled();
      expect(calls("answer")).toHaveLength(0);
      expect(calls("send")).toHaveLength(0);
    },
  );

  it("updates mounted labels while preserving an unsent draft", async () => {
    const view = mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const message = screen.getByLabelText("Message");
    locale = "ja-JP";
    view.rerender(
      <ClaudeSessionPanel workspaceId="workspace" initialSessionId="session" onClose={vi.fn()} />,
    );
    expect(screen.getByLabelText("メッセージ")).toBe(message);
    expect(message).toHaveValue("Preserved draft");
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(calls("send")).toHaveLength(0);
    expect(calls("adopt")).toHaveLength(0);
  });
});
