// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, request, Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { HISTORY_SEARCH_METHODS } from "@agentkib/runtime-protocol";
import { HOSTED_ORIGIN, WebAccessService } from "./service";

let service: WebAccessService;
let dir: string;
let port: number;
let bearer: string;
let csrf: string;
let bootId: string;
let registered = true;
let liveWorkspace = "w";
let unregisterOnSend = false;
let catalogReads = 0;
let unregisterAtCatalogRead: number | undefined;
const reference = {
  sessionId: "source",
  recordId: "r",
  chunkId: "c",
  sourceRevision: "v",
  start: 0,
  end: 5,
  contentHash: "a".repeat(64),
};
const runtime = vi.fn(async (raw: unknown): Promise<unknown> => {
  const input = raw as { operation: string; requestId?: string };
  if (input.operation === "catalog") {
    catalogReads++;
    if (catalogReads === unregisterAtCatalogRead) registered = false;
    return {
      workspaces: registered ? [{ id: "w", name: "Workspace", path: dir }] : [],
      sessions: [
        { id: "target", agent: "codex", workspace_id: "w" },
        { id: "source", agent: "cursor", workspace_id: "w" },
        { id: "secret", agent: "claude-code", workspace_id: "other" },
      ],
    };
  }
  if (input.operation === "live")
    return {
      workspaceId: liveWorkspace,
      executionMode: "codex-managed",
      revision: 1,
      runtimeBootId: "runtime",
      sendEnabled: true,
    };
  if (input.operation === "capabilities")
    return {
      executionMode: "codex-managed",
      features: Object.fromEntries(
        ["send", "fork", "resume", "files"].map((name) => [name, { available: true }]),
      ),
    };
  if (input.operation === "send" && unregisterOnSend) registered = false;
  return { accepted: true, requestId: input.requestId };
});
const history = vi.fn(async (method: string, _raw: unknown): Promise<unknown> => {
  if (method === HISTORY_SEARCH_METHODS.references)
    return {
      references: [
        {
          reference,
          title: "Source",
          agent: "cursor",
          kind: "user",
          toolName: null,
          content: "quote",
        },
      ],
    };
  return { hits: [], enabled: true };
});
async function http(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/web/v1${path}`,
        method,
        headers: {
          Host: `192.168.20.10:${port}`,
          Origin: HOSTED_ORIGIN,
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          "X-CSRF-Token": csrf,
          "X-AgentKib-Protocol": "2",
          "Content-Type": "application/json",
          ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function pair(send: boolean) {
  bearer = "";
  const access = (await http("/access")).body;
  bearer = access.bearerToken;
  csrf = access.csrfToken;
  bootId = access.bootId;
  const code = (await service.request({ operation: "generate-code" })).code!.value;
  const paired = await http("/pair", { code, name: "History fixture" });
  expect(paired.status).toBe(200);
  await service.request({ operation: "approve", id: paired.body.pending.id, send, approve: false });
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ak-history-lan-"));
  bearer = csrf = bootId = "";
  registered = true;
  liveWorkspace = "w";
  unregisterOnSend = false;
  catalogReads = 0;
  unregisterAtCatalogRead = undefined;
  runtime.mockClear();
  history.mockClear();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    args[1] = "127.0.0.1";
    return Reflect.apply(listen, this, args);
  } as typeof listen);
  service = new WebAccessService({
    mode: "lan",
    dataDir: dir,
    staticDir: dir,
    runtimeRequest: runtime,
    historyRequest: history,
    verifiedCodex: true,
    addresses: () => [{ name: "fixture", address: "192.168.20.10" }],
  });
  await service.initialize();
  await service.request({
    operation: "configure",
    enabled: true,
    port,
    externalOrigin: HOSTED_ORIGIN,
    experimentalEnabled: true,
    lanAddress: "192.168.20.10",
    allowPlaintext: true,
    allowedWorkspaceIds: ["w"],
  });
});
afterEach(async () => {
  await service.shutdown();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
it("keeps LAN reads under existing workspaces and sends under the separate send grant", async () => {
  await pair(false);
  expect((await http("/access")).body).toMatchObject({ historySearch: true });
  expect((await http("/history/search", { query: "needle" })).status).toBe(200);
  expect(history).toHaveBeenCalledWith(
    HISTORY_SEARCH_METHODS.query,
    expect.objectContaining({ allowedSessionIds: ["source", "target"] }),
  );
  expect(
    (await http("/history/references", { references: [{ ...reference, sessionId: "secret" }] }))
      .status,
  ).toBe(403);
  const input = () => ({
    sessionId: "target",
    text: "",
    historyReferences: [reference],
    expectedRevision: 1,
    bootId,
    requestId: randomUUID(),
  });
  expect((await http("/send", input())).status).toBe(403);
  await pair(true);
  expect(await http("/send", input())).toMatchObject({ status: 200 });
  expect(runtime).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "send",
      historyReferences: [reference],
      text: "[History reference: Source · cursor · user]\nquote\n[/History reference]",
    }),
  );
  expect((await http("/attachments", {})).status).toBe(403);
  expect((await http("/history/configure", { enabled: true })).status).toBe(403);
  expect((await http("/history/search", undefined, "OPTIONS")).status).toBe(204);
  expect((await http("/history/configure", undefined, "OPTIONS")).status).toBe(403);
  expect((await service.localRequest("/history/configure", { enabled: true })).status).toBe(404);
});
const sendInput = () => ({
  sessionId: "target",
  text: "continue",
  expectedRevision: 1,
  bootId,
  requestId: randomUUID(),
});
it("permits registered Codex sends while keeping LAN files and manage unavailable", async () => {
  await pair(true);
  expect((await http("/live?sessionId=target")).body.sendEnabled).toBe(true);
  const capabilities = (await http("/codex/capabilities?sessionId=target")).body;
  expect(capabilities.features.send.available).toBe(true);
  for (const name of ["fork", "resume", "files"])
    expect(capabilities.features[name].available).toBe(false);
  expect((await http("/send", sendInput())).status).toBe(200);
  expect((await http("/files/workspaces")).status).toBe(403);
  expect((await http("/managed/release", sendInput())).status).toBe(403);
});
it("does not project or dispatch LAN sends without the send grant", async () => {
  await pair(false);
  expect((await http("/live?sessionId=target")).body.sendEnabled).toBe(false);
  expect((await http("/send", sendInput())).status).toBe(403);
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "send")).toBe(
    false,
  );
});
it.each(["unregistered", "mismatched"])("rejects a %s Codex workspace in LAN", async (kind) => {
  await pair(true);
  if (kind === "unregistered") registered = false;
  else liveWorkspace = "other";
  expect((await http("/live?sessionId=target")).body.sendEnabled).toBe(false);
  expect((await http("/send", sendInput())).status).toBe(403);
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "send")).toBe(
    false,
  );
});
it("rechecks LAN registration after dispatch without turning a lost response into a retry", async () => {
  await pair(true);
  unregisterOnSend = true;
  expect((await http("/send", sendInput())).body).toEqual({
    error: "workspace_not_authorized",
    controlOutcome: "unknown",
  });
  expect((await http("/send", sendInput())).body).toEqual({
    error: "outcome_unknown",
    controlOutcome: "not-dispatched",
  });
  expect(
    runtime.mock.calls.filter(([p]) => (p as { operation: string }).operation === "send"),
  ).toHaveLength(1);
});
it("rechecks LAN registration immediately before dispatch", async () => {
  await pair(true);
  catalogReads = 0;
  unregisterAtCatalogRead = 3;
  const result = await http("/send", sendInput());
  expect(result.status).toBe(403);
  expect(result.body).toEqual({
    error: "workspace_not_authorized",
    controlOutcome: "not-dispatched",
  });
  expect(runtime.mock.calls.some(([p]) => (p as { operation: string }).operation === "send")).toBe(
    false,
  );
});
