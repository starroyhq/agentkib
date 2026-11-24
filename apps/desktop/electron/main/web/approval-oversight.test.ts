// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRuleList, ManagedAgent } from "@agentkib/runtime-protocol";
import {
  nativeApprovalRules,
  type ApprovalRuleContext,
} from "@agentkib/backend/approval-rule-providers";
import { WebAccessService, type HostSessionRequest } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

describe("paired approval oversight", () => {
  let directory: string;
  let origin: string;
  let service: WebAccessService;
  let workspaces: { id: string; name: string; path: string }[];
  const providers = {
    codex: { list: false, revoke: false },
    "claude-code": { list: true, revoke: true },
    "deepseek-harness": { list: false, revoke: false },
    devin: { list: false, revoke: false },
    antigravity: { list: false, revoke: false },
  };
  const list = vi.fn(async (context: ApprovalRuleContext): Promise<ApprovalRuleList> => ({
    providers,
    rules: [
      {
        id: "rule",
        agent: "claude-code",
        scope: context.workspace ? "project" : "global",
        source: "settings.json",
        content: "Read",
        revocable: true,
      },
    ],
  }));
  const revoke = vi.fn(
    async (context: ApprovalRuleContext, _agent: ManagedAgent, _ruleId: string) => {
      await context.authorizeWrite?.();
    },
  );
  const sessionRequest = vi.fn(async (_input: HostSessionRequest): Promise<unknown> => ({
    entries: [],
  }));

  async function browser(access?: "full" | "read" | "restricted") {
    const initial = await fetch(origin + "/api/web/v1/access");
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = await initial.json();
    const api = async (path: string, body?: unknown, headers?: Record<string, string>) => {
      const response = await fetch(`${origin}/api/web/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrfToken,
          "X-AgentKib-Protocol": "2",
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    let deviceId: string | undefined;
    if (access === "restricted") {
      deviceId = await approveLegacyBrowser(service, cookie, { files: true });
    } else if (access) {
      const pairCode = (await service.request({ operation: "generate-code", access })).code!.value;
      const paired = await api("/pair", { code: pairCode, name: "Test device" });
      expect(paired.body.status).toBe("approved");
      deviceId = paired.body.device.id;
    }
    return { api, deviceId };
  }

  beforeEach(async () => {
    list.mockClear();
    revoke.mockClear();
    sessionRequest.mockReset().mockResolvedValue({ entries: [] });
    directory = await realpath(await mkdtemp(join(tmpdir(), "agentkib-approval-oversight-")));
    workspaces = ["visible", "hidden"].map((id) => ({ id, name: id, path: join(directory, id) }));
    await Promise.all(workspaces.map(({ path }) => mkdir(path)));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      sessionRequest,
      approvalRules: { list, revoke },
      workspaceRequest: async () => workspaces,
      verifiedExperimental: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["visible"],
    });
  });

  afterEach(async () => {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("advertises new reads only after pairing and sends only authorized workspace scopes", async () => {
    const unpaired = await browser();
    expect((await unpaired.api("/access")).body).not.toHaveProperty("approvalAuditVersion");
    expect((await unpaired.api("/approval-audit")).status).toBe(401);
    const { api } = await browser("restricted");
    expect((await api("/access")).body).toMatchObject({
      approvalAuditVersion: 1,
      approvalRulesVersion: 1,
    });
    expect(await api("/approval-audit?limit=1&before=cursor")).toEqual({
      status: 200,
      body: { entries: [] },
    });
    expect(sessionRequest).toHaveBeenLastCalledWith({
      host: {
        request: {
          operation: "approval-audit-list",
          before: "cursor",
          limit: 1,
          workspaces: [expect.objectContaining({ id: "visible" })],
        },
      },
    });
    expect((await api("/approval-audit?workspaceId=hidden")).status).toBe(400);
    expect(await service.localRequest("/approval-audit")).toMatchObject({
      status: 200,
      body: { entries: [] },
    });
    expect(sessionRequest).toHaveBeenLastCalledWith({
      host: { request: { operation: "approval-audit-list", limit: 30 } },
    });
  });

  it("keeps global rules and explicit revoke out of restricted devices", async () => {
    const { api } = await browser("restricted");
    expect((await api("/approval-rules")).status).toBe(403);
    expect((await api("/approval-rules?workspaceId=hidden")).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
    const read = await api("/approval-rules?workspaceId=visible");
    expect(read).toMatchObject({
      status: 200,
      body: { rules: [{ id: "rule", scope: "project", revocable: false }] },
    });
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]?.[0]).toMatchObject({ includeGlobal: false });
    expect(
      (
        await api("/approval-rules/revoke", {
          agent: "claude-code",
          ruleId: "rule",
          workspaceId: "visible",
        })
      ).status,
    ).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    // Read-only pairing codes have host-wide workspace reads but none of the settings grants.
    const readOnly = await browser("read");
    expect((await readOnly.api("/approval-rules")).status).toBe(403);
    expect(
      (await readOnly.api("/approval-rules/revoke", { agent: "claude-code", ruleId: "rule" }))
        .status,
    ).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("uses the same provider for trusted desktop and full-access remote clients", async () => {
    const { api } = await browser("full");
    const remote = await api("/approval-rules");
    const local = await service.localRequest("/approval-rules");
    expect(remote).toEqual(local);
    expect(remote.body.rules).toMatchObject([{ scope: "global", revocable: true }]);
    const body = { agent: "claude-code", ruleId: "rule" };
    expect((await api("/approval-rules/revoke", body, { "X-CSRF-Token": "wrong" })).status).toBe(
      403,
    );
    expect(revoke).not.toHaveBeenCalled();
    expect(await api("/approval-rules/revoke", body)).toEqual({
      status: 200,
      body: { revoked: true },
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ includeGlobal: true }),
      "claude-code",
      "rule",
    );
  });

  it("rejects a new symlink in place of the registered workspace before reading or writing", async () => {
    const { api } = await browser("full");
    const visible = join(directory, "visible");
    await rename(visible, join(directory, "previous"));
    await symlink(join(directory, "hidden"), visible, "junction");
    expect((await api("/approval-rules?workspaceId=visible")).status).toBe(403);
    expect(
      (
        await api("/approval-rules/revoke", {
          agent: "claude-code",
          ruleId: "rule",
          workspaceId: "visible",
        })
      ).status,
    ).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("returns a definite read-only refusal for a provider without native revoke", async () => {
    const { api } = await browser("full");
    revoke.mockImplementationOnce((context, agent, ruleId) =>
      nativeApprovalRules.revoke({ ...context, home: directory, env: {} }, agent, ruleId),
    );
    expect(await api("/approval-rules/revoke", { agent: "codex", ruleId: "rule" })).toMatchObject({
      status: 403,
      body: { error: "approval_rule_read_only" },
    });
  });

  it("rechecks a device's grants after loading a page and before a configuration write", async () => {
    const first = await browser("full");
    sessionRequest.mockImplementationOnce(async () => {
      await service.request({ operation: "revoke", id: first.deviceId! });
      return { entries: [{ id: "never-returned" }] };
    });
    const response = await first.api("/approval-audit");
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty("entries");

    const second = await browser("full");
    const write = vi.fn();
    revoke.mockImplementationOnce(async (context) => {
      await service.request({ operation: "revoke", id: second.deviceId! });
      await context.authorizeWrite?.();
      write();
    });
    expect(
      (await second.api("/approval-rules/revoke", { agent: "claude-code", ruleId: "rule" })).status,
    ).toBe(401);
    expect(write).not.toHaveBeenCalled();
  });

  it("attaches authenticated source metadata without changing native decision input", async () => {
    let revision = 4;
    sessionRequest.mockImplementation(async ({ host: { request } }) => {
      if (request.operation === "catalog")
        return {
          workspaces,
          sessions: [{ id: "session", workspace_id: "visible", agent: "codex" }],
        };
      if (request.operation === "live")
        return {
          revision,
          workspaceId: "visible",
          executionMode: "codex-managed",
          runtimeBootId: "runtime",
          turnId: "turn",
          approvals: [
            {
              requestId: 7,
              turnId: "turn",
              supported: true,
              availableDecisions: ["allow", "deny"],
            },
          ],
        };
      if (request.operation === "approve") return { accepted: true, requestId: request.requestId };
      return null;
    });
    const { api, deviceId } = await browser("full");
    const access = await api("/access");
    const body = {
      sessionId: "session",
      bootId: access.body.bootId,
      requestId: randomUUID(),
      expectedRevision: 4,
      turnId: "turn",
      approvalId: 7,
      decision: "deny",
      deviceId: "spoof",
      approvalAudit: { source: { kind: "desktop", deviceId: "spoof" } },
    };
    expect((await api("/approve", body, { "X-AgentKib-Client": "mobile" })).status).toBe(200);
    const approval = sessionRequest.mock.calls
      .map(([input]) => input.host)
      .find((input) => input.request.operation === "approve");
    expect(approval?.approvalAudit?.source).toEqual({ kind: "phone", deviceId });
    expect(approval?.request).toMatchObject({ deviceId, approvalId: 7, decision: "deny" });
    expect(approval?.request).not.toHaveProperty("approvalAudit");

    revision++;
    expect((await api("/approve", { ...body, requestId: randomUUID() })).status).toBe(409);
    await vi.waitFor(() =>
      expect(sessionRequest).toHaveBeenCalledWith({
        host: {
          request: expect.objectContaining({
            operation: "approval-audit-expired",
            sessionId: "session",
            interactionKind: "approval",
          }),
          approvalAudit: expect.objectContaining({
            source: { kind: "web", deviceId },
            decision: { kind: "deny", scope: "once" },
          }),
        },
      }),
    );
    sessionRequest.mockClear();
    expect(
      (await api("/approve", { ...body, requestId: randomUUID(), approvalId: 100 })).status,
    ).toBe(409);
    expect(sessionRequest.mock.calls.map(([input]) => input.host.request.operation)).not.toContain(
      "approval-audit-expired",
    );

    const staleRequestId = randomUUID();
    const stale = await api("/approve", {
      ...body,
      decision: undefined,
      approvalAudit: undefined,
      requestId: staleRequestId,
      bootId: "previous-host-boot",
      interactionRuntimeBootId: "runtime",
      interactionDecisionId: "choice:deny",
    });
    expect(stale).toMatchObject({ status: 409, body: { error: "interaction_expired" } });
    await vi.waitFor(() =>
      expect(sessionRequest).toHaveBeenCalledWith({
        host: {
          request: expect.objectContaining({
            operation: "approval-audit-expired",
            requestId: staleRequestId,
          }),
          approvalAudit: expect.objectContaining({ decision: { kind: "deny", scope: "once" } }),
        },
      }),
    );
  });
});
