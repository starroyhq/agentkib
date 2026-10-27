import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A scripted stand-in for the Claude CLI, built from hand-made stream-json frames. It records
 * every line it receives on stdin, echoes the one environment variable the runner overrides, and
 * plays back a plan the test writes. No real Claude session or user configuration is involved, and
 * that a real CLI emits any of these frames in this form is NOT verified.
 *
 * Plan items (`beforeInitialize` before answering initialize, `afterInitialize` after its
 * response, `onUser` on each user frame, then ordinary assistant/result unless `noResult`):
 *  - a frame object, sent as is;
 *  - `{ __exit: true }`: the process ends, like a CLI that dies mid-turn;
 *  - `{ __closeOutput: true }`: closes stdout while the root process stays alive;
 *  - `{ __spawn: "name", detached?: true }`: starts a child that keeps running and records its PID;
 *  - `{ __huge: true }`: writes more than the 25 MiB frame limit without a line break;
 *  - `{ __raw: "text" }`: writes the text and a line break as is, JSON or not;
 *  - `{ __wait: "<request_id>" }`: holds the rest of the plan until stdin carries a
 *    control_response for that request, so a test can prove the answer arrived before the result.
 */
export type FakeClaudePlan = {
  beforeInitialize?: unknown[];
  afterInitialize?: unknown[];
  onUser?: unknown[];
  noResult?: boolean;
  /** Never answer initialize, so the runner's initialization times out. */
  silentInitialize?: boolean;
  /** The slash-command catalog the initialize response reports; empty by default. */
  commands?: unknown[];
};

export function createFakeClaude(prefix = "agentkib-claude-drift-") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const bin = path.join(root, "bin");
  for (const directory of [workspace, home, config, bin]) mkdirSync(directory, { mode: 0o700 });
  const log = path.join(root, "frames.jsonl");
  const planFile = path.join(root, "plan.json");
  const children = path.join(root, "child");
  const executable = path.join(bin, "claude");
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const plan = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8')); } catch { return {}; } };
const log = (value) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
log({args: process.argv.slice(2), env: {background: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null}});
let queue = [];
let waiting = null;
let first;
const run = () => {
  while (queue.length) {
    const item = queue.shift();
    if (item.__exit) { process.stdout.end(() => process.exit(0)); return; }
    if (item.__closeOutput) { process.stdout.end(); continue; }
    if (item.__spawn) {
      const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        {stdio: 'ignore', detached: !!item.detached});
      fs.writeFileSync(process.env.FAKE_CHILDREN + '.' + item.__spawn, String(started.pid));
      continue;
    }
    if (item.__huge) { process.stdout.write('x'.repeat(26 * 1024 * 1024)); continue; }
    if (item.__raw !== undefined) { process.stdout.write(item.__raw + '\n'); continue; }
    if (item.__wait) { waiting = item.__wait; return; }
    send(item);
  }
};
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const frame = JSON.parse(line); log(frame);
  if (frame.type === 'control_response') {
    if (waiting && frame.response && frame.response.request_id === waiting) { waiting = null; run(); }
    return;
  }
  if (frame.type === 'control_request') {
    const initialize = frame.request.subtype === 'initialize';
    if (initialize) { queue = (plan().beforeInitialize || []).slice(); run(); }
    if (initialize && plan().silentInitialize) return;
    send({type: 'control_response', response: {
      subtype: 'success', request_id: frame.request_id,
      response: initialize ? {
        models: [{value: 'fixture-model', displayName: 'Fixture', supportedEffortLevels: ['low', 'high']}],
        commands: plan().commands || [],
      } : {},
    }});
    if (initialize) { queue = (plan().afterInitialize || []).slice(); run(); }
  } else if (frame.type === 'user') {
    first ||= frame.uuid;
    queue = (plan().onUser || []).slice();
    if (!plan().noResult) {
      queue.push({type: 'assistant', parent_tool_use_id: null, message: {
        id: first, model: 'fixture-model', usage: {input_tokens: 7}, content: [],
      }});
      queue.push({type: 'result', subtype: 'success', is_error: false,
        usage: {input_tokens: 19, output_tokens: 11},
        modelUsage: {'fixture-model': {contextWindow: 100}}, terminal_reason: 'completed'});
    }
    run();
  }
});
`}`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: bin,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_DATA_HOME: path.join(home, "data"),
    FAKE_LOG: log,
    FAKE_PLAN: planFile,
    FAKE_CHILDREN: children,
  };
  return {
    root,
    workspace,
    config,
    executable,
    environment,
    setPlan: (plan: FakeClaudePlan) => writeFileSync(planFile, JSON.stringify(plan)),
    /** Every line the fake CLI received, in order, after its own startup record. */
    frames: (): Array<Record<string, any>> =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    childPid: (name: string): number | null =>
      existsSync(`${children}.${name}`)
        ? Number(readFileSync(`${children}.${name}`, "utf8"))
        : null,
  };
}

/** True while the process exists (a zombie that nobody reaped yet counts as gone on Linux). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}
