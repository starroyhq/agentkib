import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  WebClient,
  type ConversationClientBridge,
  type ConversationSessionSummary,
  type SessionStreamHandlers,
} from "@agentkib/web-client";
import { WebAccessService } from "../../desktop/electron/main/web/service";
import { useSessionController } from "@/features/conversation/web-session-controller";
import { pendingScope, readPending, rememberPending } from "@agentkib/session-ui";

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(delayBusy = false) {
  const directory = await mkdtemp(join(tmpdir(), "agentkib-catalog-recovery-"));
  const command = deferred<{ accepted: boolean }>();
  const busyResponse = deferred<void>();
  const commandStarted = vi.fn();
  const catalogResponses: number[] = [];
  const settled = vi.fn();
  const streams = new Map<string, SessionStreamHandlers>();
  const sessions: ConversationSessionSummary[] = ["first", "second"].map((id) => ({
    id,
    workspace_id: "workspace",
    agent: "claude-code",
    availability: "readable",
    archived: false,
    sidechain: false,
  }));
  const live = (sessionId: string) => ({
    sessionId,
    executionMode: "managed-resume",
    workspaceId: "workspace",
    runtimeBootId: "runtime",
    status: "idle",
    revision: 1,
    sendEnabled: true,
    approvals: [],
    questions: [],
  });
  const service = new WebAccessService({
    dataDir: directory,
    staticDir: directory,
    verifiedClaudeManaged: true,
    workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: directory }],
    receiptRequest: async ({ requestId }) => ({
      found: true,
      requestId,
      sessionId: "first",
      operation: "send",
      status: "unknown",
    }),
    runtimeRequest: async (params) => {
      const input = params as { operation: string; sessionId: string };
      if (input.operation === "catalog")
        return {
          indexEnabled: true,
          sessions: sessions.map((session) => ({ ...session })),
          workspaces: [{ id: "workspace", name: "Workspace", path: directory }],
        };
      if (input.operation === "live") return live(input.sessionId);
      if (input.operation === "send") {
        commandStarted();
        return command.promise;
      }
      if (input.operation === "events") return { events: [], warnings: [] };
      return { available: false };
    },
  });
  await service.initialize();
  const bridge: ConversationClientBridge = {
    async request<Result>(path: string, body?: unknown): Promise<Result> {
      const response = await service.localRequest(path, body);
      if (path === "catalog") {
        catalogResponses.push(response.status);
        if (delayBusy && response.status === 409) await busyResponse.promise;
      }
      if (response.status >= 400) {
        const error = response.body as {
          error: string;
          controlOutcome?: "unknown" | "not-dispatched";
        };
        throw new ApiError(response.status, error.error, error.controlOutcome);
      }
      return response.body as Result;
    },
    stream(id, handlers) {
      streams.set(id, handlers);
      let closed = false;
      queueMicrotask(async () => {
        if (closed) return;
        handlers.open();
        if (id) {
          // A manual refresh replaces the subscription. Its baseline must carry
          // the service's current command fence, just like the production stream.
          const response = await service.localRequest(`live?sessionId=${id}`);
          if (closed) return;
          expect(response.status).toBe(200);
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live: response.body },
            }),
          );
        }
      });
      return () => {
        closed = true;
        if (streams.get(id) === handlers) streams.delete(id);
      };
    },
    uploadAttachment: vi.fn(),
  };
  const removeChanged = service.onControlChanged((id) => {
    settled(id);
    streams.get("")?.event("control-changed", JSON.stringify({ sessionId: id }));
    streams.get(id)?.event("control-changed", JSON.stringify({ sessionId: id }));
  });
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  const view = renderHook(() => useSessionController({ client, embedded: true }));
  let pending: ReturnType<typeof service.localRequest> | undefined;
  return {
    view,
    catalogResponses,
    commandStarted,
    settled,
    invalidate: () => streams.get("")!.event("catalog-invalidated", "{}"),
    async startCommand() {
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => {
        await view.result.current.choose("first");
      });
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      pending = service.localRequest("send", {
        sessionId: "first",
        text: "Isolated native command",
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
        bootId: view.result.current.access!.bootId,
      });
      await waitFor(() => expect(commandStarted).toHaveBeenCalledOnce());
      sessions[1].title = "Updated native catalog";
    },
    async settle(accepted = true) {
      command.resolve({ accepted });
      const response = await pending;
      expect(response).toMatchObject({ status: accepted ? 200 : 502 });
      await waitFor(() => expect(settled).toHaveBeenCalledWith("first"));
    },
    releaseBusy: () => busyResponse.resolve(),
    async dispose() {
      busyResponse.resolve();
      command.resolve({ accepted: true });
      await pending;
      view.unmount();
      removeChanged();
      await service.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("catalog recovery across native command admission", () => {
  it.each([false, true])(
    "recovers controls after catalog contention (settlement precedes busy response: %s)",
    async (settlementFirst) => {
      const host = await fixture(settlementFirst);
      try {
        await host.startCommand();
        // Native runners may publish state before startup/control acknowledgement.
        act(host.invalidate);
        await waitFor(() => expect(host.catalogResponses).toContain(409));
        await act(async () => {
          await host.settle();
        });
        if (settlementFirst)
          await act(async () => {
            host.releaseBusy();
          });
        // Settlement alone must recover the catalog, including when its wakeup
        // arrived before the busy response. No extra invalidation is required.
        await waitFor(() =>
          expect(
            host.view.result.current.sessions.find((session) => session.id === "second")?.title,
          ).toBe("Updated native catalog"),
        );
        expect(host.catalogResponses.at(-1)).toBe(200);
        expect(host.view.result.current.live).toMatchObject({ status: "idle", sendEnabled: true });
        await waitFor(() => expect(host.view.result.current.canSend).toBe(true));
        const reads = host.catalogResponses.length;
        // A later Worker invalidation remains safe after recovery has completed.
        act(host.invalidate);
        await waitFor(() => expect(host.catalogResponses.length).toBeGreaterThan(reads));
        expect(host.catalogResponses.at(-1)).toBe(200);
        expect(host.view.result.current.canSend).toBe(true);
        expect(host.commandStarted).toHaveBeenCalledOnce();
      } finally {
        await host.dispose();
      }
    },
  );

  it.each(["host-unknown", "durable"])(
    "retains the %s command fence after the catalog recovers",
    async (fence) => {
      const host = await fixture();
      const scope = pendingScope("", "desktop-local");
      const pending = { requestId: crypto.randomUUID(), sessionId: "first", kind: "send" as const };
      try {
        await host.startCommand();
        if (fence === "durable") act(() => rememberPending(scope, pending));
        act(host.invalidate);
        await waitFor(() => expect(host.catalogResponses).toContain(409));
        await act(async () => {
          await host.settle(fence !== "host-unknown");
        });
        act(host.invalidate);
        await waitFor(() =>
          expect(
            host.view.result.current.sessions.find((session) => session.id === "second")?.title,
          ).toBe("Updated native catalog"),
        );
        if (fence === "host-unknown")
          expect(host.view.result.current.live).toMatchObject({
            status: "outcome-unknown",
            reason: "control-outcome-unconfirmed",
            sendEnabled: false,
          });
        else expect(readPending(scope)).toEqual([pending]);
        expect(host.view.result.current.canSend).toBe(false);
        expect(host.commandStarted).toHaveBeenCalledOnce();
      } finally {
        await host.dispose();
      }
    },
  );
});

describe("full refresh recovery across native command admission", () => {
  it.each([
    { manual: false, settlementFirst: false },
    { manual: true, settlementFirst: false },
    { manual: false, settlementFirst: true },
    { manual: true, settlementFirst: true },
  ])(
    "finishes a busy refresh on settlement alone (manual: $manual, settlement first: $settlementFirst)",
    async ({ manual, settlementFirst }) => {
      const host = await fixture(settlementFirst);
      try {
        await host.startCommand();
        let refreshing!: Promise<void>;
        act(() => {
          refreshing = host.view.result.current.refresh(manual);
        });
        await waitFor(() => expect(host.catalogResponses.at(-1)).toBe(409));
        await act(async () => {});
        expect(host.view.result.current.canSend).toBe(false);
        await act(async () => host.settle());
        // No final catalog invalidation is emitted. The actual service settlement
        // must wake the refresh even if its busy response has not arrived yet.
        await act(async () => {
          host.releaseBusy();
          await refreshing;
        });
        await waitFor(() =>
          expect(
            host.view.result.current.sessions.find((session) => session.id === "second")?.title,
          ).toBe("Updated native catalog"),
        );
        expect(host.catalogResponses.at(-1)).toBe(200);
        expect(host.view.result.current.live).toMatchObject({ status: "idle", sendEnabled: true });
        expect(host.view.result.current.error).toBe(false);
        await waitFor(() => expect(host.view.result.current.canSend).toBe(true));
        expect(host.commandStarted).toHaveBeenCalledOnce();
      } finally {
        await host.dispose();
      }
    },
  );

  it.each([
    { manual: false, fence: "host-unknown" },
    { manual: true, fence: "host-unknown" },
    { manual: false, fence: "durable" },
    { manual: true, fence: "durable" },
  ])(
    "retains the $fence fence after retrying a busy refresh (manual: $manual)",
    async ({ manual, fence }) => {
      const host = await fixture(true);
      const scope = pendingScope("", "desktop-local");
      const pending = { requestId: crypto.randomUUID(), sessionId: "first", kind: "send" as const };
      try {
        await host.startCommand();
        if (fence === "durable") act(() => rememberPending(scope, pending));
        let refreshing!: Promise<void>;
        act(() => {
          refreshing = host.view.result.current.refresh(manual);
        });
        await waitFor(() => expect(host.catalogResponses.at(-1)).toBe(409));
        await act(async () => host.settle(fence !== "host-unknown"));
        await act(async () => {
          host.releaseBusy();
          await refreshing;
        });
        await waitFor(() =>
          expect(
            host.view.result.current.sessions.find((session) => session.id === "second")?.title,
          ).toBe("Updated native catalog"),
        );
        expect(host.catalogResponses.at(-1)).toBe(200);
        expect(host.view.result.current.error).toBe(false);
        if (fence === "host-unknown")
          expect(host.view.result.current.live).toMatchObject({
            status: "outcome-unknown",
            reason: "control-outcome-unconfirmed",
            sendEnabled: false,
          });
        else {
          expect(host.view.result.current.live).toMatchObject({
            status: "idle",
            sendEnabled: true,
          });
          expect(readPending(scope)).toEqual([pending]);
        }
        expect(host.view.result.current.canSend).toBe(false);
        expect(host.commandStarted).toHaveBeenCalledOnce();
      } finally {
        await host.dispose();
      }
    },
  );
});
