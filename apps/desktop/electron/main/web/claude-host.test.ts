// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService, type WebDevice } from "./service";
import { AttachmentStore } from "./attachments";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import type { ArtifactListing } from "./artifacts";

describe("Claude host control boundary", () => {
  let directory: string;
  let service: WebAccessService;
  let port: number;
  let cookie: string;
  let csrf: string;
  let bootId: string;
  let deviceId: string;
  let revision: number;
  let completed: boolean;
  let workspaceRegistered: boolean;
  const workspaceRequest = vi.fn(async () =>
    workspaceRegistered
      ? [{ id: "workspace", name: "Synthetic workspace", path: join(directory, "workspace") }]
      : [],
  );
  const receipts = new Map<string, Record<string, unknown>>();
  const runtime = vi.fn<(value: unknown) => Promise<unknown>>();
  const managed = vi.fn<(value: unknown) => Promise<unknown>>();
  const codexManaged = vi.fn<(value: unknown) => Promise<unknown>>();
  const receipt = vi.fn(
    async ({ requestId }: { requestId: string; deviceId: string }) =>
      receipts.get(requestId) ?? { found: false, requestId },
  );

  async function http(path: string, body?: Record<string, unknown>) {
    return new Promise<{ status: number; body: Record<string, unknown>; cookies?: string[] }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method: body ? "POST" : "GET",
            headers: {
              Connection: "close",
              ...(cookie ? { Cookie: cookie } : {}),
              ...(body
                ? {
                    "Content-Type": "application/json",
                    Origin: `http://127.0.0.1:${port}`,
                    "X-CSRF-Token": csrf,
                  }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
                cookies: res.headers["set-cookie"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      },
    );
  }
  async function configure(allowedWorkspaceIds = ["workspace"]) {
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds,
    });
  }
  async function upload(owner = deviceId) {
    const store = new AttachmentStore(join(directory, "attachments"));
    const item = await store.upload(
      (async function* () {
        yield Buffer.from("synthetic attachment");
      })(),
      { deviceId: owner, sessionId: "claude-session" },
      "notes.txt",
      "text/plain",
      () => undefined,
    );
    return { store, item };
  }
  beforeEach(async () => {
    receipts.clear();
    receipt.mockClear();
    runtime.mockReset();
    managed.mockReset();
    codexManaged.mockReset();
    revision = 4;
    completed = false;
    workspaceRegistered = true;
    cookie = csrf = bootId = "";
    directory = await mkdtemp(join(tmpdir(), "agentkib-claude-host-"));
    await mkdir(join(directory, "workspace"));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const claudeRequest = async (value: unknown) => {
      const params = value as Record<string, unknown>;
      if (params.operation === "catalog")
        return {
          sessions: [
            { id: "claude-session", workspace_id: "workspace", agent: "claude-code" },
            { id: "other-claude", workspace_id: "workspace", agent: "claude-code" },
            { id: "codex-session", workspace_id: "workspace", agent: "codex" },
          ],
          workspaces: [],
        };
      if (params.operation === "live")
        return {
          executionMode: "claude-managed",
          workspaceId: "workspace",
          runtimeBootId: "runtime-one",
          revision,
          status: completed ? "idle" : revision === 4 ? "idle" : "running",
          sendEnabled: revision === 4 || completed,
          turnId: "turn",
          stopEnabled: !completed,
        };
      if (params.operation === "capabilities")
        return { features: { attachments: { available: true }, context: { available: false } } };
      if (params.operation === "send") {
        revision = 5;
        return {
          accepted: true,
          completed: false,
          requestId: params.requestId,
          controlOutcome: "accepted",
          runtimeBootId: "runtime-one",
        };
      }
      return {
        accepted: true,
        requestId: params.requestId,
        controlOutcome: "accepted",
      };
    };
    runtime.mockImplementation(claudeRequest);
    managed.mockImplementation(claudeRequest);
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      claudeManagedRequest: managed,
      managedRequest: codexManaged,
      receiptRequest: receipt,
      workspaceRequest,
      verifiedClaudeManaged: true,
    });
    await service.initialize();
    await configure();
    const access = await http("/access");
    cookie = access.cookies![0].split(";")[0];
    csrf = String(access.body.csrfToken);
    bootId = String(access.body.bootId);
    deviceId = await approveLegacyBrowser(service, cookie, {
      send: true,
      approve: true,
      manage: true,
      attachments: true,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses restricted-device Claude control outside the current workspace allowlist", async () => {
    await configure([]);
    bootId = String((await http("/access")).body.bootId);
    const result = await http("/send", {
      bootId,
      sessionId: "claude-session",
      requestId: randomUUID(),
      expectedRevision: 4,
      text: "hello",
    });
    expect(result.status).toBe(403);
    expect(
      runtime.mock.calls.some(([value]) => (value as Record<string, unknown>).operation === "send"),
    ).toBe(false);
  });
  it("routes Claude release with both revision and Runtime identity without touching Codex", async () => {
    const requestId = randomUUID();
    const result = await http("/managed/release", {
      agent: "claude-code",
      bootId,
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
    });
    expect(result.status).toBe(200);
    expect(managed).toHaveBeenCalledWith({
      operation: "release",
      sessionId: "claude-session",
      requestId,
      deviceId,
      expectedRevision: 4,
      runtimeBootId: "runtime-one",
    });
    expect(codexManaged).not.toHaveBeenCalled();
    await service.localClaude({
      operation: "release",
      sessionId: "claude-session",
      requestId: randomUUID(),
      expectedRevision: 4,
      deviceId: "spoofed",
    });
    expect(managed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "release",
        runtimeBootId: "runtime-one",
        expectedRevision: 4,
        deviceId: "agentkib-local-owner",
      }),
    );
  });
  it("removes a new pin when the host rejects before Runtime dispatch", async () => {
    const { store, item } = await upload();
    const result = await http("/send", {
      bootId,
      sessionId: "claude-session",
      requestId: randomUUID(),
      expectedRevision: 4,
      text: "",
      attachmentIds: [item.id],
      resourceIds: ["not-supported"],
    });
    expect(result.status).toBe(403);
    expect(result.body.controlOutcome).toBe("not-dispatched");
    expect(await store.pendingRequests("claude-session")).toEqual([]);
    await expect(
      store.remove(deviceId, "claude-session", item.id, item.version),
    ).resolves.toBeUndefined();
    expect(
      runtime.mock.calls.some(([value]) => (value as Record<string, unknown>).operation === "send"),
    ).toBe(false);
  });
  it("retains uncertain pins across a new store and idle snapshots without matching completion", async () => {
    const { store, item } = await upload();
    const requestId = randomUUID();
    await http("/send", {
      bootId,
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
      text: "",
      attachmentIds: [item.id],
    });
    completed = true;
    await http("/live?sessionId=claude-session");
    expect(await store.pendingRequests("claude-session")).toEqual([{ deviceId, requestId }]);
    await expect(store.remove(deviceId, "claude-session", item.id, item.version)).rejects.toThrow(
      "attachment_in_use",
    );
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      status: "accepted",
      completionObserved: true,
    });
    await http("/live?sessionId=claude-session");
    expect(await store.pendingRequests("claude-session")).toEqual([]);
  });
  it("forwards a repeated text request to Runtime fingerprint replay after live revision advances", async () => {
    const requestId = randomUUID();
    const input = {
      operation: "send",
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
      text: "same text",
    };
    expect(await service.localClaude(input)).toMatchObject({ accepted: true });
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      executionMode: "claude-managed",
      status: "accepted",
    });
    expect(await service.localClaude(input)).toMatchObject({ accepted: true });
    expect(
      managed.mock.calls.filter(
        ([value]) => (value as Record<string, unknown>).operation === "send",
      ),
    ).toHaveLength(2);
  });
  it("lets Web retry retrieve the same text receipt after a successful send", async () => {
    const requestId = randomUUID();
    const input = {
      bootId,
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
      text: "same text",
    };
    expect((await http("/send", input)).status).toBe(200);
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      executionMode: "claude-managed",
      status: "accepted",
    });
    expect((await http("/send", input)).status).toBe(200);
  });
  it("returns the original attachment receipt after completion and attachment deletion", async () => {
    const { store, item } = await upload("agentkib-local-owner");
    const requestId = randomUUID();
    const input = {
      operation: "send",
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
      text: "read",
      attachmentIds: [item.id],
    };
    expect(await service.localClaude(input)).toMatchObject({ accepted: true });
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      executionMode: "claude-managed",
      operation: "send",
      expectedRevision: 4,
      ack: { accepted: true, requestId, sessionId: "claude-session", controlOutcome: "accepted" },
      status: "accepted",
      completionObserved: true,
    });
    completed = true;
    await service.localClaude({ operation: "live", sessionId: "claude-session" });
    await store.remove("agentkib-local-owner", "claude-session", item.id, item.version);
    expect(await service.localClaude(input)).toMatchObject({ accepted: true });
    expect(await service.localClaude({ ...input, text: "different" })).toMatchObject({
      accepted: false,
      controlOutcome: "unknown",
    });
    expect(
      managed.mock.calls.filter(
        ([value]) => (value as Record<string, unknown>).operation === "send",
      ),
    ).toHaveLength(1);
  });
  it("replays Web attachment receipts after deletion but rejects changed content", async () => {
    const { store, item } = await upload();
    const requestId = randomUUID();
    const input = {
      bootId,
      sessionId: "claude-session",
      requestId,
      expectedRevision: 4,
      text: "read",
      attachmentIds: [item.id],
    };
    expect((await http("/send", input)).status).toBe(200);
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      executionMode: "claude-managed",
      operation: "send",
      expectedRevision: 4,
      status: "accepted",
      completionObserved: true,
      ack: { accepted: true, requestId, sessionId: "claude-session", controlOutcome: "accepted" },
    });
    completed = true;
    await http("/live?sessionId=claude-session");
    await store.remove(deviceId, "claude-session", item.id, item.version);
    expect((await http("/send", input)).status).toBe(200);
    expect(await http("/send", { ...input, text: "different" })).toMatchObject({
      status: 409,
      body: { controlOutcome: "unknown" },
    });
    expect(
      runtime.mock.calls.filter(
        ([value]) => (value as Record<string, unknown>).operation === "send",
      ),
    ).toHaveLength(1);
  });
  it.each(["Web", "owner"])(
    "keeps unknown %s attachment replay conflicts pinned without another dispatch",
    async (client) => {
      const owner = client === "owner" ? "agentkib-local-owner" : deviceId;
      const { store, item } = await upload(owner);
      const requestId = randomUUID();
      const input = {
        operation: "send",
        bootId,
        sessionId: "claude-session",
        requestId,
        expectedRevision: 4,
        text: "read",
        attachmentIds: [item.id],
      };
      if (client === "owner")
        expect(await service.localClaude(input)).toMatchObject({ accepted: true });
      else expect((await http("/send", input)).status).toBe(200);
      receipts.set(requestId, {
        found: true,
        requestId,
        sessionId: "claude-session",
        executionMode: "claude-managed",
        operation: "send",
        expectedRevision: 4,
        status: "unknown",
        completionObserved: false,
      });
      for (const changed of [
        { ...input, text: "changed" },
        { ...input, attachmentIds: [randomUUID()] },
      ]) {
        const result =
          client === "owner"
            ? await service.localClaude(changed)
            : (await http("/send", changed)).body;
        expect(result).toMatchObject({ controlOutcome: "unknown" });
        await expect(store.remove(owner, "claude-session", item.id, item.version)).rejects.toThrow(
          "attachment_in_use",
        );
      }
      expect(
        (client === "owner" ? managed : runtime).mock.calls.filter(
          ([value]) => (value as Record<string, unknown>).operation === "send",
        ),
      ).toHaveLength(1);
    },
  );
  it("returns definitive non-dispatch only after matching the stored attachment semantics", async () => {
    const { store, item } = await upload();
    const requestId = randomUUID();
    await store.inputForAgent(deviceId, "claude-session", [item.id], "read", "claude", requestId);
    receipts.set(requestId, {
      found: true,
      requestId,
      sessionId: "claude-session",
      executionMode: "claude-managed",
      operation: "send",
      expectedRevision: 4,
      status: "not-dispatched",
      ack: { accepted: false, completed: false, requestId, controlOutcome: "not-dispatched" },
    });
    expect(
      await http("/send", {
        bootId,
        sessionId: "claude-session",
        requestId,
        expectedRevision: 4,
        text: "read",
        attachmentIds: [item.id],
      }),
    ).toMatchObject({ status: 409, body: { controlOutcome: "not-dispatched" } });
    expect(
      runtime.mock.calls.filter(
        ([value]) => (value as Record<string, unknown>).operation === "send",
      ),
    ).toHaveLength(0);
  });
  it.each(["release", "adopt"])(
    "keeps an existing managed %s unknown when preflight fails",
    async (operation) => {
      const requestId = randomUUID();
      receipts.set(requestId, {
        found: true,
        requestId,
        status: "unknown",
        executionMode: "claude-managed",
      });
      runtime.mockRejectedValue(new Error("runtime_unavailable"));
      expect(
        await http(`/managed/${operation}`, {
          agent: "claude-code",
          bootId,
          sessionId: "claude-session",
          requestId,
          expectedRevision: 4,
          handoffConfirmed: true,
          handoffFingerprint: "fingerprint",
        }),
      ).toMatchObject({ body: { controlOutcome: "unknown" } });
      expect(receipt).toHaveBeenCalledWith({ requestId, deviceId });
      expect(managed).not.toHaveBeenCalled();
    },
  );
  it.each(["/send", "/managed/release"])(
    "keeps %s unknown when its device-scoped receipt lookup fails",
    async (path) => {
      receipt.mockRejectedValueOnce(new Error("receipt_unavailable"));
      expect(
        await http(path, {
          agent: "claude-code",
          bootId,
          sessionId: "claude-session",
          requestId: randomUUID(),
          expectedRevision: 4,
          text: "hello",
        }),
      ).toMatchObject({ body: { controlOutcome: "unknown" } });
      expect(managed).not.toHaveBeenCalled();
      expect(
        runtime.mock.calls.filter(
          ([value]) => (value as Record<string, unknown>).operation === "send",
        ),
      ).toHaveLength(0);
    },
  );
  it("projects Claude capabilities through actual device roles and LAN transport restrictions", async () => {
    const features = Object.fromEntries(
      ["send", "approve", "adopt", "release", "files", "attachments"].map((name) => [
        name,
        { available: true },
      ]),
    );
    managed.mockResolvedValue({
      sessionId: "claude-session",
      executionMode: "claude-managed",
      features,
    });
    cookie = "";
    const access = await http("/access");
    cookie = access.cookies![0].split(";")[0];
    csrf = String(access.body.csrfToken);
    await approveLegacyBrowser(service, cookie, {
      send: false,
      approve: false,
      manage: false,
      attachments: false,
      files: false,
    });
    const result = await http("/managed/capabilities?agent=claude-code&sessionId=claude-session");
    expect(result.status).toBe(200);
    expect(result.body.features).toEqual(
      Object.fromEntries(
        Object.keys(features).map((name) => [
          name,
          { available: false, reason: "permission_denied" },
        ]),
      ),
    );
    const lan = new WebAccessService({
      mode: "lan",
      dataDir: join(directory, "lan"),
      staticDir: directory,
      runtimeRequest: runtime,
      verifiedClaudeManaged: true,
    });
    const view = lan as unknown as {
      projectClaudeCapabilities(
        value: unknown,
        device: WebDevice,
        sessionId: string,
      ): { features: Record<string, { available: boolean; reason?: string }> };
    };
    const caps = view.projectClaudeCapabilities(
      { features },
      {
        id: "lan-phone",
        name: "Phone",
        createdAt: 0,
        send: true,
        approve: true,
        manage: true,
        files: true,
        attachments: true,
      },
      "claude-session",
    );
    expect(caps.features.attachments).toEqual({ available: false, reason: "same_origin_required" });
    expect(caps.features.files).toEqual({ available: false, reason: "same_origin_required" });
  });
  it("scopes desktop file IDs to a registered Claude session and rejects traversal and symlinks", async () => {
    await writeFile(join(directory, "workspace", "notes.txt"), "synthetic text");
    await writeFile(join(directory, "outside.txt"), "outside must remain private");
    await symlink(join(directory, "outside.txt"), join(directory, "workspace", "outside.txt"));
    const listing = (await service.localClaude({
      operation: "files",
      sessionId: "claude-session",
    })) as ArtifactListing;
    expect(listing.entries.map((item) => item.name)).toEqual(["notes.txt"]);
    const item = listing.entries[0];
    expect(
      await service.localClaude({
        operation: "file-text",
        sessionId: "claude-session",
        artifactId: item.id,
        revision: item.revision,
      }),
    ).toMatchObject({ text: "synthetic text", revision: item.revision });
    await expect(
      service.localClaude({
        operation: "file-text",
        sessionId: "other-claude",
        artifactId: item.id,
        revision: item.revision,
      }),
    ).rejects.toThrow();
    for (const sessionId of ["unknown", "codex-session"])
      await expect(service.localClaude({ operation: "files", sessionId })).rejects.toThrow(
        "workspace_not_authorized",
      );
    await expect(
      service.localClaude({
        operation: "files",
        sessionId: "claude-session",
        directoryId: "../../",
      }),
    ).rejects.toThrow();
    await expect(
      service.localClaude({
        operation: "file-text",
        sessionId: "claude-session",
        artifactId: join(directory, "outside.txt"),
        revision: item.revision,
      }),
    ).rejects.toThrow();
    workspaceRegistered = false;
    await expect(
      service.localClaude({
        operation: "file-text",
        sessionId: "claude-session",
        artifactId: item.id,
        revision: item.revision,
      }),
    ).rejects.toThrow("workspace_not_authorized");
  });
  it("serves HTML on an isolated loopback preview and revokes its ticket when the workspace disappears", async () => {
    await writeFile(
      join(directory, "workspace", "index.html"),
      "<html><script>document.body.dataset.synthetic='yes'</script><p>synthetic preview</p></html>",
    );
    const listing = (await service.localClaude({
      operation: "files",
      sessionId: "claude-session",
    })) as ArtifactListing;
    const item = listing.entries[0];
    const ticket = (await service.localClaude({
      operation: "file-preview",
      sessionId: "claude-session",
      artifactId: item.id,
      revision: item.revision,
    })) as { url: string; revision: string };
    const url = new URL(ticket.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.protocol).toBe("http:");
    expect(url.port).not.toBe(String(port));
    // HTML tickets describe a frozen bundle; its hash differs from the listing's file revision.
    expect(ticket.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(ticket.revision).not.toBe(item.revision);
    const preview = await fetch(url);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
    expect(preview.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(preview.headers.get("set-cookie")).toBeNull();
    expect(await preview.text()).toContain("synthetic preview");
    await expect(
      service.localClaude({
        operation: "file-preview",
        sessionId: "claude-session",
        artifactId: item.id,
      }),
    ).rejects.toThrow();
    await writeFile(
      join(directory, "workspace", "index.html"),
      "<html>different content after listing</html>",
    );
    await expect(
      service.localClaude({
        operation: "file-preview",
        sessionId: "claude-session",
        artifactId: item.id,
        revision: item.revision,
      }),
    ).rejects.toThrow("artifact_changed");
    // An already issued ticket is the original frozen bundle, not a live pointer to the new file.
    expect(await (await fetch(url)).text()).toContain("synthetic preview");
    workspaceRegistered = false;
    const revoked = await fetch(url);
    expect(revoked.ok).toBe(false);
    expect(await revoked.text()).not.toContain("synthetic preview");
  });
});
