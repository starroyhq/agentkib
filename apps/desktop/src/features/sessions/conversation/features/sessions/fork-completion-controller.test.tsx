// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Live,
} from "@agentkib/web-client";
import { useSessionController } from "@/features/sessions/conversation/features/sessions/use-session-controller";
import {
  pendingScope,
  readPending,
} from "@/features/sessions/conversation/features/sessions/pending-controls";

vi.mock("@/features/sessions/conversation/features/preferences/use-appearance", () => ({
  useAppearance: () => {},
}));
vi.mock("@/features/sessions/conversation/features/sessions/use-session-live", () => ({
  useSessionLive: ({
    selected,
    streamReady,
    refreshRequired,
    hasDurablePending,
    setControlReady,
  }: {
    selected: string;
    streamReady: { current: boolean };
    refreshRequired: { current: boolean };
    hasDurablePending: (id: string) => boolean;
    setControlReady: (ready: boolean) => void;
  }) => {
    useEffect(() => {
      streamReady.current = !!selected;
      setControlReady(!!selected && !refreshRequired.current && !hasDurablePending(selected));
    }, [selected, streamReady, refreshRequired, hasDurablePending, setControlReady]);
  },
}));

const history: ConversationEventPage = { events: [], warnings: [] };
const summary = (
  id: string,
  agent: "codex" | "claude-code" = "codex",
): ConversationSessionSummary => ({
  id,
  agent,
  title: id,
  workspace_id: "workspace",
  availability: "readable",
  archived: false,
  sidechain: false,
});
const baseIdle = (sessionId: string, agent: "codex" | "claude-code" = "codex"): Live => ({
  sessionId,
  revision: 1,
  status: "idle",
  executionMode: agent === "codex" ? "codex-managed" : "claude-managed",
  sendEnabled: true,
  approvals: [],
  questions: [],
});
const baseOccupied = (sessionId: string, agent: "codex" | "claude-code" = "codex"): Live => ({
  ...baseIdle(sessionId, agent),
  status: "unsupported",
  sendEnabled: false,
  reason: agent === "codex" ? "codex-owner-busy" : "claude-owner-busy",
  ownershipReason: agent === "codex" ? "codex-owner-busy" : "claude-owner-busy",
});

function baseFixture(initial: Live, agent: "codex" | "claude-code") {
  const client = new WebClient();
  const scope = pendingScope(client.origin, "device");
  const sessions = [summary("original", agent), summary("other", agent)];
  const liveById = new Map<string, Live>([["original", initial]]);
  vi.spyOn(client, "access").mockResolvedValue({
    status: "approved",
    protocolVersion: 2,
    csrfToken: "synthetic-test",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "device",
      name: "Browser",
      send: true,
      approve: true,
      manage: true,
      accessMode: "full",
    },
  });
  vi.spyOn(client, "catalog").mockImplementation(async () => ({
    indexEnabled: true,
    sessions: [...sessions],
  }));
  const events = vi.spyOn(client, "events").mockResolvedValue(history);
  const live = vi
    .spyOn(client, "live")
    .mockImplementation(async (id) => liveById.get(id) ?? baseIdle(id, agent));
  vi.spyOn(client, "stream").mockImplementation(() => () => {});
  const receipt = vi
    .spyOn(client, "receipt")
    .mockImplementation(async (requestId) => ({ found: false, requestId }));
  vi.spyOn(client, "sessionCapabilities").mockImplementation(async (sessionId) => ({
    sessionId,
    executionMode: agent === "codex" ? "codex-managed" : "claude-managed",
    status: "idle",
    features: { fork: { available: true } },
  }));
  const request = vi.spyOn(client, "request").mockImplementation(async (path) => {
    if (path === (agent === "codex" ? "codex/fork" : "managed/action")) {
      sessions.push(summary("forked", agent));
      return { accepted: true, sessionId: "forked" };
    }
    return { accepted: true };
  });
  return { client, scope, sessions, liveById, events, live, receipt, request };
}

async function open(host: ReturnType<typeof baseFixture>) {
  const view = renderHook(() => useSessionController({ client: host.client }));
  await act(async () => {});
  expect(view.result.current.sessions).toHaveLength(2);
  await act(async () => view.result.current.choose("original"));
  await act(async () => {});
  expect(view.result.current.capabilities?.features.fork?.available).toBe(true);
  return view;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("active send receipt ownership", () => {
  it("keeps a pending send distinct from an unknown receipt", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    host.request.mockImplementation(async () => pending);
    host.receipt.mockImplementation(async (requestId) => ({
      found: true,
      requestId,
      sessionId: "original",
      operation: "send",
      status: "unknown",
      completionObserved: false,
    }));
    const view = await open(host);
    act(() => view.result.current.setMessage("Keep this startup draft"));
    let sending!: Promise<boolean | undefined>;
    act(() => {
      sending = view.result.current.control("send");
    });
    await act(async () => {});
    expect(host.request).toHaveBeenCalledOnce();
    await act(async () => view.result.current.refresh());
    expect(view.result.current.notice).toBeUndefined();
    expect(host.receipt).not.toHaveBeenCalled();
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.canSend).toBe(false);
    await act(async () => {
      reject(new ApiError(409, "startup_failed", "not-dispatched"));
      await sending;
    });
    expect(view.result.current.notice).toBe("notDispatched");
    expect(view.result.current.message).toBe("Keep this startup draft");
    expect(view.result.current.canSend).toBe(true);
    expect(host.request).toHaveBeenCalledOnce();
  });
});

describe.each(["codex", "claude-code"] as const)("%s completed fork navigation", (agent) => {
  const fixture = () =>
    baseFixture({ ...baseOccupied("original", agent), runtimeBootId: "runtime" }, agent);
  const ack = (requestId: string) => ({
    accepted: true,
    completed: true,
    requestId,
    sessionId: "forked",
  });
  const acceptedReceipt = (requestId: string) => ({
    found: true as const,
    requestId,
    sessionId: "original",
    operation: "fork",
    runtimeBootId: "runtime",
    status: "accepted" as const,
    completionObserved: false,
    ack: ack(requestId),
  });
  const startUnknown = async (
    host: ReturnType<typeof baseFixture>,
    result: ReturnType<
      typeof renderHook<ReturnType<typeof useSessionController>, unknown>
    >["result"],
  ) => {
    let requestId = "";
    host.request.mockImplementationOnce(async (_path, body) => {
      requestId = (body as { requestId: string }).requestId;
      throw new ApiError(504, "outcome_unknown", "unknown");
    });
    let completion!: Promise<string | undefined>;
    await act(async () => {
      completion = result.current.forkContinuation();
    });
    expect(requestId).not.toBe("");
    expect(result.current.notice).toBe("uncertain");
    expect(result.current.busy).toBe(false);
    return { requestId, completion };
  };

  it("returns the confirmed child for navigation before its history or live read completes", async () => {
    const host = fixture();
    const { result } = await open(host);
    let finishHistory!: (page: ConversationEventPage) => void;
    host.events.mockImplementation(async (id) =>
      id === "forked"
        ? new Promise((resolve) => {
            finishHistory = resolve;
          })
        : history,
    );
    await act(async () => result.current.setMessage("Keep the source draft"));
    let completion!: Promise<string | undefined>;
    let navigated: string | undefined;
    await act(async () => {
      completion = result.current.forkContinuation();
      void completion.then((id) => {
        navigated = id;
      });
    });
    expect(result.current.selected).toBe("forked");
    expect(navigated).toBe("forked");
    expect(result.current.message).toBe("Keep the source draft");
    expect(host.request).toHaveBeenCalledOnce();
    await act(async () => finishHistory(history));
    await expect(completion).resolves.toBe("forked");
  });

  it("opens one late completed fork receipt and transfers its in-memory draft without resubmitting", async () => {
    const host = fixture();
    const { result } = await open(host);
    await act(async () => result.current.setMessage("Late fork draft"));
    const { requestId, completion } = await startUnknown(host, result);
    expect(readPending(host.scope)).toHaveLength(1);
    host.sessions.push(summary("forked", agent));
    host.receipt.mockResolvedValue(acceptedReceipt(requestId));
    await act(async () => result.current.refresh());
    await expect(completion).resolves.toBe("forked");
    expect(result.current.selected).toBe("forked");
    expect(result.current.message).toBe("Late fork draft");
    expect(readPending(host.scope)).toEqual([]);
    expect(host.request).toHaveBeenCalledOnce();
  });

  it("restores the confirmed branch while the previous source refresh is still loading", async () => {
    const host = fixture();
    const { result } = await open(host);
    let finishSource!: (page: ConversationEventPage) => void;
    let held = false;
    host.events.mockImplementation(async (id) => {
      if (id !== "original" || held) return history;
      held = true;
      return new Promise((resolve) => {
        finishSource = resolve;
      });
    });
    const { requestId, completion } = await startUnknown(host, result);
    expect(finishSource).toBeTypeOf("function");
    host.sessions.push(summary("forked", agent));
    host.receipt.mockResolvedValue(acceptedReceipt(requestId));
    await act(async () => result.current.refresh());
    await expect(completion).resolves.toBe("forked");
    expect(result.current.selected).toBe("forked");
    await act(async () => finishSource(history));
    expect(result.current.selected).toBe("forked");
    expect(host.request).toHaveBeenCalledOnce();
  });

  it("waits for the confirmed child to become readable in the catalog without forking twice", async () => {
    const host = fixture();
    const { result } = await open(host);
    host.request.mockImplementationOnce(async (_path, body) =>
      ack((body as { requestId: string }).requestId),
    );
    let completion!: Promise<string | undefined>;
    let navigated: string | undefined;
    await act(async () => {
      completion = result.current.forkContinuation();
      void completion.then((id) => {
        navigated = id;
      });
    });
    expect(result.current.selected).toBe("original");
    expect(navigated).toBeUndefined();
    let duplicate!: Promise<string | undefined>;
    await act(async () => {
      duplicate = result.current.forkContinuation();
    });
    expect(host.request).toHaveBeenCalledOnce();
    host.sessions.push(summary("forked", agent));
    await act(async () => result.current.refresh());
    await expect(completion).resolves.toBe("forked");
    await expect(duplicate).resolves.toBe("forked");
    expect(result.current.selected).toBe("forked");
    expect(host.request).toHaveBeenCalledOnce();
  });

  it.each([
    "ack-request",
    "ack-accepted",
    "ack-completed",
    "ack-child",
    "source-child",
    "receipt-request",
    "receipt-source",
    "receipt-operation",
    "runtime-boot",
    "unknown",
  ] as const)(
    "keeps an unconfirmed %s fork receipt fenced without navigating or resubmitting",
    async (variant) => {
      const host = fixture();
      const { result } = await open(host);
      const { requestId } = await startUnknown(host, result);
      host.sessions.push(summary("forked", agent));
      const receipt = acceptedReceipt(requestId);
      const malformed =
        variant === "ack-request"
          ? { ...receipt, ack: { ...receipt.ack, requestId: crypto.randomUUID() } }
          : variant === "ack-accepted"
            ? { ...receipt, ack: { ...receipt.ack, accepted: false } }
            : variant === "ack-completed"
              ? { ...receipt, ack: { ...receipt.ack, completed: false } }
              : variant === "ack-child"
                ? { ...receipt, ack: { ...receipt.ack, sessionId: "" } }
                : variant === "source-child"
                  ? { ...receipt, ack: { ...receipt.ack, sessionId: "original" } }
                  : variant === "receipt-request"
                    ? { ...receipt, requestId: crypto.randomUUID() }
                    : variant === "receipt-source"
                      ? { ...receipt, sessionId: "other" }
                      : variant === "receipt-operation"
                        ? { ...receipt, operation: "send" }
                        : variant === "runtime-boot"
                          ? { ...receipt, runtimeBootId: "other-runtime" }
                          : { ...receipt, status: "unknown" as const };
      host.receipt.mockResolvedValue(malformed);
      await act(async () => result.current.refresh());
      expect(result.current.selected).toBe("original");
      expect(result.current.notice).toBe("uncertain");
      expect(readPending(host.scope)).toHaveLength(1);
      expect(host.request).toHaveBeenCalledOnce();
    },
  );

  it("does not navigate an old fork intent after the backend runtime changes under the same access boot", async () => {
    const host = fixture();
    const { result } = await open(host);
    const { requestId, completion } = await startUnknown(host, result);
    host.liveById.set("original", {
      ...baseOccupied("original", agent),
      runtimeBootId: "new-runtime",
    });
    await act(async () => result.current.refresh());
    expect(result.current.access?.bootId).toBe("boot");
    expect(result.current.live?.runtimeBootId).toBe("new-runtime");
    expect(result.current.notice).toBe("uncertain");
    expect(readPending(host.scope)).toHaveLength(1);
    host.sessions.push(summary("forked", agent));
    host.receipt.mockResolvedValue(acceptedReceipt(requestId));
    await act(async () => result.current.refresh());
    await expect(completion).resolves.toBeUndefined();
    expect(result.current.selected).toBe("original");
    expect(readPending(host.scope)).toEqual([]);
    expect(host.request).toHaveBeenCalledOnce();
  });

  it.each(["selection", "access-boot"] as const)(
    "does not restore late fork navigation after changing %s",
    async (change) => {
      const host = fixture();
      const { result } = await open(host);
      const { requestId, completion } = await startUnknown(host, result);
      if (change === "selection") {
        await act(async () => result.current.choose("other"));
        await act(async () => result.current.choose("original"));
      } else {
        const access = await host.client.access();
        vi.mocked(host.client.access).mockResolvedValue({ ...access, bootId: "new-boot" });
        await act(async () => result.current.refresh());
        await act(async () => result.current.choose("original"));
      }
      host.sessions.push(summary("forked", agent));
      host.receipt.mockResolvedValue(acceptedReceipt(requestId));
      await act(async () => result.current.refresh());
      await expect(completion).resolves.toBeUndefined();
      expect(result.current.selected).toBe("original");
      expect(host.request).toHaveBeenCalledOnce();
    },
  );
});

describe("a command button's message", () => {
  it("is sent on its own and leaves the draft as it is", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    // The device may attach files and context, so only the command rule stops those below.
    const approved = await host.client.access();
    vi.mocked(host.client.access).mockResolvedValue({
      ...approved,
      device: { ...approved.device!, attachments: true },
    });
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (sessionId) => ({
      sessionId,
      executionMode: "claude-managed",
      status: "idle",
      features: {
        fork: { available: true },
        attachments: { available: true },
        context: { available: true },
      },
    }));
    const { result } = await open(host);
    await act(async () => result.current.setMessage("Keep this draft"));
    await act(async () =>
      result.current.control("send", undefined, undefined, undefined, undefined, {
        command: "/compact",
      }),
    );
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({ sessionId: "original", text: "/compact" }),
    );
    expect(result.current.notice).toBe("accepted");
    expect(result.current.message).toBe("Keep this draft");
    host.request.mockClear();
    for (const extra of [
      { command: "compact" },
      { command: "/compact", attachmentIds: ["attachment"] },
      { command: "/compact", resourceIds: ["resource"] },
    ])
      await act(async () =>
        result.current.control("send", undefined, undefined, undefined, undefined, extra),
      );
    expect(host.request).not.toHaveBeenCalled();
  });
});

describe("a Claude settings change Claude Code refuses", () => {
  // The Service answers 400 with its own codes before the backend checks; the backend answers 409.
  it.each([
    [409, "unsupported-model", "claude-model-unsupported"],
    [409, "unsupported-effort", "claude-effort-unsupported"],
    [400, "unsupported_model", "claude-model-unsupported"],
    [400, "unsupported_effort", "claude-effort-unsupported"],
    [409, "session-busy", undefined],
  ] as const)("is explained (%i %s) with Claude's own reason", async (status, code, reason) => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (sessionId) => ({
      sessionId,
      executionMode: "claude-managed",
      status: "idle",
      features: { fork: { available: true }, settings: { available: true } },
    }));
    const { result } = await open(host);
    host.request.mockRejectedValueOnce(new ApiError(status, code, "not-dispatched"));
    await act(async () => result.current.codexAction("settings", { model: "no-such-model" }));
    expect(host.request).toHaveBeenCalledWith(
      "managed/action",
      expect.objectContaining({ operation: "settings", model: "no-such-model" }),
    );
    expect(result.current.notice).toBe("notDispatched");
    expect(result.current.noticeReason).toBe(reason);
  });
});
