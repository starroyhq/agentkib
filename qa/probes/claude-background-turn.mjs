// Real Claude Code CLI in the managed runner's headless mode, against a loopback mock model.
// Question: after a turn that started a background Bash command has ended, does the CLI start a
// turn of its own when the command finishes, and which frames does it emit?
//
//   node qa/probes/claude-background-turn.mjs <new run dir> <claude binary> [mode] [bg seconds]
//        [seconds to wait after the first result] [scenario]
//
// mode:     enabled (default) | disabled (sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, as managed
//           sessions run today)
// scenario: plain (default) | send-while-running (the host sends a second message while the
//           command runs) | finish-during-turn (the command finishes inside a host-started turn)
//           | tool-in-self-turn (the model calls a tool in the turn the CLI starts by itself)
//           | two-tasks (two commands that finish together) | two-tasks-apart (3 s apart)
//           | interrupt-tool (a second message runs a long foreground command; the host sends the
//           `interrupt` control request while it runs) | interrupt-approval (the same, while its
//           approval is unanswered) | interrupt-model (while the model has not answered yet)
//           | interrupt-steer (as interrupt-tool, with a message added to the turn just before the
//           interrupt, which then asks to cancel queued messages).
//           After an interrupt the host sends a third message, then waits for the background
//           command.
// PROBE_SESSION_STATE=1 also sets CLAUDE_CODE_SDK_READS_SESSION_STATE=1; PROBE_INTERRUPT_AFTER_MS sets
// how long interrupt-tool lets the command run (2500 by default).
//
// macOS only. HOME, CLAUDE_CONFIG_DIR and TMPDIR live in the run dir, and sandbox-exec allows no
// network except the mock's port: the user's Claude configuration and credentials are never read
// and no real model request is made. Results: qa/claude-background-tasks-probe-2026-11-13.md and,
// for the interrupt scenarios, qa/claude-interrupt-2026-11-13.md.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const [root, claude, mode = "enabled", bgArg = "6", waitArg = "25", scenario = "plain"] =
  process.argv.slice(2);
const bgSeconds = Number(bgArg);
const waitAfterResult = Number(waitArg);
for (const dir of ["home", "config", "project", "tmp"]) mkdirSync(path.join(root, dir), { recursive: true });
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5);
const log = (line) => {
  console.log(line);
  appendFileSync(path.join(root, "summary.log"), line + "\n");
};

// ---- mock model -------------------------------------------------------------------------
const blocksOf = (message) =>
  Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }];
let modelRequests = 0;
let heldOnce = false;
const mock = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    if (request.method !== "POST" || !request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      log(`${at()} mock  other ${request.method} ${request.url}`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
      return;
    }
    const body = JSON.parse(raw);
    const index = ++modelRequests;
    const tools = (body.tools ?? []).map((tool) => tool.name);
    const messages = body.messages ?? [];
    const last = messages[messages.length - 1];
    const lastBlocks = blocksOf(last);
    const assistantTurns = messages.filter((message) => message.role === "assistant").length;
    const bash = (body.tools ?? []).find((tool) => tool.name === "Bash");
    writeFileSync(path.join(root, `model-request-${index}.json`), JSON.stringify(body, null, 1));
    let content;
    let reason = "end_turn";
    let delay = 0;
    if (!bash) {
      content = [{ type: "text", text: "ok" }];
    } else if (assistantTurns === 0) {
      content = [
        {
          type: "tool_use",
          id: "toolu_bgprobe_1",
          name: "Bash",
          input: {
            command: `sleep ${bgSeconds}; echo bg-done`,
            description: "Background probe",
            run_in_background: true,
          },
        },
      ];
      if (scenario === "two-tasks" || scenario === "two-tasks-apart")
        content.push({
          type: "tool_use",
          id: "toolu_bgprobe_1b",
          name: "Bash",
          input: {
            command: `sleep ${bgSeconds + (scenario === "two-tasks" ? 0 : 3)}; echo bg-done-b`,
            description: "Second background probe",
            run_in_background: true,
          },
        });
      reason = "tool_use";
    } else if (assistantTurns === 1 && lastBlocks.some((block) => block.type === "tool_result")) {
      content = [{ type: "text", text: "STARTED" }];
    } else if (scenario === "interrupt-model" && !heldOnce && lastBlocks.some((block) => block.type === "text" && block.text.includes("Second message."))) {
      // Only once: the CLI folds the interrupted message into the next one it sends.
      heldOnce = true;
      content = [{ type: "text", text: "SLOW-ANSWER" }];
      delay = 15_000;
    } else if ((scenario === "finish-during-turn" || scenario.startsWith("interrupt-")) && lastBlocks.some((block) => block.type === "text" && block.text.includes("Second message."))) {
      content = [{ type: "tool_use", id: "toolu_bgprobe_2", name: "Bash", input: { command: scenario === "finish-during-turn" ? "sleep 7; echo fg-done" : "perl -e 'select(undef, undef, undef, 30); print qq(fg-done\\n)'", description: "Foreground probe" } }];
      reason = "tool_use";
    } else if (lastBlocks.some((block) => block.type === "tool_result" && block.tool_use_id === "toolu_bgprobe_2")) {
      content = [{ type: "text", text: "FG-DONE" }];
    } else if (scenario === "tool-in-self-turn" && lastBlocks.some((block) => block.type === "text" && block.text.includes("<task-notification>"))) {
      content = [{ type: "tool_use", id: "toolu_bgprobe_3", name: "Bash", input: { command: "touch self-turn-file && echo self-turn-tool", description: "Tool in a self-started turn" } }];
      reason = "tool_use";
    } else if (lastBlocks.some((block) => block.type === "tool_result" && block.tool_use_id === "toolu_bgprobe_3")) {
      content = [{ type: "text", text: "SELF-TURN-TOOL-DONE" }];
    } else {
      content = [{ type: "text", text: `NOTED-${assistantTurns}` }];
    }
    const lastText = lastBlocks
      .map((block) =>
        block.type === "text"
          ? block.text
          : block.type === "tool_result"
            ? "[tool_result] " + JSON.stringify(block.content)
            : `[${block.type}]`,
      )
      .join(" | ")
      .replace(/\s+/g, " ");
    log(
      `${at()} mock  request ${index}: tools=${tools.length} bash=${!!bash}` +
        (bash ? ` bashParams=${Object.keys(bash.input_schema?.properties ?? {}).join(",")}` : "") +
        ` messages=${messages.length} assistantTurns=${assistantTurns} last=${last.role}` +
        ` -> ${content[0].type === "tool_use" ? "tool_use Bash " + JSON.stringify(content[0].input) : content[0].text}`,
    );
    log(`      last message: ${lastText.slice(0, 700)}`);
    const message = {
      id: `msg_bgprobe_${index}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: reason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    if (delay) log(`${at()} mock  holding the answer ${delay} ms`);
    setTimeout(() => answer(message, content, reason, body.stream, response), delay);
  });
});
function answer(message, content, reason, stream, response) {
    if (response.destroyed || response.writableEnded) return log(`${at()} mock  client went away before the answer`);
    if (!stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(message));
      return;
    }
    const events = [
      ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
    ];
    content.forEach((block, position) => {
      const tool = block.type === "tool_use";
      events.push(
        ["content_block_start", { type: "content_block_start", index: position, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: position, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } }],
        ["content_block_stop", { type: "content_block_stop", index: position }],
      );
    });
    events.push(
      ["message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } }],
      ["message_stop", { type: "message_stop" }],
    );
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
}
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;

// ---- the CLI, launched as the managed runner launches it ---------------------------------
const profile = path.join(root, "cli-network.sb");
writeFileSync(profile, `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${port}"))\n`);
const home = path.join(root, "home");
const env = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: path.join(root, "config"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  TMPDIR: path.join(root, "tmp"),
  LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "offline-synthetic-dummy-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  CLAUDE_CODE_MAX_RETRIES: "0",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  ENABLE_TOOL_SEARCH: "false",
  ...(mode === "disabled" ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
  ...(process.env.PROBE_SESSION_STATE === "1" ? { CLAUDE_CODE_SDK_READS_SESSION_STATE: "1" } : {}),
};
const sessionId = randomUUID();
const args = [
  "-f", profile, claude,
  `--session-id=${sessionId}`,
  "--print", "--input-format", "stream-json", "--output-format", "stream-json",
  "--verbose", "--include-partial-messages",
  "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
  "--model", "claude-sonnet-4-6",
];
log(`mode=${mode} bg=${bgSeconds}s wait=${waitAfterResult}s scenario=${scenario} mock=127.0.0.1:${port}`);
const child = spawn("/usr/bin/sandbox-exec", args, { cwd: path.join(root, "project"), env, stdio: ["pipe", "pipe", "pipe"] });
const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const initId = randomUUID();
const interruptId = randomUUID();
let results = 0;
let secondUserSent = false;
let interruptSent = false;
const interrupting = scenario.startsWith("interrupt-");
const interrupt = (why) => {
  if (interruptSent) return;
  interruptSent = true;
  log(`${at()} host  interrupt (${why})`);
  send({ type: "control_request", request_id: interruptId, request: { subtype: "interrupt", ...(scenario === "interrupt-steer" ? { cancel_queued: true } : {}) } });
};
let buffer = "";
const userFrame = (text) => ({
  type: "user",
  session_id: sessionId,
  parent_tool_use_id: null,
  uuid: randomUUID(),
  message: { role: "user", content: [{ type: "text", text }] },
});
const describe = (frame) => {
  if (frame.type === "stream_event") return null;
  if (frame.type === "system") {
    const extra = Object.entries(frame)
      .filter(([key]) => !["type", "subtype", "session_id", "uuid", "tools", "mcp_servers", "slash_commands", "agents", "skills", "plugins", "cwd", "apiKeySource", "output_style", "claude_code_version", "model", "permissionMode"].includes(key))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`.slice(0, 260))
      .join(" ");
    return `system/${frame.subtype} ${frame.subtype === "init" ? `version=${frame.claude_code_version} permissionMode=${frame.permissionMode}` : extra}`;
  }
  if (frame.type === "assistant" || frame.type === "user") {
    const parts = blocksOf(frame.message ?? { content: [] }).map((block) =>
      block.type === "text"
        ? `text:${JSON.stringify(block.text).slice(0, 200)}`
        : block.type === "tool_use"
          ? `tool_use:${block.name}${JSON.stringify(block.input).slice(0, 160)}`
          : block.type === "tool_result"
            ? `tool_result:${JSON.stringify(block.content).slice(0, 300)}`
            : block.type,
    );
    return `${frame.type} parent=${frame.parent_tool_use_id ?? "null"} ${parts.join(" ; ")}`;
  }
  if (frame.type === "result") return `result subtype=${frame.subtype} is_error=${frame.is_error} num_turns=${frame.num_turns} result=${JSON.stringify(frame.result)?.slice(0, 120)}`;
  if (frame.type === "control_request") return `control_request ${frame.request?.subtype} ${frame.request?.tool_name ?? ""} ${JSON.stringify(frame.request?.input ?? {}).slice(0, 160)}`;
  if (frame.type === "control_response")
    return `control_response ${frame.response?.subtype} ${frame.response?.request_id === interruptId ? "(interrupt) " + JSON.stringify(frame.response?.response ?? frame.response?.error ?? {}).slice(0, 200) : ""}`;
  return `${frame.type} ${JSON.stringify(frame).slice(0, 240)}`;
};
let finish;
const done = new Promise((resolve) => (finish = resolve));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    appendFileSync(path.join(root, "cli.stdout.jsonl"), line + "\n");
    let frame;
    try { frame = JSON.parse(line); } catch { log(`${at()} cli   unparsable line`); continue; }
    const text = describe(frame);
    if (text) log(`${at()} cli   ${results ? `[after result ${results}] ` : ""}${text}`);
    if (frame.type === "control_response" && frame.response?.request_id === initId) send(userFrame("Start the background probe."));
    const foreground = frame.type === "control_request" && frame.request?.subtype === "can_use_tool" && frame.request?.tool_use_id === "toolu_bgprobe_2";
    if (foreground && scenario === "interrupt-approval") setTimeout(() => interrupt("approval unanswered"), 1500);
    else if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
      send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { behavior: "allow", updatedInput: frame.request.input } } });
      if (foreground && scenario === "interrupt-tool")
        setTimeout(() => interrupt("foreground command running"), Number(process.env.PROBE_INTERRUPT_AFTER_MS ?? 2500));
      if (foreground && scenario === "interrupt-steer") {
        setTimeout(() => { log(`${at()} host  message added to the turn`); send({ ...userFrame("Steered message."), priority: "next" }); }, 2000);
        setTimeout(() => interrupt("foreground command running, a message queued"), 2500);
      }
    }
    if (frame.type === "result") {
      results++;
      if (results === 1) {
        if ((["send-while-running", "finish-during-turn"].includes(scenario) || interrupting) && !secondUserSent) {
          secondUserSent = true;
          setTimeout(() => { log(`${at()} host  second user message while the background command runs`); send(userFrame("Second message.")); }, 1500);
          if (scenario === "interrupt-model") setTimeout(() => interrupt("model not answered"), 4500);
        }
        if (!interrupting) setTimeout(() => finish("waited"), waitAfterResult * 1000);
      }
      if (interrupting && interruptSent && results === 2) {
        setTimeout(() => { log(`${at()} host  third user message after the interrupt`); send(userFrame("Third message.")); }, 2000);
        setTimeout(() => finish("waited"), waitAfterResult * 1000);
      }
    }
  }
});
child.on("exit", (code, signal) => { log(`${at()} cli   exited code=${code} signal=${signal}`); finish("exit"); });
send({ type: "control_request", request_id: initId, request: { subtype: "initialize", hooks: null } });
const guard = setTimeout(() => finish("guard"), (waitAfterResult + bgSeconds + 60) * 1000);
const why = await done;
clearTimeout(guard);
log(`${at()} host  stopping (${why}); results=${results} modelRequests=${modelRequests}`);
child.stdin.end();
await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 6000); child.on("exit", () => { clearTimeout(timer); resolve(); }); if (child.exitCode !== null) { clearTimeout(timer); resolve(); } });
if (stderr.trim()) writeFileSync(path.join(root, "cli.stderr"), stderr);
log(`stderr bytes=${stderr.length}`);
mock.close();
process.exit(0);
