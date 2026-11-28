import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacOwnedProcessTree } from "../../../packages/backend/src/mac-owned-process-tree";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerOptions,
  type ClaudeRunnerSnapshot,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/agents/claude/claude-managed-runner";

import {
  CLAUDE_STEERING_START_TIMEOUT_MS,
  ClaudeSteeringDeadline,
} from "../../../packages/backend/src/agents/claude/claude-steering";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(mode = "ordinary", options: ClaudeRunnerOptions = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-runner-parity-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  for (const directory of [home, workspace, config]) mkdirSync(directory, { mode: 0o700 });
  const log = path.join(root, "synthetic-frames.jsonl");
  const executable = path.join(root, "synthetic-claude");
  const nativeReplyIds = [randomUUID(), randomUUID()];
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = (value) => fs.appendFileSync(process.env.PARITY_LOG, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
log({args: process.argv.slice(2)});
const mode = process.env.PARITY_MODE;
let first, firstSession;
const steers = [];
const lifecycle = (command_uuid, state) => send({type:'command_lifecycle', command_uuid, state});
const beginReply = (ids, text) => {
  const messages = ids.length ? {user_message_uuids:ids} : {};
  send({type:'system', subtype:'init', model:'fixture-model', ...messages});
  send({type:'system', subtype:'status', status:'requesting', ...messages});
  send({type:'stream_event', parent_tool_use_id:null,
    ...messages, user_message_uuid:ids.at(-1),
    event:{type:'message_start',message:{id:'msg_'+(ids.at(-1) || 'unbound'),model:'fixture-model',usage:{input_tokens:7}}},
  });
  send({type:'stream_event', parent_tool_use_id:null, event:{
    type:'content_block_start', index:0, content_block:{type:'text', text:''},
  }});
  send({type:'stream_event', parent_tool_use_id:null, event:{
    type:'content_block_delta', index:0, delta:{type:'text_delta', text},
  }});
};
const finishReply = (ids, replyId, text) => {
  send({type:'assistant', uuid:replyId, parent_tool_use_id:null, message:{
    id:'msg_'+replyId, model:'fixture-model', stop_reason:'end_turn', content:[{type:'text', text}],
  }});
  send({type:'result', subtype:'success', is_error:false, num_turns:1, terminal_reason:'completed',
    ...(ids.length && {user_message_uuid:ids.at(-1), user_message_uuids:ids}),
  });
};
readline.createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line); log(frame);
  if(frame.type === 'control_request') {
    if(frame.request.subtype !== 'initialize' && process.env.PARITY_MODE === 'timeout') return;
    if(frame.request.subtype === 'initialize' && process.env.PARITY_MODE === 'model-alias')
      send({type:'system',subtype:'init',model:'fixture-actual-model',permissionMode:'plan'});
    if(frame.request.subtype === 'initialize' && process.env.PARITY_MODE === 'inherited-plan')
      send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
    if(first && frame.request.subtype === 'set_model' && process.env.PARITY_MODE.startsWith('model-replay-')) {
      send({type:'user',isReplay:true,parent_tool_use_id:null,session_id:firstSession,uuid:first,
        message:{role:'user',content:process.env.PARITY_MODE === 'model-replay-output'
          ? '<local-command-stdout>Set model to \`fixture-model (fixture-actual-model)\`</local-command-stdout>'
          : 'Unexpected user message'}});
    }
    const response = frame.request.subtype === 'initialize' ? {
      models: process.env.PARITY_MODE === 'model-alias'
        ? [{value:'fixture-alias',resolvedModel:'fixture-actual-model',displayName:'Fixture',supportedEffortLevels:['low','high']}]
        : [{value:'fixture-model',displayName:'Fixture',supportedEffortLevels:['low','high'],
            ...(process.env.PARITY_MODE === 'bad-resolved-model' ? {resolvedModel:[]} : {})}],
      commands: [{name:'fixture:check',description:'Synthetic command'}],
      account: {apiKeySource:'must-not-be-forwarded'},
    } : {};
    send({type:'control_response',response:{
      subtype:'success', request_id: process.env.PARITY_MODE === 'wrong-id' &&
        frame.request.subtype !== 'initialize' ? 'unrelated' : frame.request_id, response,
    }});
  } else if(frame.type === 'user') {
    first ||= frame.uuid;
    firstSession ||= frame.session_id;
    if(mode.startsWith('steer-rollover')) {
      if(!frame.priority) {
        lifecycle(first, 'queued');
        lifecycle(first, 'started');
        beginReply([first], 'First reply');
        return;
      }
      const [firstReply, nextReply] = JSON.parse(process.env.PARITY_REPLY_IDS);
      // The CLI queues the steer during the current stream, then starts it after the first result.
      steers.push(frame.uuid);
      lifecycle(frame.uuid, 'queued');
      const batch = mode === 'steer-rollover-batch' || mode.startsWith('steer-rollover-partial-result') ||
        mode.startsWith('steer-rollover-no-start');
      if(batch && steers.length < 2) return;
      finishReply([first], firstReply, 'First reply');
      lifecycle(first, 'completed');
      if(mode.startsWith('steer-rollover-no-start')) {
        if(mode.endsWith('completed-only')) for(const uuid of steers) lifecycle(uuid, 'completed');
        // Prove the child and frame reader are still live after omitting the start events.
        send({type:'system', subtype:'commands_changed', commands:[{name:'fixture:steer-boundary', description:'Boundary reached'}]});
        return;
      }
      if(mode.startsWith('steer-rollover-missing-start-stream')) {
        const inputs = mode.endsWith('unbound') ? [] :
          mode.endsWith('foreign') ? [...steers, require('node:crypto').randomUUID()] : steers;
        beginReply(inputs, 'Second reply');
        return;
      }
      if(mode === 'steer-rollover-cancelled') lifecycle(frame.uuid, 'cancelled');
      const next = mode === 'steer-rollover-unrelated' ? [require('node:crypto').randomUUID()] :
        mode === 'steer-rollover-unattributed' ? [] : steers;
      const continueTurn = () => {
        for(const uuid of next) lifecycle(uuid, 'started');
        const reported = mode === 'steer-rollover-mismatch' ? [require('node:crypto').randomUUID()] : next;
        beginReply(reported, 'Second reply');
        const resultIds = mode === 'steer-rollover-partial-result-omits-first' ? reported.slice(1) :
          mode === 'steer-rollover-partial-result-omits-last' ? reported.slice(0, -1) :
          mode === 'steer-rollover-partial-result-omits-all' ? [] :
          mode === 'steer-rollover-partial-result-duplicate' ? reported.map(() => reported[0]) :
          mode === 'steer-rollover-partial-result-malformed' ? [reported[0], null] :
          mode === 'steer-rollover-partial-result-foreign' ? [require('node:crypto').randomUUID()] : reported;
        finishReply(resultIds, nextReply, 'Second reply');
        for(const uuid of next) lifecycle(uuid, 'completed');
      };
      if(mode === 'steer-rollover-gap') {
        const gate = process.env.PARITY_ROLLOVER_GATE;
        const release = () => {
          if(!fs.existsSync(gate)) return;
          watching.close();
          continueTurn();
        };
        const watching = fs.watch(require('node:path').dirname(gate), {persistent:false}, release);
        release();
      } else continueTurn();
      return;
    }
    if(process.env.PARITY_MODE === 'inherited-plan-late')
      send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
    if(mode === 'steer') {
      lifecycle(frame.uuid, 'queued');
      lifecycle(frame.uuid, 'started');
      if(!frame.priority) return;
      send({type:'system', subtype:'status', status:'requesting', user_message_uuids:[first,frame.uuid]});
    }
    send({type:'assistant',parent_tool_use_id:null,message:{
      id: first, model:'fixture-model', usage:{input_tokens:7},content:[],
    }});
    if(process.env.PARITY_MODE === 'missing-result') {
      process.stdout.end(() => process.exit(0));
      return;
    }
    send({type:'result',subtype:process.env.PARITY_MODE === 'error' ? 'error_during_execution' : 'success',
      is_error:process.env.PARITY_MODE === 'error', usage:{input_tokens:19,output_tokens:11,cache_read_input_tokens:23},
      modelUsage:{'fixture-model':{contextWindow:100}},total_cost_usd:0.012,
      terminal_reason: process.env.PARITY_MODE === 'aborted' ? 'aborted_tools' : 'completed',
      ...(mode === 'steer' && {user_message_uuids:[first,frame.uuid]}),
    });
    if(mode === 'steer') {
      lifecycle(first, 'completed');
      lifecycle(frame.uuid, 'completed');
    }
  }
});
`}`,
    { mode: 0o700 },
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const results: ClaudeRunnerTerminalResult[] = [];
  const observations: Array<Parameters<NonNullable<ClaudeRunnerOptions["onResult"]>>[1]> = [];
  const events: Array<{ type: string; turnId: string; text: unknown }> = [];
  const listeners = new Set<(snapshot: ClaudeRunnerSnapshot) => void>();
  const completions = new Map<string, () => void>();
  const waitForResult = (turnId: string) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    completions.set(turnId, resolve);
    return promise;
  };
  const runner = new ClaudeManagedRunnerProcess(
    workspace,
    randomUUID(),
    true,
    0,
    {
      HOME: home,
      PATH: root,
      XDG_DATA_HOME: path.join(home, "data"),
      CLAUDE_CONFIG_DIR: config,
      PARITY_LOG: log,
      PARITY_MODE: mode,
      PARITY_REPLY_IDS: JSON.stringify(nativeReplyIds),
      PARITY_ROLLOVER_GATE: path.join(root, "continue-steer"),
    },
    (snapshot) => {
      for (const listener of listeners) listener(snapshot);
    },
    true,
    (type, payload, live) => events.push({ type, turnId: live.turnId, text: payload.text }),
    {
      ...options,
      onResult: (result, observation) => {
        results.push(result);
        observations.push(observation);
        completions.get(result.turnId)?.();
        completions.delete(result.turnId);
      },
    },
  );
  cleanups.push(() => runner.shutdown());
  const frames = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const waitForSnapshot = (matches: (snapshot: ClaudeRunnerSnapshot) => boolean) => {
    const snapshot = runner.snapshot();
    if (matches(snapshot)) return Promise.resolve(snapshot);
    return new Promise<ClaudeRunnerSnapshot>((resolve) => {
      listeners.add(function listen(snapshot) {
        if (!matches(snapshot)) return;
        listeners.delete(listen);
        resolve(snapshot);
      });
    });
  };
  return {
    runner,
    executable,
    frames,
    results,
    observations,
    events,
    nativeReplyIds,
    releaseRollover: () => writeFileSync(path.join(root, "continue-steer"), ""),
    waitForSnapshot,
    waitForResult,
  };
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude remote runner protocol",
  () => {
    it("prepares and discovers options without sending a model turn; settings require native acknowledgements", async () => {
      const f = fixture();
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered).toMatchObject({
        models: [{ value: "fixture-model" }],
        commands: [{ name: "fixture:check" }],
        settingsAcknowledged: true,
      });
      expect(discovered).not.toHaveProperty("account");
      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        turnId: "",
        terminalResult: null,
      });
      const changing = f.runner.configure(
        { model: "fixture-model", effort: "high", permissionMode: "plan" },
        f.runner.snapshot().revision,
      );
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      await expect(changing).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high", permissionMode: "plan" },
        settingsAcknowledged: true,
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(0);
      expect(
        f
          .frames()
          .filter((frame) => frame.type === "control_request")
          .map((frame) => frame.request),
      ).toEqual([
        { subtype: "initialize", hooks: null },
        { subtype: "set_model", model: "fixture-model" },
        { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
        { subtype: "set_permission_mode", mode: "plan" },
      ]);
    });

    it("keeps an idle runner ready when set_model replays its local command output", async () => {
      const f = fixture("model-replay-output");
      const firstTurn = randomUUID();
      const firstResult = f.waitForResult(firstTurn);
      await f.runner.send(f.executable, "first turn", firstTurn, 0);
      await firstResult;
      expect(f.results).toHaveLength(1);
      const before = f.runner.snapshot();
      await expect(
        f.runner.configure({ model: "fixture-model", effort: "high" }, before.revision),
      ).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high" },
        settingsAcknowledged: true,
      });
      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        turnId: firstTurn,
        terminalResult: before.terminalResult,
      });
      expect(f.results).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);

      const nextTurn = randomUUID();
      const nextResult = f.waitForResult(nextTurn);
      await f.runner.send(f.executable, "next turn", nextTurn, f.runner.snapshot().revision);
      await nextResult;
      expect(f.results.map((result) => result.turnId)).toEqual([firstTurn, nextTurn]);
      expect(f.frames().filter((frame) => frame.args)).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toMatchObject([
        { uuid: firstTurn },
        { uuid: nextTurn },
      ]);
    });

    it("still rejects an unexpected user frame while waiting for set_model", async () => {
      const f = fixture("model-replay-user");
      const turn = randomUUID();
      const completed = f.waitForResult(turn);
      await f.runner.send(f.executable, "first turn", turn, 0);
      await completed;
      expect(f.results).toHaveLength(1);
      await expect(
        f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision),
      ).rejects.toThrow("Claude user frame outside an active turn");
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
    });

    it("rejects unavailable model and effort before sending controls", async () => {
      const f = fixture();
      await f.runner.prepare(f.executable);
      const revision = f.runner.snapshot().revision;
      await expect(f.runner.configure({ model: "unknown" }, revision)).rejects.toThrow(
        "unsupported Claude model",
      );
      await expect(
        f.runner.configure({ model: "fixture-model", effort: "max" }, revision),
      ).rejects.toThrow("unsupported Claude effort");
      expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
      expect(f.runner.snapshot().status).toBe("idle");
    });

    it("validates effort against the resolved inherited model without selecting the alias", async () => {
      const f = fixture("model-alias");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.models[0]).toMatchObject({
        value: "fixture-alias",
        resolvedModel: "fixture-actual-model",
      });
      await f.runner.configure({ effort: "high" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings).toEqual({
        model: "fixture-actual-model",
        effort: "high",
        permissionMode: "plan",
      });
      expect(f.frames().filter((frame) => frame.request?.subtype === "set_model")).toEqual([]);
    });

    it("rejects malformed resolved models and shares failure cleanup with immediate shutdown", async () => {
      const f = fixture("bad-resolved-model");
      await expect(f.runner.prepare(f.executable)).rejects.toThrow("invalid Claude resolved model");
      await expect(Promise.all([f.runner.shutdown(), f.runner.shutdown()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.cleanupError).toBeNull();
    });

    it("keeps inherited permission settings unknown until the CLI reports them", async () => {
      const f = fixture();
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settingsAcknowledged).toBe(true);
      expect(discovered.settings.permissionMode).toBeNull();
      await f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBeNull();
      expect(f.frames()[0].args).not.toContain("--permission-mode");
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
    });

    it("reports inherited Plan mode without turning it into an explicit setting", async () => {
      const f = fixture("inherited-plan");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settings.permissionMode).toBe("plan");
      await f.runner.configure({ effort: "high" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings).toMatchObject({
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      await f.runner.configure({ model: "fixture-model" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
      await f.runner.retireIfInactive();
      await f.runner.prepare(f.executable);
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches.every((frame) => !frame.args.includes("--permission-mode"))).toBe(true);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
    });

    it("updates inherited permissions when native init arrives with the first turn", async () => {
      const f = fixture("inherited-plan-late");
      const discovered = await f.runner.prepare(f.executable);
      expect(discovered.settings.permissionMode).toBeNull();
      await f.runner.send(f.executable, "first turn", randomUUID(), f.runner.snapshot().revision);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
    });

    it.each(["bypassPermissions", null])(
      "rejects unsafe or invalid permission mode %s",
      async (mode) => {
        const f = fixture();
        await f.runner.prepare(f.executable);
        await expect(
          f.runner.configure(
            { permissionMode: mode } as unknown as Parameters<typeof f.runner.configure>[0],
            f.runner.snapshot().revision,
          ),
        ).rejects.toThrow("unsupported Claude permission mode");
        expect(
          f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
        ).toEqual([]);
      },
    );

    it("confirms an explicit permission change and retains default on worker restart", async () => {
      const f = fixture();
      await f.runner.prepare(f.executable);
      await f.runner.configure({ permissionMode: "plan" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("plan");
      await f.runner.configure({ permissionMode: "default" }, f.runner.snapshot().revision);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBe("default");
      await f.runner.retireIfInactive();
      const restarted = await f.runner.prepare(f.executable);
      expect(restarted.settings.permissionMode).toBe("default");
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches[1].args.slice(-2)).toEqual(["--permission-mode", "default"]);
    });

    it("confirms explicitly selected startup settings after initialization", async () => {
      const f = fixture("ordinary", {
        model: "fixture-model",
        effort: "high",
        permissionMode: "acceptEdits",
      });
      expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
      expect(f.runner.optionsSnapshot.settings.permissionMode).toBeNull();
      await expect(f.runner.prepare(f.executable)).resolves.toMatchObject({
        settings: { model: "fixture-model", effort: "high", permissionMode: "acceptEdits" },
        settingsAcknowledged: true,
      });
    });

    it.each(["timeout", "wrong-id"])(
      "keeps uncertain settings blocked on %s instead of claiming success",
      async (mode) => {
        const f = fixture(mode, { controlTimeoutMs: 1500 });
        await f.runner.prepare(f.executable);
        await expect(
          f.runner.configure({ permissionMode: "acceptEdits" }, f.runner.snapshot().revision),
        ).rejects.toThrow();
        expect(f.runner.snapshot().status).toBe("outcome-unknown");
        expect(f.runner.optionsSnapshot.settingsAcknowledged).toBe(false);
        await expect.poll(() => f.runner.hasWorker).toBe(false);
      },
    );

    it("steers in the same turn with a distinct input identity and next priority", async () => {
      const f = fixture("steer");
      const turnId = randomUUID();
      const steerId = randomUUID();
      await f.runner.send(f.executable, "start", turnId, 0);
      const revision = f.runner.snapshot().revision;
      let dispatches = 0;
      await f.runner.steer("focus on this", steerId, turnId, revision, () => dispatches++);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.frames().filter((frame) => frame.type === "user")).toMatchObject([
        { uuid: turnId, message: { content: "start" } },
        { uuid: steerId, priority: "next", message: { content: "focus on this" } },
      ]);
      expect(f.runner.snapshot().turnId).toBe(turnId);
      expect(f.results).toHaveLength(1);
      expect(f.results[0]?.turnId).toBe(turnId);
      expect(dispatches).toBe(1);
      await expect(
        f.runner.steer("duplicate", steerId, turnId, f.runner.snapshot().revision),
      ).rejects.toThrow();
    });

    it.each([
      { mode: "steer-rollover", expected: "idle" },
      { mode: "steer-rollover-gap", expected: "idle" },
      { mode: "steer-rollover-batch", expected: "idle", secondSteer: true },
      { mode: "steer-rollover-mismatch", expected: "outcome-unknown" },
      {
        mode: "steer-rollover-partial-result-omits-first",
        expected: "outcome-unknown",
        secondSteer: true,
        recoverable: true,
      },
      {
        mode: "steer-rollover-partial-result-omits-last",
        expected: "outcome-unknown",
        secondSteer: true,
        recoverable: true,
      },
      {
        mode: "steer-rollover-partial-result-omits-all",
        expected: "outcome-unknown",
        secondSteer: true,
        recoverable: true,
      },
      ...["duplicate", "malformed", "foreign"].map((reason) => ({
        mode: `steer-rollover-partial-result-${reason}`,
        expected: "outcome-unknown",
        secondSteer: true,
      })),
      {
        mode: "steer-rollover-missing-start-stream",
        expected: "outcome-unknown",
        recoverable: true,
      },
      { mode: "steer-rollover-missing-start-stream-unbound", expected: "outcome-unknown" },
      { mode: "steer-rollover-missing-start-stream-foreign", expected: "outcome-unknown" },
      { mode: "steer-rollover-unrelated", expected: "outcome-unknown" },
      { mode: "steer-rollover-unattributed", expected: "outcome-unknown" },
      { mode: "steer-rollover-cancelled", expected: "outcome-unknown" },
    ])(
      "binds the next native response to the dispatched steer UUID ($mode)",
      async ({ mode, expected, secondSteer, recoverable }) => {
        const f = fixture(mode);
        const turnId = randomUUID();
        const steerId = randomUUID();
        await f.runner.send(f.executable, "start", turnId, f.runner.snapshot().revision);
        const streaming = await f.waitForSnapshot(
          (snapshot) => snapshot.streamText === "First reply",
        );
        expect(streaming).toMatchObject({ status: "running", turnId, turnOrigin: "host" });
        const finished = f.waitForSnapshot(
          (snapshot) =>
            snapshot.status === "outcome-unknown" ||
            (snapshot.status === "idle" && f.results.length === 2),
        );
        let dispatches = 0;
        await f.runner.steer(
          "include this next",
          steerId,
          turnId,
          streaming.revision,
          () => dispatches++,
        );
        const secondSteerId = randomUUID();
        if (secondSteer)
          await f.runner.steer(
            "add this too",
            secondSteerId,
            turnId,
            f.runner.snapshot().revision,
            () => dispatches++,
          );
        if (mode === "steer-rollover-gap") {
          const waiting = await f.waitForSnapshot((snapshot) => snapshot.status === "starting");
          expect(waiting).toMatchObject({ turnId, sendEnabled: false, stopEnabled: false });
          expect(f.runner.retireIfInactive()).toBeNull();
          await expect(
            f.runner.send(f.executable, "would interleave", randomUUID(), waiting.revision),
          ).rejects.toThrow("Claude session is busy");
          f.releaseRollover();
        }
        const snapshot = await finished;
        expect(snapshot.status).toBe(expected);
        expect(f.frames().filter((frame) => frame.type === "user")).toMatchObject([
          { uuid: turnId, message: { content: "start" } },
          { uuid: steerId, priority: "next", message: { content: "include this next" } },
          ...(secondSteer
            ? [{ uuid: secondSteerId, priority: "next", message: { content: "add this too" } }]
            : []),
        ]);
        expect(dispatches).toBe(secondSteer ? 2 : 1);

        const [firstReply, nextReply] = f.nativeReplyIds;
        const completed = [{ turnId, success: true }];
        const replies = [{ itemId: firstReply, replyText: "First reply" }];
        const deltas = [{ type: "text-delta", turnId, text: "First reply" }];
        if (expected === "idle") {
          completed.push({ turnId: steerId, success: true });
          replies.push({ itemId: nextReply, replyText: "Second reply" });
          deltas.push({ type: "text-delta", turnId: steerId, text: "Second reply" });
          expect(snapshot).toMatchObject({ turnId: steerId, turnOrigin: "host", reason: null });
          expect(f.runner.hasWorker).toBe(true);
          if (secondSteer) expect(f.results[1]?.steeringIds).toEqual([secondSteerId]);
        } else {
          expect(snapshot.reason).toMatch(/^claude-unrequested-turn:/);
          expect(snapshot.sendEnabled).toBe(false);
          expect(snapshot.steeringRecovery).toBeUndefined();
          if (mode.startsWith("steer-rollover-partial-result")) {
            expect(snapshot.stopEnabled).toBe(false);
            expect(snapshot.pendingSteeringIds).toEqual([steerId, secondSteerId]);
            deltas.push({ type: "text-delta", turnId: steerId, text: "Second reply" });
          }
          await f.runner.shutdown();
          if (recoverable && process.platform === "darwin")
            expect(f.runner.snapshot().steeringRecovery).toEqual({
              version: 1,
              inputIds: secondSteer ? [steerId, secondSteerId] : [steerId],
            });
          else expect(f.runner.snapshot().steeringRecovery).toBeUndefined();
        }
        expect(f.results).toMatchObject(completed);
        expect(f.observations).toMatchObject(replies);
        expect(f.events.filter((event) => event.type === "text-delta")).toEqual(deltas);
      },
    );

    it.skipIf(process.platform !== "darwin")(
      "does not publish a recovery proof when the owned process tree cannot be confirmed gone",
      async () => {
        const f = fixture("steer-rollover-missing-start-stream");
        const opener = randomUUID();
        const steer = randomUUID();
        await f.runner.send(f.executable, "start", opener, f.runner.snapshot().revision);
        await f.waitForSnapshot((snapshot) => snapshot.streamText === "First reply");
        const enteredCleanup = Promise.withResolvers<void>();
        const firstCleanup = Promise.withResolvers<void>();
        const cleanup = vi
          .spyOn(MacOwnedProcessTree.prototype, "terminate")
          .mockImplementationOnce(() => {
            enteredCleanup.resolve();
            return firstCleanup.promise;
          });
        try {
          const failed = f.waitForSnapshot(
            (snapshot) =>
              snapshot.reason?.startsWith("Claude process cleanup unconfirmed") === true,
          );
          await f.runner.steer("next", steer, opener, f.runner.snapshot().revision);
          await enteredCleanup.promise;
          const sharedFailure = expect(f.runner.shutdown()).rejects.toThrow(
            "Claude process cleanup unconfirmed",
          );
          firstCleanup.reject(new Error("fixture owned process tree could not be verified"));
          await sharedFailure;
          expect(await failed).toMatchObject({
            status: "outcome-unknown",
            pendingSteeringIds: [steer],
          });
          expect(f.runner.hasWorker).toBe(true);
          expect(f.runner.snapshot().steeringRecovery).toBeUndefined();
        } finally {
          firstCleanup.resolve();
          cleanup.mockRestore();
        }
        await f.runner.shutdown();
        expect(f.runner.snapshot().steeringRecovery).toBeUndefined();
      },
    );

    it("bounds an unresolved steering gap once and cancels the deadline on native progress", () => {
      const first = vi.fn();
      const second = vi.fn();
      const deadline = new ClaudeSteeringDeadline();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        deadline.watch(true, first);
        vi.advanceTimersByTime(CLAUDE_STEERING_START_TIMEOUT_MS - 1);
        deadline.watch(true, first);
        expect(first).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(first).toHaveBeenCalledOnce();

        deadline.watch(false, first);
        deadline.watch(true, second);
        deadline.watch(false, second);
        vi.advanceTimersByTime(CLAUDE_STEERING_START_TIMEOUT_MS);
        expect(second).not.toHaveBeenCalled();
      } finally {
        deadline.clear();
        vi.useRealTimers();
      }
    });

    it.each(["silent", "completed-only"])(
      "keeps both steers unconfirmed when the CLI never starts them (%s)",
      async (mode) => {
        const f = fixture(`steer-rollover-no-start-${mode}`);
        const first = randomUUID();
        const steers = [randomUUID(), randomUUID()];
        await f.runner.send(f.executable, "start", first, f.runner.snapshot().revision);
        await f.waitForSnapshot((snapshot) => snapshot.streamText === "First reply");
        let expire: (() => void) | undefined;
        const deadline = vi
          .spyOn(ClaudeSteeringDeadline.prototype, "watch")
          .mockImplementation((waiting, onTimeout) => {
            expire = waiting ? (expire ?? onTimeout) : undefined;
          });
        try {
          for (const [index, id] of steers.entries())
            await f.runner.steer(`next ${index}`, id, first, f.runner.snapshot().revision);
          const waiting = await f.waitForSnapshot(() =>
            f.runner.optionsSnapshot.commands.some(({ name }) => name === "fixture:steer-boundary"),
          );
          expect(waiting).toMatchObject({
            status: "starting",
            turnId: first,
            sendEnabled: false,
            stopEnabled: false,
            pendingSteeringIds: steers,
          });
          expect(f.runner.hasWorker).toBe(true);
          expect(expire).toBeTypeOf("function");
          expire!();
          const unsettled = f.runner.snapshot();
          expect(unsettled).toMatchObject({
            status: "outcome-unknown",
            turnId: first,
            sendEnabled: false,
            stopEnabled: false,
            pendingSteeringIds: steers,
          });
          expect(unsettled.reason).toMatch(/^claude-steering-start-unconfirmed(?::|$)/);
          await expect(
            f.runner.send(f.executable, "would overtake", randomUUID(), unsettled.revision),
          ).rejects.toThrow();
          expect(f.results).toMatchObject([{ turnId: first, success: true }]);
          expect(
            f
              .frames()
              .filter((frame) => frame.type === "user")
              .map(({ uuid }) => uuid),
          ).toEqual([first, ...steers]);
        } finally {
          deadline.mockRestore();
        }
      },
    );

    it.each(["ordinary", "error", "aborted"])(
      "retains the native result aggregate separately from context usage (%s)",
      async (mode) => {
        const f = fixture(mode);
        const id = randomUUID();
        await f.runner.send(f.executable, "one turn", id, 0);
        await expect.poll(() => f.results.length).toBe(1);
        expect(f.results[0]).toMatchObject({
          turnId: id,
          success: mode === "ordinary",
          usage: { input_tokens: 19, output_tokens: 11, cache_read_input_tokens: 23 },
          costUsd: 0.012,
        });
        expect(f.runner.snapshot().tokenUsage).toEqual({ input_tokens: 7 });
        if (mode === "aborted") expect(f.runner.snapshot().lastOutcome).toBe("cancelled");
      },
    );

    it("keeps a fork lazy and binds native parent, target and cutoff on first launch", async () => {
      const parent = randomUUID();
      const cutoff = randomUUID();
      const f = fixture("ordinary", { forkSourceNativeId: parent, forkCutoff: cutoff });
      expect(f.runner.hasWorker).toBe(false);
      await f.runner.send(f.executable, "fork continuation", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(f.frames()[0].args).toEqual(
        expect.arrayContaining([
          `--resume=${parent}`,
          "--fork-session",
          `--session-id=${f.runner.sessionId}`,
          `--resume-session-at=${cutoff}`,
        ]),
      );
      await f.runner.retireIfInactive();
      await f.runner.send(f.executable, "same fork", randomUUID(), f.runner.snapshot().revision);
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      const launches = f.frames().filter((frame) => frame.args);
      expect(launches).toHaveLength(2);
      expect(launches[1].args).toContain(`--resume=${f.runner.sessionId}`);
      expect(launches[1].args).not.toContain("--fork-session");
    });

    it("does not infer completion or usage totals when the CLI exits without a native result", async () => {
      const f = fixture("missing-result");
      await f.runner.send(f.executable, "unfinished", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.snapshot().terminalResult).toBeNull();
      expect(f.results).toEqual([]);
      expect(f.runner.snapshot().sendEnabled).toBe(false);
    });
  },
);
