// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcp } from "../../../../packages/backend/src/agents/antigravity/antigravity-acp";
import { AntigravitySessionProvider } from "../../../../packages/backend/src/agents/antigravity/session-provider";
import { ClaudeManagedReadOwner } from "../../../../packages/backend/src/agents/claude/claude-managed-read";
import { OrchestrationService } from "../../../../packages/backend/src/orchestration-service";
import type { SessionProviderResponse } from "../../../../packages/backend/src/session-provider";
import { SessionReaders } from "../../../../packages/backend/src/session-readers";
import type { NativeSession } from "../../../../packages/backend/src/session-store";
import { BackendStore } from "../../../../packages/backend/src/store";
import { startBackend, startHost } from "./harness";

const nativeId = "baseline-antigravity-acp";
const localId = "antigravity-local-v1-app-baseline";
const allowed = { available: true };
type Frame = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: object;
  result?: object;
};

function fakeAcp() {
  let notify: (frame: Omit<Frame, "jsonrpc">) => void;
  let promptCapabilities: Record<string, boolean> | undefined;
  const frames: Frame[] = [];
  const config: Record<string, string> = { model: "flash", thought_level: "high", mode: "default" };
  const choices: Record<string, string[]> = {
    model: ["flash", "sonnet"],
    thought_level: ["low", "high"],
    mode: ["default", "accept-edits", "auto", "plan"],
  };
  const configOptions = () =>
    Object.entries(config).map(([id, currentValue]) => ({
      id,
      type: "select",
      currentValue,
      options: choices[id]!.map((value) => ({ value, name: value })),
    }));
  const spawn = vi
    .spyOn(AntigravityAcp, "spawn")
    .mockImplementation((_executable, _args, _cwd, _environment, options) => {
      const fromAgent = new PassThrough();
      const toAgent = new PassThrough();
      const answer = (frame: Omit<Frame, "jsonrpc">) =>
        fromAgent.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
      notify = answer;

      toAgent.setEncoding("utf8");
      toAgent.on("data", (data: string) => {
        const frame = JSON.parse(data) as Frame;
        frames.push(frame);
        if (frame.method === "initialize")
          answer({
            id: frame.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.2.0" },
              agentCapabilities: {
                loadSession: true,
                ...(promptCapabilities && { promptCapabilities }),
              },
            },
          });
        if (frame.method === "session/load")
          answer({ id: frame.id, result: { configOptions: configOptions() } });
        // A session the CLI opens for its options; without a message it is never stored.
        if (frame.method === "session/new")
          answer({
            id: frame.id,
            result: { sessionId: "options-probe", configOptions: configOptions() },
          });
        if (frame.method === "session/set_config_option") {
          const { configId, value } = frame.params as { configId: string; value: string };
          config[configId] = value;
          answer({ id: frame.id, result: { configOptions: configOptions() } });
        }
      });
      return new AntigravityAcp(fromAgent, toAgent, options);
    });
  return {
    frames,
    notify: (frame: Omit<Frame, "jsonrpc">) => notify(frame),
    setPromptCapabilities: (value: Record<string, boolean> | undefined) => {
      promptCapabilities = value;
    },
    spawn,
  };
}

describe("Antigravity session baseline through HTTP, backend RPC and ACP frames", () => {
  let root: string;
  let workspace: string;
  let backend: Awaited<ReturnType<typeof startBackend>>;
  let host: Awaited<ReturnType<typeof startHost>>;
  let acp: ReturnType<typeof fakeAcp>;
  let nativeSessions: NativeSession[];
  let sessionId: string;
  let localSessionId: string;

  const openBackend = (reuseData = false, enableAcp = true) => {
    const home = join(root, "home");
    return startBackend({
      data: join(root, "backend"),
      workspace,
      environment: {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        PATH: root,
        ...(enableAcp ? { AGENTKIB_ENABLE_ANTIGRAVITY_ACP: "1" } : {}),
        AGENTKIB_HOST_ATTACHMENTS_DIRS: JSON.stringify([join(root, "host", "attachments")]),
      },
      indexSessions: true,
      reuseData,
    });
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "ak-baseline-acp-")));
    workspace = join(root, "workspace");
    const data = join(root, "backend");
    const home = join(root, "home");
    await Promise.all([mkdir(workspace), mkdir(home)]);
    nativeSessions = [nativeId, localId].map((native_ref) => ({
      native_ref,
      agent: "antigravity",
      title: "Antigravity baseline history",
      origin: "interactive",
      created_at: null,
      updated_at: null,
      message_count: 2,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
    }));
    const read = SessionReaders.prototype.list;
    vi.spyOn(SessionReaders.prototype, "list").mockImplementation(
      function (this: SessionReaders, agent, cwd, selection) {
        if (agent === "antigravity")
          return Promise.resolve({ sessions: nativeSessions, incomplete: false });
        return read.call(this, agent, cwd, selection);
      },
    );
    vi.spyOn(SessionReaders.prototype, "antigravityControlExecutable").mockReturnValue(
      join(root, "synthetic-acp"),
    );
    vi.spyOn(SessionReaders.prototype, "antigravityReadHandoff").mockResolvedValue({
      compact_summary: null,
      messages: [],
      omitted_tool_count: 0,
      warnings: [],
    });
    acp = fakeAcp();
    backend = await openBackend();
    const store = new BackendStore(join(data, "agentkib.db"));
    try {
      store.sessions.sync("workspace", "antigravity", nativeSessions);
      sessionId = store.sessions.id("antigravity", nativeId);
      localSessionId = store.sessions.id("antigravity", localId);
    } finally {
      store.close();
    }
    host = await startHost({ root, workspace, rpc: backend.rpc, enableClaudeScheduler: true });
  });

  afterEach(async () => {
    try {
      await host?.dispose();
    } finally {
      try {
        await backend?.close();
      } finally {
        vi.restoreAllMocks();
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
  });

  const live = (id = sessionId) => host.http(`/live?sessionId=${id}`);

  it("starts a ninth resumed session while the earlier turns are still running", async () => {
    const others = Array.from({ length: 8 }, (_, index) => ({
      ...nativeSessions[0]!,
      native_ref: `antigravity-concurrency-${index}`,
    }));
    nativeSessions.push(...others);
    const store = new BackendStore(join(root, "backend", "agentkib.db"));
    let sessionIds: string[];
    try {
      store.sessions.sync("workspace", "antigravity", nativeSessions);
      sessionIds = [
        sessionId,
        ...others.map((row) => store.sessions.id("antigravity", row.native_ref)),
      ];
    } finally {
      store.close();
    }
    for (const id of sessionIds) {
      const initial = await live(id);
      expect(
        await host.http("/send", {
          sessionId: id,
          bootId: host.bootId,
          requestId: randomUUID(),
          expectedRevision: initial.body.revision,
          text: "Hold this turn open.",
        }),
      ).toMatchObject({ status: 200, body: { accepted: true } });
    }
    expect(acp.frames.filter(({ method }) => method === "session/prompt")).toHaveLength(9);
    for (const id of sessionIds) {
      expect(await live(id)).toMatchObject({ status: 200, body: { status: "running" } });
    }
  });

  it("keeps control capabilities disabled for desktop and paired clients without opening ACP", async () => {
    const initial = await live();
    const queuedText = "Pending before ACP was disabled";
    expect(
      await backend.rpc(RUNTIME_METHODS.sessionRequest, {
        operation: "queue-add",
        sessionId,
        deviceId: host.deviceId,
        requestId: randomUUID(),
        runtimeBootId: initial.body.runtimeBootId,
        expectedRevision: initial.body.revision,
        experimentalEnabled: true,
        text: queuedText,
      }),
    ).toMatchObject({ result: { accepted: true } });
    await host.dispose();
    await backend.close();
    backend = await openBackend(true, false);
    const reason = "antigravity-acp-disabled";
    host = await startHost({
      root,
      workspace,
      rpc: backend.rpc,
      enableClaudeScheduler: true,
      disabledSessionProviders: { antigravity: reason },
    });
    const unavailable = { available: false, reason };
    for (const read of [host.desktop, host.http]) {
      expect(await read("/access")).toMatchObject({
        status: 200,
        body: { disabledSessionProviders: { antigravity: reason } },
      });
      expect(await read("/managed/options?agent=antigravity&workspaceId=workspace")).toMatchObject({
        status: 200,
        body: { ...unavailable, provider: { create: { mode: "with-first-message" } } },
      });
      expect(await read(`/live?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: { executionMode: "acp-managed", sendEnabled: false, stopEnabled: false, reason },
      });
      expect(await read(`/managed/settings?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: unavailable,
      });
      expect(await read(`/managed/capabilities?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: {
          features: {
            send: unavailable,
            stop: unavailable,
            approve: unavailable,
            answer: unavailable,
            settings: unavailable,
            fork: unavailable,
            "queue-add": unavailable,
            "queue-resume": unavailable,
            "queue-list": allowed,
          },
        },
      });
      expect(await read(`/managed/queue?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: {
          data: [{ text: queuedText, actions: { update: unavailable, delete: unavailable } }],
        },
      });
    }

    const create = await host.http("/managed/create", {
      agent: "antigravity",
      bootId: host.bootId,
      workspaceId: "workspace",
      requestId: randomUUID(),
      prompt: "Must not reach the CLI",
    });
    expect(create).toMatchObject({ status: 409, body: { controlOutcome: "not-dispatched" } });
    const disabledLive = await live();
    await expect(
      backend.rpc(RUNTIME_METHODS.sessionRequest, {
        operation: "send",
        sessionId,
        deviceId: host.deviceId,
        requestId: randomUUID(),
        runtimeBootId: disabledLive.body.runtimeBootId,
        expectedRevision: disabledLive.body.revision,
        experimentalEnabled: true,
        text: "Must not reach the CLI",
      }),
    ).rejects.toThrow(reason);
    await host.tickClaudeQueue();

    const leadId = "offline-claude-lead";
    vi.spyOn(ClaudeManagedReadOwner.prototype, "hasManagedSession").mockImplementation(
      (id) => id === leadId,
    );
    vi.spyOn(ClaudeManagedReadOwner.prototype, "managedWorkspace").mockImplementation((id) =>
      id === leadId ? "workspace" : null,
    );
    expect(
      await backend.rpc("claude.managed", {
        operation: "lead-assignment-options",
        sessionId: leadId,
        deviceId: "agentkib-local-owner",
        candidateIds: [sessionId, localSessionId],
      }),
    ).toMatchObject({
      capable: true,
      candidates: [sessionId, localSessionId].map((id) => ({
        sessionId: id,
        reason: "worker-agent-unsupported",
      })),
    });
    expect(acp.spawn).not.toHaveBeenCalled();
  });

  it("confirms Web permission writes and keeps settings writable on desktop after reopening", async () => {
    const settingsPath = `/managed/settings?sessionId=${sessionId}`;
    let settings = await host.http(settingsPath);
    expect(settings).toMatchObject({
      status: 200,
      body: {
        current: { permissionMode: "default" },
        writable: { permissionMode: allowed },
      },
    });
    for (const permissionMode of ["plan", "default"]) {
      const requestId = randomUUID();
      const revision = settings.body.revision;
      const before = await live();
      const acknowledgement = {
        accepted: true,
        completed: true,
        appliesTo: "next-turn",
        sessionId,
        requestId,
        runtimeBootId: before.body.runtimeBootId,
      };
      const request = permissionMode === "plan" ? host.http : host.desktop;
      const response = await request("/managed/action", {
        operation: "settings",
        agent: "antigravity",
        sessionId,
        bootId: host.bootId,
        requestId,
        expectedRevision: revision,
        permissionMode,
      });
      const receipt = await request(`/requests/${requestId}`);
      expect({ response, receipt, lastFrame: acp.frames.at(-1) }).toMatchObject({
        response: { status: 200, body: acknowledgement },
        receipt: {
          status: 200,
          body: { status: "accepted", expectedRevision: revision, ack: acknowledgement },
        },
        lastFrame: {
          method: "session/set_config_option",
          params: { sessionId: nativeId, configId: "mode", value: permissionMode },
        },
      });
      settings = await host.http(settingsPath);
      expect(settings).toMatchObject({
        status: 200,
        body: {
          applicationStatus: "confirmed",
          current: { permissionMode },
          selected: { permissionMode },
          writable: { permissionMode: allowed },
        },
      });
      expect(Number(settings.body.revision)).toBeGreaterThan(Number(revision));
      expect(await live()).toMatchObject({
        status: 200,
        body: { status: "idle", revision: settings.body.revision, sendEnabled: true, reason: null },
      });
      if (permissionMode === "plan") {
        await host.dispose();
        await backend.close();
        acp = fakeAcp();
        backend = await openBackend(true);
        host = await startHost({ root, workspace, rpc: backend.rpc, enableClaudeScheduler: true });
        settings = await host.http(settingsPath);
        expect(settings).toMatchObject({
          status: 200,
          body: {
            current: { permissionMode: "plan" },
            selected: { permissionMode: "plan" },
            writable: { permissionMode: allowed },
          },
        });
        expect(await host.desktop(settingsPath)).toMatchObject({
          status: 200,
          body: {
            current: { permissionMode: "plan" },
            writable: { permissionMode: allowed },
          },
        });
        expect(acp.frames).toContainEqual(
          expect.objectContaining({
            method: "session/set_config_option",
            params: { sessionId: nativeId, configId: "mode", value: "plan" },
          }),
        );
      }
    }
  });

  it("assigns an ACP worker, reports approvals and replies, and stops its exact turn", async () => {
    const leadId = "offline-claude-lead";
    const deviceId = "agentkib-local-owner";
    const reports: string[] = [];
    vi.spyOn(ClaudeManagedReadOwner.prototype, "hasManagedSession").mockImplementation(
      (id) => id === leadId,
    );
    vi.spyOn(ClaudeManagedReadOwner.prototype, "managedWorkspace").mockImplementation((id) =>
      id === leadId ? "workspace" : null,
    );
    vi.spyOn(ClaudeManagedReadOwner.prototype, "queueReport").mockImplementation(
      (_id, _device, message) => {
        reports.push(message);
        return true;
      },
    );
    let service: OrchestrationService | undefined;
    const assign = OrchestrationService.prototype.assignWorkers;
    vi.spyOn(OrchestrationService.prototype, "assignWorkers").mockImplementation(
      function (this: OrchestrationService, input) {
        service = this;
        return assign.call(this, input);
      },
    );
    const lead = (operation: string, fields: Record<string, unknown> = {}) =>
      backend.rpc("claude.managed", { operation, sessionId: leadId, deviceId, ...fields });
    expect(
      await lead("lead-assignment-options", { candidateIds: [sessionId, localSessionId] }),
    ).toMatchObject({
      capable: true,
      candidates: [
        { sessionId, reason: null },
        { sessionId: localSessionId, reason: "worker-unavailable" },
      ],
    });
    await lead("lead-assign-workers", { workers: [sessionId] });
    await lead("lead-update", { scope: { approvals: ["command"] } });
    expect(acp.spawn).not.toHaveBeenCalled();
    const call = async (name: string, input: Record<string, unknown> = {}) =>
      JSON.parse((await service!.call(leadId, name, { worker: "worker-1", ...input })).text);
    expect(await call("worker_list")).toMatchObject({
      workers: [{ worker: "worker-1", agent: "antigravity", session: sessionId }],
    });
    expect(acp.spawn).not.toHaveBeenCalled();
    expect(await call("worker_send", { text: "Read the handoff", title: "Handoff" })).toMatchObject(
      {
        accepted: true,
        operation: "send",
      },
    );
    const prompt = acp.frames.find((frame) => frame.method === "session/prompt")!;
    expect(prompt.params).toEqual({
      sessionId: nativeId,
      prompt: [{ type: "text", text: "Read the handoff" }],
    });
    const queuePath = `/managed/queue?${new URLSearchParams({ sessionId, agent: "antigravity" })}`;
    const queue = (operation: string, fields: Record<string, unknown> = {}) =>
      live().then(({ body }) =>
        host.http("/managed/action", {
          operation,
          agent: "antigravity",
          sessionId,
          bootId: host.bootId,
          expectedRevision: body.revision,
          requestId: randomUUID(),
          ...fields,
        }),
      );
    expect(await call("worker_send", { text: "Queued by the project Agent" })).toMatchObject({
      accepted: true,
      operation: "queue-add",
    });
    const queued = await host.http(queuePath);
    expect(queued).toMatchObject({
      status: 200,
      body: {
        data: [{ id: expect.any(String), status: "pending", text: "Queued by the project Agent" }],
      },
    });
    const [{ id: queuedSubmissionId }] = queued.body.data as Array<{ id: string }>;
    expect(await queue("queue-pause")).toMatchObject({ status: 200 });
    expect(
      await queue("queue-update", { queuedSubmissionId, text: "Edited by the user" }),
    ).toMatchObject({ status: 200 });
    expect(await host.http(queuePath)).toMatchObject({
      status: 200,
      body: { paused: true, data: [{ id: queuedSubmissionId, text: "Edited by the user" }] },
    });
    expect(await queue("queue-add", { text: "Added by the user" })).toMatchObject({ status: 200 });
    await expect.poll(() => reports.at(-1)).toContain("the user sent it a message directly");
    const both = await host.http(queuePath);
    expect(both).toMatchObject({
      status: 200,
      body: {
        paused: true,
        data: [
          { id: queuedSubmissionId, text: "Edited by the user" },
          { id: expect.any(String), text: "Added by the user" },
        ],
      },
    });
    const userItem = (both.body.data as Array<{ id: string }>)[1]!;
    expect(await queue("queue-delete", { queuedSubmissionId: userItem.id })).toMatchObject({
      status: 200,
    });
    expect(await host.http(queuePath)).toMatchObject({
      status: 200,
      body: { paused: true, data: [{ id: queuedSubmissionId }] },
    });
    expect(acp.frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
    acp.notify({
      id: "worker-permission",
      method: "session/request_permission",
      params: {
        sessionId: nativeId,
        toolCall: {
          toolCallId: "show-brief",
          kind: "execute",
          rawInput: { command: "cat brief.md", cwd: workspace },
        },
        options: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
          { optionId: "reject", name: "Reject once", kind: "reject_once" },
        ],
      },
    });
    await expect.poll(() => reports.at(-1)).toContain("waiting for the user's approval");
    expect(
      await call("worker_approve", { approval: "worker-permission", decision: "accept" }),
    ).toMatchObject({ accepted: true });
    expect(acp.frames.find((frame) => frame.id === "worker-permission")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    acp.notify({
      method: "session/update",
      params: {
        sessionId: nativeId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "visible-reply",
          content: { type: "text", text: "Confirmed the handoff." },
        },
      },
    });
    acp.notify({ id: prompt.id, result: { stopReason: "end_turn" } });
    await expect.poll(() => reports.at(-1)).toContain("turn ended: completed");
    expect(reports.at(-1)).toContain("Confirmed the handoff.");
    expect(await call("worker_read")).toMatchObject({
      status: "idle",
      title: "Handoff",
      replies: [{ text: "Confirmed the handoff." }],
    });
    expect(acp.spawn).toHaveBeenCalledOnce();

    await host.tickClaudeQueue();
    expect(acp.frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
    expect(await queue("queue-resume")).toMatchObject({ status: 200 });
    await host.tickClaudeQueue();
    expect(acp.frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(2);
    const next = acp.frames.filter((frame) => frame.method === "session/prompt").at(-1)!;
    expect(next.params).toEqual({
      sessionId: nativeId,
      prompt: [{ type: "text", text: "Edited by the user" }],
    });
    expect(await host.http(queuePath)).toMatchObject({
      status: 200,
      body: { paused: false, data: [] },
    });
    expect(await call("worker_stop")).toMatchObject({ accepted: true });
    expect(acp.frames.at(-1)).toMatchObject({
      method: "session/cancel",
      params: { sessionId: nativeId },
    });
    acp.notify({ id: next.id, result: { stopReason: "cancelled" } });
    await expect.poll(() => reports.at(-1)).toContain("turn ended: cancelled");
    expect(reports).toHaveLength(4);
  });

  async function accepted(
    operation: "send" | "approve" | "stop",
    state: Record<string, unknown>,
    fields: Record<string, unknown>,
  ) {
    const requestId = randomUUID();
    const response = await host.http(`/${operation}`, {
      requestId,
      sessionId,
      bootId: host.bootId,
      expectedRevision: state.revision,
      ...fields,
    });
    const acknowledgement = {
      accepted: true,
      completed: false,
      sessionId,
      requestId,
      runtimeBootId: state.runtimeBootId,
    };
    expect(response).toEqual({ status: 200, body: acknowledgement });
    expect(host.calls).toContainEqual({
      method: "session.request",
      params: {
        operation,
        sessionId,
        requestId,
        deviceId: host.deviceId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        runtimeBootId: state.runtimeBootId,
        ...fields,
      },
    });
    expect(await host.http(`/requests/${requestId}`)).toMatchObject({
      status: 200,
      body: {
        found: true,
        requestId,
        sessionId,
        workspaceId: "workspace",
        operation,
        executionMode: "antigravity-acp-managed",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        turnId: fields.turnId ?? null,
        status: "accepted",
        ack: acknowledgement,
        completionObserved: false,
      },
    });
    expect(host.calls).toContainEqual({
      method: "control.receipt",
      params: { requestId, deviceId: host.deviceId },
    });
  }

  it("negotiates composer capabilities without attaching a session", async () => {
    const capabilities = await host.http(`/managed/capabilities?sessionId=${sessionId}`);
    const runtimeBootId = capabilities.body.runtimeBootId;
    expect(typeof runtimeBootId).toBe("string");
    expect(capabilities).toMatchObject({
      status: 200,
      body: {
        sessionId,
        executionMode: "acp-managed",
        status: "idle",
        reason: null,
        features: {
          send: allowed,
          stop: { available: false, reason: "session-not-running" },
          approve: { available: false, reason: "no-supported-approval" },
          answer: { available: false, reason: "unsupported-operation" },
          inspect: allowed,
          attachments: {
            available: false,
            attachmentKinds: { image: false, files: false },
          },
          "queue-list": allowed,
          "queue-add": allowed,
          "queue-update": allowed,
          "queue-delete": allowed,
          "queue-pause": allowed,
        },
      },
    });
    expect(await host.http(`/managed/inspect?sessionId=${sessionId}`)).toEqual({
      status: 200,
      body: {
        sessionId,
        executionMode: "acp-managed",
        runtimeBootId,
        status: "idle",
        revision: 0,
        turnId: null,
        approvals: [],
        reason: null,
      },
    });
    expect(await live()).toMatchObject({
      status: 200,
      body: {
        sessionId,
        runtimeBootId,
        executionMode: "acp-managed",
        status: "idle",
        revision: 0,
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        reason: null,
      },
    });
    for (const operation of ["capabilities", "inspect", "live"]) {
      expect(host.calls).toContainEqual({
        method: "session.request",
        params: { operation, sessionId, experimentalEnabled: true },
      });
    }
    expect(acp.spawn).toHaveBeenCalledTimes(1);
    expect(acp.frames.map(({ method }) => method)).toEqual(["initialize"]);
  });

  it("negotiates idle ACP attachments and sends staged image and resource blocks", async () => {
    acp.setPromptCapabilities({ image: true, embeddedContext: true });
    const request = (operation: string, fields: Record<string, unknown> = {}) =>
      backend.rpc(RUNTIME_METHODS.sessionRequest, {
        operation,
        sessionId,
        deviceId: host.deviceId,
        experimentalEnabled: true,
        ...fields,
      });
    const initial = (await request("live")) as SessionProviderResponse<"live">;
    expect(acp.frames).toEqual([]);
    const caps = await Promise.all([request("capabilities"), request("capabilities")]);
    for (const result of caps) {
      expect(result).toMatchObject({
        result: {
          features: {
            attachments: {
              available: true,
              attachmentKinds: { image: true, files: true },
            },
          },
        },
      });
    }
    expect(acp.frames.map(({ method }) => method)).toEqual(["initialize"]);

    const staged = join(root, "backend", "attachments");
    await mkdir(staged, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
      "base64",
    );
    const note = Buffer.from("Antigravity context");
    const put = async (name: string, mime: string, bytes: Buffer) => {
      const id = randomUUID();
      await writeFile(join(staged, id), bytes);
      return {
        type: "acpAttachment",
        id,
        name,
        mime,
        size: bytes.length,
        version: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const [image, file] = await Promise.all([
      put("capture.png", "image/png", png),
      put("notes.txt", "text/plain", note),
    ]);
    const result = await request("send", {
      requestId: randomUUID(),
      runtimeBootId: initial.result.runtimeBootId,
      expectedRevision: initial.result.revision,
      text: "Check the attachments",
      input: [{ type: "text", text: "Check the attachments" }, image, file],
    });
    expect(result).toMatchObject({ result: { accepted: true } });
    const uri = pathToFileURL(join(staged, file.id)).href;
    expect(acp.frames.filter(({ method }) => method === "session/prompt")).toMatchObject([
      {
        params: {
          prompt: [
            { type: "text", text: "Check the attachments" },
            { type: "image", mimeType: "image/png", data: png.toString("base64") },
            {
              type: "resource",
              resource: { uri, mimeType: "text/plain", blob: note.toString("base64") },
            },
            { type: "text", text: expect.stringContaining("[notes.txt](") },
          ],
        },
      },
    ]);
  });

  it("sends a staged Web file from the configured host store outside the backend data directory", async () => {
    acp.setPromptCapabilities({ embeddedContext: true });
    const data = { note: "A file uploaded through the host" };
    const upload = await host.http(
      `/attachments?sessionId=${sessionId}&name=notes.txt&mime=text%2Fplain`,
      data,
    );
    expect(upload).toMatchObject({ status: 201, body: { id: expect.any(String) } });
    const before = await live();
    const response = await host.http("/send", {
      sessionId,
      bootId: host.bootId,
      requestId: randomUUID(),
      expectedRevision: before.body.revision,
      text: "",
      attachmentIds: [upload.body.id],
    });
    expect(response).toMatchObject({ status: 200, body: { accepted: true } });
    const uri = pathToFileURL(join(root, "host", "attachments", String(upload.body.id))).href;
    expect(acp.frames.find(({ method }) => method === "session/prompt")).toMatchObject({
      params: {
        prompt: [
          {
            type: "resource",
            resource: {
              uri,
              mimeType: "text/plain",
              blob: Buffer.from(JSON.stringify(data)).toString("base64"),
            },
          },
          { type: "text", text: expect.stringContaining("[notes.txt](") },
        ],
      },
    });
  });

  it("keeps the serial queue on the typed RPC without opening another ACP transport", async () => {
    const provider = vi.spyOn(AntigravitySessionProvider.prototype, "request");
    const interventions = vi.spyOn(OrchestrationService.prototype, "laneControlled");
    const scope = { sessionId, deviceId: host.deviceId, experimentalEnabled: true };
    const request = (operation: string, fields: Record<string, unknown> = {}) =>
      backend.rpc(RUNTIME_METHODS.sessionRequest, { operation, ...scope, ...fields });
    const initial = (await request("live")) as SessionProviderResponse<"live">;
    expect(initial).toMatchObject({
      operation: "live",
      result: { sessionId, status: "idle", revision: 0, execution: { owner: "agentkib" } },
    });
    const { runtimeBootId } = initial.result;
    expect(await request("capabilities")).toMatchObject({
      operation: "capabilities",
      result: {
        sessionId,
        runtimeBootId,
        execution: { owner: "agentkib" },
        features: { send: allowed, "queue-list": allowed, "queue-add": allowed },
      },
    });
    expect(acp.frames.map(({ method }) => method)).toEqual(["initialize"]);

    expect(
      await request("send", {
        requestId: randomUUID(),
        runtimeBootId,
        expectedRevision: initial.result.revision,
        text: "Start the ACP turn",
      }),
    ).toMatchObject({ operation: "send", result: { accepted: true, sessionId } });
    const running = (await request("live")) as SessionProviderResponse<"live">;
    expect(running.result).toMatchObject({ sessionId, status: "running", sendEnabled: false });

    const requestId = randomUUID();
    const text = "Follow up after the ACP turn";
    expect(
      await request("queue-add", {
        requestId,
        runtimeBootId,
        expectedRevision: running.result.revision,
        text,
      }),
    ).toMatchObject({
      operation: "queue-add",
      result: { accepted: true, completed: false, requestId, sessionId },
    });
    expect(await request("queue-list")).toMatchObject({
      operation: "queue-list",
      result: { sessionId, paused: false, data: [{ status: "pending", text }] },
    });
    expect(provider.mock.calls.map(([value]) => value.operation)).toEqual([
      "live",
      "capabilities",
      "send",
      "live",
      "queue-add",
      "queue-list",
    ]);
    expect(interventions.mock.calls.filter(([id]) => id === sessionId)).toEqual([
      [sessionId, "send"],
      [sessionId, "queue-add"],
    ]);
    expect(acp.spawn).toHaveBeenCalledTimes(2);
    expect(acp.frames.map(({ method }) => method)).toEqual([
      "initialize",
      "initialize",
      "session/load",
      "session/prompt",
    ]);
  });

  it("dispatches prompt, permission choice and cancellation to the attached ACP session", async () => {
    const initial = await live();
    expect(initial).toMatchObject({ status: 200, body: { status: "idle", revision: 0 } });
    await accepted("send", initial.body, { text: "Continue the baseline session" });
    const sending = (await live()).body;
    const turnId = sending.turnId as string;
    expect(sending).toMatchObject({
      status: "running",
      revision: 2,
      sendEnabled: false,
      stopEnabled: true,
    });
    expect(acp.spawn).toHaveBeenCalledExactlyOnceWith(
      join(root, "synthetic-acp"),
      [],
      workspace,
      expect.objectContaining({ HOME: join(root, "home") }),
      { timeout: 15_000, version: "0.15.1" },
    );
    expect(acp.frames.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { session: { compaction: {} } },
          clientInfo: { name: "agentkib", version: "0.15.1" },
        },
      },
      { method: "session/load", params: { sessionId: nativeId, cwd: workspace, mcpServers: [] } },
      {
        method: "session/prompt",
        params: {
          sessionId: nativeId,
          prompt: [{ type: "text", text: "Continue the baseline session" }],
        },
      },
    ]);
    const prompt = acp.frames[2]!;
    expect(turnId).toBe(String(prompt.id));
    acp.notify({
      id: "acp-approval",
      method: "session/request_permission",
      params: {
        sessionId: nativeId,
        toolCall: {
          toolCallId: "read-notes",
          kind: "read",
          rawInput: { path: join(workspace, "notes.txt") },
        },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    });
    await expect
      .poll(async () => (await live()).body)
      .toMatchObject({
        status: "waiting-approval",
        approvals: [
          {
            requestId: "acp-approval",
            turnId,
            supported: true,
            availableDecisions: ["allow-once"],
          },
        ],
      });
    await accepted("approve", (await live()).body, {
      turnId,
      approvalId: "acp-approval",
      decision: "allow-once",
    });
    expect(acp.frames[3]).toEqual({
      jsonrpc: "2.0",
      id: "acp-approval",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    const running = (await live()).body;
    expect(running).toMatchObject({ status: "running", turnId, approvals: [] });
    await accepted("stop", running, { turnId });
    expect(acp.frames[4]).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: nativeId },
    });
    expect((await live()).body).toMatchObject({ status: "running", turnId, cancelling: true });
    acp.notify({ id: prompt.id, result: { stopReason: "cancelled" } });
    await expect
      .poll(async () => (await live()).body)
      .toMatchObject({
        status: "idle",
        turnId: null,
        completedTurnId: turnId,
        sendEnabled: true,
        stopEnabled: false,
        cancelling: false,
      });
  });

  it.each([{}])(
    "declines creation without a first message (%j) at HTTP admission",
    async (fields) => {
      const requestId = randomUUID();
      expect(
        await host.http("/managed/create", {
          agent: "antigravity",
          workspaceId: "workspace",
          bootId: host.bootId,
          requestId,
          ...fields,
        }),
      ).toMatchObject({
        status: 400,
        body: { error: "missing_prompt" },
      });
      expect(await host.http(`/requests/${requestId}`)).toEqual({
        status: 200,
        body: { found: false, requestId },
      });
      expect(acp.frames).toEqual([]);
    },
  );

  it.each([
    [
      "/managed/action",
      { agent: "antigravity", operation: "steer", text: "Add to turn" },
      "capability_unavailable",
    ],
    [
      "/managed/action",
      { agent: "antigravity", operation: "queue-steer", queuedSubmissionId: "not-native" },
      "capability_unavailable",
    ],
    [
      "/answer",
      { turnId: "fixture-turn", questionId: "question", answers: { question: ["A"] } },
      "question_unavailable",
    ],
  ] as const)("rejects unsupported %s payload %j", async (path, fields, error) => {
    const requestId = randomUUID();
    expect(
      await host.http(path, {
        sessionId,
        requestId,
        bootId: host.bootId,
        expectedRevision: 0,
        ...fields,
      }),
    ).toMatchObject({ status: 409, body: { error, controlOutcome: "not-dispatched" } });
    expect(await host.http(`/requests/${requestId}`)).toEqual({
      status: 200,
      body: { found: false, requestId },
    });
    expect(acp.frames.filter(({ method }) => method !== "initialize")).toEqual([]);
  });

  it("keeps Antigravity desktop history read only and offers the CLI's creation options", async () => {
    expect(
      await host.http("/managed/options?agent=antigravity&workspaceId=workspace"),
    ).toMatchObject({
      status: 200,
      body: {
        available: true,
        models: [
          { id: "flash", efforts: ["low", "high"] },
          { id: "sonnet", efforts: ["low", "high"] },
        ],
        permissionModes: [
          { id: "default" },
          { id: "accept-edits" },
          { id: "auto" },
          { id: "plan" },
        ],
      },
    });
    // The options came from a session without a message, which the CLI never stores.
    expect(acp.frames.filter((frame) => frame.method === "session/prompt")).toEqual([]);
    acp.frames.length = 0;
    const state = await live(localSessionId);
    expect(state).toMatchObject({
      status: 200,
      body: {
        status: "unsupported",
        sendEnabled: false,
        stopEnabled: false,
        reason: "session-read-only",
      },
    });
    expect(
      await host.http("/send", {
        sessionId: localSessionId,
        bootId: host.bootId,
        requestId: randomUUID(),
        expectedRevision: state.body.revision,
        text: "Continue read-only history",
      }),
    ).toMatchObject({
      status: 409,
      body: { error: "control_unavailable", controlOutcome: "not-dispatched" },
    });
    expect(acp.frames).toEqual([]);
  });
});
