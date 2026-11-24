// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedRunnerProcess } from "../../../../packages/backend/src/agents/claude/claude-managed-runner";
import { Commands } from "../../../../packages/backend/src/commands";
import { readControlReceipt } from "../../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
} from "../../../../packages/backend/src/managed-ledger";
import { createFakeClaude } from "../fixtures/claude-fake-cli";
import { startBackend, startHost } from "./harness";

const agent = "claude-code";
const executionMode = "claude-managed";
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
};
type Body = Record<string, unknown>;

describe.skipIf(process.platform === "win32")(
  "Claude session baseline through HTTP, backend RPC, and stream-json",
  () => {
    let cli: ReturnType<typeof createFakeClaude>;
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
    let host: Awaited<ReturnType<typeof startHost>>;
    const dataDir = () => join(cli.root, "backend");
    beforeEach(async () => {
      cli = createFakeClaude("agentkib-baseline-claude-");
      const run = Commands.prototype.run;
      vi.spyOn(Commands.prototype, "run").mockImplementation(
        function (this: Commands, program, args, options) {
          const command = args.join(" ");
          // The ownership probe sees no external Claude process in the isolated fixture.
          let output: string | undefined;
          if (program === "/bin/ps" && command === "-axo pid=,pgid=,lstart=,command=") output = "";
          if (program === cli.executable && command === "--version")
            output = "2.1.286 (Claude Code)\n";
          if (program === cli.executable && command === "agents --json") output = "[]\n";
          if (output !== undefined)
            return Promise.resolve({
              success: true,
              bytes: Buffer.from(output),
              error: "",
              truncated: false,
              exitCode: 0,
            });
          return run.call(this, program, args, options);
        },
      );
      await openRuntime();
      host = await startHost({
        root: cli.root,
        workspace: cli.workspace,
        rpc: (method, params) => backend!.rpc(method, params),
        enableClaudeScheduler: true,
      });
    });

    async function openRuntime(reuseData = false) {
      backend = await startBackend({
        data: dataDir(),
        reuseData,
        workspace: cli.workspace,
        environment: {
          ...cli.environment,
          USERPROFILE: cli.environment.HOME,
          CODEX_HOME: join(cli.environment.HOME, ".codex"),
          DSH_HOME: join(cli.environment.HOME, ".dsh"),
          AGENTKIB_HOME: join(cli.environment.HOME, ".agentkib"),
        },
      });
    }

    afterEach(async () => {
      try {
        await host?.dispose();
      } finally {
        try {
          await backend?.close();
        } finally {
          if (cli) rmSync(cli.root, { recursive: true, force: true });
          vi.restoreAllMocks();
        }
      }
    });

    async function receipt(
      requestId: string,
      sessionId: string,
      operation: string,
      fields: Body = {},
    ) {
      expect(await host.http(`/requests/${requestId}`)).toMatchObject({
        status: 200,
        body: {
          found: true,
          status: "accepted",
          requestId,
          sessionId,
          operation,
          workspaceId: "workspace",
          executionMode,
          ack: { accepted: true, requestId, sessionId },
          ...fields,
        },
      });
    }

    async function create(prompt?: string) {
      const requestId = randomUUID();
      const response = await host.http("/managed/create", {
        agent,
        bootId: host.bootId,
        workspaceId: "workspace",
        requestId,
        ...(prompt === undefined ? {} : { prompt }),
      });
      expect(response).toMatchObject({
        status: 200,
        body: { accepted: true, requestId, sessionId: expect.any(String) },
      });
      const sessionId = String(response.body.sessionId);
      expect(host.calls).toContainEqual({
        method: "session.request",
        params: {
          operation: "provider-create",
          agent,
          workspaceId: "workspace",
          requestId,
          deviceId: host.deviceId,
        },
      });
      await receipt(requestId, sessionId, "create");
      return sessionId;
    }

    async function live(sessionId: string) {
      const response = await host.http(`/live?sessionId=${sessionId}`);
      expect(response).toMatchObject({
        status: 200,
        body: { executionMode, revision: expect.any(Number) },
      });
      expect(host.calls).toContainEqual({
        method: "session.request",
        params: { operation: "live", sessionId, experimentalEnabled: true },
      });
      return response.body;
    }

    async function control(sessionId: string, path: string, operation: string, fields: Body) {
      const requestId = randomUUID();
      const { revision } = await live(sessionId);
      const response = await host.http(path, {
        sessionId,
        requestId,
        bootId: host.bootId,
        expectedRevision: revision,
        ...(path === "/managed/action" ? { operation, agent } : {}),
        ...fields,
      });
      expect(response).toMatchObject({
        status: 200,
        body: {
          accepted: true,
          completed: operation === "settings",
          requestId,
          sessionId,
          runtimeBootId: expect.any(String),
        },
      });
      expect(host.calls).toContainEqual(
        expect.objectContaining({
          method: "session.request",
          params: expect.objectContaining({
            operation,
            requestId,
            deviceId: host.deviceId,
            sessionId,
            expectedRevision: revision,
            experimentalEnabled: true,
            runtimeBootId: expect.any(String),
            ...fields,
          }),
        }),
      );
      await receipt(requestId, sessionId, operation);
      return { requestId, response };
    }

    const userFrames = () => cli.frames().filter((frame) => frame.type === "user");
    const commands = () =>
      cli
        .frames()
        .filter((frame) => frame.type === "control_request")
        .map((frame) => frame.request);

    it.each([
      ["without a first message", undefined],
      ["with an ignored first message", "Ignored at creation"],
    ])("creates an idle record %s", async (_label, prompt) => {
      const sessionId = await create(prompt);
      expect(await live(sessionId)).toMatchObject({
        status: "idle",
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
      });
      expect(cli.frames()).toEqual([]);
    });

    const submit = (request: Body) => backend!.rpc(RUNTIME_METHODS.claudeManaged, request);
    const findReceipt = (requestId: string, deviceId = host.deviceId) =>
      backend!.rpc(RUNTIME_METHODS.controlReceipt, { requestId, deviceId });

    async function receiptRequest(sessionId: string, operation = "send") {
      const view = await live(sessionId);
      return {
        operation,
        sessionId,
        requestId: randomUUID(),
        deviceId: host.deviceId,
        expectedRevision: view.revision,
        runtimeBootId: view.runtimeBootId,
        experimentalEnabled: true,
        text: "Receipt baseline",
      };
    }

    it("returns the same send acknowledgment once and isolates it by device", async () => {
      cli.setPlan({ noResult: true });
      const sessionId = await create();
      const request = await receiptRequest(sessionId);
      const ack = await submit(request);
      expect(ack).toMatchObject({
        accepted: true,
        completed: false,
        requestId: request.requestId,
        sessionId,
        runtimeBootId: request.runtimeBootId,
        controlOutcome: "accepted",
      });
      await expect(submit(Object.fromEntries(Object.entries(request).reverse()))).resolves.toEqual(
        ack,
      );
      await expect(submit({ ...request, text: "Different input" })).rejects.toThrow(
        "request-id-reused-with-different-input",
      );
      const otherDevice = "baseline-other-device";
      await expect(submit({ ...request, deviceId: otherDevice })).rejects.toThrow(
        "request-id-reused-with-different-input",
      );
      await expect(findReceipt(request.requestId, otherDevice)).resolves.toEqual({
        found: false,
        requestId: request.requestId,
      });
      expect(await host.http("/requests/" + request.requestId)).toEqual({
        status: 200,
        body: {
          found: true,
          requestId: request.requestId,
          sessionId,
          workspaceId: "workspace",
          operation: "send",
          executionMode,
          runtimeBootId: request.runtimeBootId,
          expectedRevision: request.expectedRevision,
          turnId: null,
          status: "accepted",
          completionObserved: false,
          ack,
        },
      });
      await expect
        .poll(userFrames)
        .toMatchObject([
          { uuid: request.requestId, message: { role: "user", content: request.text } },
        ]);
    });

    it("serializes duplicate sends while the first native dispatch is pending", async () => {
      cli.setPlan({ noResult: true });
      const sessionId = await create();
      const request = await receiptRequest(sessionId);
      const { promise: release, resolve } = Promise.withResolvers<void>();
      const send = ClaudeManagedRunnerProcess.prototype.send;
      const recorded = vi
        .spyOn(ClaudeManagedRunnerProcess.prototype, "send")
        .mockImplementationOnce(async function (...args) {
          await send.apply(this, args);
          await release;
        });
      const first = submit(request);
      void first.catch(() => undefined);
      let duplicate: Promise<unknown> | undefined;
      try {
        await expect
          .poll(userFrames)
          .toMatchObject([
            { uuid: request.requestId, message: { role: "user", content: request.text } },
          ]);
        expect(
          readControlReceipt(dataDir(), {
            requestId: request.requestId,
            deviceId: request.deviceId,
          }),
        ).toMatchObject({ found: true, status: "unknown", ack: null });
        duplicate = submit(request);
        void duplicate.catch(() => undefined);
      } finally {
        resolve();
        await first;
      }
      const ack = await first;
      expect(ack).toMatchObject({ accepted: true, controlOutcome: "accepted" });
      await expect(duplicate).resolves.toEqual(ack);
      await expect(findReceipt(request.requestId)).resolves.toMatchObject({
        found: true,
        status: "accepted",
        ack,
      });
      expect(recorded).toHaveBeenCalledTimes(1);
    });

    it("replays send and host queue acknowledgments after reboot with a fresh boot ID", async () => {
      const sessionId = await create();
      const send = await receiptRequest(sessionId);
      const sent = await submit(send);
      await expect.poll(() => live(sessionId)).toMatchObject({ status: "idle" });
      const queue = await receiptRequest(sessionId, "queue-add");
      const queued = await submit(queue);
      const receipts = await Promise.all(
        [send, queue].map(({ requestId }) => findReceipt(requestId)),
      );
      expect(receipts).toMatchObject([
        { status: "accepted", completionObserved: true, ack: sent },
        { status: "accepted", operation: "queue-add", ack: queued },
      ]);

      await backend!.close();
      backend = undefined;
      await openRuntime(true);
      const { runtimeBootId } = await live(sessionId);
      expect(runtimeBootId).toBeTypeOf("string");
      expect(runtimeBootId).not.toBe(send.runtimeBootId);
      await expect(submit(send)).rejects.toThrow("invalid-managed-control");
      await expect(submit({ ...send, runtimeBootId })).resolves.toEqual(sent);
      await expect(submit({ ...queue, runtimeBootId })).resolves.toEqual(queued);
      await expect(
        Promise.all([send, queue].map(({ requestId }) => findReceipt(requestId))),
      ).resolves.toEqual(receipts);
      expect(userFrames()).toHaveLength(1);
      expect(await host.http("/managed/queue?sessionId=" + sessionId)).toMatchObject({
        status: 200,
        body: { data: [{ text: queue.text, status: "pending" }] },
      });
    });

    it.each([
      { operation: "send", dispatched: false },
      { operation: "queue-add", dispatched: false },
      { operation: "send", dispatched: true },
    ])(
      "reads a preexisting $operation fingerprint (dispatched: $dispatched)",
      async ({ operation, dispatched }) => {
        const sessionId = await create();
        const request = {
          ...(await receiptRequest(sessionId, operation)),
          input: undefined,
          ...(operation === "send" ? { schedulePermitId: randomUUID() } : {}),
        };
        // Legacy send omits absent keys and its transient permit. The host transaction
        // includes an explicit undefined input as null. Both omit the runtime boot ID.
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              deviceId: request.deviceId,
              expectedRevision: request.expectedRevision,
              experimentalEnabled: request.experimentalEnabled,
              ...(operation === "queue-add" ? { input: null } : {}),
              operation,
              requestId: request.requestId,
              sessionId,
              text: request.text,
            }),
          )
          .digest("hex");
        expect(
          claimManagedCommand(
            dataDir(),
            request.requestId,
            sessionId,
            fingerprint,
            request.deviceId,
            {
              operation,
              workspaceId: "workspace",
              runtimeBootId: "previous-backend",
              executionMode,
            },
          ),
        ).toBeNull();

        if (dispatched) {
          dispatchManagedCommand(dataDir(), request.requestId);
          await expect(findReceipt(request.requestId)).resolves.toMatchObject({
            found: true,
            status: "unknown",
            completionObserved: false,
            ack: null,
          });
          await expect(submit(request)).resolves.toEqual({
            accepted: false,
            completed: false,
            requestId: request.requestId,
            controlOutcome: "unknown",
            reason: "control-outcome-unconfirmed",
          });
        } else {
          const ack = {
            accepted: true,
            completed: false,
            controlOutcome: "accepted",
            requestId: request.requestId,
            sessionId,
            runtimeBootId: "previous-backend",
          };
          finishManagedCommand(dataDir(), request.requestId, ack);
          await expect(submit(request)).resolves.toEqual(ack);
          await expect(findReceipt(request.requestId)).resolves.toMatchObject({
            status: "accepted",
            ack,
          });
        }
        expect(userFrames()).toEqual([]);
      },
    );

    it("passes send and next-priority steering to the CLI, queues locally, and stops", async () => {
      cli.setPlan({ noResult: true });
      const stop = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "stop");
      const sessionId = await create();
      const sent = await control(sessionId, "/send", "send", { text: "Initial text" });
      const running = await live(sessionId);
      expect(running).toMatchObject({
        status: "running",
        turnId: expect.any(String),
        stopEnabled: true,
      });
      await control(sessionId, "/managed/action", "steer", {
        turnId: running.turnId,
        text: "Steering text",
      });
      const queued = await control(sessionId, "/managed/action", "queue-add", {
        text: "Queued text",
      });
      expect(queued.response.body).toMatchObject({
        queuedSubmission: {
          id: expect.any(String),
          requestId: expect.any(String),
          clientUserMessageId: queued.requestId,
          status: "pending",
        },
      });
      await expect.poll(userFrames).toMatchObject([
        { type: "user", uuid: running.turnId, message: { role: "user", content: "Initial text" } },
        { type: "user", priority: "next", message: { role: "user", content: "Steering text" } },
      ]);
      expect(await host.http(`/managed/queue?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: { data: [{ text: "Queued text", status: "pending" }] },
      });
      const stopped = await control(sessionId, "/stop", "stop", { turnId: running.turnId });
      expect(stop).toHaveBeenCalledExactlyOnceWith(running.turnId, expect.any(Number));
      expect((stop.mock.contexts[0] as ClaudeManagedRunnerProcess).hasWorker).toBe(false);
      expect(commands()).toEqual([{ subtype: "initialize", hooks: null }]);
      await expect
        .poll(() => live(sessionId))
        .toMatchObject({
          status: "idle",
          turnId: running.turnId,
          stopEnabled: false,
          lastOutcome: "cancelled",
        });
      await host.tickClaudeQueue();
      expect(userFrames()).toHaveLength(2);
      expect(await host.http(`/managed/queue?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: { paused: true, data: [{ text: "Queued text", status: "pending" }] },
      });
      await receipt(sent.requestId, sessionId, "send", { completionObserved: true });
      await receipt(stopped.requestId, sessionId, "stop", {
        completionObserved: false,
        turnId: running.turnId,
      });
      await receipt(queued.requestId, sessionId, "queue-add");
    });

    const nativeQuestion = {
      questions: [
        {
          question: "Pick a destination?",
          header: "Destination",
          options: [
            { label: "Here", description: "Use the offline workspace" },
            { label: "Elsewhere" },
          ],
          multiSelect: false,
        },
      ],
    };
    it.each([
      {
        operation: "approve",
        status: "waiting-approval",
        method: "Read",
        fields: { approvalId: "offline-interaction", decision: "allow" },
      },
      {
        operation: "answer",
        status: "waiting-input",
        method: "AskUserQuestion",
        input: nativeQuestion,
        fields: { questionId: "offline-interaction", answers: { "Pick a destination?": ["Here"] } },
        nativeInput: { ...nativeQuestion, answers: { "Pick a destination?": "Here" } },
      },
    ])(
      "sends the correlated $operation frame and clears the pending interaction",
      async (scenario) => {
        const input =
          scenario.operation === "approve"
            ? { file_path: join(cli.workspace, "notes.txt") }
            : scenario.input;
        cli.setPlan({
          noResult: true,
          onUser: [
            {
              type: "control_request",
              request_id: "offline-interaction",
              request: {
                subtype: "can_use_tool",
                tool_name: scenario.method,
                input,
              },
            },
            { __wait: "offline-interaction" },
            result,
          ],
        });
        const sessionId = await create();
        const sent = await control(sessionId, "/send", "send", { text: "Wait for a response" });
        await expect.poll(() => live(sessionId)).toMatchObject({ status: scenario.status });
        const pending = await live(sessionId);
        const turnId = pending.turnId;
        const collection = scenario.operation === "approve" ? "approvals" : "questions";
        expect(pending[collection]).toMatchObject([
          { requestId: "offline-interaction", turnId, supported: true },
        ]);
        await control(sessionId, `/${scenario.operation}`, scenario.operation, {
          turnId,
          ...scenario.fields,
        });
        expect(cli.frames().filter((frame) => frame.type === "control_response")).toEqual([
          {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: "offline-interaction",
              response: { behavior: "allow", updatedInput: scenario.nativeInput ?? input },
            },
          },
        ]);
        await expect
          .poll(() => live(sessionId))
          .toMatchObject({ status: "idle", approvals: [], questions: [] });
        await receipt(sent.requestId, sessionId, "send", {
          completionObserved: true,
          turnId: null,
        });
      },
    );

    it("queries options and inspect and applies model and permission changes to the running CLI", async () => {
      expect(
        await host.http("/managed/options?agent=claude-code&workspaceId=workspace"),
      ).toMatchObject({
        status: 200,
        body: {
          available: true,
          models: [{ id: "fixture-model", name: "Fixture", efforts: ["low", "high"] }],
          permissionModes: [{ id: "default" }, { id: "plan" }, { id: "acceptEdits" }],
        },
      });
      expect(host.calls).toContainEqual({
        method: "session.request",
        params: { operation: "provider-options", agent, workspaceId: "workspace" },
      });
      const sessionId = await create();
      const beforeReads = cli.frames();
      expect(
        await host.http(`/managed/capabilities?sessionId=${sessionId}&agent=${agent}`),
      ).toMatchObject({
        status: 200,
        body: {
          executionMode,
          features: {
            send: { available: true },
            stop: { available: false },
            settings: { available: true },
          },
        },
      });
      expect(
        await host.http(`/managed/inspect?sessionId=${sessionId}&agent=${agent}`),
      ).toMatchObject({
        status: 200,
        body: { sessionId, reconciled: false, live: { executionMode, status: "idle" } },
      });
      expect(cli.frames()).toEqual(beforeReads);
      for (const operation of ["capabilities", "inspect"]) {
        expect(host.calls).toContainEqual({
          method: "session.request",
          target: "claude-code",
          params: { operation, sessionId, experimentalEnabled: true },
        });
      }
      await control(sessionId, "/send", "send", { text: "Initialize the runner" });
      await expect.poll(() => live(sessionId)).toMatchObject({ status: "idle" });
      const fields = { model: "fixture-model", permissionMode: "plan" };
      await control(sessionId, "/managed/action", "settings", fields);
      expect(commands()).toEqual(
        expect.arrayContaining([
          { subtype: "set_model", model: fields.model },
          { subtype: "set_permission_mode", mode: fields.permissionMode },
        ]),
      );
      expect(await host.http(`/managed/settings?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: {
          sessionId,
          selected: { modelId: fields.model, permissionMode: fields.permissionMode },
        },
      });
      expect(await live(sessionId)).toMatchObject({ status: "idle", sendEnabled: true });
    });
  },
);
