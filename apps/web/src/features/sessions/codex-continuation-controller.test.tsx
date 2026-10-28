import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Live,
  type ResolvedHistoryReference,
} from "@agentkib/web-client";
import { useSessionController } from "@/features/conversation/features/sessions/use-session-controller";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import { sessionDisplayState } from "@/features/conversation/features/sessions/session-display-state";
import {
  pendingScope,
  readPending,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";

vi.mock("@/features/conversation/features/preferences/use-appearance", () => ({
  useAppearance: () => {},
}));
vi.mock("@/features/conversation/features/sessions/use-session-live", () => ({
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

describe("stable capability observation", () => {
  it.each(["fork", "settings", "rename"] as const)(
    "checks current host capabilities before %s after the display read has settled",
    async (action) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const capabilities = (available: boolean) => ({
        sessionId: "original",
        status: "idle",
        executionMode: "codex-managed",
        features: {
          fork: { available, reason: available ? undefined : "permission_denied" },
          settings: { available, reason: available ? undefined : "permission_denied" },
          rename: { available, reason: available ? undefined : "permission_denied" },
        },
      });
      vi.mocked(host.client.sessionCapabilities).mockResolvedValue(capabilities(true));
      const { result } = await open(host);
      const reads = vi.mocked(host.client.sessionCapabilities).mock.calls.length;
      vi.mocked(host.client.sessionCapabilities).mockResolvedValue(capabilities(false));
      await act(async () => result.current.codexAction(action, { name: "new name" }));
      expect(host.request).not.toHaveBeenCalled();
      expect(host.client.sessionCapabilities).toHaveBeenCalledTimes(reads + 1);
      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.settingsChangedHere).toBe(false);
    },
  );

  it("preserves an existing unknown receipt while attachment authorization is rechecked", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const caps = (sessionId: string) => ({
      sessionId,
      status: "idle",
      executionMode: "codex-managed",
      features: { fork: { available: true }, attachments: { available: true } },
    });
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (id) => caps(id));
    const access = await host.client.access();
    vi.mocked(host.client.access).mockResolvedValue({
      ...access,
      device: { ...access.device!, attachments: true },
    });
    const { result } = await open(host);
    await act(async () => result.current.setMessage("with an attachment"));
    let finish!: (value: ReturnType<typeof caps>) => void;
    vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => result.current.refresh(true));
    let sending!: Promise<unknown>;
    act(() => {
      sending = result.current.control("send", undefined, undefined, undefined, undefined, {
        attachmentIds: ["synthetic-file"],
      });
    });
    const requestId = crypto.randomUUID();
    rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
    host.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "original",
      operation: "send",
      status: "unknown",
      completionObserved: false,
    });
    await act(async () => result.current.refresh());
    await act(async () => finish(caps("original")));
    await sending;
    expect(result.current.notice).toBe("uncertain");
    expect(host.request).not.toHaveBeenCalled();
    expect(readPending(host.scope)).toHaveLength(1);
  });

  it("preserves a reconciled unknown outcome while a fork is waiting for its read", async () => {
    const host = baseFixture(baseOccupied("original"), "codex");
    const { result } = await open(host);
    let finish!: (value: Awaited<ReturnType<WebClient["sessionCapabilities"]>>) => void;
    vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => result.current.refresh(true));
    let forking!: Promise<string | undefined>;
    act(() => {
      forking = result.current.forkContinuation();
    });
    const requestId = crypto.randomUUID();
    rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
    host.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "original",
      operation: "send",
      status: "unknown",
      completionObserved: false,
    });
    await act(async () => result.current.refresh());
    expect(result.current.notice).toBe("uncertain");
    await act(async () =>
      finish({
        sessionId: "original",
        status: "idle",
        executionMode: "codex-managed",
        features: { fork: { available: true } },
      }),
    );
    await forking;
    expect(result.current.notice).toBe("uncertain");
    expect(result.current.actionUnavailableReason).toBeUndefined();
    expect(host.request).not.toHaveBeenCalled();
    expect(readPending(host.scope)).toHaveLength(1);
  });

  it.each(["selection", "boot"] as const)(
    "discards a late capability read after %s changes",
    async (change) => {
      const host = baseFixture(baseOccupied("original"), "codex");
      const { result } = await open(host);
      let finish!: (value: Awaited<ReturnType<WebClient["sessionCapabilities"]>>) => void;
      vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await act(async () => result.current.refresh(true));
      if (change === "selection") await act(async () => result.current.choose("other"));
      else {
        const access = await host.client.access();
        vi.mocked(host.client.access).mockResolvedValue({ ...access, bootId: "replacement-boot" });
        await act(async () => result.current.refresh());
      }
      await act(async () =>
        finish({
          sessionId: "original",
          status: "idle",
          executionMode: "codex-managed",
          features: { fork: { available: true } },
        }),
      );
      expect(result.current.capabilities?.sessionId).not.toBe("original");
      expect(result.current.settingsChangedHere).toBe(false);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it("does not offer or recheck a fork while the native outcome is unknown", async () => {
    const host = baseFixture(
      {
        ...baseOccupied("original"),
        status: "outcome-unknown",
        reason: "control-outcome-unconfirmed",
      },
      "codex",
    );
    const { result } = await open(host);
    const reads = vi.mocked(host.client.catalog).mock.calls.length;
    expect(result.current.forkCheckAvailable).toBe(false);
    await act(async () => result.current.forkContinuation());
    expect(host.request).not.toHaveBeenCalled();
    expect(host.client.catalog).toHaveBeenCalledTimes(reads);
  });

  it("keeps a terminal follower's read-only presentation through a turn boundary", async () => {
    const initial: Live = {
      ...baseIdle("original", "claude-code"),
      executionMode: "claude-follower",
      executionLocation: "terminal",
      sendEnabled: false,
      terminalSend: false,
    };
    const host = baseFixture(initial, "claude-code");
    const { result } = await open(host);
    let finish!: (value: Awaited<ReturnType<WebClient["sessionCapabilities"]>>) => void;
    vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    host.liveById.set("original", { ...initial, status: "running", turnId: "native-turn" });
    await act(async () => result.current.refresh());
    expect(sessionDisplayState(result.current).continuation).toBe("terminal-watch");
    expect(result.current.canSend).toBe(false);
    await act(async () =>
      finish({
        sessionId: "original",
        status: "running",
        executionMode: "claude-follower",
        features: { fork: { available: true } },
      }),
    );
  });

  it("scopes actual settings intent to this page binding", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (sessionId) => ({
      sessionId,
      status: "idle",
      executionMode: "codex-managed",
      features: { settings: { available: true }, fork: { available: true } },
    }));
    const { result } = await open(host);
    expect(result.current.settingsChangedHere).toBe(false);
    await act(async () => result.current.codexAction("settings", { effort: "low" }));
    expect(result.current.settingsChangedHere).toBe(true);
    await act(async () => result.current.choose("other"));
    expect(result.current.settingsChangedHere).toBe(false);
    await act(async () => result.current.choose("original"));
    expect(result.current.settingsChangedHere).toBe(false);
  });
  it("keeps the fork check entry during occupancy polling and waits for that read", async () => {
    const host = baseFixture(baseOccupied("original"), "codex");
    const { result } = await open(host);
    let finish!: (value: Live) => void;
    host.live.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let checking!: Promise<void>;
    act(() => {
      checking = result.current.checkContinuation();
    });
    await act(async () => {});
    expect(result.current.forkCheckAvailable).toBe(true);
    let forking!: Promise<string | undefined>;
    act(() => {
      forking = result.current.forkContinuation();
    });
    expect(host.request).not.toHaveBeenCalled();
    await act(async () => finish(baseOccupied("original")));
    await act(async () => {
      await checking;
      await forking;
    });
    expect(host.request).toHaveBeenCalledOnce();
  });

  it("refreshes list metadata after a different session's catalog invalidation", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const { result } = await open(host);
    host.sessions[1] = {
      ...host.sessions[1],
      title: "Newest native turn",
      updated_at: "2026-10-20T03:00:00Z",
    };
    await act(async () => publishSessionInvalidation(host.client, "other", ["catalog"]));
    expect(result.current.sessions.find((item) => item.id === "other")?.title).toBe(
      "Newest native turn",
    );
  });

  it("retains the current binding while a read is pending and waits before forking", async () => {
    const host = baseFixture(baseOccupied("original"), "codex");
    const { result } = await open(host);
    let finish!: (value: Awaited<ReturnType<WebClient["sessionCapabilities"]>>) => void;
    vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => result.current.refresh(true));
    expect(result.current.capabilities?.features.fork?.available).toBe(true);
    let task!: Promise<string | undefined>;
    act(() => {
      task = result.current.forkContinuation();
    });
    expect(host.request).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        sessionId: "original",
        status: "idle",
        executionMode: "codex-managed",
        features: { fork: { available: false, reason: "permission_denied" } },
      }),
    );
    await task;
    expect(host.request).not.toHaveBeenCalled();
    expect(result.current.notice).toBe("notDispatched");
  });

  it("does not restore an old binding or dispatch after permission revocation", async () => {
    const host = baseFixture(baseOccupied("original"), "codex");
    const { result } = await open(host);
    let finish!: (value: Awaited<ReturnType<WebClient["sessionCapabilities"]>>) => void;
    vi.mocked(host.client.sessionCapabilities).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => result.current.refresh(true));
    vi.mocked(host.client.sessionCapabilities).mockResolvedValue({
      sessionId: "original",
      status: "idle",
      executionMode: "codex-managed",
      features: { fork: { available: false, reason: "permission_denied" } },
    });
    const granted = await host.client.access();
    vi.mocked(host.client.access).mockResolvedValue({
      ...granted,
      device: { ...granted.device!, manage: false },
    });
    await act(async () => result.current.refresh());
    await act(async () =>
      finish({
        sessionId: "original",
        status: "idle",
        executionMode: "codex-managed",
        features: { fork: { available: true } },
      }),
    );
    expect(result.current.capabilities?.features.fork?.available).toBe(false);
    await act(async () => result.current.forkContinuation());
    expect(host.request).not.toHaveBeenCalled();
  });
});

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Codex next-turn settings recovery", () => {
  it.each(["native-model-unconfirmed", "native-effort-unconfirmed"] as const)(
    "retains a definite fork rejection's source-settings reason: %s",
    async (reason) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const { result } = await open(host);
      await act(async () => result.current.setMessage("Keep source draft"));
      host.request.mockRejectedValueOnce(new ApiError(409, reason, "not-dispatched"));
      await act(async () => result.current.forkContinuation());
      expect(result.current.selected).toBe("original");
      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.noticeReason).toBe(reason);
      expect(result.current.message).toBe("Keep source draft");
      expect(readPending(host.scope)).toEqual([]);
      expect(host.request).toHaveBeenCalledOnce();
    },
  );
  it.each(["unsupported-model", "unsupported-effort"] as const)(
    "keeps the draft and exposes the explicit %s rejection until the next request",
    async (reason) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const { result } = await open(host);
      await act(async () => result.current.setMessage("  Keep model recovery draft  "));
      host.request.mockRejectedValueOnce(new ApiError(409, reason, "not-dispatched"));

      await act(async () => result.current.control("send"));

      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.noticeReason).toBe(reason);
      expect(result.current.message).toBe("  Keep model recovery draft  ");
      expect(readPending(host.scope)).toEqual([]);
      expect(host.request).toHaveBeenCalledOnce();
      let finish!: (value: { accepted: true }) => void;
      host.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let sending!: Promise<boolean | undefined>;
      await act(async () => {
        sending = result.current.control("send");
      });
      expect(result.current.noticeReason).toBeUndefined();
      await act(async () => finish({ accepted: true }));
      await sending;
      expect(result.current.noticeReason).toBeUndefined();
    },
  );

  it("clears a recoverable reason after changing sessions or losing access", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const { result } = await open(host);
    await act(async () => result.current.setMessage("Draft"));
    host.request.mockRejectedValueOnce(new ApiError(409, "unsupported-model", "not-dispatched"));
    await act(async () => result.current.control("send"));
    expect(result.current.noticeReason).toBe("unsupported-model");
    await act(async () => result.current.choose("other"));
    expect(result.current.noticeReason).toBeUndefined();
    await act(async () => result.current.setMessage("Another draft"));
    host.request.mockRejectedValueOnce(new ApiError(409, "unsupported-effort", "not-dispatched"));
    await act(async () => result.current.control("send"));
    expect(result.current.noticeReason).toBe("unsupported-effort");
    vi.mocked(host.client.access).mockRejectedValueOnce(new Error("offline"));
    await act(async () => result.current.refresh());
    expect(result.current.online).toBe(false);
    expect(result.current.noticeReason).toBeUndefined();
  });

  it.each(["reason", "error"] as const)(
    "recovers a matching not-dispatched receipt's ack.%s",
    async (field) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const { result } = await open(host);
      const requestId = crypto.randomUUID();
      rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
      host.receipt.mockResolvedValue({
        found: true,
        requestId,
        sessionId: "original",
        operation: "send",
        status: "not-dispatched",
        completionObserved: false,
        ack: { [field]: "unsupported-model" },
      });
      await act(async () => result.current.refresh());
      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.noticeReason).toBe("unsupported-model");
      expect(readPending(host.scope)).toEqual([]);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "wrong-session", "wrong-operation"])(
    "keeps a %s receipt fenced despite its model error",
    async (variant) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const requestId = crypto.randomUUID();
      rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
      host.receipt.mockResolvedValue({
        found: true,
        requestId,
        sessionId: variant === "wrong-session" ? "other" : "original",
        operation: variant === "wrong-operation" ? "stop" : "send",
        status: variant === "unknown" ? "unknown" : "not-dispatched",
        completionObserved: false,
        ack: { error: "unsupported-model" },
      });
      const { result } = await open(host);
      expect(result.current.notice).toBe("uncertain");
      expect(result.current.noticeReason).toBeUndefined();
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([expect.objectContaining({ requestId })]);
      expect(host.request).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "claude-code"] as const)(
    "does not advertise model recovery for an uncertain %s request",
    async (agent) => {
      const host = baseFixture(baseIdle("original", agent), agent);
      const { result } = await open(host);
      await act(async () => result.current.setMessage("Uncertain draft"));
      host.request.mockRejectedValueOnce(new ApiError(409, "unsupported-model", "unknown"));
      await act(async () => result.current.control("send"));
      expect(result.current.notice).toBe("uncertain");
      expect(result.current.noticeReason).toBeUndefined();
      expect(readPending(host.scope)).toHaveLength(1);
      expect(result.current.message).toBe("Uncertain draft");
    },
  );

  it("keeps Claude not-dispatched errors out of Codex recovery", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    const { result } = await open(host);
    await act(async () => result.current.setMessage("Claude draft"));
    host.request.mockRejectedValueOnce(new ApiError(409, "session-busy", "not-dispatched"));
    await act(async () => result.current.control("send"));
    expect(result.current.notice).toBe("notDispatched");
    expect(result.current.noticeReason).toBeUndefined();
  });

  // The Service answers 400 with its own codes before the backend checks; the backend answers 409.
  it.each([
    [409, "unsupported-model", "claude-model-unsupported"],
    [409, "unsupported-effort", "claude-effort-unsupported"],
    [400, "unsupported_model", "claude-model-unsupported"],
    [400, "unsupported_effort", "claude-effort-unsupported"],
  ] as const)(
    "names a Claude settings change refused (%i %s) with Claude's own reason",
    async (status, code, reason) => {
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
    },
  );

  it("sends a command button's message and leaves the draft and quotes as they are", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    // Quotes survive the refresh after a send only while history search stays granted. The
    // device may attach files and context, so only the command rule stops those below.
    const approved = await host.client.access();
    vi.mocked(host.client.access).mockResolvedValue({
      ...approved,
      historySearch: true,
      historySearchScope: "quotes",
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
    const reference: ResolvedHistoryReference = {
      reference: {
        sessionId: "original",
        recordId: "record",
        chunkId: "chunk",
        sourceRevision: "revision",
        start: 0,
        end: 5,
        contentHash: "hash",
      },
      title: "Quoted history",
      agent: "claude-code",
      kind: "assistant",
      toolName: null,
      content: "quote",
    };
    await act(async () => {
      result.current.setMessage("Keep this draft");
      result.current.setHistoryReferences([reference]);
    });
    await act(async () =>
      result.current.control("send", undefined, undefined, undefined, undefined, {
        command: "/compact",
      }),
    );
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({ sessionId: "original", text: "/compact" }),
    );
    expect(host.request.mock.lastCall?.[1]).not.toHaveProperty("historyReferences");
    expect(result.current.notice).toBe("accepted");
    expect(result.current.message).toBe("Keep this draft");
    expect(result.current.historyReferences).toEqual([reference]);
    // Only a slash command, with nothing attached, goes this way.
    host.request.mockClear();
    for (const extra of [
      { command: "hello" },
      { command: "/compact", attachmentIds: ["attachment"] },
      { command: "/compact", resourceIds: ["resource"] },
    ])
      await act(async () =>
        result.current.control("send", undefined, undefined, undefined, undefined, extra),
      );
    expect(host.request).not.toHaveBeenCalled();
  });

  it("sends a message AgentKib wrote for a Codex command in place of the draft", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    // The device may attach files and context, so only the message rule stops those below.
    const approved = await host.client.access();
    vi.mocked(host.client.access).mockResolvedValue({
      ...approved,
      historySearch: true,
      historySearchScope: "quotes",
      device: { ...approved.device!, attachments: true },
    });
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (sessionId) => ({
      sessionId,
      executionMode: "codex-managed",
      status: "idle",
      features: {
        fork: { available: true },
        attachments: { available: true },
        context: { available: true },
      },
    }));
    const { result } = await open(host);
    const reference: ResolvedHistoryReference = {
      reference: {
        sessionId: "original",
        recordId: "record",
        chunkId: "chunk",
        sourceRevision: "revision",
        start: 0,
        end: 5,
        contentHash: "hash",
      },
      title: "Quoted history",
      agent: "codex",
      kind: "assistant",
      toolName: null,
      content: "quote",
    };
    await act(async () => {
      result.current.setMessage("/review");
      result.current.setHistoryReferences([reference]);
    });
    expect(result.current.historyReferences).toEqual([reference]);
    await act(async () =>
      result.current.control("send", undefined, undefined, undefined, undefined, {
        prompt: "Review the uncommitted changes.",
      }),
    );
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({ sessionId: "original", text: "Review the uncommitted changes." }),
    );
    expect(host.request.mock.lastCall?.[1]).not.toHaveProperty("historyReferences");
    expect(result.current.notice).toBe("accepted");
    expect(result.current.message).toBe("");
    host.request.mockClear();
    for (const extra of [
      { prompt: " " },
      { prompt: "Review", attachmentIds: ["attachment"] },
      { prompt: "Review", resourceIds: ["resource"] },
    ])
      await act(async () =>
        result.current.control("send", undefined, undefined, undefined, undefined, extra),
      );
    expect(host.request).not.toHaveBeenCalled();
  });

  it("names the slash-command rule the host refused a Claude message with", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    const { result } = await open(host);
    await act(async () => result.current.setMessage("/fixture-new"));
    host.request.mockRejectedValueOnce(
      new ApiError(409, "claude-command-owner-only", "not-dispatched"),
    );
    await act(async () => result.current.control("send"));
    expect(result.current.notice).toBe("notDispatched");
    expect(result.current.noticeReason).toBe("claude-command-owner-only");
    expect(result.current.message).toBe("/fixture-new");
    expect(readPending(host.scope)).toEqual([]);
    // Codex never receives these codes; they stay out of its recovery.
    const codex = baseFixture(baseIdle("original"), "codex");
    const other = await open(codex);
    await act(async () => other.result.current.setMessage("Draft"));
    codex.request.mockRejectedValueOnce(
      new ApiError(409, "claude-command-owner-only", "not-dispatched"),
    );
    await act(async () => other.result.current.control("send"));
    expect(other.result.current.noticeReason).toBeUndefined();
  });
});

describe.each(["codex", "claude-code"] as const)(
  "%s continuation in the production controller",
  (agent) => {
    const idle = (id: string) => baseIdle(id, agent);
    const occupied = (id: string) => baseOccupied(id, agent);
    const fixture = (initial = idle("original")) => baseFixture(initial, agent);
    const ownerReason = agent === "codex" ? "codex-owner-busy" : "claude-owner-busy";
    it("shows the pending first message while the host starts and clears it only after acceptance", async () => {
      const host = fixture();
      const { result } = await open(host);
      await act(async () => result.current.setMessage("First continued message"));
      let accept!: (value: { accepted: true }) => void;
      host.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      let sending!: Promise<boolean | undefined>;
      await act(async () => {
        sending = result.current.control("send");
      });
      expect(result.current.pendingSend).toMatchObject({
        sessionId: "original",
        text: "First continued message",
      });
      expect(result.current.message).toBe("First continued message");
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([
        expect.objectContaining({ sessionId: "original", kind: "send" }),
      ]);
      await act(async () => accept({ accepted: true }));
      await expect(sending).resolves.toBe(true);
      expect(result.current.pendingSend).toBeUndefined();
      expect(result.current.message).toBe("");
      expect(readPending(host.scope)).toEqual([]);
      expect(host.request).toHaveBeenCalledOnce();
    });
    it("preserves a rejected draft and clears its receipt after a not-dispatched writer conflict", async () => {
      const host = fixture();
      const { result } = await open(host);
      await act(async () => result.current.setMessage("  Keep this draft  "));
      host.request.mockImplementation(async (path) => {
        expect(path).toBe("send");
        expect(readPending(host.scope)).toEqual([
          expect.objectContaining({ sessionId: "original", kind: "send" }),
        ]);
        host.liveById.set("original", occupied("original"));
        throw new ApiError(409, ownerReason, "not-dispatched");
      });

      await act(async () => result.current.control("send"));

      expect(host.request).toHaveBeenCalledExactlyOnceWith(
        "send",
        expect.objectContaining({ sessionId: "original", text: "Keep this draft" }),
      );
      expect(result.current.message).toBe("  Keep this draft  ");
      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.pendingSend).toBeUndefined();
      expect(result.current.live?.ownershipReason).toBe(ownerReason);
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([]);
    });

    it("checks an occupied session every four seconds and restores sending when its owner leaves", async () => {
      vi.useFakeTimers();
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      expect(result.current.canSend).toBe(false);
      host.live.mockClear();
      host.liveById.set("original", idle("original"));

      await act(async () => vi.advanceTimersByTimeAsync(3999));
      expect(host.live).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));

      expect(host.live).toHaveBeenCalledExactlyOnceWith("original");
      expect(result.current.live?.ownershipReason).not.toBe(ownerReason);
      expect(result.current.canSend).toBe(true);
      expect(host.request).not.toHaveBeenCalled();
    });

    it("checks the new selection while an older session's occupancy read is still pending", async () => {
      const host = fixture(occupied("original"));
      host.liveById.set("other", occupied("other"));
      const { result } = await open(host);
      let finishOldRead!: (state: Live) => void;
      host.live.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = resolve;
          }),
      );
      let oldCheck!: Promise<void>;
      await act(async () => {
        oldCheck = result.current.checkContinuation();
      });
      expect(host.live).toHaveBeenLastCalledWith("original");
      await act(async () => result.current.choose("other"));
      expect(result.current.canSend).toBe(false);
      host.live.mockClear();
      host.liveById.set("other", idle("other"));

      await act(async () => result.current.checkContinuation());

      expect(host.live).toHaveBeenCalledExactlyOnceWith("other");
      expect(result.current.canSend).toBe(true);
      await act(async () => finishOldRead(occupied("original")));
      await oldCheck;
      expect(result.current.selected).toBe("other");
      expect(result.current.live?.sessionId).toBe("other");
      expect(result.current.canSend).toBe(true);
    });

    it("forks with the original draft and preserves edits made while the new branch loads", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      let finishHistory!: (page: ConversationEventPage) => void;
      host.events.mockImplementation(async (id) =>
        id === "forked"
          ? new Promise((resolve) => {
              finishHistory = resolve;
            })
          : history,
      );
      await act(async () => result.current.setMessage("  Original draft A  "));
      let completion!: Promise<string | undefined>;
      await act(async () => {
        completion = result.current.forkContinuation();
      });
      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("  Original draft A  ");
      expect(host.request).toHaveBeenCalledExactlyOnceWith(
        agent === "codex" ? "codex/fork" : "managed/action",
        expect.objectContaining({ sessionId: "original", requestId: expect.any(String) }),
      );
      await act(async () => result.current.setMessage("New branch draft B"));
      await act(async () => finishHistory(history));
      await expect(completion).resolves.toBe("forked");
      expect(result.current.message).toBe("New branch draft B");
      expect(readPending(host.scope)).toEqual([]);
    });

    it("transfers quoted history and file drafts once with the selected branch generation", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      const reference: ResolvedHistoryReference = {
        reference: {
          sessionId: "original",
          recordId: "record",
          chunkId: "chunk",
          sourceRevision: "revision",
          start: 0,
          end: 5,
          contentHash: "hash",
        },
        title: "Quoted history",
        agent,
        kind: "assistant",
        toolName: null,
        content: "quote",
      };
      const file = new File(["private draft"], "draft.txt");
      await act(async () => {
        result.current.setHistoryReferences([reference]);
        result.current.setMessage("");
      });
      await act(async () =>
        result.current.forkContinuation({
          files: [file],
          resources: [{ id: "source-only", name: "README", kind: "file", available: true }],
        }),
      );
      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("");
      expect(result.current.historyReferences).toEqual([reference]);
      expect(result.current.takeContinuationDraft("other")).toBeUndefined();
      const restored = result.current.takeContinuationDraft("forked");
      expect(restored?.files).toEqual([file]);
      expect(restored?.historyReferences).toEqual([reference]);
      expect(result.current.takeContinuationDraft("forked")).toBeUndefined();
      expect(host.request).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(host.scope) ?? "").not.toContain("private draft");
    });
    it("discards an unconsumed bundle when navigating away instead of restoring it on a later visit", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      const file = new File(["draft"], "old.txt");
      await act(async () => result.current.forkContinuation({ files: [file], resources: [] }));
      await act(async () => result.current.choose("other"));
      await act(async () => result.current.choose("forked"));
      expect(result.current.takeContinuationDraft("forked")).toBeUndefined();
    });
    it("navigates before branch reads and preserves a later visit while the first read settles", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      let finishFirstRead!: (page: ConversationEventPage) => void;
      let branchReads = 0;
      host.events.mockImplementation(async (id) =>
        id === "forked" && ++branchReads === 1
          ? new Promise((resolve) => {
              finishFirstRead = resolve;
            })
          : history,
      );
      await act(async () => result.current.setMessage("Original draft A"));
      let completion!: Promise<string | undefined>;
      await act(async () => {
        completion = result.current.forkContinuation();
      });
      expect(result.current.selected).toBe("forked");
      await expect(completion).resolves.toBe("forked");
      await act(async () => result.current.choose("other"));
      await act(async () => result.current.choose("forked"));
      await act(async () => result.current.setMessage("New selection draft B"));
      await act(async () => finishFirstRead(history));

      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("New selection draft B");
      expect(host.request).toHaveBeenCalledOnce();
    });

    it("keeps an unknown request fenced when checking occupancy or requesting a fork", async () => {
      const host = fixture(occupied("original"));
      const requestId = crypto.randomUUID();
      rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
      const { result } = await open(host);
      await act(async () => result.current.setMessage("Keep the fenced draft"));
      host.live.mockClear();

      await act(async () => result.current.checkContinuation());
      await act(async () => result.current.forkContinuation());

      expect(host.receipt).toHaveBeenCalledWith(requestId);
      expect(host.live).not.toHaveBeenCalled();
      expect(host.request).not.toHaveBeenCalled();
      expect(result.current.selected).toBe("original");
      expect(result.current.message).toBe("Keep the fenced draft");
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([
        expect.objectContaining({ requestId, sessionId: "original", kind: "send" }),
      ]);
    });
  },
);

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
