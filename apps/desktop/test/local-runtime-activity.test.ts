// @vitest-environment node
import {
  HISTORY_SEARCH_METHODS,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  RUNTIME_METHODS,
} from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimeActivity } from "../../../packages/backend/src/local-runtime-activity";
import {
  parseLocalRuntimeTraceRow,
  type LocalRuntimeTraceEvent,
} from "../../../packages/backend/src/local-runtime-trace";

const success = { jsonrpc: "2.0", result: null };

describe("local runtime stalls", () => {
  let now: number;
  const record = vi.fn<(event: LocalRuntimeTraceEvent) => void>();
  let activity: LocalRuntimeActivity;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    activity = new LocalRuntimeActivity({ record });
    record.mockClear();
  });

  afterEach(() => {
    activity.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the blocking request when it completes before the overdue timer", () => {
    const finish = activity.beginRequest({
      jsonrpc: "2.0",
      method: RUNTIME_METHODS.sessionRequest,
      params: {
        host: {
          request: {
            operation: "send",
            sessionId: "private-id",
            text: "private-message",
            cwd: "/private-workspace",
          },
        },
      },
    });
    now = 2_101;
    finish?.(success);
    vi.advanceTimersByTime(100);

    const context = {
      method: RUNTIME_METHODS.sessionRequest,
      operation: "send",
      session: expect.stringMatching(/^[0-9a-f]{16}$/),
    };
    expect(record.mock.calls).toEqual([
      [{ kind: "stall", durationMs: 2_001, active: [context], activeCount: 1 }],
      [
        {
          kind: "request",
          durationMs: 2_101,
          ...context,
          stage: "runtime-dispatch",
          outcome: "completed",
        },
      ],
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-");
  });

  it("labels host catalog reads through capture and diagnostic export", () => {
    const read = activity.beginRequest({
      jsonrpc: "2.0",
      method: RUNTIME_METHODS.sessionRequest,
      params: { host: { request: { operation: "catalog", readerScope: "private-scope" } } },
    });
    now = 10;
    read?.(success);
    expect(parseLocalRuntimeTraceRow({ v: 1, at: 10, ...record.mock.calls[0]?.[0] })).toEqual({
      v: 1,
      at: 10,
      kind: "request",
      method: RUNTIME_METHODS.sessionRequest,
      operation: "catalog",
      durationMs: 10,
      stage: "runtime-dispatch",
      outcome: "completed",
    });
  });

  it("distinguishes a slow asynchronous request from an event-loop stall", () => {
    const finish = activity.begin(RUNTIME_METHODS.sessionRequest, {
      operation: "/untrusted-operation",
      sessionId: "synthetic-session",
    });
    for (let tick = 0; tick < 30; tick++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    finish?.(success);
    expect(record.mock.calls).toEqual([
      [
        {
          kind: "request",
          method: RUNTIME_METHODS.sessionRequest,
          session: expect.stringMatching(/^[0-9a-f]{16}$/),
          durationMs: 3_000,
          stage: "runtime-dispatch",
          outcome: "completed",
        },
      ],
    ]);
    now += 2_100;
    vi.advanceTimersByTime(100);
    expect(record).toHaveBeenCalledTimes(1);
    now += 2_101;
    vi.advanceTimersByTime(100);
    expect(record).toHaveBeenLastCalledWith({
      kind: "stall",
      durationMs: 2_001,
      active: [],
      activeCount: 0,
    });
  });

  it("summarizes only stalls observed in the last ten minutes", () => {
    now = 15_100;
    activity.begin(RUNTIME_METHODS.sessionRequest)?.(success);
    now = 17_201;
    activity.begin(RUNTIME_METHODS.sessionRequest)?.(success);

    expect(record.mock.calls.flat().filter((event) => event.kind === "stall")).toHaveLength(2);
    expect(activity.recentStalls()).toEqual({ count: 2, longestMs: 15_000 });
    now = 615_101;
    expect(activity.recentStalls()).toEqual({ count: 1, longestMs: 2_001 });
    now = 617_202;
    expect(activity.recentStalls()).toEqual({ count: 0, longestMs: 0 });
  });

  it("bounds the stall context and aliases session IDs within one runtime", () => {
    const request = [RUNTIME_METHODS.sessionsSubscribe, { sessionId: "same-session" }] as const;
    const finishes = Array.from({ length: 150 }, () => activity.begin(...request));
    now = 3_000;
    vi.advanceTimersByTime(100);
    const event = record.mock.calls[0]?.[0];
    expect(event).toMatchObject({ kind: "stall", activeCount: 150 });
    if (event?.kind !== "stall") throw new Error("Expected a stall");
    expect(event.active).toHaveLength(8);
    expect(new Set(event.active.map((context) => context.session)).size).toBe(1);
    for (const finish of finishes) finish?.(success);

    const anotherRuntime = new LocalRuntimeActivity({ record });
    try {
      anotherRuntime.begin(...request)?.(success);
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({ session: expect.not.stringMatching(event.active[0]!.session!) }),
      );
    } finally {
      anotherRuntime.close();
    }
  });

  it("records each attempt once and distinguishes control acknowledgements from completion", () => {
    const beginSend = () => activity.begin(RUNTIME_METHODS.sessionRequest, { operation: "send" });
    const reply = (fields: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      result: { operation: "send", result: fields },
    });
    const refuse = beginSend();
    refuse?.(
      reply({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: REMOTE_ERROR_CODES.sessionCompacting,
      }),
    );
    refuse?.(success);
    beginSend()?.(reply({ accepted: true, completed: false }));
    beginSend()?.(
      reply({
        accepted: true,
        controlOutcome: "unknown",
        reason: REMOTE_ERROR_CODES.operationBusy,
      }),
    );
    expect(record.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        operation: "send",
        stage: "runtime-dispatch",
        outcome: "refused",
        reason: REMOTE_ERROR_CODES.sessionCompacting,
      }),
      expect.objectContaining({
        operation: "send",
        stage: "runtime-dispatch",
        outcome: "accepted",
      }),
      expect.objectContaining({
        operation: "send",
        stage: "runtime-dispatch",
        outcome: "unknown",
        reason: REMOTE_ERROR_CODES.operationBusy,
      }),
    ]);
  });

  it("keeps only registered RPC reasons and treats unproven write failures as unknown", () => {
    const error = (code: number, detail?: string) => ({
      jsonrpc: "2.0",
      error: { code, message: "private exception", data: { detail } },
    });
    const application = REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode;
    activity.begin(RUNTIME_METHODS.sessionRequest, { operation: "send" })?.(
      error(application, "/private/exception with a token"),
    );
    activity.begin(RUNTIME_METHODS.sessionRequest, { operation: "catalog" })?.(
      error(application, REMOTE_ERROR_CODES.catalogStaleDetail),
    );
    activity.begin(RUNTIME_METHODS.sessionRequest, { operation: "send" })?.(
      error(REMOTE_ERROR_CONTRACT.rpcInvalidParams.ipc.rpcCode, "private validation error"),
    );
    activity.begin(HISTORY_SEARCH_METHODS.query)?.(
      error(application, "irrelevant text"),
      "cancelled",
    );

    expect(record.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        operation: "send",
        outcome: "unknown",
        reason: REMOTE_ERROR_CODES.requestFailed,
      }),
      expect.objectContaining({
        operation: "catalog",
        outcome: "failed",
        reason: REMOTE_ERROR_CODES.catalogStaleDetail,
      }),
      expect.objectContaining({
        operation: "send",
        outcome: "refused",
        reason: REMOTE_ERROR_CODES.rpcInvalidParams,
      }),
      expect.objectContaining({
        method: HISTORY_SEARCH_METHODS.query,
        outcome: "cancelled",
        reason: REMOTE_ERROR_CODES.historyRequestCancelled,
      }),
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private");
  });

  it("labels cached catalog reads partial only for evidence of unreadable sources", () => {
    const read = (reasons: string[]) =>
      activity.begin(RUNTIME_METHODS.sessionRequest, { operation: "catalog" })?.({
        jsonrpc: "2.0",
        result: {
          complete: false,
          taskSummarySourceCoverage: {
            indexEnabled: true,
            managedComplete: true,
            sources: [{ complete: false, reasons, workspaceId: "private-workspace" }],
          },
        },
      });
    read(["not-scanned", "refreshing", "index-disabled"]);
    read(["source-unavailable", "private-unregistered-source-detail"]);
    read(["source-unavailable", REMOTE_ERROR_CODES.dshRuntimeOffline]);
    expect(record.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ operation: "catalog", outcome: "completed" }),
      expect.objectContaining({
        operation: "catalog",
        outcome: "partial",
        reason: REMOTE_ERROR_CODES.requestFailed,
      }),
      expect.objectContaining({
        operation: "catalog",
        outcome: "partial",
        reason: REMOTE_ERROR_CODES.dshRuntimeOffline,
      }),
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private");
  });
});
