// @vitest-environment node
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService, type WebConfig } from "./service";

describe("remote capabilities share device and workspace authorization", () => {
  let dir: string,
    root: string,
    origin: string,
    cookie: string,
    csrf: string,
    bootId: string,
    deviceId: string;
  let service: WebAccessService, config: WebConfig;
  const managed = vi.fn();
  const runtime = vi.fn();
  async function api(path: string, body?: unknown) {
    return fetch(`${origin}/api/web/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        ...(body === undefined
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
              "X-AgentKib-Protocol": "2",
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function pair(grants: { files?: boolean; manage?: boolean } = {}) {
    const access = await api("access");
    cookie = access.headers.get("set-cookie")!.split(";")[0];
    const data = await access.json();
    csrf = data.csrfToken;
    bootId = data.bootId;
    deviceId = await approveLegacyBrowser(service, cookie, { send: true, ...grants });
  }
  beforeEach(async () => {
    cookie = "";
    managed.mockReset();
    runtime.mockReset();
    dir = await mkdtemp(join(tmpdir(), "agentkib-remote-capabilities-"));
    root = join(dir, "project");
    await mkdir(root);
    await writeFile(join(root, "report.html"), "<h1>Report</h1>");
    await writeFile(join(root, "note.md"), "# Result");
    await writeFile(join(root, ".env"), "PRIVATE=hidden");
    await writeFile(join(root, "clip.mp4"), Buffer.alloc(1024, 7));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    runtime.mockImplementation(async (input: Record<string, unknown>) =>
      input.operation === "catalog"
        ? {
            workspaces: [
              { id: "w", name: "Project", path: root },
              { id: "other", name: "Other", path: dir },
            ],
            sessions: [{ id: "s", workspace_id: "w" }],
          }
        : input.operation === "events"
          ? { events: [{ content: "[Result](note.md) and [outside](/outside/private.txt)" }] }
          : { patch: "safe diff", binary: false },
    );
    managed.mockResolvedValue({ available: true, policies: [], models: [] });
    service = new WebAccessService({
      dataDir: join(dir, "state"),
      staticDir: root,
      runtimeRequest: runtime,
      managedRequest: managed,
      verifiedCodex: true,
    });
    await service.initialize();
    config = {
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["w"],
    };
    await service.request({ operation: "configure", ...config });
  });
  afterEach(async () => {
    await service?.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  it("keeps new capabilities off for an existing-style browser grant", async () => {
    await pair();
    expect((await api("files/workspaces")).status).toBe(403);
    expect((await api("managed/options")).status).toBe(403);
    expect((await api("managed/create", { bootId, requestId: "a", workspaceId: "w" })).status).toBe(
      403,
    );
    expect(managed).not.toHaveBeenCalled();
  });
  it("lists only authorized roots and resolves explicit task references", async () => {
    await pair({ files: true });
    expect(await (await api("files/workspaces")).json()).toEqual({
      workspaces: [{ id: "w", name: "Project" }],
    });
    expect((await api("files/list?workspaceId=other")).status).toBe(403);
    const listing = await (await api("files/list?workspaceId=w")).json();
    expect(listing.entries.map((e: { name: string }) => e.name)).not.toContain(".env");
    const artifacts = await (await api("artifacts?workspaceId=w&sessionId=s")).json();
    expect(artifacts.artifacts.map((e: { name: string }) => e.name)).toEqual(["note.md"]);
    expect((await api("artifacts?workspaceId=w&sessionId=another")).status).toBe(403);
  });
  it("reads text with opaque IDs and prevents cross-device ID reuse", async () => {
    await pair({ files: true });
    const listing = await (await api("files/list?workspaceId=w")).json();
    const note = listing.entries.find((e: { name: string }) => e.name === "note.md");
    expect(
      (
        await (
          await api(`files/text?workspaceId=w&artifactId=${note.id}&revision=${note.revision}`)
        ).json()
      ).text,
    ).toBe("# Result");
    cookie = "";
    await pair({ files: true });
    expect((await api(`files/text?workspaceId=w&artifactId=${note.id}`)).status).toBe(404);
  });
  it("streams Range on a separate origin and revokes tickets with the device", async () => {
    await pair({ files: true });
    const listing = await (await api("files/list?workspaceId=w")).json();
    const clip = listing.entries.find((e: { name: string }) => e.name === "clip.mp4");
    const issued = await api("artifact-tickets", { workspaceId: "w", artifactId: clip.id });
    expect(issued.status).toBe(200);
    const ticket = await issued.json();
    expect(ticket.sourceRevision).toBe(clip.revision);
    expect(ticket.revision).toBe(clip.revision);
    expect(new URL(ticket.url).origin).not.toBe(origin);
    const media = await fetch(ticket.url, { headers: { Range: "bytes=100-199" } });
    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(100);
    await service.request({ operation: "revoke", id: deviceId });
    expect((await fetch(ticket.url)).status).not.toBe(200);
  });
  it("checks the requested artifact revision while retaining the bundle hash contract", async () => {
    await pair({ files: true });
    const listing = await (await api("files/list?workspaceId=w")).json();
    const html = listing.entries.find((e: { name: string }) => e.name === "report.html");
    const issued = await api("artifact-tickets", {
      workspaceId: "w",
      artifactId: html.id,
      expectedRevision: html.revision,
    });
    expect(issued.status).toBe(200);
    const ticket = await issued.json();
    expect(ticket.sourceRevision).toBe(html.revision);
    expect(ticket.revision).not.toBe(html.revision);
    await writeFile(join(root, "report.html"), "<h1>New report</h1>");
    const stale = await api("artifact-tickets", {
      workspaceId: "w",
      artifactId: html.id,
      expectedRevision: html.revision,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "artifact_changed" });
    expect(
      (
        await api("artifact-tickets", {
          workspaceId: "w",
          artifactId: html.id,
          expectedRevision: 7,
        })
      ).status,
    ).toBe(400);
    expect((await api("artifact-tickets", { workspaceId: "w", artifactId: html.id })).status).toBe(
      200,
    );
  });
  it("clears old tickets when directory grants change", async () => {
    await pair({ files: true });
    const listing = await (await api("files/list?workspaceId=w")).json();
    const file = listing.entries.find((e: { name: string }) => e.name === "note.md");
    const ticket = await (
      await api("artifact-tickets", { workspaceId: "w", artifactId: file.id })
    ).json();
    await service.request({ operation: "configure", ...config, allowedWorkspaceIds: [] });
    expect((await api("files/list?workspaceId=w")).status).toBe(403);
    expect(
      await fetch(ticket.url).then(
        (r) => r.status,
        () => 0,
      ),
    ).not.toBe(200);
  });
  it("checks boot, workspace and request identity before managed dispatch", async () => {
    await pair({ manage: true });
    const options = await (await api("managed/options")).json();
    expect(options.workspaces.map((w: { id: string }) => w.id)).toEqual(["w"]);
    managed.mockClear();
    managed.mockResolvedValue({ sessionId: "new", accepted: true });
    expect(
      (await api("managed/create", { bootId: "stale", requestId: "a", workspaceId: "w" })).status,
    ).toBe(409);
    expect(
      (await api("managed/create", { bootId, requestId: "a", workspaceId: "other" })).status,
    ).toBe(403);
    expect(managed).not.toHaveBeenCalled();
    const body = { bootId, requestId: "a", workspaceId: "w", cwd: "/", model: "verified-model" };
    expect((await api("managed/create", body)).status).toBe(200);
    expect(managed).toHaveBeenCalledWith({
      operation: "create",
      deviceId,
      requestId: "a",
      workspaceId: "w",
      policyId: "workspace-write-on-request",
      model: "verified-model",
    });
    expect((await api("managed/create", body)).status).toBe(409);
    expect(managed).toHaveBeenCalledTimes(1);
    // Another policy is a settings change, which only a device with full access may make.
    expect(
      (
        await api("managed/create", {
          bootId,
          requestId: "b",
          workspaceId: "w",
          policyId: "full-access-on-request",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("managed/create", {
          bootId,
          requestId: "c",
          workspaceId: "w",
          policyId: "anything",
        })
      ).status,
    ).toBe(400);
    expect(managed).toHaveBeenCalledTimes(1);
  });
  it("reports release blocked by an unknown control as definitely not dispatched", async () => {
    await pair({ manage: true });
    managed.mockImplementation(async ({ requestId }) => ({
      requestId,
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    }));
    const rejected = await api("managed/release", {
      bootId,
      requestId: "blocked-release",
      sessionId: "s",
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "control-outcome-unconfirmed",
      controlOutcome: "not-dispatched",
    });
    expect(managed).toHaveBeenCalledTimes(1);
    managed.mockResolvedValue({ accepted: true, released: true });
    expect(
      (
        await api("managed/release", {
          bootId,
          requestId: "confirmed-release",
          sessionId: "s",
        })
      ).status,
    ).toBe(200);
  });
  it("keeps explicit Codex adoption behind the manage grant", async () => {
    await pair();
    expect((await api("managed/adopt", { bootId, requestId: "a", sessionId: "s" })).status).toBe(
      403,
    );
    expect(managed).not.toHaveBeenCalled();
  });
  it("keeps Codex adoption scoped without manual confirmation", async () => {
    await pair({ manage: true });
    expect(
      (
        await api("managed/adopt", {
          bootId,
          requestId: "b",
          sessionId: "unknown",
        })
      ).status,
    ).toBe(403);
    managed.mockResolvedValue({ accepted: true });
    expect(
      (
        await api("managed/adopt", {
          bootId,
          requestId: "c",
          sessionId: "s",
        })
      ).status,
    ).toBe(200);
    expect(managed).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "adopt", sessionId: "s" }),
    );
    expect(managed.mock.calls.at(-1)![0]).not.toHaveProperty("handoffConfirmed");
  });
  it("does not report a rejected or uncertain native handoff as success", async () => {
    await pair({ manage: true });
    managed.mockImplementation(async ({ requestId }) => ({
      requestId,
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    }));
    const rejected = await api("managed/adopt", {
      bootId,
      requestId: "busy",
      sessionId: "s",
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: "codex-owner-busy",
      controlOutcome: "not-dispatched",
    });
    managed.mockResolvedValue({
      accepted: false,
      completed: false,
      controlOutcome: "unknown",
      reason: "internal/private/path",
    });
    const unknown = await api("managed/adopt", {
      bootId,
      requestId: "lost",
      sessionId: "s",
    });
    expect(unknown.status).toBe(502);
    expect(await unknown.json()).toEqual({ error: "outcome_unknown", controlOutcome: "unknown" });
  });
  it("removes managed execution controls when its workspace grant is removed", async () => {
    await pair({ manage: true });
    const original = runtime.getMockImplementation()!;
    runtime.mockImplementation(async (input) =>
      input.operation === "live"
        ? {
            sessionId: "s",
            workspaceId: "w",
            executionMode: "codex-managed",
            runtimeBootId: "r",
            revision: 1,
            status: "idle",
            sendEnabled: true,
            stopEnabled: true,
            approvals: [],
            questions: [],
          }
        : original(input),
    );
    expect((await (await api("live?sessionId=s")).json()).sendEnabled).toBe(true);
    await service.request({ operation: "configure", ...config, allowedWorkspaceIds: [] });
    const live = await (await api("live?sessionId=s")).json();
    expect(live.sendEnabled).toBe(false);
    expect(live.stopEnabled).toBe(false);
  });
});
