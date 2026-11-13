// @vitest-environment node
// Opt in on macOS with AGENTKIB_CLAUDE_BACKGROUND_NATIVE=1 (and AGENTKIB_CLAUDE_EXECUTABLE for a
// CLI other than ~/.local/bin/claude). This runs the installed CLI under the real managed runner
// against a synthetic localhost model: HOME, the Claude configuration and the temporary directory
// are throwaway, and sandbox-exec lets the CLI reach nothing but that model. No real model
// account, credential or user configuration is read.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerSnapshot,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/claude-managed-runner";

type Json = Record<string, any>;
const blocksOf = (message: Json): Json[] =>
  Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content) }];

/** What the model does when it first sees a prompt naming one of these. */
const FIRST_MOVES: Record<string, (seconds: string) => Json> = {
  "BACKGROUND-COMMAND": (seconds) => ({
    name: "Bash",
    input: {
      command: `sleep ${seconds}; echo background-done`,
      description: "Background acceptance",
      run_in_background: true,
    },
  }),
  MONITOR: (seconds) => ({
    name: "Monitor",
    input: {
      description: "Monitor acceptance",
      timeout_ms: 60_000,
      command: `sleep ${seconds}; echo event-one; sleep ${seconds}`,
    },
  }),
};

/** A model that answers by script: one tool call for a named prompt, a short text otherwise. */
async function mockModel() {
  const requests: Json[] = [];
  const offered = new Set<string>();
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.startsWith("/v1/messages?")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));
        return;
      }
      const body = JSON.parse(raw) as Json;
      const messages: Json[] = body.messages ?? [];
      const assistantTurns = messages.filter((message) => message.role === "assistant").length;
      const prompt = blocksOf(messages[0] ?? {})
        .map((block) => block.text ?? "")
        .join(" ");
      const tools: string[] = (body.tools ?? []).map((tool: Json) => tool.name);
      for (const tool of tools) offered.add(tool);
      let content: Json[] = [{ type: "text", text: `reply ${assistantTurns + 1}` }];
      let reason = "end_turn";
      const move = Object.entries(FIRST_MOVES).find(([name]) => prompt.includes(name));
      // 2.1.263 ends the list with reminders of its own (`role: "system"`).
      const last = blocksOf([...messages].reverse().find((item) => item.role === "user") ?? {});
      const asked = last.map((block) => (block.type === "text" ? block.text : "")).join(" ");
      if (tools.includes("Bash") && asked.includes("FOREGROUND-COMMAND")) {
        // A long command in the foreground, without the word `sleep` that 2.1.323 refuses.
        const seconds = /seconds=([0-9.]+)/.exec(asked)?.[1] ?? "30";
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "Bash",
            input: {
              command: `perl -e 'select(undef, undef, undef, ${seconds}); print qq(foreground-done\\n)'`,
              description: "Foreground acceptance",
            },
          },
        ];
        reason = "tool_use";
      } else if (tools.includes("Bash") && assistantTurns === 0 && move) {
        const seconds = /seconds=([0-9.]+)/.exec(prompt)?.[1] ?? "3";
        content = [
          { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, ...move[1](seconds) },
        ];
        reason = "tool_use";
      }
      if (tools.includes("Bash")) requests.push({ assistantTurns, reply: content[0] });
      // A reply that takes this long, once: the CLI repeats the message it was interrupted in.
      const slow = /SLOW-REPLY seconds=([0-9.]+)/.exec(asked);
      if (tools.includes("Bash") && slow && !held.has(slow[0])) {
        held.add(slow[0]);
        const wait = setTimeout(
          () => respond(body, content, reason, response),
          Number(slow[1]) * 1000,
        );
        response.on("close", () => clearTimeout(wait));
        return;
      }
      respond(body, content, reason, response);
    });
  });
  const held = new Set<string>();
  const respond = (body: Json, content: Json[], reason: string, response: ServerResponse) => {
    const message = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: reason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(message));
      return;
    }
    const events: Array<[string, Json]> = [
      [
        "message_start",
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ],
    ];
    content.forEach((block, index) => {
      const tool = block.type === "tool_use";
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: tool
              ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
              : { type: "text_delta", text: block.text },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index }],
      );
    });
    events.push(
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: null },
          usage: { output_tokens: 20 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    );
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join(""),
    );
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    /** Whether the CLI offered the model this tool. */
    offered: (tool: string) => offered.has(tool),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A throwaway home and workspace, and the CLI confined to the mock model. */
async function sandbox() {
  const model = await mockModel();
  cleanups.push(() => model.close());
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-background-native-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["home", "config", "workspace", "tmp", "bin"])
    mkdirSync(path.join(root, directory), { mode: 0o700 });
  const claude = realpathSync(
    process.env.AGENTKIB_CLAUDE_EXECUTABLE ?? path.join(homedir(), ".local/bin/claude"),
  );
  const profile = path.join(root, "cli-network.sb");
  writeFileSync(
    profile,
    `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${model.port}"))\n`,
  );
  const executable = path.join(root, "bin", "claude");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${claude}' "$@"\n`,
    {
      mode: 0o700,
    },
  );
  const home = path.join(root, "home");
  const environment: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(root, "config"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    TMPDIR: path.join(root, "tmp"),
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "offline-synthetic-dummy-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}`,
    CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ENABLE_TOOL_SEARCH: "false",
  };
  const version = spawnSync(claude, ["--version"], { encoding: "utf8", env: environment }).stdout;
  return { model, executable, environment, workspace: path.join(root, "workspace"), version };
}

function managed(
  box: Awaited<ReturnType<typeof sandbox>>,
  sessionId: string,
  fresh: boolean,
  backgroundTasks: boolean,
) {
  const snapshots: ClaudeRunnerSnapshot[] = [];
  const results: ClaudeRunnerTerminalResult[] = [];
  const runner = new ClaudeManagedRunnerProcess(
    box.workspace,
    sessionId,
    fresh,
    0,
    box.environment,
    (snapshot) => snapshots.push(snapshot),
    true,
    undefined,
    { backgroundTasks, cliVersion: box.version.trim(), onResult: (result) => results.push(result) },
  );
  cleanups.push(async () => {
    await runner.shutdown().catch(() => undefined);
  });
  const send = (text: string) => {
    const turnId = randomUUID();
    return runner.send(box.executable, text, turnId, runner.snapshot().revision).then(() => turnId);
  };
  return { runner, snapshots, results, send };
}

const running = (pattern: string) =>
  spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean).length;
const wait = { timeout: 45_000, interval: 100 };

describe.skipIf(
  process.platform !== "darwin" || process.env.AGENTKIB_CLAUDE_BACKGROUND_NATIVE !== "1",
)("real Claude CLI under the managed runner, background work allowed", () => {
  it("follows a background command to the turn the CLI starts by itself", async () => {
    const box = await sandbox();
    const { runner, results, snapshots, send } = managed(box, randomUUID(), true, true);
    const turnId = await send("BACKGROUND-COMMAND seconds=4");
    await expect.poll(() => results.length, wait).toBe(1);
    expect(results[0]).toMatchObject({ turnId, success: true });
    const resting = runner.snapshot();
    expect(resting).toMatchObject({ status: "idle", sendEnabled: true, reason: null });
    expect(resting.backgroundTasks).toMatchObject([
      { kind: "command", description: "Background acceptance" },
    ]);
    expect(runner.retireIfInactive()).toBeNull();

    await expect.poll(() => results.length, wait).toBe(2);
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    expect(results[1]!.turnId).not.toBe(turnId);
    expect(results[1]).toMatchObject({ success: true });
    expect(runner.snapshot()).toMatchObject({
      turnOrigin: "self",
      lastOutcome: "succeeded",
      reason: null,
      backgroundTasks: [],
    });
    expect(
      snapshots.some((snapshot) => snapshot.status === "running" && snapshot.turnOrigin === "self"),
    ).toBe(true);
    expect(runner.hasWorker).toBe(true);
    // The first request starts the command, the second ends the turn, the third is the CLI's own.
    expect(box.model.requests.map((request) => request.assistantTurns)).toEqual([0, 1, 2]);
  }, 120_000);

  it("follows a Monitor: a turn for its event, and one for its end", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    await send("MONITOR seconds=3");
    await expect.poll(() => results.length, wait).toBe(1);
    // 2.1.299 has no Monitor tool; 2.1.322 does.
    if (!box.model.offered("Monitor")) return;
    expect(runner.snapshot().backgroundTasks).toMatchObject([
      { kind: "command", description: "Monitor acceptance" },
    ]);
    await expect.poll(() => results.length, wait).toBe(3);
    await expect.poll(() => runner.snapshot().backgroundTasks.length, wait).toBe(0);
    expect(new Set(results.map((result) => result.turnId)).size).toBe(3);
    expect(runner.snapshot()).toMatchObject({ status: "idle", reason: null, turnOrigin: "self" });
  }, 120_000);

  it("stops only the turn: the foreground command ends, the CLI and its background command go on", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    // Durations no other process on this machine waits for.
    const background = `9.${Math.floor(Math.random() * 9000) + 1000}`;
    const foreground = `48.${Math.floor(Math.random() * 9000) + 1000}`;
    await send(`BACKGROUND-COMMAND seconds=${background}`);
    await expect.poll(() => results.length, wait).toBe(1);
    const pid = runner.processId;
    const turnId = await send(`FOREGROUND-COMMAND seconds=${foreground}`);
    await expect
      .poll(() => runner.snapshot().status !== "running" || running(`${foreground}`) > 0, wait)
      .toBe(true);
    const asking = runner.snapshot();
    if (asking.status === "waiting-approval") {
      await runner.approve(asking.approvals[0]!.requestId, turnId, "allow", asking.revision);
      await expect.poll(() => running(`${foreground}`), wait).toBeGreaterThan(0);
    }
    // A CLI that refused the command itself (2.1.299 in this sandbox) ended the turn already.
    if (runner.snapshot().status === "idle") return;
    await runner.stop(turnId, runner.snapshot().revision);
    expect(runner.snapshot()).toMatchObject({
      status: "idle",
      lastOutcome: "cancelled",
      reason: null,
      backgroundTasks: [{ kind: "command", description: "Background acceptance" }],
    });
    expect(runner.hasWorker).toBe(true);
    expect(runner.processId).toBe(pid);
    await expect.poll(() => running(`${foreground}`), wait).toBe(0);
    expect(running(`sleep ${background}`)).toBeGreaterThan(0);
    // The background command still ends in a turn of the CLI's own, in the same process.
    await expect.poll(() => runner.snapshot().backgroundTasks.length, wait).toBe(0);
    await expect.poll(() => results.length, wait).toBe(2);
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    expect(runner.snapshot()).toMatchObject({ turnOrigin: "self", lastOutcome: "succeeded" });
    expect(runner.processId).toBe(pid);
  }, 180_000);

  it("stops a turn still waiting for the model; the CLI and its background command go on", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    const background = `9.${Math.floor(Math.random() * 9000) + 1000}`;
    await send(`BACKGROUND-COMMAND seconds=${background}`);
    await expect.poll(() => results.length, wait).toBe(1);
    const pid = runner.processId;
    const turnId = await send("SLOW-REPLY seconds=30");
    await expect.poll(() => runner.snapshot().status, wait).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await runner.stop(turnId, runner.snapshot().revision);
    expect(runner.snapshot()).toMatchObject({
      status: "idle",
      lastOutcome: "cancelled",
      reason: null,
      backgroundTasks: [{ kind: "command", description: "Background acceptance" }],
    });
    expect(runner.processId).toBe(pid);
    expect(running(`sleep ${background}`)).toBeGreaterThan(0);
    // The same process takes the next message.
    const next = await send("Message after the stop.");
    await expect.poll(() => results.some((result) => result.turnId === next), wait).toBe(true);
    expect(results.find((result) => result.turnId === next)).toMatchObject({ success: true });
    expect(runner.processId).toBe(pid);
  }, 180_000);

  // The next worker hears that the command was stopped. That start is where a session used to be
  // lost: the CLI sends an empty result before the turn of the message it was given.
  for (const backgroundTasks of [false, true])
    it(`ends a running background command with the worker; the session goes on with background work ${backgroundTasks ? "allowed" : "off"}`, async () => {
      const box = await sandbox();
      const sessionId = randomUUID();
      // A duration no other process on this machine sleeps for.
      const seconds = `29${Math.floor(Math.random() * 9000) + 1000}.7`;
      const first = managed(box, sessionId, true, true);
      await first.send(`BACKGROUND-COMMAND seconds=${seconds}`);
      await expect.poll(() => first.results.length, wait).toBe(1);
      await expect.poll(() => running(`sleep ${seconds}`), wait).toBeGreaterThan(0);
      await first.runner.shutdown();
      expect(running(`sleep ${seconds}`)).toBe(0);
      expect(first.runner.snapshot().backgroundTasks).toEqual([]);

      const next = managed(box, sessionId, false, backgroundTasks);
      const turnId = await next.send("Message after the restart.");
      await expect.poll(() => next.results.length, wait).toBe(1);
      await expect.poll(() => next.runner.snapshot().status, wait).toBe("idle");
      expect(next.results[0]).toMatchObject({ turnId, success: true });
      expect(next.runner.protocolDiagnostics.strayResults).toEqual({ before_turn_start: 1 });
      // Nothing more comes: the session rests with its worker alive and no reason to show.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(next.results).toHaveLength(1);
      expect(next.runner.snapshot()).toMatchObject({
        status: "idle",
        reason: null,
        lastOutcome: "succeeded",
      });
      expect(next.runner.hasWorker).toBe(true);
    }, 180_000);
});
