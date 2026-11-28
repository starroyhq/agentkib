// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { REMOTE_ERROR_CODES, RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Commands } from "../../../../packages/backend/src/commands";
import { PROJECT_AGENT_LOCAL_OWNER } from "../../../../packages/backend/src/orchestration-request";
import { seedClaudeHandoverSettings } from "../../../../qa/fixtures/session-shapes/claude-handover-settings.mjs";
import { createFakeClaude } from "../fixtures/claude-fake-cli";
import { startBackend, startHost } from "./harness";

const workspaceId = "workspace";
const agent = "claude-code";
const executionMode = "claude-managed";
const unconfirmed = REMOTE_ERROR_CODES.controlOutcomeUnconfirmed;

describe.skipIf(process.platform === "win32")("Claude handover recovery invariants", () => {
  it("recovers an adopted session with an orphaned settings dispatch without replay", async () => {
    const cli = createFakeClaude("agentkib-claude-handover-shape-");
    cli.setPlan({
      noResult: true,
      controlResponses: {
        initialize: { current_permission_mode: "auto" },
        get_settings: { applied: { model: "fixture-model" } },
      },
    });
    const dataDir = join(cli.root, "backend");
    const openRuntime = (reuseData: boolean) =>
      startBackend({
        data: dataDir,
        workspace: cli.workspace,
        environment: cli.environment,
        reuseData,
      });
    const run = Commands.prototype.run;
    const ownership = vi
      .spyOn(Commands.prototype, "run")
      .mockImplementation(function (this: Commands, program, args, options) {
        const command = args.join(" ");
        let output: string | undefined;
        if (program === "/bin/ps" && command === "-axo pid=,pgid=,lstart=,command=") output = "";
        if (program === cli.executable && command === "--version")
          output = "2.1.286 (Claude Code)\n";
        if (program === cli.executable && command === "agents --json") output = "[]\n";
        return output === undefined
          ? run.call(this, program, args, options)
          : Promise.resolve({
              success: true,
              bytes: Buffer.from(output),
              error: "",
              truncated: false,
              exitCode: 0,
            });
      });
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    onTestFinished(async () => {
      try {
        await host?.dispose();
      } finally {
        try {
          await backend?.close();
        } finally {
          ownership.mockRestore();
          rmSync(cli.root, { recursive: true, force: true });
        }
      }
    });

    backend = await openRuntime(false);
    const restart = async () => {
      await backend!.close();
      backend = undefined;
      backend = await openRuntime(true);
    };
    const paired = await startHost({
      root: cli.root,
      workspace: cli.workspace,
      rpc: (method, params) => backend!.rpc(method, params),
    });
    host = paired;
    const lead = await paired.http("/managed/create", {
      agent,
      bootId: paired.bootId,
      workspaceId,
      requestId: randomUUID(),
    });
    expect(lead).toMatchObject({
      status: 200,
      body: { accepted: true, sessionId: expect.any(String) },
    });
    const leadId = String(lead.body.sessionId);
    const leadLive = await paired.http(`/live?sessionId=${leadId}`);
    expect(leadLive.body.runtimeBootId).toBeTypeOf("string");

    await backend.close();
    backend = undefined;
    const { sessionId, settingsRequestId, turnId, transcriptPath } = seedClaudeHandoverSettings({
      dataDir,
      workspaceId,
      workspace: cli.workspace,
      home: cli.config,
      deviceId: paired.deviceId,
      previousBootId: String(leadLive.body.runtimeBootId),
    });
    backend = await openRuntime(true);

    const live = () => paired.http(`/live?sessionId=${sessionId}`);
    const capabilities = () =>
      paired.http(`/managed/capabilities?agent=${agent}&sessionId=${sessionId}`);
    const settings = () => paired.http(`/managed/settings?sessionId=${sessionId}`);
    const receipt = (requestId: string) => paired.http(`/requests/${requestId}`);
    const settingsReceipt = () => receipt(settingsRequestId);
    const catalogRow = async () => {
      const response = await paired.http("/catalog");
      expect(response.status).toBe(200);
      return (response.body.sessions as { id: string }[]).find((row) => row.id === sessionId);
    };
    const project = (operation: string, fields: Record<string, unknown>) =>
      backend!.rpc(RUNTIME_METHODS.claudeManaged, {
        operation,
        sessionId: leadId,
        deviceId: PROJECT_AGENT_LOCAL_OWNER,
        ...fields,
      });
    const assignment = () => project("lead-assignment-options", { candidateIds: [sessionId] });
    const transcriptHash = () =>
      createHash("sha256").update(readFileSync(transcriptPath)).digest("hex");
    const originalHash = transcriptHash();
    const expectBlocked = async () => {
      const detail = await live();
      expect(detail).toMatchObject({
        status: 200,
        body: { executionMode, status: "outcome-unknown", sendEnabled: false },
      });
      expect(await catalogRow()).toMatchObject({
        executionMode,
        continuation: {
          executionLocation: null,
          status: "outcome-unknown",
          reason: unconfirmed,
        },
      });
      expect(await capabilities()).toMatchObject({
        status: 200,
        body: {
          executionMode,
          features: {
            send: { available: false },
            settings: { available: false },
            reconcile: { available: true },
          },
        },
      });
      expect(await settings()).toMatchObject({
        status: 200,
        body: { executionMode, selected: { permissionMode: "auto" } },
      });
      expect(await assignment()).toMatchObject({
        candidates: [{ sessionId, reason: unconfirmed }],
      });
      expect(await settingsReceipt()).toMatchObject({
        status: 200,
        body: { status: "unknown", ack: null },
      });
      return detail.body.runtimeBootId;
    };
    const firstBoot = await expectBlocked();
    await restart();
    expect(await expectBlocked()).not.toBe(firstBoot);
    expect(cli.frames()).toEqual([]);

    const reconcileId = randomUUID();
    const reconcile = () =>
      paired.http("/managed/reconcile", {
        agent,
        sessionId,
        requestId: reconcileId,
        bootId: paired.bootId,
      });
    const settled = await reconcile();
    expect(settled).toMatchObject({
      status: 200,
      body: { reconciled: true, live: { status: "idle", turnId } },
    });
    expect(await reconcile()).toEqual(settled);
    const oldResult = {
      status: 200,
      body: {
        status: "unknown",
        operation: "settings",
        completionObserved: false,
        ack: { recovery: "orphaned-claude-command", controlOutcome: "unknown" },
      },
    };
    expect(await settingsReceipt()).toMatchObject(oldResult);
    expect(await receipt(turnId)).toMatchObject({
      status: 200,
      body: { status: "accepted", operation: "send", completionObserved: true },
    });
    expect(cli.frames()).toEqual([]);
    expect(transcriptHash()).toBe(originalHash);

    await restart();
    expect(await settingsReceipt()).toMatchObject(oldResult);
    const ready = await live();
    expect(ready).toMatchObject({
      status: 200,
      body: { executionMode, status: "idle", turnId, sendEnabled: true },
    });
    expect(await catalogRow()).toMatchObject({
      executionMode,
      continuation: { executionLocation: "agentkib", status: "idle" },
    });
    expect(await capabilities()).toMatchObject({
      status: 200,
      body: {
        executionMode,
        features: { send: { available: true }, settings: { available: true } },
      },
    });
    expect(await settings()).toMatchObject({
      status: 200,
      body: { executionMode, selected: { permissionMode: "auto" } },
    });
    expect(await assignment()).toMatchObject({
      capable: true,
      candidates: [
        {
          sessionId,
          reason: null,
          eligibility: { executionSide: "agentkib", availability: { available: true } },
        },
      ],
    });
    expect(await project("lead-assign-workers", { workers: [sessionId] })).toMatchObject({
      lead: { workers: [expect.objectContaining({ sessionId })] },
    });

    const requestId = randomUUID();
    const text = "New synthetic input after recovery.";
    const userFrames = () => cli.frames().filter((frame) => frame.type === "user");
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    void promise.catch(() => undefined);
    const read = () => {
      try {
        if (userFrames().some((frame) => frame.uuid === requestId)) resolve();
      } catch (error) {
        reject(error);
      }
    };
    const watcher = watch(cli.root, { persistent: false }, read);
    watcher.once("error", reject);
    watcher.once("close", () => reject(new Error("Claude fixture closed before the new input")));
    onTestFinished(() => watcher.close());
    try {
      expect(
        await paired.http("/send", {
          sessionId,
          requestId,
          bootId: paired.bootId,
          expectedRevision: ready.body.revision,
          text,
        }),
      ).toMatchObject({ status: 200, body: { accepted: true, requestId } });
      read();
      await promise;
      expect(await settingsReceipt()).toMatchObject(oldResult);
    } finally {
      watcher.close();
    }
    await backend.close();
    backend = undefined;
    expect(userFrames()).toMatchObject([
      { uuid: requestId, message: { role: "user", content: text } },
    ]);
  });
});
