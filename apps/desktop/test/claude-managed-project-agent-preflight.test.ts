import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/agents/claude/claude-managed-read";
import type { Commands } from "../../../packages/backend/src/commands";
import {
  OrchestrationService,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { BackendStore } from "../../../packages/backend/src/store";
import { createFakeClaude } from "./fixtures/claude-fake-cli";

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "connects the managed CLI's own scoped Worker tools and delivers one new report turn",
  async () => {
    const fixture = createFakeClaude("agentkib-managed-lead-");
    fixture.setPlan({ lifecycle: true });
    const deviceId = "desktop-local";
    const workspaceId = "fixture-workspace";
    const worker = "fixture-worker";
    const commands = {
      run: vi.fn(async (command: string, args: string[]) => ({
        success: true,
        bytes: Buffer.from(
          command === "/bin/ps" ? "" : args[0] === "agents" ? "[]\n" : "2.1.311 (Claude Code)\n",
        ),
      })),
    } as unknown as Commands;
    const store = { workspacePath: () => fixture.workspace } as unknown as BackendStore;
    const readers = { claudeFirstEvents: async () => null } as unknown as SessionReaders;
    let orchestration: OrchestrationService | undefined;
    const owner = new ClaudeManagedReadOwner(
      store,
      readers,
      commands,
      fixture.root,
      fixture.environment,
      randomUUID(),
      undefined,
      { leadTools: (id) => orchestration!.leadTools(id) },
    );
    const client = new Client({ name: "synthetic-managed-claude", version: "1.0.0" });
    try {
      const created = (await owner.request({
        operation: "create",
        workspaceId,
        deviceId,
        requestId: randomUUID(),
      })) as { sessionId: string };
      const { sessionId } = created;
      let running = false;
      const mutate = vi.fn<LaneHost["control"]>(async ({ operation }) => {
        running = operation === "send";
        return { accepted: true, controlOutcome: "accepted" };
      });
      const restart = vi.fn<NonNullable<LaneHost["restart"]>>(async (_value, beforeDispatch) => {
        beforeDispatch();
        return { accepted: true, controlOutcome: "accepted" };
      });
      const laneHost: LaneHost = {
        control: mutate,
        restart,
        session: (id) =>
          id === sessionId
            ? { agent: "claude-code", workspaceId, title: "Project Agent" }
            : id === worker || id === "unassigned"
              ? { agent: "codex", workspaceId, title: "Worker" }
              : null,
        live: async (id) => ({
          sessionId: id,
          workspaceId,
          status: running ? "running" : "idle",
          executionMode: "codex-managed",
          sendEnabled: true,
          stopEnabled: running,
          revision: 1,
          runtimeBootId: "fixture-boot",
          turnId: running ? "worker-turn" : null,
        }),
        events: async () => [
          { kind: "agent-message", content: "Synthetic worker result", turn_id: "worker-turn" },
        ],
        managed: async () => true,
        workspaces: () => [{ id: workspaceId, name: "Synthetic workspace" }],
      };
      const queue = vi.fn<OrchestrationService["sendReport"]>(
        (lead, device, message, admit, id) => {
          expect(admit?.()).toBe(true);
          return owner.queueReport(lead, device, message, id);
        },
      );
      orchestration = new OrchestrationService(
        fixture.root,
        owner.bootId,
        laneHost,
        (id) => id === sessionId,
        queue,
      );
      await orchestration.assignWorkers({ sessionId, workspaceId, deviceId, workers: [worker] });
      const ready = (await owner.live(sessionId, true)) as { revision: number };
      const send = await owner.request({
        operation: "send",
        sessionId,
        deviceId,
        text: "Initial project turn",
        requestId: randomUUID(),
        expectedRevision: ready.revision,
        runtimeBootId: owner.bootId,
        experimentalEnabled: true,
      });
      expect(send).toMatchObject({ accepted: true });
      const idle = () =>
        expect.poll(async () => (await owner.live(sessionId, true))?.status).toBe("idle");
      await idle();

      const args = fixture.frames().find((frame) => Array.isArray(frame.args))!.args as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          "--input-format",
          "stream-json",
          "--output-format",
          "--allowedTools",
          "mcp__agentkib_workers",
        ]),
      );
      const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
      expect(Object.keys(config.mcpServers)).toEqual(["agentkib_workers"]);
      const url = new URL(config.mcpServers.agentkib_workers.url);
      expect(url.hostname).toBe("127.0.0.1");
      await client.connect(new StreamableHTTPClientTransport(url));
      const { tools } = await client.listTools();
      expect(tools.map(({ name }: { name: string }) => name)).toEqual([
        "worker_list",
        "worker_send",
        "worker_read",
        "worker_stop",
        "worker_restart",
      ]);
      const call = async (name: string, input: Record<string, unknown> = {}) =>
        JSON.parse((await client.callTool({ name, arguments: input })).content[0].text);
      expect(await call("worker_list")).toMatchObject({
        workers: [{ worker: "worker-1", session: worker }],
      });
      expect(await call("worker_read", { worker: "unassigned" })).toMatchObject({
        accepted: false,
      });
      expect(await call("worker_read", { worker: "worker-1" })).toMatchObject({
        replies: [{ text: "Synthetic worker result" }],
      });
      const target = { worker: "worker-1" };
      expect(await call("worker_send", { ...target, text: "Synthetic work" })).toMatchObject({
        accepted: true,
      });
      expect(await call("worker_stop", target)).toMatchObject({ accepted: true });
      expect(
        mutate.mock.calls.map(([value]) => [value.operation, value.sessionId, value.deviceId]),
      ).toEqual([
        ["send", worker, deviceId],
        ["stop", worker, deviceId],
      ]);
      orchestration.pause(sessionId);
      expect(await call("worker_send", { ...target, text: "Paused" })).toMatchObject({
        accepted: false,
        reason: "delegation-paused",
      });
      expect(mutate).toHaveBeenCalledTimes(2);
      orchestration.resume(sessionId, deviceId);

      await orchestration.laneTurnEnded(worker, "worker-turn", "completed");
      await orchestration.laneTurnEnded(worker, "worker-turn", "completed");
      expect(queue).toHaveBeenCalledTimes(1);
      const schedule = (await owner.request({ operation: "schedule-list", sessionId })) as {
        sessions: Array<{
          revision: number;
          next: { itemId: string; requestId: string; deviceId: string; kind: string };
        }>;
      };
      const { next, revision } = schedule.sessions[0]!;
      expect(next.kind).toBe("report");
      const {
        accepted,
        expiresAt: _expiresAt,
        ...permit
      } = (await owner.request({
        operation: "schedule-prepare",
        sessionId,
        itemId: next.itemId,
        requestId: next.requestId,
        deviceId: next.deviceId,
        runtimeBootId: owner.bootId,
        expectedRevision: revision,
      })) as Record<string, unknown>;
      expect(accepted).toBe(true);
      expect(await owner.request({ operation: "schedule-dispatch", ...permit })).toMatchObject({
        accepted: true,
      });
      await idle();
      const prompts = fixture.frames().filter((frame) => frame.type === "user");
      expect(prompts.map(({ message }) => message.content)).toEqual([
        "Initial project turn",
        expect.stringMatching(/^\[AgentKib report\].*\n[\s\S]*Synthetic worker result/),
      ]);
      expect(prompts[0]!.uuid).not.toBe(prompts[1]!.uuid);
      await orchestration.catchUp();
      expect(queue).toHaveBeenCalledTimes(1);
      expect(owner.queuedReports(sessionId)).toBe(0);
      expect(await call("worker_restart", target)).toMatchObject({ accepted: true });
      expect(restart).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: worker, deviceId }),
        expect.any(Function),
      );
    } finally {
      await client.close();
      await orchestration?.close();
      await owner.shutdown();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  30_000,
);
