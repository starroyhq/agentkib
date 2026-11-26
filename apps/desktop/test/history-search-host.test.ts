// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { HISTORY_SEARCH_METHODS, type HistoryReference } from "@agentkib/runtime-protocol";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  openManagedLedger,
} from "../../../packages/backend/src/managed-ledger";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { WebAccessService, createWebControlState } from "../electron/main/web/service";
import { approveLegacyBrowser } from "../electron/main/web/legacy-pairing-fixture";
import { historyInputHash } from "../electron/main/web/history-references";
import { AttachmentStore } from "../electron/main/web/attachments";
import { RuntimeRequestError } from "../electron/main/runtime-host";

const reference: HistoryReference = {
  sessionId: "source",
  recordId: "record",
  chunkId: "chunk",
  sourceRevision: "revision",
  start: 0,
  end: 5,
  contentHash: "b".repeat(64),
};
const status = {
  enabled: false,
  generation: 0,
  bytes: 0,
  limitBytes: 1_000_000,
  budgetExceeded: false,
  coverage: {
    total: 0,
    ready: 0,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
};

describe("history search host authorization and frozen input", () => {
  let dir: string;
  let service: WebAccessService;
  let allowed: string[];
  let port: number;
  let cookie: string;
  let csrf: string;
  let bootId: string;
  let registered: boolean;
  let sourceRegistered: boolean;
  let sourceWorkspaceId: string;
  let sourceText: string;
  let targetAgent: string;
  let deviceId: string;
  let control: ReturnType<typeof createWebControlState>;
  const sent: Record<string, unknown>[] = [];
  const runtime = vi.fn(async (raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>;
    if (params.operation === "catalog")
      return {
        sessions: [
          {
            id: "target",
            workspace_id: "w",
            agent: targetAgent,
            indexedSessionIds: ["target-index"],
          },
          ...(sourceRegistered
            ? [{ id: "source", workspace_id: sourceWorkspaceId, agent: "cursor" }]
            : []),
          { id: "hidden", workspace_id: "other", agent: "codex" },
        ],
      };
    if (params.operation === "live")
      return {
        executionMode: targetAgent === "claude-code" ? "claude-managed" : "codex-managed",
        revision: 1,
        runtimeBootId: "runtime",
        workspaceId: "w",
        status: "running",
        sendEnabled: true,
        turnId: "turn",
      };
    if (params.operation === "capabilities")
      return {
        executionMode: "codex-managed",
        features: {
          steer: { available: true },
          "queue-add": { available: true },
          attachments: { available: true },
        },
      };
    if (["send", "steer", "queue-add"].includes(String(params.operation))) {
      sent.push(params);
      const requestId = String(params.requestId);
      claimManagedCommand(
        dir,
        requestId,
        String(params.sessionId),
        createHash("sha256").update(JSON.stringify(params)).digest("hex"),
        String(params.deviceId),
        {
          operation: params.operation,
          workspaceId: "w",
          expectedRevision: params.expectedRevision,
          historyInputHash: params.historyInputHash,
          executionMode: "codex-managed",
        },
      );
      dispatchManagedCommand(dir, requestId);
      const ack = { accepted: true, requestId, frozen: "receipt" };
      finishManagedCommand(dir, requestId, ack);
      return ack;
    }
    throw new Error(`unexpected operation ${String(params.operation)}`);
  });
  const defaultRuntime = runtime.getMockImplementation()!;
  const history = vi.fn(async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as { references?: HistoryReference[] };
    if (method === HISTORY_SEARCH_METHODS.references)
      return {
        references: (params.references ?? []).map((item) => ({
          reference: item,
          title: "Source",
          agent: "cursor",
          kind: "user",
          toolName: null,
          content: sourceText,
        })),
      };
    if (method === HISTORY_SEARCH_METHODS.query)
      return { hits: [], status, limited: false, nextCursor: null };
    if (method === HISTORY_SEARCH_METHODS.status) return status;
    if (method === HISTORY_SEARCH_METHODS.locate) return { content: sourceText };
    return status;
  });
  const defaultHistory = history.getMockImplementation()!;
  async function configure() {
    return service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: allowed,
    });
  }
  function tighten() {
    allowed = [];
    (
      service as unknown as { config: { allowedWorkspaceIds: string[] } }
    ).config.allowedWorkspaceIds = allowed;
  }
  async function separateSourceWorkspace() {
    sourceWorkspaceId = "source-w";
    allowed = ["w", sourceWorkspaceId];
    await configure();
    bootId = (await http("/access")).body.bootId;
  }
  async function http(path: string, body?: unknown) {
    return new Promise<{ status: number; body: Record<string, any>; cookie?: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method: body === undefined ? "GET" : "POST",
            headers: {
              Cookie: cookie,
              Origin: `http://127.0.0.1:${port}`,
              "X-CSRF-Token": csrf,
              "X-AgentKib-Protocol": "2",
              "Content-Type": "application/json",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(data),
                cookie: res.headers["set-cookie"]?.[0].split(";")[0],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  }
  const body = (text = "", references = [reference]) => ({
    text,
    historyReferences: references,
    sessionId: "target",
    expectedRevision: 1,
    bootId,
    requestId: randomUUID(),
    turnId: "turn",
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-history-host-"));
    allowed = ["w"];
    registered = true;
    sourceRegistered = true;
    sourceWorkspaceId = "w";
    sourceText = "quote";
    targetAgent = "codex";
    sent.length = 0;
    cookie = "";
    csrf = "";
    runtime.mockReset().mockImplementation(defaultRuntime);
    history.mockReset().mockImplementation(defaultHistory);
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    control = createWebControlState();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      managedRequest: runtime,
      claudeManagedRequest: runtime,
      historyRequest: history,
      receiptRequest: async (params) => readControlReceipt(dir, params),
      verifiedCodex: true,
      verifiedExperimental: true,
      verifiedClaudeManaged: true,
      sharedControl: control,
      workspaceRequest: async () => [
        ...(registered ? [{ id: "w", name: "Workspace", path: dir }] : []),
        ...(sourceRegistered && sourceWorkspaceId !== "w"
          ? [{ id: sourceWorkspaceId, name: "Source workspace", path: dir }]
          : []),
      ],
    });
    await service.initialize();
    await configure();
    const access = await http("/access");
    cookie = access.cookie!;
    csrf = access.body.csrfToken;
    bootId = access.body.bootId;
    deviceId = await approveLegacyBrowser(service, cookie, {
      send: true,
      advancedControl: true,
      attachments: true,
    });
  });
  afterEach(async () => {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("advertises capability while disabled and filters managed aliases for every read", async () => {
    const access = await http("/access");
    expect(access.body).toMatchObject({
      historySearch: true,
      historySearchScope: expect.any(String),
    });
    expect(await http("/history/status")).toMatchObject({ status: 200, body: { enabled: false } });
    expect(await http("/history/search", { query: "needle", workspaceIds: ["w"] })).toMatchObject({
      status: 200,
    });
    for (const [method, params] of history.mock.calls) {
      expect([HISTORY_SEARCH_METHODS.query, HISTORY_SEARCH_METHODS.status]).toContain(method);
      expect(params).toMatchObject({
        allowedSessionIds: ["source", "target-index"],
        requestId: expect.any(String),
      });
    }
    expect(history.mock.calls[0][1]).not.toHaveProperty("query");
  });
  it("never forwards URL queries, authorization overrides, quote bodies, or hidden locators", async () => {
    expect((await http("/history/search?query=secret", { query: "x" })).status).toBe(400);
    expect(
      (await http("/history/search", { query: "x", allowedSessionIds: ["hidden"] })).status,
    ).toBe(400);
    expect((await http("/history/locate", { ...reference, sessionId: "hidden" })).status).toBe(400);
    const { start: _start, end: _end, contentHash: _contentHash, ...location } = reference;
    expect((await http("/history/locate", { ...location, sessionId: "hidden" })).status).toBe(403);
    expect(
      (await http("/history/references", { references: [{ ...reference, content: "injected" }] }))
        .status,
    ).toBe(400);
    expect(
      (await http("/history/references", { references: [{ ...reference, sessionId: "hidden" }] }))
        .status,
    ).toBe(403);
    expect(history).not.toHaveBeenCalled();
  });
  it.each(["search", "locate", "references", "status"])(
    "rechecks tightened grants after awaited %s",
    async (kind) => {
      let release!: (value: unknown) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      history.mockImplementation(async (method, _raw) => {
        if (method === HISTORY_SEARCH_METHODS.cancel) return {};
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const { start: _start, end: _end, contentHash: _contentHash, ...location } = reference;
      const requestBody =
        kind === "search"
          ? { query: "x" }
          : kind === "locate"
            ? location
            : kind === "references"
              ? { references: [reference] }
              : undefined;
      const initial = (await http("/access")).body.historySearchScope;
      const pending = http(`/history/${kind}`, requestBody);
      await started;
      tighten();
      release({ content: "secret", references: [], hits: [{ snippet: "secret" }] });
      expect(await pending).toMatchObject({ status: 403, body: { error: "access_changed" } });
      expect((await http("/access")).body.historySearchScope).not.toBe(initial);
      expect(control.requests.size).toBe(0);
    },
  );
  it.each([
    ["web", "search"],
    ["web", "locate"],
    ["web", "references"],
    ["web", "status"],
    ["desktop", "search"],
    ["desktop", "locate"],
    ["desktop", "references"],
    ["desktop", "status"],
  ] as const)(
    "%s discards an awaited %s result after source workspace removal despite a stale catalog",
    async (transport, kind) => {
      await separateSourceWorkspace();
      sourceText = "secret";
      const catalog = await defaultRuntime({ operation: "catalog" });
      // Runtime can return a registration snapshot captured before its awaited alias read.
      runtime.mockImplementation(async (raw) =>
        (raw as { operation: string }).operation === "catalog" ? catalog : defaultRuntime(raw),
      );
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      history.mockImplementation(async (method, raw) => {
        if (method === HISTORY_SEARCH_METHODS.cancel) return {};
        const result = await defaultHistory(method, raw);
        entered();
        return new Promise((resolve) => {
          release = () =>
            resolve(
              method === HISTORY_SEARCH_METHODS.query
                ? { hits: [{ snippet: "secret" }], status, limited: false, nextCursor: null }
                : result,
            );
        });
      });
      const read = (path: string, input?: unknown) =>
        transport === "web" ? http(path, input) : service.localRequest(path, input);
      const { start: _start, end: _end, contentHash: _contentHash, ...location } = reference;
      const input =
        kind === "search"
          ? { query: "needle", workspaceIds: ["source-w"] }
          : kind === "locate"
            ? location
            : kind === "references"
              ? { references: [reference] }
              : undefined;
      const initial = (await read("/access")).body.historySearchScope;
      const pending = read(`/history/${kind}`, input);
      await started;
      sourceRegistered = false;
      release();
      expect(await pending).toMatchObject({ status: 403, body: { error: "access_changed" } });
      expect((await read("/access")).body.historySearchScope).not.toBe(initial);
      expect(allowed).toEqual(["w", "source-w"]);
      expect(registered).toBe(true);
      expect(sent).toHaveLength(0);
      expect(control.requests.size).toBe(0);
    },
  );
  it("keeps owner history reads over registered workspaces outside the scoped allow-list", async () => {
    await separateSourceWorkspace();
    tighten();
    expect(await service.localRequest("/history/search", { query: "needle" })).toMatchObject({
      status: 200,
    });
    expect(history).toHaveBeenCalledWith(
      HISTORY_SEARCH_METHODS.query,
      expect.objectContaining({ allowedSessionIds: ["source", "target-index"] }),
    );
    expect((await http("/history/references", { references: [reference] })).status).toBe(403);
  });
  it("keeps mutations owner-only and does not advertise unsupported old hosts", async () => {
    expect((await http("/history/configure", { enabled: true })).status).toBe(403);
    expect((await http("/history/clear", {})).status).toBe(403);
    expect((await http("/history/rebuild", {})).status).toBe(403);
    expect(history).not.toHaveBeenCalled();
    expect(await service.localRequest("/history/configure", { enabled: true })).toMatchObject({
      status: 200,
    });
    expect(await service.localRequest("/history/rebuild", {})).toMatchObject({ status: 200 });
    expect(history.mock.calls.map(([method]) => method)).toEqual([
      HISTORY_SEARCH_METHODS.configure,
      HISTORY_SEARCH_METHODS.refresh,
    ]);
    const old = new WebAccessService({
      dataDir: join(dir, "old"),
      staticDir: dir,
      runtimeRequest: runtime,
    });
    await old.initialize();
    expect((await old.localRequest("/access")).body).not.toHaveProperty("historySearch");
    expect((await old.localRequest("/history/status")).status).toBe(404);
    await old.shutdown();
  });
  it.each([
    ["history-source-stale", 409],
    ["history-source-changed", 409],
    ["history-source-owner-changed", 409],
    ["history-owner-changed", 409],
    ["history-search-cursor-stale", 409],
    ["history-source-unavailable", 410],
    ["history-search-disabled", 410],
    ["history-search-cache-unavailable", 410],
    ["history-reference-range-invalid", 400],
    ["history-references-too-large", 400],
    ["history-search-input-invalid", 400],
  ])(
    "projects definitive Runtime %s so the draft can discard invalid references",
    async (detail, expected) => {
      history.mockRejectedValue(
        new RuntimeRequestError({
          code: -32000,
          message: "AgentKib command failed",
          data: { detail },
        }),
      );
      expect(await http("/history/references", { references: [reference] })).toMatchObject({
        status: expected,
        body: { error: detail },
      });
      expect(
        await service.localRequest("/history/references", { references: [reference] }),
      ).toMatchObject({ status: expected, body: { error: detail } });
      expect(sent).toHaveLength(0);
    },
  );
  it("does not expose an unknown Runtime error or source path", async () => {
    history.mockRejectedValue(
      new RuntimeRequestError({
        code: -32000,
        message: "read /synthetic/private/source.db failed",
        data: { detail: "read /synthetic/private/source.db failed" },
      }),
    );
    expect(await http("/history/references", { references: [reference] })).toMatchObject({
      status: 500,
      body: { error: "request_failed" },
    });
    expect(
      await service.localRequest("/history/references", { references: [reference] }),
    ).toMatchObject({ status: 500, body: { error: "request_failed" } });
  });
  it("rejects revoked read grants after the Worker returns without leaking the result", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    history.mockImplementation(async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = http("/history/search", { query: "x" });
    await started;
    await service.request({ operation: "revoke", id: deviceId });
    release({ hits: [{ snippet: "secret" }] });
    expect(await pending).toMatchObject({ status: 401, body: { error: "access_ended" } });
  });
  it.each(["send", "codex/steer", "codex/queue-add"])(
    "freezes references-only %s and reuses durable accepted bytes without source reads",
    async (path) => {
      await separateSourceWorkspace();
      const input = body();
      const first = await http(`/${path}`, input);
      expect(first.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        historyReferences: [reference],
        historyInputHash: expect.any(String),
        text: "[History reference: Source · cursor · user]\nquote\n[/History reference]",
      });
      const ledger = openManagedLedger(dir)!;
      const before = ledger
        .prepare("SELECT result,evidence,fingerprint FROM managed_commands WHERE request_id=?")
        .get(input.requestId);
      ledger.close();
      const reads = history.mock.calls.length;
      sourceRegistered = false;
      history.mockRejectedValue(new Error("source_deleted"));
      const repeated = await http(`/${path}`, { ...input, bootId: "old-host" });
      expect(repeated).toMatchObject({ status: 200, body: first.body });
      expect(sent).toHaveLength(1);
      expect(history).toHaveBeenCalledTimes(reads);
      expect((await http(`/${path}`, { ...input, text: "different" })).status).toBe(409);
      expect((await http(`/${path}`, { ...input, historyReferences: [] })).status).toBe(409);
      const again = openManagedLedger(dir)!;
      expect(
        again
          .prepare("SELECT result,evidence,fingerprint FROM managed_commands WHERE request_id=?")
          .get(input.requestId),
      ).toEqual(before);
      again.close();
    },
  );
  it("does not replay an unknown history command and keeps native owner receipts first", async () => {
    const input = body("review");
    claimManagedCommand(dir, input.requestId, "target", "fingerprint", "desktop-local", {
      operation: "send",
      historyInputHash: historyInputHash(input, "send"),
      workspaceId: "w",
    });
    dispatchManagedCommand(dir, input.requestId);
    expect(await service.localRequest("/send", input)).toMatchObject({
      status: 409,
      body: { error: "outcome_unknown" },
    });
    expect(history).not.toHaveBeenCalled();
    const localInput = { ...body("review"), operation: "send" };
    claimManagedCommand(
      dir,
      localInput.requestId,
      "target",
      "local-fingerprint",
      "agentkib-local-owner",
      {
        operation: "send",
        historyInputHash: historyInputHash(localInput, "send"),
        workspaceId: "w",
      },
    );
    dispatchManagedCommand(dir, localInput.requestId);
    const ack = { accepted: true, requestId: localInput.requestId };
    finishManagedCommand(dir, localInput.requestId, ack);
    targetAgent = "claude-code";
    expect(await service.localClaude(localInput)).toEqual(ack);
    expect(await service.localClaude({ ...localInput, text: "changed" })).toMatchObject({
      error: "request_id_conflict",
    });
    expect(history).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
  it.each(["web", "local-claude"])(
    "uses frozen reference text in %s attachment input",
    async (transport) => {
      const owner = transport === "web" ? deviceId : "agentkib-local-owner";
      const store = new AttachmentStore(join(dir, "attachments"));
      const item = await store.upload(
        (async function* () {
          yield Buffer.from("attachment fixture");
        })(),
        { deviceId: owner, sessionId: "target" },
        "notes.txt",
        "text/plain",
        () => undefined,
      );
      const input = { ...body(" review "), attachmentIds: [item.id] };
      if (transport === "web") {
        expect((await http("/send", input)).status).toBe(200);
      } else {
        targetAgent = "claude-code";
        expect(await service.localClaude({ ...input, operation: "send" })).toMatchObject({
          accepted: true,
        });
      }
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBeUndefined();
      expect(sent[0].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "review\n\n[History reference: Source · cursor · user]\nquote\n[/History reference]",
          }),
        ]),
      );
      expect(sent[0]).toMatchObject({
        historyReferences: [reference],
        historyInputHash: expect.any(String),
      });
      const reads = history.mock.calls.length;
      history.mockRejectedValue(new Error("source_changed"));
      if (transport === "web") expect((await http("/send", input)).status).toBe(200);
      else
        expect(await service.localClaude({ ...input, operation: "send" })).toMatchObject({
          accepted: true,
        });
      expect(sent).toHaveLength(1);
      expect(history).toHaveBeenCalledTimes(reads);
    },
  );
  it.each(["send", "codex/steer", "codex/queue-add"])(
    "rejects %s when the final catalog returns a snapshot captured before source removal",
    async (path) => {
      await separateSourceWorkspace();
      let sourceResolved = false;
      let sourceScopeChecks = 0;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      history.mockImplementation(async (method, raw) => {
        const result = await defaultHistory(method, raw);
        if (method === HISTORY_SEARCH_METHODS.references) sourceResolved = true;
        return result;
      });
      runtime.mockImplementation(async (raw) => {
        const snapshot = await defaultRuntime(raw);
        // The first check follows source resolution; the second is immediately before dispatch.
        if (
          (raw as { operation: string }).operation === "catalog" &&
          sourceResolved &&
          ++sourceScopeChecks === 2
        ) {
          entered();
          await barrier;
        }
        return snapshot;
      });
      const pending = http(`/${path}`, body());
      await started;
      sourceRegistered = false;
      release();
      expect(await pending).toMatchObject({
        status: 403,
        body: { error: "access_changed", controlOutcome: "not-dispatched" },
      });
      expect(
        history.mock.calls.filter(([method]) => method === HISTORY_SEARCH_METHODS.references),
      ).toHaveLength(1);
      expect(sent).toHaveLength(0);
      expect(control.active.size).toBe(0);
      expect(control.outcomeFences.sessions.size).toBe(0);
      runtime.mockImplementation(defaultRuntime);
      expect(await http("/history/search", { query: "needle", workspaceIds: ["w"] })).toMatchObject(
        { status: 200 },
      );
      expect(history).toHaveBeenLastCalledWith(
        HISTORY_SEARCH_METHODS.query,
        expect.objectContaining({ allowedSessionIds: ["target-index"] }),
      );
      expect(allowed).toEqual(["w", "source-w"]);
      expect(registered).toBe(true);
    },
  );
  it("enforces count, quote bytes, combined text budget, and final source grant before dispatch", async () => {
    expect((await http("/send", body("", Array(6).fill(reference)))).status).toBe(400);
    sourceText = "a".repeat(8193);
    expect((await http("/send", body())).status).toBe(400);
    sourceText = "a".repeat(8000);
    expect((await http("/send", body("b".repeat(9000)))).status).toBe(400);
    sourceText = "quote";
    // Configuration is deliberately tightened inside the Worker await boundary.
    history.mockImplementation(async (method, raw) => {
      const result = await defaultHistory(method, raw);
      tighten();
      return result;
    });
    expect((await http("/send", body())).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it("cancels only the host-generated read request when an HTTP client disconnects", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    history.mockImplementation(async (method) => {
      if (method === HISTORY_SEARCH_METHODS.cancel) return {};
      entered();
      return new Promise(() => {});
    });
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/api/web/v1/history/search",
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}`,
        "X-CSRF-Token": csrf,
        "X-AgentKib-Protocol": "2",
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ query: "needle" }));
    await started;
    req.destroy();
    await vi.waitFor(() =>
      expect(history).toHaveBeenCalledWith(HISTORY_SEARCH_METHODS.cancel, expect.any(Object)),
    );
    const query = history.mock.calls.find(([method]) => method === HISTORY_SEARCH_METHODS.query)!;
    const cancel = history.mock.calls.find(([method]) => method === HISTORY_SEARCH_METHODS.cancel)!;
    expect(cancel[1]).toEqual({ requestId: (query[1] as { requestId: string }).requestId });
    expect(control.requests.size).toBe(0);
  });
  it.each([
    ["/history/search", { query: "needle" }, HISTORY_SEARCH_METHODS.query],
    [
      "/history/locate",
      {
        sessionId: reference.sessionId,
        recordId: reference.recordId,
        chunkId: reference.chunkId,
        sourceRevision: reference.sourceRevision,
      },
      HISTORY_SEARCH_METHODS.locate,
    ],
    ["/history/references", { references: [reference] }, HISTORY_SEARCH_METHODS.references],
    ["/history/status", undefined, HISTORY_SEARCH_METHODS.status],
  ] as const)(
    "cancels the real local %s read with a host-generated RPC ID",
    async (path, input, method) => {
      const abort = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      history.mockImplementation(async (name) => {
        if (name === HISTORY_SEARCH_METHODS.cancel) return {};
        entered();
        return new Promise(() => {});
      });
      const pending = service.localRequest(path, input, undefined, abort.signal);
      await started;
      abort.abort();
      expect(await pending).toMatchObject({
        status: 408,
        body: { error: "history_request_cancelled" },
      });
      const read = history.mock.calls.find(([name]) => name === method)!;
      const cancelled = history.mock.calls.find(
        ([name]) => name === HISTORY_SEARCH_METHODS.cancel,
      )!;
      expect(cancelled[1]).toEqual({ requestId: (read[1] as { requestId: string }).requestId });
      expect((read[1] as { requestId: string }).requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(sent).toHaveLength(0);
    },
  );
  it("does not dispatch a cancelled local read before or during catalog admission", async () => {
    const first = new AbortController();
    first.abort();
    expect(
      await service.localRequest("/history/status", undefined, undefined, first.signal),
    ).toMatchObject({ status: 408 });
    expect(history).not.toHaveBeenCalled();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.mockImplementation(async (raw) => {
      if ((raw as { operation: string }).operation === "catalog") {
        entered();
        await barrier;
      }
      return defaultRuntime(raw);
    });
    const second = new AbortController();
    const pending = service.localRequest("/history/status", undefined, undefined, second.signal);
    await started;
    second.abort();
    release();
    expect(await pending).toMatchObject({ status: 408 });
    expect(history).not.toHaveBeenCalled();
  });
  it("rejects a read cancellation signal on mutations without sending", async () => {
    expect(
      await service.localRequest("/send", body(), undefined, new AbortController().signal),
    ).toMatchObject({ status: 400, body: { error: "history_read_route_required" } });
    expect(sent).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
  });
});
