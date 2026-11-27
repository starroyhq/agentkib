// @vitest-environment node
// Opt in on macOS with AGENTKIB_CLAUDE_BACKGROUND_NATIVE=1 (and AGENTKIB_CLAUDE_EXECUTABLE for a
// CLI other than ~/.local/bin/claude). This runs the installed CLI under the real managed runner
// against a synthetic localhost model: HOME, the Claude configuration and the temporary directory
// are throwaway, and sandbox-exec lets the CLI reach nothing but that model. No real model
// account, credential or user configuration is read.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerSnapshot,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/agents/claude/claude-managed-runner";
import {
  LEAD_ALLOWED_TOOLS,
  OrchestrationService,
} from "../../../packages/backend/src/orchestration-service";

type Json = Record<string, any>;
const blocksOf = (message: Json): Json[] =>
  Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content) }];

const spaciousPreview = "[Header]\n[Body]";
const previewQuestions = [
  {
    question: "Choose a shape",
    header: "Shape",
    multiSelect: false,
    options: [
      { label: "Circle", description: "Round" },
      { label: "Square", description: "Four sides" },
    ],
  },
  {
    question: "Choose fruit",
    header: "Fruit",
    multiSelect: true,
    options: [
      { label: "Apple", description: "Green" },
      { label: "Cherry", description: "Red" },
    ],
  },
  {
    question: "Name a pet",
    header: "Pet",
    multiSelect: false,
    options: [
      { label: "Dog", description: "A dog" },
      { label: "Cat", description: "A cat" },
    ],
  },
  {
    question: "Choose a layout",
    header: "Layout",
    multiSelect: false,
    options: [
      { label: "Compact", description: "One line", preview: "[Header]" },
      { label: "Spacious", description: "Two lines", preview: spaciousPreview },
    ],
  },
];

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
  // Then, in the turn the CLI starts by itself, a question for the person.
  "BACKGROUND-QUESTION": (seconds) => ({
    name: "Bash",
    input: {
      command: `sleep ${seconds}; echo background-done`,
      description: "Background before a question",
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
  const unknownQuestionReceipt = Promise.withResolvers<Json[]>();
  const continueAfterUnknownQuestion = Promise.withResolvers<void>();
  const offered = new Set<string>();
  /** The tools the CLI offered in each request, in order. */
  const toolsByRequest: string[][] = [];
  // The job `/loop` scheduled (CronCreate's answer names it), and whether LOOP-STOP deleted it.
  let job: string | null = null;
  let jobDeleted = false;
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
      toolsByRequest.push(tools);
      let content: Json[] = [{ type: "text", text: `reply ${assistantTurns + 1}` }];
      let reason = "end_turn";
      const move = Object.entries(FIRST_MOVES).find(([name]) => prompt.includes(name));
      // 2.1.263 ends the list with reminders of its own (`role: "system"`).
      const last = blocksOf([...messages].reverse().find((item) => item.role === "user") ?? {});
      const asked = last.map((block) => (block.type === "text" ? block.text : "")).join(" ");
      const toolResults = messages.flatMap((item) =>
        blocksOf(item).filter((block) => block.type === "tool_result"),
      );
      job ??= /Scheduled (?:recurring )?job ([0-9a-f]{8})/.exec(JSON.stringify(toolResults))?.[1] ?? null;
      if (prompt.includes("PROJECT-AGENT") && toolResults.length < 2) {
        const name = toolResults.length === 0 ? "worker_list" : "worker_read";
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: `mcp__agentkib_workers__${name}`,
            input: name === "worker_read" ? { worker: "worker-1" } : {},
          },
        ];
        reason = "tool_use";
        requests.push({ assistantTurns, reply: content[0], toolResults });
      } else if (tools.includes("Bash") && asked.includes("FOREGROUND-COMMAND")) {
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
      } else if (tools.includes("Bash") && assistantTurns === 0 && prompt.includes("TWO-MONITORS")) {
        // Two Monitors at once, each with events of its own, over half a minute.
        const seconds = Number(/seconds=([0-9.]+)/.exec(prompt)?.[1] ?? "3");
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "Monitor",
            input: {
              description: "Monitor one",
              timeout_ms: 120_000,
              command: `sleep ${seconds}; echo one-a; sleep ${seconds * 3}; echo one-b; sleep ${seconds}`,
            },
          },
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "Monitor",
            input: {
              description: "Monitor two",
              timeout_ms: 120_000,
              command: `sleep ${seconds * 2}; echo two-a; sleep ${seconds * 4}`,
            },
          },
        ];
        reason = "tool_use";
      } else if (
        assistantTurns === 0 &&
        prompt.includes("QUESTION-UNKNOWN") &&
        tools.includes("AskUserQuestion")
      ) {
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "AskUserQuestion",
            input: { questions: [previewQuestions[0]] },
          },
        ];
        reason = "tool_use";
      } else if (
        assistantTurns === 0 &&
        prompt.includes("QUESTION-PREVIEW") &&
        tools.includes("AskUserQuestion")
      ) {
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "AskUserQuestion",
            input: { questions: previewQuestions },
          },
        ];
        reason = "tool_use";
      } else if (
        prompt.includes("BACKGROUND-QUESTION") &&
        assistantTurns === 2 &&
        tools.includes("AskUserQuestion")
      ) {
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Keep the change?",
                  header: "Change",
                  multiSelect: false,
                  options: [
                    { label: "Keep", description: "Keep it." },
                    { label: "Drop", description: "Drop it." },
                  ],
                },
              ],
            },
          },
        ];
        reason = "tool_use";
      } else if (
        tools.includes("CronDelete") &&
        asked.includes("LOOP-STOP") &&
        job &&
        !jobDeleted
      ) {
        jobDeleted = true;
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "CronDelete",
            input: { id: job },
          },
        ];
        reason = "tool_use";
      } else if (
        tools.includes("CronCreate") &&
        asked.includes("<command-name>/loop</command-name>") &&
        !toolResults.length
      ) {
        content = [
          {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "CronCreate",
            input: {
              cron: "*/1 * * * *",
              prompt: "LOOP-TICK fire",
              recurring: true,
              ...(asked.includes("DURABLE") ? { durable: true } : {}),
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
      if (tools.includes("Bash"))
        requests.push({
          assistantTurns,
          reply: content[0],
          asked,
          answers: JSON.stringify(toolResults).slice(-2000),
        });
      if (prompt.includes("QUESTION-UNKNOWN") && assistantTurns === 1 && toolResults.length) {
        unknownQuestionReceipt.resolve(toolResults);
        void continueAfterUnknownQuestion.promise.then(() =>
          respond(body, [{ type: "text", text: "Please reply in plain text." }], reason, response),
        );
        return;
      }
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
    toolsByRequest,
    unknownQuestionReceipt: unknownQuestionReceipt.promise,
    continueAfterUnknownQuestion: continueAfterUnknownQuestion.resolve,
    /** Whether the CLI offered the model this tool. */
    offered: (tool: string) => offered.has(tool),
    close: () => {
      continueAfterUnknownQuestion.resolve();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
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
  const ports = [model.port];
  const writeProfile = () =>
    writeFileSync(
      profile,
      `(version 1)(allow default)(deny network*)${ports
        .map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`)
        .join("")}
(deny file-read* file-write* (subpath "/Users") (subpath "/System/Volumes/Data/Users") (subpath "/Volumes") (subpath "/Library/Keychains"))
(allow file-read* (literal ${JSON.stringify(claude)}))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))
`,
    );
  writeProfile();
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
    CFFIXED_USER_HOME: home,
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
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: environment,
    timeout: 5_000,
  }).stdout;
  return {
    model,
    executable,
    environment,
    workspace: path.join(root, "workspace"),
    version,
    /** Lets the CLI reach one more loopback port, such as an AgentKib MCP endpoint. */
    allowPort: (port: number) => {
      ports.push(port);
      writeProfile();
    },
  };
}

function managed(
  box: Awaited<ReturnType<typeof sandbox>>,
  sessionId: string,
  fresh: boolean,
  backgroundTasks: boolean,
  extra: {
    mcpConfig?: Record<string, unknown>;
    allowedTools?: string[];
    onSnapshot?: (snapshot: ClaudeRunnerSnapshot) => void;
    onResult?: (result: ClaudeRunnerTerminalResult) => void;
  } = {},
) {
  const { onSnapshot, onResult, ...processOptions } = extra;
  const snapshots: ClaudeRunnerSnapshot[] = [];
  const results: ClaudeRunnerTerminalResult[] = [];
  const runner = new ClaudeManagedRunnerProcess(
    box.workspace,
    sessionId,
    fresh,
    0,
    box.environment,
    (snapshot) => {
      snapshots.push(snapshot);
      onSnapshot?.(snapshot);
    },
    true,
    undefined,
    {
      backgroundTasks,
      cliVersion: box.version.trim(),
      onResult: (result) => {
        results.push(result);
        onResult?.(result);
      },
      ...processOptions,
    },
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

/** Whether the CLI scheduled the job `/loop` asked for (CronCreate's answer says so). */
const scheduled = (box: Awaited<ReturnType<typeof sandbox>>) =>
  box.model.requests.some((request) =>
    /Scheduled (?:recurring )?job [0-9a-f]{8}/.test(String(request.answers)),
  );

/** The session transcript the CLI wrote in its throwaway configuration. */
function transcript(box: Awaited<ReturnType<typeof sandbox>>, sessionId: string) {
  const projects = path.join(box.environment.CLAUDE_CONFIG_DIR!, "projects");
  if (!existsSync(projects)) return "";
  for (const directory of readdirSync(projects)) {
    const file = path.join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return "";
}

function transcriptHas(box: Awaited<ReturnType<typeof sandbox>>, sessionId: string, text: string) {
  return transcript(box, sessionId).includes(text);
}

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

  it("follows /loop: its turns are the CLI's own, and the worker stays for them", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    await send("/loop 1m LOOP-TICK");
    await expect.poll(() => results.length, wait).toBe(1);
    if (!box.model.offered("CronCreate")) return;
    // 2.1.299 and 2.1.301 refuse the call offline (a classifier they cannot reach): nothing is
    // scheduled, and nothing keeps the worker.
    if (!scheduled(box)) {
      expect(runner.retireIfInactive()).not.toBeNull();
      return;
    }
    // Idle, with a prompt scheduled: never retired.
    expect(runner.snapshot()).toMatchObject({ status: "idle", reason: null });
    expect(runner.retireIfInactive()).toBeNull();
    // The job fires within the minute: a turn of the CLI's own, not a broken stream.
    await expect.poll(() => results.length, { timeout: 75_000, interval: 200 }).toBe(2);
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    expect(results[1]).toMatchObject({ success: true });
    expect(runner.snapshot()).toMatchObject({ reason: null, turnOrigin: "self" });
    expect(box.model.requests.some((request) => String(request.asked).includes("LOOP-TICK fire"))).toBe(
      true,
    );
    // Deleted, it no longer keeps the worker.
    await send("LOOP-STOP");
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    await expect
      .poll(() => box.model.requests.some((request) => request.reply?.name === "CronDelete"), wait)
      .toBe(true);
    await expect.poll(() => runner.retireIfInactive() !== null, wait).toBe(true);
  }, 180_000);

  it("takes a durable job's turn in a later worker of the session", async () => {
    const box = await sandbox();
    const sessionId = randomUUID();
    const { runner, results, send } = managed(box, sessionId, true, true);
    await send("/loop 1m LOOP-TICK DURABLE");
    await expect.poll(() => results.length, wait).toBe(1);
    if (!box.model.offered("CronCreate") || !scheduled(box)) return;
    expect(existsSync(path.join(box.workspace, ".claude", "scheduled_tasks.json"))).toBe(true);
    // The worker goes, as when AgentKib restarts; the next one resumes the session.
    await runner.shutdown();
    const next = managed(box, sessionId, false, true);
    await next.send("RESUME-AFTER-RESTART");
    await expect.poll(() => next.results.length, wait).toBe(1);
    // It knows nothing of the job, yet takes its turn as the CLI's own.
    expect(next.runner.retireIfInactive()).toBeNull();
    await expect.poll(() => next.results.length, { timeout: 75_000, interval: 200 }).toBe(2);
    await expect.poll(() => next.runner.snapshot().status, wait).toBe("idle");
    expect(next.results[1]).toMatchObject({ success: true });
    expect(next.runner.snapshot()).toMatchObject({ reason: null, turnOrigin: "self" });
  }, 180_000);

  it("asks the person in a turn it starts by itself, and goes on with the answer", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    await send("BACKGROUND-QUESTION seconds=3");
    await expect.poll(() => results.length, wait).toBe(1);
    if (!box.model.offered("AskUserQuestion")) return;
    await expect.poll(() => runner.snapshot().questions.length, wait).toBe(1);
    const asking = runner.snapshot();
    expect(asking).toMatchObject({ status: "waiting-input", turnOrigin: "self" });
    const pending = asking.questions[0] as Json;
    const id = (pending.questions as Json[])[0]!.id as string;
    await runner.answer(pending.requestId, asking.turnId, { [id]: ["Keep"] }, asking.revision);
    await expect.poll(() => results.length, wait).toBe(2);
    expect(results[1]).toMatchObject({ success: true });
    expect(runner.snapshot()).toMatchObject({
      status: "idle",
      questions: [],
      turnOrigin: "self",
      reason: null,
    });
    // The answer reached the model in that same turn.
    expect(box.model.requests.at(-1)).toMatchObject({ assistantTurns: 3 });
    expect(box.model.requests.at(-1)!.answers).toContain("Keep");
  }, 120_000);

  it.each([undefined, "Keep the body below the header."])(
    "answers all four native questions and confirms the selected preview on the original call (notes: %s)",
    async (notes) => {
      const box = await sandbox();
      const started = Promise.withResolvers<ClaudeRunnerSnapshot>();
      const ended = Promise.withResolvers<ClaudeRunnerTerminalResult>();
      const sessionId = randomUUID();
      const { runner, send } = managed(box, sessionId, true, true, {
        onSnapshot: (snapshot) => {
          if (snapshot.status === "waiting-input" || snapshot.status === "outcome-unknown")
            started.resolve(snapshot);
        },
        onResult: ended.resolve,
      });
      const turnId = await send("QUESTION-PREVIEW");
      const pending = await Promise.race([
        started.promise,
        ended.promise.then(() => runner.snapshot()),
      ]);
      expect(pending.status, pending.reason ?? "Expected the native question to be pending").toBe(
        "waiting-input",
      );
      expect(pending).toMatchObject({
        status: "waiting-input",
        turnId,
        questions: [
          {
            supported: true,
            questions: previewQuestions.map((question) => ({
              id: question.question,
              ...question,
              allowCustom: true,
            })),
          },
        ],
      });

      const answers = {
        "Choose a shape": ["Circle"],
        "Choose fruit": ["Apple", "Cherry"],
        "Name a pet": ["Parrot"],
        "Choose a layout": ["Spacious"],
      };
      if (notes === undefined) {
        // Old clients still send only the original answer map.
        await runner.answer(pending.questions[0]!.requestId, turnId, answers, pending.revision);
      } else {
        await runner.answer(pending.questions[0]!.requestId, turnId, answers, pending.revision, {
          "Choose a layout": notes,
        });
      }
      expect(await ended.promise).toMatchObject({ turnId, success: true });
      expect(runner.snapshot()).toMatchObject({ status: "idle", questions: [] });

      const request = box.model.requests.find(({ reply }) => reply?.name === "AskUserQuestion");
      expect(request).toBeDefined();
      const receipts = JSON.parse(box.model.requests.at(-1)!.answers) as Json[];
      expect(receipts).toEqual([
        expect.objectContaining({
          tool_use_id: request!.reply.id,
          content: expect.stringContaining(spaciousPreview),
        }),
      ]);
      for (const text of ["Circle", "Apple, Cherry", "Parrot", "Spacious"])
        expect(receipts[0]!.content).toContain(text);
      if (notes !== undefined) expect(receipts[0]!.content).toContain(notes);
      await runner.shutdown();
      const nativeResults = transcript(box, sessionId)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)
        .filter(({ message }) =>
          blocksOf(message ?? {}).some(
            (block) => block.type === "tool_result" && block.tool_use_id === request!.reply.id,
          ),
        );
      expect(nativeResults).toEqual([
        expect.objectContaining({
          toolUseResult: expect.objectContaining({
            answers: {
              "Choose a shape": "Circle",
              "Choose fruit": "Apple, Cherry",
              "Name a pet": "Parrot",
              "Choose a layout": "Spacious",
            },
            annotations: {
              "Choose a layout": {
                preview: spaciousPreview,
                ...(notes === undefined ? {} : { notes }),
              },
            },
          }),
        }),
      ]);
    },
    30_000,
  );

  it("refuses only the unsupported native question and continues on the same CLI", async () => {
    const box = await sandbox();
    const unexpected = Promise.withResolvers<ClaudeRunnerSnapshot>();
    const ended = Promise.withResolvers<ClaudeRunnerTerminalResult>();
    const nextEnded = Promise.withResolvers<ClaudeRunnerTerminalResult>();
    const { runner, results, send, snapshots } = managed(box, randomUUID(), true, true, {
      onSnapshot: (snapshot) => {
        if (snapshot.status === "waiting-input" || snapshot.status === "outcome-unknown")
          unexpected.resolve(snapshot);
      },
      onResult: (result) =>
        results.length === 1 ? ended.resolve(result) : nextEnded.resolve(result),
    });
    // Both tested CLI versions remove unrecognized model input fields before can_use_tool.
    // Simulate a newer CLI's field at the runner boundary, then let the real CLI consume the reply.
    const nativeFrame = runner.state.frame.bind(runner.state);
    let questionsReceived = 0;
    runner.state.frame = (value) => {
      const frame = value as Json;
      const request = frame.request;
      if (
        frame.type !== "control_request" ||
        request?.subtype !== "can_use_tool" ||
        request.tool_name !== "AskUserQuestion"
      )
        return nativeFrame(value);
      questionsReceived++;
      return nativeFrame({
        ...frame,
        request: {
          ...request,
          input: { ...request.input, futureQuestionField: "fixture" },
        },
      });
    };
    const turnId = await send("QUESTION-UNKNOWN");
    const pid = runner.processId;
    const receipts = await Promise.race([
      box.model.unknownQuestionReceipt,
      unexpected.promise.then((snapshot) => {
        throw new Error(`Claude did not keep running: ${snapshot.reason ?? snapshot.status}`);
      }),
      ended.promise.then((result) => {
        throw new Error(`Claude ended before reporting the refusal: ${result.subtype}`);
      }),
    ]);
    const question = box.model.requests.find(({ reply }) => reply?.name === "AskUserQuestion");
    expect(question).toBeDefined();
    expect(questionsReceived).toBe(1);
    expect(receipts).toEqual([
      expect.objectContaining({
        tool_use_id: question!.reply.id,
        is_error: true,
        content: expect.stringContaining(
          "This question format is not supported by this client. Ask the user in plain text instead.",
        ),
      }),
    ]);
    expect(runner.snapshot()).toMatchObject({
      turnId,
      status: "running",
      questions: [],
      stopEnabled: true,
    });

    box.model.continueAfterUnknownQuestion();
    expect(await ended.promise).toMatchObject({ turnId, success: true });
    expect(runner.snapshot()).toMatchObject({ status: "idle", sendEnabled: true, reason: null });
    expect(runner.processId).toBe(pid);

    const nextTurnId = await send("Replying in plain text.");
    expect(await nextEnded.promise).toMatchObject({ turnId: nextTurnId, success: true });
    expect(runner.processId).toBe(pid);
    expect(snapshots.map(({ status }) => status)).not.toContain("outcome-unknown");
  }, 30_000);

  it("follows two Monitors at once until both end, and is not retired meanwhile", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    await send("TWO-MONITORS seconds=3");
    await expect.poll(() => results.length, wait).toBe(1);
    if (!box.model.offered("Monitor")) return;
    expect(runner.snapshot().backgroundTasks.map((task) => task.description).sort()).toEqual([
      "Monitor one",
      "Monitor two",
    ]);
    // Idle between events, but with work going on: never retired.
    const longRun = { timeout: 90_000, interval: 100 };
    let checks = 0;
    await expect
      .poll(() => {
        const snapshot = runner.snapshot();
        if (snapshot.status === "idle" && snapshot.backgroundTasks.length) {
          expect(runner.retireIfInactive()).toBeNull();
          checks++;
        }
        return snapshot.backgroundTasks.length;
      }, longRun)
      .toBe(0);
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    expect(checks).toBeGreaterThan(0);
    // Each event and each end woke the CLI; none of those turns failed or got lost.
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((result) => result.success)).toBe(true);
    expect(new Set(results.map((result) => result.turnId)).size).toBe(results.length);
    expect(runner.snapshot()).toMatchObject({ reason: null, turnOrigin: "self" });
    await runner.shutdown();
    expect(running("one-a; sleep")).toBe(0);
  }, 180_000);

  it("takes a message sent just as the CLI starts a turn by itself", async () => {
    const box = await sandbox();
    const { runner, results, send } = managed(box, randomUUID(), true, true);
    await send("BACKGROUND-COMMAND seconds=3");
    await expect.poll(() => results.length, wait).toBe(1);
    // The moment the background work ends, the CLI begins its own turn.
    await expect
      .poll(
        () => runner.snapshot().backgroundTasks.length === 0 || runner.snapshot().status !== "idle",
        { timeout: 45_000, interval: 2 },
      )
      .toBe(true);
    let sent: string;
    try {
      sent = await send("RACE-MESSAGE");
    } catch (error) {
      // Its own turn came first: the message waits for it, as AgentKib's queue would.
      expect(String(error)).toMatch(/busy|stale/);
      await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
      sent = await send("RACE-MESSAGE");
    }
    await expect.poll(() => results.some((result) => result.turnId === sent), wait).toBe(true);
    await expect.poll(() => runner.snapshot().status, wait).toBe("idle");
    expect(results.every((result) => result.success)).toBe(true);
    expect(runner.snapshot()).toMatchObject({ reason: null, backgroundTasks: [] });
    // The model read the message once.
    expect(
      box.model.requests.filter((request) => String(request.asked).includes("RACE-MESSAGE")),
    ).toHaveLength(1);
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

  it("lets a Project Agent call its worker tools without asking", async () => {
    const box = await sandbox();
    const lanes = {
      control: async () => ({ accepted: true }),
      live: async (sessionId: string) => ({ sessionId, status: "idle", revision: 1 }),
      events: async () => [],
      session: (id: string) =>
        id === "worker-session" ? { agent: "codex", workspaceId: "w1", title: null } : null,
      managed: async () => false,
      workspaces: () => [{ id: "w1", name: "app" }],
    };
    const data = mkdtempSync(path.join(tmpdir(), "agentkib-project-agent-native-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const lead = randomUUID();
    const orchestration = new OrchestrationService(data, "boot", lanes, (id) => id === lead);
    cleanups.push(() => orchestration.close());
    await orchestration.assignWorkers({
      sessionId: lead,
      deviceId: "desktop-local",
      workspaceId: "w1",
      workers: ["worker-session"],
    });
    const tools = (await orchestration.leadTools(lead)) as {
      mcpServers: Record<string, { url: string }>;
    };
    box.allowPort(Number(new URL(tools.mcpServers.agentkib_workers!.url).port));
    const { runner, results, snapshots, send } = managed(box, randomUUID(), true, true, {
      mcpConfig: tools,
      allowedTools: [...LEAD_ALLOWED_TOOLS],
    });
    await send("PROJECT-AGENT: read the worker assigned to this project.");
    await expect.poll(() => results.length, wait).toBe(1);
    expect(results[0]).toMatchObject({ success: true });
    // No approval was asked for either call.
    expect(snapshots.every((snapshot) => snapshot.approvals.length === 0)).toBe(true);
    const calls = box.model.requests.filter((request) => request.toolResults);
    expect(calls.map((request) => request.reply.name)).toEqual([
      "mcp__agentkib_workers__worker_list",
      "mcp__agentkib_workers__worker_read",
    ]);
    // The model saw the tools' answers.
    expect(JSON.stringify(calls[1]!.toolResults)).toContain("worker-1");
    expect(orchestration.status(lead)!.lanes).toMatchObject([
      { name: "worker-1", sessionId: "worker-session", workspaceId: "w1" },
    ]);
    expect(box.model.toolsByRequest.flat()).not.toContain("mcp__agentkib_workers__worker_open");
    expect(box.model.toolsByRequest.flat()).not.toContain("mcp__agentkib_workers__worker_close");
    expect(runner.snapshot()).toMatchObject({ status: "idle", reason: null });
  }, 120_000);

  // The host ends each CLI with SIGKILL (idle retirement, stop, cleanup); none ends its session at
  // the endpoint, which lasts as long as the backend.
  it("gives a Project Agent its worker tools in every new CLI process", async () => {
    const box = await sandbox();
    const lanes = {
      control: async () => ({ accepted: true }),
      live: async (sessionId: string) => ({ sessionId, status: "idle", revision: 1 }),
      events: async () => [],
      session: () => null,
      managed: async () => false,
      workspaces: () => [{ id: "w1", name: "app" }],
    };
    const data = mkdtempSync(path.join(tmpdir(), "agentkib-project-agent-native-"));
    cleanups.push(() => rmSync(data, { recursive: true, force: true }));
    const lead = randomUUID();
    const orchestration = new OrchestrationService(data, "boot", lanes, (id) => id === lead);
    cleanups.push(() => orchestration.close());
    orchestration.designate({ sessionId: lead, deviceId: "desktop-local", workspaceId: "w1" });
    const tools = (await orchestration.leadTools(lead)) as {
      mcpServers: Record<string, { url: string }>;
    };
    box.allowPort(Number(new URL(tools.mcpServers.agentkib_workers!.url).port));
    const sessionId = randomUUID();
    const offered: boolean[] = [];
    for (let count = 0; count < 6; count++) {
      const before = box.model.toolsByRequest.length;
      const { runner, results, send } = managed(box, sessionId, count === 0, true, {
        mcpConfig: tools,
        allowedTools: [...LEAD_ALLOWED_TOOLS],
      });
      await send(`message ${count + 1}`);
      await expect.poll(() => results.length, wait).toBe(1);
      offered.push(
        box.model.toolsByRequest
          .slice(before)
          .some((names) => names.includes("mcp__agentkib_workers__worker_list")),
      );
      // 2.1.263 writes the transcript after the result; resuming a CLI killed at once finds nothing.
      await expect.poll(() => transcriptHas(box, sessionId, `reply ${count + 1}`), wait).toBe(true);
      await runner.shutdown();
    }
    expect(offered).toEqual([true, true, true, true, true, true]);
  }, 300_000);

  it("offers the scheduling tools only where background work is allowed", async () => {
    const box = await sandbox();
    const on = managed(box, randomUUID(), true, true);
    await on.send("Plain message.");
    await expect.poll(() => on.results.length, wait).toBe(1);
    if (!box.model.toolsByRequest.at(-1)!.includes("CronCreate")) return;
    const off = managed(box, randomUUID(), true, false);
    await off.send("Plain message.");
    await expect.poll(() => off.results.length, wait).toBe(1);
    const offered = box.model.toolsByRequest.at(-1)!;
    expect(offered).toContain("Bash");
    expect(
      offered.filter((tool) => ["CronCreate", "CronDelete", "ScheduleWakeup"].includes(tool)),
    ).toEqual([]);
  }, 120_000);

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
