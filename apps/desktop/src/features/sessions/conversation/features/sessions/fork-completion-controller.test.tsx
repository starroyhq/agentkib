// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Live,
  type ResolvedHistoryReference,
  type SessionActionBody,
  type SessionActionResult,
} from "@agentkib/web-client";
import { useSessionController } from "@/features/sessions/conversation/desktop-session-controller";
import { pendingScope, readPending } from "@agentkib/session-ui";
import { publishSessionInvalidation } from "@agentkib/conversation-state";

vi.mock(
  "../../../../../../../../packages/session-ui/src/conversation/preferences/use-appearance",
  () => ({ useAppearance: () => {} }),
);
vi.mock(
  "../../../../../../../../packages/session-ui/src/conversation/sessions/use-session-live",
  () => ({
    useSessionLive: ({
      client,
      selected,
      streamReady,
      refreshRequired,
      setControlReady,
      readSettingsControls,
      setLive,
    }: {
      client: WebClient;
      selected: string;
      streamReady: { current: boolean };
      refreshRequired: { current: boolean };
      setControlReady: (ready: boolean) => void;
      readSettingsControls: { current: ((sessionId: string) => Promise<void>) | undefined };
      setLive: (live: Live) => void;
    }) => {
      useEffect(() => {
        streamReady.current = !!selected;
        setControlReady(!!selected && !refreshRequired.current);
      }, [selected, streamReady, refreshRequired, setControlReady]);
      useEffect(() => {
        let mounted = true;
        readSettingsControls.current = async (sessionId) => {
          if (sessionId !== selected) return;
          const live = await client.live(sessionId);
          if (!mounted) return;
          setLive(live);
          setControlReady(
            streamReady.current && !refreshRequired.current && live.status !== "outcome-unknown",
          );
        };
        return () => {
          mounted = false;
          readSettingsControls.current = undefined;
        };
      }, [
        client,
        selected,
        streamReady,
        refreshRequired,
        setControlReady,
        readSettingsControls,
        setLive,
      ]);
    },
  }),
);

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
  const request = vi.spyOn(client, "request").mockImplementation(async (path, body) => {
    if (path === "managed/action" && (body as { operation?: unknown })?.operation === "fork") {
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

describe("catalog refresh source authority", () => {
  it("does not retain the old workspace row when a global session moves during a partial refresh", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const view = await open(host);
    const moved = { ...host.sessions[0], workspace_id: "new-workspace" };
    vi.mocked(host.client.catalog).mockResolvedValue({
      indexEnabled: true,
      sessions: [moved],
      complete: false,
      incompleteSources: [{ workspaceId: "workspace", agent: "codex" }],
    });
    await act(async () => view.result.current.refresh(true, true));
    expect(view.result.current.sessions.filter((record) => record.id === "original")).toEqual([
      moved,
    ]);
    expect(view.result.current.selected).toBe("original");
  });

  it("uses verified managed aliases instead of retaining native ghost rows from a partial source", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const view = await open(host);
    const managed = { ...summary("managed"), indexedSessionIds: ["original", "other"] };
    vi.mocked(host.client.catalog).mockResolvedValue({
      indexEnabled: true,
      sessions: [managed],
      complete: false,
      incompleteSources: [{ workspaceId: "workspace", agent: "codex" }],
    });
    await act(async () => view.result.current.refresh(true, true));
    expect(view.result.current.sessions).toEqual([managed]);
    expect(readPending(host.scope)).toEqual([]);
  });

  it("keeps the selected managed owner without adding its temporarily exposed native alias", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    host.sessions[0] = { ...host.sessions[0], indexedSessionIds: ["native"] };
    const view = await open(host);
    const previous = view.result.current.sessions;
    vi.mocked(host.client.catalog).mockResolvedValue({
      indexEnabled: true,
      sessions: [summary("native")],
      complete: false,
      incompleteSources: [{ workspaceId: "workspace", agent: "codex" }],
    });
    await act(async () => view.result.current.refresh(true, true));
    expect(view.result.current.sessions).toEqual(previous);
    expect(view.result.current.sessions[0]).toBe(previous[0]);
    expect(view.result.current.selected).toBe("original");
    expect(view.result.current.page).toBeDefined();
  });

  it("keeps the selected incomplete source and accepts deletions from a completed source", async () => {
    const host = baseFixture(baseIdle("original", "claude-code"), "claude-code");
    host.sessions[1] = summary("other", "codex");
    const view = await open(host);
    const selected = view.result.current.sessions.find((record) => record.id === "original");
    vi.mocked(host.client.catalog).mockResolvedValue({
      indexEnabled: true,
      sessions: [],
      complete: false,
      incompleteSources: [{ workspaceId: "workspace", agent: "claude-code" }],
    });
    await act(async () => view.result.current.refresh(true, true));
    expect(view.result.current.sessions).toEqual([selected]);
    expect(view.result.current.sessions[0]).toBe(selected);
    expect(view.result.current.selected).toBe("original");
    expect(view.result.current.page).toBeDefined();
    expect(host.request).not.toHaveBeenCalled();
    expect(readPending(host.scope)).toEqual([]);
  });

  it.each([undefined, []])(
    "retains unknown partial missing records (%s)",
    async (incompleteSources) => {
      const host = baseFixture(baseIdle("original"), "codex");
      const view = await open(host);
      const previous = view.result.current.sessions;
      vi.mocked(host.client.catalog).mockResolvedValue({
        indexEnabled: true,
        sessions: [],
        complete: false,
        incompleteSources,
      });
      await act(async () => view.result.current.refresh(true, true));
      expect(view.result.current.sessions).toEqual(previous);
      expect(view.result.current.sessions[0]).toBe(previous[0]);
      expect(view.result.current.selected).toBe("original");
    },
  );

  it("bounds stale catalog retries without adding business pending or removing current history", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const view = await open(host);
    vi.mocked(host.client.catalog)
      .mockClear()
      .mockRejectedValue(new ApiError(409, "catalog_stale"));
    await act(async () => view.result.current.refresh(true, true));
    expect(host.client.catalog).toHaveBeenCalledTimes(3);
    expect(view.result.current.selected).toBe("original");
    expect(view.result.current.page).toBeDefined();
    expect(view.result.current.error).toBe(false);
    expect(readPending(host.scope)).toEqual([]);
    expect(host.request).not.toHaveBeenCalled();
  });

  it("clears the reader when the index is explicitly disabled even if old records are available", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
    const view = await open(host);
    vi.mocked(host.client.catalog).mockResolvedValue({
      indexEnabled: false,
      sessions: [],
      complete: false,
    });
    await act(async () => view.result.current.refresh(true, true));
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.selected).toBe("");
    expect(view.result.current.page).toBeUndefined();
    expect(view.result.current.indexEnabled).toBe(false);
  });
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

describe("settings actions and their receipts", () => {
  function fixture(agent: "codex" | "claude-code", terminal = false) {
    const live: Live = {
      ...baseIdle("original", agent),
      ...(terminal ? { executionMode: "claude-follower" } : {}),
      runtimeBootId: "runtime",
    };
    const host = baseFixture(live, agent);
    vi.mocked(host.client.sessionCapabilities).mockImplementation(async (sessionId) => ({
      sessionId,
      executionMode: live.executionMode!,
      status: "idle",
      features: {
        fork: { available: true },
        settings: { available: !terminal },
        "open-model-picker": { available: terminal },
      },
    }));
    return { ...host, updated: () => host.liveById.set("original", { ...live, revision: 2 }) };
  }

  const ack = (requestId: string) => ({
    accepted: true,
    completed: true,
    requestId,
    sessionId: "original",
    runtimeBootId: "runtime",
  });

  it.each([
    ["codex", "settings"],
    ["claude-code", "settings"],
    ["claude-code", "open-model-picker"],
  ] as const)("does one scoped read after an acknowledged %s %s request", async (agent, action) => {
    const host = fixture(agent, action === "open-model-picker");
    const { result } = await open(host);
    act(() => result.current.setMessage("Keep this draft"));
    host.live.mockClear();
    host.events.mockClear();
    vi.mocked(host.client.catalog).mockClear();
    let finish!: (result: SessionActionResult) => void;
    host.request.mockImplementationOnce(async () => new Promise((resolve) => (finish = resolve)));
    let save!: ReturnType<typeof result.current.runSessionAction>;
    const change =
      action === "open-model-picker"
        ? {}
        : agent === "codex"
          ? { serviceTierId: "priority" }
          : { model: "sonnet" };
    await act(async () => {
      save = result.current.runSessionAction(action, change);
    });
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      "managed/action",
      expect.objectContaining({
        ...change,
        agent,
        operation: action,
        sessionId: "original",
        expectedRevision: 1,
      }),
    );
    const { requestId } = host.request.mock.calls[0]![1] as SessionActionBody;
    expect(readPending(host.scope)).toMatchObject([
      { requestId, sessionId: "original", kind: action },
    ]);
    expect(result.current.canSend).toBe(false);
    expect(result.current.busy).toBe(false);
    await act(async () => publishSessionInvalidation(host.client, "original", ["receipts"]));
    expect(host.receipt).not.toHaveBeenCalled();
    expect(result.current.notice).toBeUndefined();
    expect(host.live).not.toHaveBeenCalled();

    host.updated();
    await act(async () => {
      finish(ack(requestId));
      await expect(save).resolves.toMatchObject(ack(requestId));
    });
    expect(host.live).toHaveBeenCalledExactlyOnceWith("original");
    expect(host.events).not.toHaveBeenCalled();
    expect(host.client.catalog).not.toHaveBeenCalled();
    expect(host.receipt).not.toHaveBeenCalled();
    expect(readPending(host.scope)).toEqual([]);
    expect(result.current.live?.revision).toBe(2);
    expect(result.current.message).toBe("Keep this draft");
    expect(result.current.canSend).toBe(true);
    expect(host.request).toHaveBeenCalledOnce();
  });

  it.each(["sending", "stopping"] as const)(
    "keeps %s locked when returning to the session before settings readback settles",
    async (operation) => {
      const host = fixture("codex");
      const { result } = await open(host);
      host.live.mockClear();
      const original = {
        ...host.liveById.get("original")!,
        revision: 2,
        ...(operation === "stopping" && {
          status: "running" as const,
          sendEnabled: false,
          stopEnabled: true,
          turnId: "current-turn",
        }),
      };
      host.liveById.set("original", original);
      let finishReadback!: (value: Live) => void;
      host.live.mockImplementationOnce(
        () => new Promise<Live>((resolve) => (finishReadback = resolve)),
      );
      host.request.mockImplementationOnce(async (_path, body) =>
        ack((body as SessionActionBody).requestId),
      );

      let save!: ReturnType<typeof result.current.runSessionAction>;
      await act(async () => {
        save = result.current.runSessionAction("settings", { effort: "high" });
      });
      expect(host.live).toHaveBeenCalledExactlyOnceWith("original");
      expect(readPending(host.scope)).toEqual([]);

      await act(async () => result.current.choose("other"));
      expect(result.current.canSend).toBe(true);
      await act(async () => result.current.choose("original"));
      expect(result.current.controlReady).toBe(true);
      expect(result.current.settingsNotice).toBeUndefined();
      expect(result.current.canSend).toBe(false);
      expect(result.current.canStop).toBe(false);
      expect(result.current.settingsOnlyBlocked).toBe(true);

      await act(async () => result.current.runSessionAction("settings", { effort: "low" }));
      expect(host.request).toHaveBeenCalledOnce();

      await act(async () => {
        finishReadback(original);
        await expect(save).resolves.toBeUndefined();
      });
      expect(result.current.canSend).toBe(operation === "sending");
      expect(result.current.canStop).toBe(operation === "stopping");
      expect(result.current.settingsOnlyBlocked).toBe(false);
    },
  );

  it.each(["matching", "other revision", "other acknowledgement"] as const)(
    "checks a %s receipt when the settings response is lost",
    async (receiptKind) => {
      const host = fixture("codex");
      const { result } = await open(host);
      host.live.mockClear();
      host.events.mockClear();
      vi.mocked(host.client.catalog).mockClear();
      host.request.mockRejectedValueOnce(new ApiError(504, "outcome_unknown", "unknown"));
      host.receipt.mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "original",
        operation: "settings",
        runtimeBootId: "runtime",
        expectedRevision: receiptKind === "other revision" ? 2 : 1,
        status: "accepted",
        completionObserved: false,
        ack: ack(receiptKind === "other acknowledgement" ? crypto.randomUUID() : requestId),
      }));
      host.updated();
      let saved: SessionActionResult | undefined;
      await act(async () => {
        saved = await result.current.runSessionAction("settings", { effort: "high" });
      });
      const { requestId } = host.request.mock.calls[0]![1] as SessionActionBody;
      expect(host.request).toHaveBeenCalledOnce();
      expect(host.receipt).toHaveBeenCalledWith(requestId);
      expect(host.receipt.mock.calls.every(([id]) => id === requestId)).toBe(true);
      expect(host.live).toHaveBeenCalledExactlyOnceWith("original");
      expect(host.events).not.toHaveBeenCalled();
      expect(host.client.catalog).not.toHaveBeenCalled();
      if (receiptKind === "matching") {
        expect(saved).toMatchObject(ack(requestId));
        expect(result.current.notice).toBeUndefined();
        expect(readPending(host.scope)).toEqual([]);
        expect(result.current.canSend).toBe(true);
      } else {
        expect(saved).toBeUndefined();
        expect(result.current.notice).toBeUndefined();
        expect(result.current.settingsNotice).toEqual({ group: "model", status: "uncertain" });
        expect(readPending(host.scope)).toMatchObject([
          { requestId, sessionId: "original", kind: "settings" },
        ]);
        expect(result.current.canSend).toBe(true);
        expect(result.current.blocksOutcome("settings")).toBe(true);
      }
    },
  );

  it("keeps a policy receipt scoped to settings until it settles", async () => {
    const host = fixture("codex");
    const { result } = await open(host);
    act(() => result.current.setMessage("Keep this draft"));
    host.events.mockClear();
    vi.mocked(host.client.catalog).mockClear();
    host.request.mockRejectedValueOnce(new ApiError(504, "outcome_unknown", "unknown"));
    await act(async () =>
      result.current.runSessionAction("settings", { policyId: "full-access-on-request" }),
    );
    const { requestId } = host.request.mock.calls[0]![1] as SessionActionBody;
    expect(result.current.notice).toBeUndefined();
    expect(result.current.settingsNotice).toEqual({ group: "permissions", status: "uncertain" });
    expect(result.current.canSend).toBe(true);
    expect(result.current.blocksOutcome("settings")).toBe(true);
    expect(readPending(host.scope)).toMatchObject([{ requestId, kind: "settings" }]);

    host.updated();
    host.receipt.mockResolvedValueOnce({
      found: true,
      requestId,
      sessionId: "original",
      operation: "settings",
      runtimeBootId: "runtime",
      expectedRevision: 1,
      status: "accepted",
      completionObserved: false,
      ack: ack(requestId),
    });
    act(() => publishSessionInvalidation(host.client, "original", ["receipts"]));
    await waitFor(() => expect(result.current.blocksOutcome("settings")).toBe(false));
    expect(result.current.notice).toBeUndefined();
    expect(result.current.settingsNotice).toBeUndefined();
    expect(result.current.message).toBe("Keep this draft");
    expect(readPending(host.scope)).toEqual([]);
    expect(host.request).toHaveBeenCalledOnce();
    expect(host.events).not.toHaveBeenCalled();
    expect(host.client.catalog).not.toHaveBeenCalled();
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

describe.each(["codex", "claude-code"] as const)("a deleted %s session", (agent) => {
  it("leaves the catalog at once and is never read again", async () => {
    const host = baseFixture(baseIdle("original", agent), agent);
    vi.spyOn(host.client, "sessionCapabilities").mockImplementation(async (sessionId) => ({
      sessionId,
      executionMode: agent === "codex" ? "codex-managed" : "claude-managed",
      status: "idle",
      features: { fork: { available: true }, delete: { available: true } },
    }));
    const path = "managed/action";
    host.request.mockImplementation(async (requested) =>
      requested === path
        ? { accepted: true, completed: true, deleted: true, sessionId: "original" }
        : { accepted: true },
    );
    const view = await open(host);
    const liveReads = host.live.mock.calls.length;
    const historyReads = host.events.mock.calls.length;
    await act(async () => {
      await view.result.current.runSessionAction("delete");
    });
    expect(host.request).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        sessionId: "original",
        operation: "delete",
        agent,
      }),
    );
    expect(view.result.current.sessions.map((session) => session.id)).toEqual(["other"]);
    expect(view.result.current.excludedSessionIds.has("original")).toBe(true);
    await act(async () => {});
    expect(host.live.mock.calls.length).toBe(liveReads);
    expect(host.events.mock.calls.length).toBe(historyReads);
    expect(readPending(host.scope)).toEqual([]);
  });
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

describe("a message AgentKib wrote for a Codex command", () => {
  it("is sent in place of the draft, without its quotes, and clears it", async () => {
    const host = baseFixture(baseIdle("original"), "codex");
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
      result.current.setMessage("/init");
      result.current.setHistoryReferences([reference]);
    });
    expect(result.current.historyReferences).toEqual([reference]);
    await act(async () =>
      result.current.control("send", undefined, undefined, undefined, undefined, {
        prompt: "Write an AGENTS.md.",
      }),
    );
    expect(host.request).toHaveBeenCalledExactlyOnceWith(
      "send",
      expect.objectContaining({ sessionId: "original", text: "Write an AGENTS.md." }),
    );
    expect(host.request.mock.lastCall?.[1]).not.toHaveProperty("historyReferences");
    expect(result.current.notice).toBe("accepted");
    expect(result.current.message).toBe("");
    host.request.mockClear();
    for (const extra of [
      { prompt: "" },
      { prompt: "Write", attachmentIds: ["attachment"] },
      { prompt: "Write", resourceIds: ["resource"] },
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
    await act(async () => result.current.runSessionAction("settings", { model: "no-such-model" }));
    expect(host.request).toHaveBeenCalledWith(
      "managed/action",
      expect.objectContaining({ operation: "settings", model: "no-such-model" }),
    );
    expect(result.current.notice).toBeUndefined();
    expect(result.current.settingsNotice).toEqual({
      group: "model",
      status: "notDispatched",
      reason: reason ?? code,
    });
  });
});
