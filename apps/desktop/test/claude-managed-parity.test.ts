import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedReadOwner,
  ClaudeHostControlPreflightError,
} from "../../../packages/backend/src/claude-managed-read";
import { ClaudeHostStateStore } from "../../../packages/backend/src/claude-host-state";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  openManagedLedger,
} from "../../../packages/backend/src/managed-ledger";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(
  version = "2.1.286",
  handshakeDelayMs = 0,
  mode = "ordinary",
  publish?: (live: Record<string, unknown>) => void,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-owner-parity-")));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const bin = path.join(root, "bin");
  for (const directory of [workspace, home, config, bin]) mkdirSync(directory, { mode: 0o700 });
  const log = path.join(root, "frames.jsonl");
  const resultGate = path.join(root, "release-result");
  const transcript = (id: string) => path.join(config, `${id}.jsonl`);
  writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs'); const crypto = require('node:crypto');
const log = value => fs.appendFileSync(process.env.PARITY_LOG, JSON.stringify(value)+'\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
log({args:process.argv.slice(2)});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const frame=JSON.parse(line); log(frame);
 if(frame.type==='control_request') {
  // Keep the owned root alive so real tree cleanup can be confirmed after stdout closes.
  if(frame.request.subtype==='initialize' && process.env.PARITY_MODE==='close-initialize') { fs.closeSync(1); return; }
  if(frame.request.subtype==='initialize' && process.env.PARITY_MODE==='initialize-rejected') {
   send({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'Synthetic failed initialization'}});
   return;
  }
  if(frame.request.subtype==='initialize' && process.env.PARITY_MODE==='reset-init-failure' &&
     fs.readFileSync(process.env.PARITY_LOG,'utf8').trim().split('\n').filter(line=>JSON.parse(line).args).length>1) {
   send({type:'control_response',response:{subtype:'error',request_id:frame.request_id,error:'Synthetic failed initialization'}});
   return;
  }
  if(frame.request.subtype==='initialize' && process.env.PARITY_MODE==='model-alias')
   send({type:'system',subtype:'init',model:'fixture-actual-model',permissionMode:'plan'});
  if(frame.request.subtype==='initialize' && process.env.PARITY_MODE==='inherited-plan')
   send({type:'system',subtype:'init',model:'fixture-model',permissionMode:'plan'});
  setTimeout(()=>send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:
   frame.request.subtype==='initialize'?{models:process.env.PARITY_MODE==='model-alias'
    ? [{value:'fixture-alias',resolvedModel:'fixture-actual-model',displayName:'Fixture',supportedEffortLevels:['low','high']}]
    : [{value:'fixture-model',displayName:'Fixture',supportedEffortLevels:['low','high']},
       ...(process.env.PARITY_MODE==='effort-models'?[{value:'fixture-low-model',displayName:'Low effort fixture',supportedEffortLevels:['low']}]:[])],commands:[{name:'fixture-skill',description:'Project fixture'},{name:'not-installed'}]}:{}}}),frame.request.subtype==='initialize'?Number(process.env.PARITY_INIT_DELAY):0);
 } else if(frame.type==='user') {
  const assistant=crypto.randomUUID();
  const file=process.env.CLAUDE_CONFIG_DIR+'/'+frame.session_id+'.jsonl';
  fs.appendFileSync(file, JSON.stringify({type:'user',uuid:frame.uuid,sessionId:frame.session_id,cwd:process.cwd(),message:frame.message})+'\n');
  if(process.env.PARITY_MODE==='steer' && !frame.priority) return;
  fs.appendFileSync(file, JSON.stringify({type:'assistant',uuid:assistant,sessionId:frame.session_id,cwd:process.cwd(),message:{role:'assistant',stop_reason:null,content:[{type:'text',text:'Synthetic complete'}]}})+'\n');
  send({type:'assistant',uuid:assistant,parent_tool_use_id:null,message:{id:assistant,model:'fixture-model',usage:{input_tokens:10},content:[]}});
  const finish=()=>send({type:'result',subtype:'success',...(process.env.PARITY_MODE==='missing-usage'?{}:{usage:{input_tokens:10,output_tokens:5}}),modelUsage:{'fixture-model':{contextWindow:100}}});
  if(process.env.PARITY_MODE==='steer') { const timer=setInterval(()=>{if(fs.existsSync(process.env.PARITY_RESULT_GATE)){clearInterval(timer);finish();}},10); } else finish();
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
    PARITY_LOG: log,
    PARITY_INIT_DELAY: String(handshakeDelayMs),
    PARITY_MODE: mode,
    PARITY_RESULT_GATE: resultGate,
  };
  let externalOwner: string | null = null;
  const commands = {
    run: vi.fn(async (command: string, args: string[]) => {
      if (command === "/bin/ps") {
        expect(args).toEqual(["-axo", "pid=,pgid=,lstart=,command="]);
        // Model only this fixture's owner; process-wide ps parsing has dedicated coverage.
        if (externalOwner) process.kill(process.pid, 0);
        return {
          success: true,
          bytes: Buffer.from(
            externalOwner
              ? `${process.pid} ${process.pid} Mon Oct 19 00:00:00 2026 node fixture-owner\n`
              : "",
          ),
        };
      }
      if (args[0] === "agents") {
        expect(args).toEqual(["agents", "--json"]);
        return {
          success: true,
          bytes: Buffer.from(
            JSON.stringify(
              externalOwner
                ? [{ sessionId: externalOwner, pid: process.pid, kind: "interactive" }]
                : [],
            ),
          ),
        };
      }
      expect(args).toEqual(["--version"]);
      return { success: true, bytes: Buffer.from(`${version} (Claude Code)\n`) };
    }),
  } as unknown as Commands;
  const indexed = new Map<string, { agent: string; workspace_id: string; sidechain: boolean }>();
  const store = {
    workspacePath: () => workspace,
    sessions: { id: (_agent: string, id: string) => id, get: (id: string) => indexed.get(id) },
  } as unknown as BackendStore;
  const sessions = {
    verifiedClaudeControlTarget: transcript,
    verifiedClaudeReadSource: (id: string) => ({
      nativeId: id,
      workspaceId: "workspace",
      workspace,
      transcript: transcript(id),
    }),
    claudeControlWorkspace: () => workspace,
    list: async () => ({ sessions: [...indexed.keys()].map((id) => ({ native_ref: id })) }),
    document: async () => ({ source: { agent: "claude-code", workspace_id: "workspace" } }),
  } as unknown as SessionReaders;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const makeOwner = () => {
    const owner = new ClaudeManagedReadOwner(
      store,
      sessions,
      commands,
      root,
      environment,
      randomUUID(),
      publish
        ? {
            publish: (_id, type, _payload, live) => {
              if (type === "state") publish(structuredClone(live));
            },
            alias: () => {},
          }
        : undefined,
    );
    cleanups.push(() => owner.shutdown());
    return owner;
  };
  const frames = (): Array<Record<string, any>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return {
    root,
    workspace,
    transcript,
    makeOwner,
    owner: makeOwner(),
    frames,
    releaseResult: () => writeFileSync(resultGate, "go"),
    setExternalOwner: (id: string | null) => {
      externalOwner = id;
    },
    indexNative: () => {
      const id = randomUUID();
      indexed.set(id, { agent: "claude-code", workspace_id: "workspace", sidechain: false });
      const user = randomUUID();
      writeFileSync(
        transcript(id),
        [
          {
            type: "user",
            uuid: user,
            sessionId: id,
            cwd: workspace,
            message: { role: "user", content: "Existing native turn" },
          },
          {
            type: "assistant",
            uuid: randomUUID(),
            parentUuid: user,
            sessionId: id,
            cwd: workspace,
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Existing native reply" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      return id;
    },
  };
}

async function create(owner: ClaudeManagedReadOwner, fields: Record<string, unknown> = {}) {
  return (await owner.request({
    operation: "create",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId: "browser-device-a",
    ...fields,
  })) as Record<string, any>;
}
async function control(
  owner: ClaudeManagedReadOwner,
  id: string,
  operation: string,
  fields: Record<string, unknown> = {},
) {
  const live = await owner.live(id, true);
  return (await owner.request({
    operation,
    sessionId: id,
    deviceId: "browser-device-a",
    requestId: randomUUID(),
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    ...fields,
  })) as Record<string, any>;
}
async function prepareSettings(owner: ClaudeManagedReadOwner, id: string) {
  return owner.request({
    operation: "settings-prepare",
    sessionId: id,
    deviceId: "browser-device-a",
    runtimeBootId: owner.bootId,
    expectedRevision: (await owner.live(id, true)).revision,
    experimentalEnabled: true,
  });
}
async function next(owner: ClaudeManagedReadOwner, id: string) {
  const list = (await owner.request({ operation: "schedule-list", sessionId: id })) as {
    sessions: Array<Record<string, any>>;
  };
  return list.sessions[0]!;
}
async function prepare(owner: ClaudeManagedReadOwner, id: string) {
  const selected = await next(owner, id);
  expect(selected.next).not.toBeNull();
  return (await owner.request({
    operation: "schedule-prepare",
    sessionId: id,
    itemId: selected.next.itemId,
    requestId: selected.next.requestId,
    deviceId: selected.next.deviceId,
    runtimeBootId: owner.bootId,
    expectedRevision: selected.revision,
  })) as Record<string, any>;
}
async function dispatch(owner: ClaudeManagedReadOwner, permit: Record<string, any>) {
  const { accepted: _accepted, expiresAt: _expiresAt, ...value } = permit;
  return owner.request({ operation: "schedule-dispatch", ...value });
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude remote owner parity (synthetic offline CLI)",
  () => {
    it("reads idle settings without starting a worker and prepares only on an explicit settings request", async () => {
      const f = fixture();
      const created = await create(f.owner);
      for (let i = 0; i < 3; i++) {
        expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
          available: true,
          current: { model: null },
          models: [],
        });
        expect(await f.owner.live(created.sessionId, true)).toMatchObject({
          status: "idle",
          executionLocation: null,
        });
      }
      expect(f.frames()).toEqual([]);
      expect(await prepareSettings(f.owner, created.sessionId)).toMatchObject({
        current: { model: null },
        models: [{ id: "fixture-model" }],
        applicationStatus: "confirmed",
      });
      expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      const database = openManagedLedger(f.root)!;
      try {
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM managed_commands WHERE phase<>'resolved'")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    });

    it.each(["create", "fork"])(
      "publishes terminal idle after explicit settings initialize succeeds for %s without a live refresh",
      async (kind) => {
        const states: Array<Record<string, unknown>> = [];
        const f = fixture("2.1.286", 0, "ordinary", (state) => states.push(state));
        const created =
          kind === "create"
            ? await create(f.owner)
            : await control(f.owner, f.indexNative(), "fork");
        const id = created.sessionId;
        states.length = 0;
        const settings = await prepareSettings(f.owner, id);
        expect(settings).toMatchObject({
          applicationStatus: "confirmed",
          models: [{ id: "fixture-model" }],
        });
        expect(
          states.some((state) => state.status === "starting" && state.sendEnabled === false),
        ).toBe(true);
        expect(states.at(-1)).toMatchObject({
          sessionId: id,
          status: "idle",
          sendEnabled: true,
          stopEnabled: false,
          revision: settings.revision,
        });
        expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
        expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
      },
    );

    it("does not publish an idle completion when explicit settings initialization fails", async () => {
      const states: Array<Record<string, unknown>> = [];
      const f = fixture("2.1.286", 0, "initialize-rejected", (state) => states.push(state));
      const created = await create(f.owner);
      await expect(prepareSettings(f.owner, created.sessionId)).rejects.toThrow(/initialize/);
      expect(states.at(-1)).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
      expect(states.some((state) => state.status === "idle" && state.sendEnabled === true)).toBe(
        false,
      );
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    });

    it.each([false, true])(
      "publishes the safe state after failed settings startup without replacing the startup error (publicationFails=%s)",
      async (publicationFails) => {
        const states: Array<Record<string, unknown>> = [];
        const f = fixture("2.1.286", 0, "close-initialize", (state) => {
          states.push(state);
          if (publicationFails && state.status === "idle")
            throw new Error("Synthetic terminal publication failed");
        });
        const created = await create(f.owner);
        await expect(prepareSettings(f.owner, created.sessionId)).rejects.toThrow(
          /Claude (stream closed|process exited|stdin write failed)/,
        );
        expect(states.some((state) => state.status === "starting")).toBe(true);
        expect(states.at(-1)).toMatchObject({
          status: process.platform === "darwin" ? "idle" : "outcome-unknown",
          sendEnabled: process.platform === "darwin",
          executionLocation: null,
        });
        if (process.platform !== "darwin")
          expect(
            states.some((state) => state.status === "idle" && state.sendEnabled === true),
          ).toBe(false);
        expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
        expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      },
    );

    it("still reports a terminal publication error when settings initialization itself succeeds", async () => {
      const failure = new Error("Synthetic terminal publication failed");
      const f = fixture("2.1.286", 0, "ordinary", (state) => {
        if (state.status === "idle") throw failure;
      });
      const created = await create(f.owner);
      await expect(prepareSettings(f.owner, created.sessionId)).rejects.toBe(failure);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    });

    it("publishes external occupancy when a fresh startup probe rejects after the cached idle preflight", async () => {
      const states: Array<Record<string, unknown>> = [];
      const f = fixture("2.1.286", 0, "ordinary", (state) => {
        states.push(state);
        if (state.status === "starting") f.setExternalOwner(String(state.sourceSessionId));
      });
      const created = await create(f.owner);
      await expect(prepareSettings(f.owner, created.sessionId)).rejects.toThrow(
        /claude-owner-busy|active in an external process/,
      );
      expect(states.at(-1)).toMatchObject({
        status: "idle",
        sendEnabled: false,
        executionLocation: "external",
        ownershipReason: "claude-owner-busy",
      });
      expect(states.some((state) => state.status === "idle" && state.sendEnabled === true)).toBe(
        false,
      );
      expect(f.frames()).toEqual([]);
    });

    it("publishes the unknown fence if another unresolved command appears before settings preparation returns", async () => {
      const states: Array<Record<string, unknown>> = [];
      let injected = false;
      const f = fixture("2.1.286", 0, "ordinary", (state) => {
        states.push(state);
        if (
          !injected &&
          state.status === "starting" &&
          Number(state.revision) > 0 &&
          f.frames().some((frame) => frame.request?.subtype === "initialize")
        ) {
          injected = true;
          const requestId = randomUUID();
          claimManagedCommand(
            f.root,
            requestId,
            String(state.sessionId),
            "independent host mutation",
            "browser-device-b",
            { operation: "queue-add" },
          );
          dispatchManagedCommand(f.root, requestId);
        }
      });
      const created = await create(f.owner);
      const settings = await prepareSettings(f.owner, created.sessionId);
      expect(injected).toBe(true);
      expect(settings).toMatchObject({
        applicationStatus: "pending",
        writable: { model: { available: false } },
      });
      expect(states.at(-1)).toMatchObject({
        status: "outcome-unknown",
        sendEnabled: false,
        reason: "control-outcome-unconfirmed",
      });
      expect(states.some((state) => state.status === "idle" && state.sendEnabled === true)).toBe(
        false,
      );
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    });

    it("persists confirmed setting options across a host restart without relaunching the CLI", async () => {
      const f = fixture("2.1.286", 0, "inherited-plan");
      const created = await create(f.owner);
      await prepareSettings(f.owner, created.sessionId);
      await f.owner.shutdown();
      const before = f.frames();
      const restored = f.makeOwner();
      for (let i = 0; i < 3; i++) {
        expect(await restored.settingsState(created.sessionId)).toMatchObject({
          current: { model: "fixture-model", permissionMode: "plan" },
          selected: { model: null, permissionMode: null },
          models: [{ id: "fixture-model" }],
          applicationStatus: "confirmed",
        });
        expect(await restored.live(created.sessionId, true)).toMatchObject({
          executionLocation: null,
          permission: { mode: "plan", previous: true },
        });
      }
      expect(f.frames()).toEqual(before);
    });

    it("rejects stale and externally occupied explicit settings preparation before spawning", async () => {
      const states: Array<Record<string, unknown>> = [];
      const f = fixture("2.1.303", 0, "ordinary", (state) => states.push(state));
      const created = await create(f.owner);
      await expect(
        f.owner.request({
          operation: "settings-prepare",
          sessionId: created.sessionId,
          deviceId: "browser-device-a",
          runtimeBootId: "stale-boot",
          expectedRevision: 0,
          experimentalEnabled: true,
        }),
      ).rejects.toThrow("invalid-managed-settings-prepare");
      f.setExternalOwner(created.sourceSessionId);
      await expect(prepareSettings(f.owner, created.sessionId)).rejects.toThrow(
        /claude-owner-busy|active in an external process/,
      );
      expect(f.frames()).toEqual([]);
      expect(states.some((state) => state.status === "idle" && state.sendEnabled === true)).toBe(
        false,
      );
      expect(await f.owner.live(created.sessionId, true)).toMatchObject({ status: "idle" });
    });
    it.each([
      { released: false, partial: false },
      { released: true, partial: false },
      { released: false, partial: true },
    ])(
      "forks an occupied native source read-only and runs only the fresh child (released=$released, partial=$partial)",
      async ({ released, partial }) => {
        const f = fixture();
        const source = f.indexNative();
        if (released) {
          await f.owner.request({
            operation: "adopt",
            sessionId: source,
            requestId: randomUUID(),
            deviceId: "browser-device-a",
          });
          await f.owner.request({
            operation: "release",
            sessionId: source,
            requestId: randomUUID(),
            deviceId: "browser-device-a",
            runtimeBootId: f.owner.bootId,
            expectedRevision: (await f.owner.live(source, true)).revision,
          });
        }
        const complete = readFileSync(f.transcript(source), "utf8");
        const cutoff = JSON.parse(complete.trim().split("\n").at(-1)!).uuid;
        if (partial)
          writeFileSync(
            f.transcript(source),
            complete +
              JSON.stringify({
                type: "user",
                uuid: randomUUID(),
                parentUuid: cutoff,
                sessionId: source,
                cwd: f.workspace,
                message: { role: "user", content: "Native turn still running" },
              }) +
              "\n",
          );
        const before = readFileSync(f.transcript(source), "utf8");
        f.setExternalOwner(source);
        await expect
          .poll(() => f.owner.live(source, true), { timeout: 5000, interval: 100 })
          .toMatchObject({
            sendEnabled: false,
            ownershipReason: "claude-owner-busy",
          });
        expect(f.owner.catalogContinuation(source)).toMatchObject({
          status: "idle",
          executionLocation: "external",
          ownershipReason: "claude-owner-busy",
        });
        const fork = await control(f.owner, source, "fork");
        expect(fork).toMatchObject({ accepted: true, forkSourceSessionId: source });
        expect(fork.sourceSessionId).not.toBe(source);
        expect(f.frames()).toEqual([]);
        expect(readFileSync(f.transcript(source), "utf8")).toBe(before);
        expect(
          JSON.parse(
            readFileSync(path.join(f.root, "claude-managed", `${fork.sessionId}.json`), "utf8"),
          ),
        ).toMatchObject({
          nativeId: fork.sourceSessionId,
          fresh: true,
          released: false,
          forkSourceNativeId: source,
          forkCutoff: cutoff,
        });
        expect(
          await control(f.owner, fork.sessionId, "send", { text: "Continue the child" }),
        ).toMatchObject({ accepted: true });
        await expect
          .poll(async () => (await f.owner.live(fork.sessionId, true)).status)
          .toBe("idle");
        const launches = f.frames().filter((frame) => frame.args);
        expect(launches).toHaveLength(1);
        expect(launches[0]!.args).toEqual(
          expect.arrayContaining([
            `--resume=${source}`,
            "--fork-session",
            `--session-id=${fork.sourceSessionId}`,
            `--resume-session-at=${cutoff}`,
          ]),
        );
        expect(readFileSync(f.transcript(source), "utf8")).toBe(before);
        expect(await f.owner.live(source, true)).toMatchObject({
          ownershipReason: "claude-owner-busy",
        });
      },
      10_000,
    );
    it("automatically adopts a native first send while still rejecting an explicitly stale fingerprint", async () => {
      const f = fixture();
      const id = f.indexNative();
      const inspected = await f.owner.inspect(id);
      const previous = readFileSync(f.transcript(id), "utf8");
      writeFileSync(
        f.transcript(id),
        previous +
          JSON.stringify({ type: "custom-title", customTitle: "Native title changed" }) +
          "\n",
      );
      await expect(
        f.owner.request({
          operation: "adopt",
          sessionId: id,
          requestId: randomUUID(),
          deviceId: "browser-device-a",
          handoffFingerprint: inspected.handoffFingerprint,
        }),
      ).rejects.toThrow("handoff-fingerprint-changed");
      expect(existsSync(path.join(f.root, "claude-managed", `${id}.json`))).toBe(false);
      expect(f.frames()).toEqual([]);
      expect(await control(f.owner, id, "send", { text: "Continue automatically" })).toMatchObject({
        accepted: true,
      });
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
      expect(
        JSON.parse(readFileSync(path.join(f.root, "claude-managed", `${id}.json`), "utf8")),
      ).toMatchObject({ nativeId: id, adopted: true, released: false });
      expect(
        f
          .frames()
          .filter((frame) => frame.args)
          .at(-1)!.args,
      ).toContain(`--resume=${id}`);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    });
    it("creates under the real browser device, persists selections without a user frame, and rejects malformed identities", async () => {
      const f = fixture();
      const requestId = randomUUID();
      const created = await create(f.owner, {
        requestId,
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      expect(f.frames()).toEqual([]);
      expect((await f.owner.live(created.sessionId, true)).settings).toMatchObject({
        selected: { model: "fixture-model", effort: "high", permissionMode: "plan" },
        current: { model: null },
        applicationStatus: "pending",
      });
      await prepareSettings(f.owner, created.sessionId);
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        selected: { model: "fixture-model", effort: "high", permissionMode: "plan" },
        current: { model: "fixture-model" },
        applicationStatus: "confirmed",
      });
      expect(f.frames().some((frame) => frame.type === "user")).toBe(false);
      const db = openManagedLedger(f.root)!;
      try {
        expect(
          db.prepare("SELECT device_id FROM managed_commands WHERE request_id=?").get(requestId),
        ).toEqual({ device_id: "browser-device-a" });
        expect(db.prepare("SELECT COUNT(*) AS count FROM managed_sessions").get()).toEqual({
          count: 0,
        });
      } finally {
        db.close();
      }
      await expect(create(f.owner, { deviceId: "bad/device" })).rejects.toThrow(
        "invalid-managed-create",
      );
      await expect(create(f.owner, { requestId, deviceId: "browser-device-b" })).rejects.toThrow(
        "request-id-reused-with-different-input",
      );
    });

    it("applies settings only after native ACK and resets by preparing a process with no override flags", async () => {
      const f = fixture();
      const created = await create(f.owner);
      await control(f.owner, created.sessionId, "settings", {
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
        publicInputHash: "a".repeat(64),
      });
      expect(f.frames().some((frame) => frame.type === "user")).toBe(false);
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { model: "fixture-model", effort: "high", permissionMode: "plan" },
        applicationStatus: "confirmed",
        writable: { restoreDefaults: { available: true } },
      });
      await control(f.owner, created.sessionId, "settings", { resetDefaults: true });
      const lastArgs = f
        .frames()
        .filter((frame) => frame.args)
        .at(-1)!.args as string[];
      expect(lastArgs).not.toContain("--model");
      expect(lastArgs).not.toContain("--effort");
      expect(lastArgs).not.toContain("--permission-mode");
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { effort: null, permissionMode: null },
        selected: { model: null, effort: null, permissionMode: null },
        applicationStatus: "confirmed",
      });
    });

    it("applies effort to a resolved inherited model without selecting model or permissions", async () => {
      const f = fixture("2.1.286", 0, "model-alias");
      const created = await create(f.owner);
      await prepareSettings(f.owner, created.sessionId);
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { model: "fixture-actual-model", permissionMode: "plan" },
        selected: { model: null, permissionMode: null },
        models: [{ id: "fixture-alias", resolvedModel: "fixture-actual-model" }],
      });
      await control(f.owner, created.sessionId, "settings", { effort: "high" });
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { model: "fixture-actual-model", effort: "high", permissionMode: "plan" },
        selected: { model: null, effort: "high", permissionMode: null },
      });
      expect(f.frames().filter((frame) => frame.request?.subtype === "set_model")).toEqual([]);
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
    });

    it.each(["fixture-actual-model", "FIXTURE-ALIAS", "Fixture-Actual-Model"])(
      "takes /model %s as the listed alias it names",
      async (typed) => {
        const f = fixture("2.1.286", 0, "model-alias");
        const created = await create(f.owner);
        await control(f.owner, created.sessionId, "settings", { model: typed });
        expect(
          f
            .frames()
            .filter((frame) => frame.request?.subtype === "set_model")
            .map((frame) => frame.request.model),
        ).toEqual(["fixture-alias"]);
        expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
          selected: { model: "fixture-alias" },
          applicationStatus: "confirmed",
        });
        expect(
          new ClaudeHostStateStore(f.root, f.owner.bootId).read(created.sessionId).settings,
        ).toEqual({ model: "fixture-alias" });
      },
    );

    it("still restores defaults when the request also names an unlisted model", async () => {
      const f = fixture();
      const created = await create(f.owner, { model: "fixture-model", effort: "high" });
      await control(f.owner, created.sessionId, "settings", {
        resetDefaults: true,
        model: "no-such-model",
      });
      expect(
        new ClaudeHostStateStore(f.root, f.owner.bootId).read(created.sessionId).settings,
      ).toEqual({});
    });

    it.each([
      ["a model Claude Code does not list", { model: "no-such-model" }, "unsupported-model"],
      [
        "an effort the model does not support",
        { model: "fixture-low-model", effort: "high" },
        "unsupported-effort",
      ],
      ["an effort level that does not exist", { effort: "turbo" }, "unsupported-effort"],
    ])("names %s in the receipt and changes nothing", async (_case, fields, reason) => {
      const f = fixture("2.1.286", 0, "effort-models");
      const created = await create(f.owner, { model: "fixture-model" });
      const before = new ClaudeHostStateStore(f.root, f.owner.bootId).read(
        created.sessionId,
      ).settings;
      const error = await control(f.owner, created.sessionId, "settings", fields).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ClaudeHostControlPreflightError);
      expect((error as ClaudeHostControlPreflightError).result).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: reason,
      });
      expect(
        f
          .frames()
          .filter((frame) =>
            ["set_model", "apply_flag_settings"].includes(String(frame.request?.subtype)),
          ),
      ).toEqual([]);
      expect(
        new ClaudeHostStateStore(f.root, f.owner.bootId).read(created.sessionId).settings,
      ).toEqual(before);
    });

    it("clears only the effort selection when switching to a model with incompatible effort", async () => {
      const f = fixture("2.1.286", 0, "effort-models");
      const created = await create(f.owner, {
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      await control(f.owner, created.sessionId, "settings", {
        model: "fixture-low-model",
        effort: null,
      });
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { model: "fixture-low-model", effort: null, permissionMode: "plan" },
        selected: { model: "fixture-low-model", effort: null, permissionMode: "plan" },
      });
      expect(
        new ClaudeHostStateStore(f.root, f.owner.bootId).read(created.sessionId).settings,
      ).toEqual({
        model: "fixture-low-model",
        permissionMode: "plan",
      });
      const controls = f.frames().filter((frame) => frame.type === "control_request");
      expect(controls.map((frame) => frame.request.subtype)).toEqual(["initialize", "initialize"]);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      await f.owner.shutdown();
      const restored = f.makeOwner();
      await prepareSettings(restored, created.sessionId);
      const args = f
        .frames()
        .filter((frame) => frame.args)
        .at(-1)!.args as string[];
      expect(args).not.toContain("--effort");
      expect(args[args.indexOf("--model") + 1]).toBe("fixture-low-model");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    });

    it("blocks clearing effort when the replacement runner initialization is unconfirmed", async () => {
      const f = fixture("2.1.286", 0, "reset-init-failure");
      const created = await create(f.owner, {
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      const requestId = randomUUID();
      await expect(
        control(f.owner, created.sessionId, "settings", {
          requestId,
          effort: null,
        }),
      ).rejects.toThrow();
      expect(await f.owner.live(created.sessionId, true)).toMatchObject({
        status: "outcome-unknown",
        settings: { applicationStatus: "pending" },
      });
      expect(
        new ClaudeHostStateStore(f.root, f.owner.bootId).read(created.sessionId).settings,
      ).toEqual({
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    });

    it("keeps native inherited permission separate from selection when only the model changes", async () => {
      const f = fixture("2.1.286", 0, "inherited-plan");
      const created = await create(f.owner);
      await prepareSettings(f.owner, created.sessionId);
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { permissionMode: "plan" },
        selected: { permissionMode: null },
        defaults: { permissionMode: null },
        applicationStatus: "confirmed",
      });
      await control(f.owner, created.sessionId, "settings", { model: "fixture-model" });
      expect(await f.owner.settingsState(created.sessionId)).toMatchObject({
        current: { model: "fixture-model", permissionMode: "plan" },
        selected: { model: "fixture-model", permissionMode: null },
      });
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toEqual([]);
      await control(f.owner, created.sessionId, "settings", { permissionMode: "acceptEdits" });
      const before = f
        .frames()
        .filter((frame) => frame.request?.subtype === "set_permission_mode").length;
      await control(f.owner, created.sessionId, "settings", { effort: "high" });
      expect(
        f.frames().filter((frame) => frame.request?.subtype === "set_permission_mode"),
      ).toHaveLength(before);
    });

    it("prepares queued input without a user frame and dispatches exactly once with original receipt settlement", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const requestId = randomUUID();
      const add = await control(f.owner, created.sessionId, "queue-add", {
        text: "queued input",
        requestId,
        publicInputHash: "b".repeat(64),
      });
      expect(add).toMatchObject({ completed: false, publicInputHash: "b".repeat(64) });
      const permit = await prepare(f.owner, created.sessionId);
      expect(f.frames().some((frame) => frame.type === "user")).toBe(false);
      expect(await dispatch(f.owner, permit)).toMatchObject({ accepted: true });
      await expect
        .poll(async () => (await f.owner.live(created.sessionId, true)).status)
        .toBe("idle");
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
      expect(
        await f.owner.receipt({
          found: true,
          executionMode: "claude-managed",
          sessionId: created.sessionId,
          requestId,
          operation: "queue-add",
          ack: add,
        }),
      ).toMatchObject({ completionObserved: true, publicInputHash: "b".repeat(64) });
      await expect(dispatch(f.owner, permit)).rejects.toThrow();
      expect((await next(f.owner, created.sessionId)).next).toBeNull();
    });

    it("invalidates prepared permits synchronously and preserves the original author without resume confirmation", async () => {
      const f = fixture();
      const created = await create(f.owner);
      await control(f.owner, created.sessionId, "queue-add", {
        text: "never silently adopt another author",
      });
      const permit = await prepare(f.owner, created.sessionId);
      f.owner.invalidateSchedulePermits(created.sessionId, "browser-device-a");
      await expect(dispatch(f.owner, permit)).rejects.toThrow();
      expect(f.frames().some((frame) => frame.type === "user")).toBe(false);
      await control(f.owner, created.sessionId, "queue-pause");
      expect(
        await control(f.owner, created.sessionId, "queue-resume", { deviceId: "browser-device-b" }),
      ).toMatchObject({ accepted: true });
      expect((await next(f.owner, created.sessionId)).next).toMatchObject({
        deviceId: "browser-device-a",
        originDeviceId: "browser-device-a",
      });
    });

    it("keeps queued work paused after restart and resumes without confirmation or reopening deleted files", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      const file = path.join(f.workspace, "context.txt");
      writeFileSync(file, "Frozen context");
      const live = await f.owner.live(id, true);
      const request = {
        operation: "queue-add",
        sessionId: id,
        deviceId: "browser-device-a",
        requestId: randomUUID(),
        runtimeBootId: f.owner.bootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Use context",
        resourceRefs: [{ kind: "file", relativePath: "context.txt" }],
        publicInputHash: "c".repeat(64),
      };
      const original = await f.owner.request(request);
      rmSync(file);
      await f.owner.shutdown();
      const restarted = f.makeOwner();
      expect(await restarted.request({ ...request, runtimeBootId: restarted.bootId })).toEqual(
        original,
      );
      expect(await next(restarted, id)).toMatchObject({ paused: true, next: null });
      await expect(
        restarted.request({ ...request, runtimeBootId: restarted.bootId, text: "different" }),
      ).rejects.toThrow("request-id-reused-with-different-input");
      await control(restarted, id, "queue-resume");
      const permit = await prepare(restarted, id);
      await dispatch(restarted, permit);
      await expect.poll(() => f.frames().filter((frame) => frame.type === "user").length).toBe(1);
      expect(JSON.stringify(f.frames().find((frame) => frame.type === "user"))).toContain(
        "Frozen context",
      );
    });

    it("bounds resource references, rejects escapes, and only advertises initialized project skills", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      writeFileSync(path.join(f.root, "outside.txt"), "private");
      symlinkSync(path.join(f.root, "outside.txt"), path.join(f.workspace, "escape.txt"));
      await expect(
        control(f.owner, id, "queue-add", {
          text: "x",
          resourceRefs: [{ kind: "file", relativePath: "../outside.txt" }],
        }),
      ).rejects.toThrow("invalid-resource-path");
      await expect(
        control(f.owner, id, "queue-add", {
          text: "x",
          resourceRefs: [{ kind: "file", relativePath: "escape.txt" }],
        }),
      ).rejects.toThrow("resource-outside-workspace");
      linkSync(path.join(f.root, "outside.txt"), path.join(f.workspace, "hardlink.txt"));
      await expect(
        control(f.owner, id, "queue-add", {
          text: "x",
          resourceRefs: [{ kind: "file", relativePath: "hardlink.txt" }],
        }),
      ).rejects.toThrow("resource-file-unavailable");
      const nested = path.join(f.workspace, "real-directory");
      mkdirSync(nested);
      writeFileSync(path.join(nested, "context.txt"), "nested");
      symlinkSync(nested, path.join(f.workspace, "alias-directory"));
      await expect(
        control(f.owner, id, "queue-add", {
          text: "x",
          resourceRefs: [{ kind: "file", relativePath: "alias-directory/context.txt" }],
        }),
      ).rejects.toThrow("resource-outside-workspace");
      const skill = path.join(f.workspace, ".claude", "skills", "fixture-skill");
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, "SKILL.md"), "Fixture instruction");
      expect(await f.owner.request({ operation: "resources", sessionId: id })).toMatchObject({
        skills: [],
      });
      await control(f.owner, id, "settings", { permissionMode: "plan" });
      const resources = (await f.owner.request({
        operation: "resources",
        sessionId: id,
      })) as Record<string, any>;
      expect(resources.skills).toEqual([
        {
          id: "fixture-skill",
          name: "fixture-skill",
          description: "Project fixture",
          available: true,
        },
      ]);
      await expect(
        control(f.owner, id, "queue-add", {
          text: "x",
          resourceRefs: [{ kind: "skill", id: "not-installed" }],
        }),
      ).rejects.toThrow("resource-skill-unavailable");
    });

    it.each([false, true])(
      "validates a rename before host or native writes (history=%s)",
      async (history) => {
        const f = fixture();
        const created = await create(f.owner);
        if (history) {
          await control(f.owner, created.sessionId, "send", { text: "native history" });
          await expect
            .poll(async () => (await f.owner.live(created.sessionId, true)).status)
            .toBe("idle");
        }
        const transcript = f.transcript(created.sourceSessionId);
        const before = history ? readFileSync(transcript, "utf8") : null;
        const host = new ClaudeHostStateStore(f.root);
        const title = host.read(created.sessionId).title;
        for (const name of ["   ", "invalid\nname", "invalid\u007fname", "字".repeat(171)]) {
          const requestId = randomUUID();
          await expect(
            control(f.owner, created.sessionId, "rename", { requestId, name }),
          ).rejects.toThrow("invalid-session-name");
          expect(host.read(created.sessionId).title).toBe(title);
          expect(
            readControlReceipt(f.root, { requestId, deviceId: "browser-device-a" }),
          ).toMatchObject({ status: "not-dispatched" });
        }
        if (history) expect(readFileSync(transcript, "utf8")).toBe(before);
        else expect(existsSync(transcript)).toBe(false);
      },
    );

    it("rejects a hard-linked native transcript before claiming or writing a rename", async () => {
      const f = fixture();
      const created = await create(f.owner);
      await control(f.owner, created.sessionId, "send", { text: "native history" });
      await expect
        .poll(async () => (await f.owner.live(created.sessionId, true)).status)
        .toBe("idle");
      const transcript = f.transcript(created.sourceSessionId);
      const backup = path.join(f.root, "history-backup.jsonl");
      linkSync(transcript, backup);
      const before = readFileSync(backup, "utf8");
      const requestId = randomUUID();
      await expect(
        control(f.owner, created.sessionId, "rename", { requestId, name: "Must not touch backup" }),
      ).rejects.toBeInstanceOf(ClaudeHostControlPreflightError);
      expect(readFileSync(transcript, "utf8")).toBe(before);
      expect(readFileSync(backup, "utf8")).toBe(before);
      expect(readControlReceipt(f.root, { requestId, deviceId: "browser-device-a" })).toMatchObject(
        {
          status: "not-dispatched",
        },
      );
      rmSync(backup);
      expect(
        await control(f.owner, created.sessionId, "rename", { name: "Safe native title" }),
      ).toMatchObject({ accepted: true });
    });

    it("renames native history with a verified custom-title row and forks lazily from a completed assistant boundary", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      await control(f.owner, id, "send", { text: "synthetic turn" });
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
      await control(f.owner, id, "rename", { name: "Renamed" });
      expect(readFileSync(f.transcript(created.sourceSessionId), "utf8")).toContain(
        JSON.stringify({
          type: "custom-title",
          customTitle: "Renamed",
          sessionId: created.sourceSessionId,
        }),
      );
      const before = f.frames().length;
      const fork = await control(f.owner, id, "fork");
      expect(f.frames()).toHaveLength(before);
      expect(fork.sessionId).not.toBe(id);
      await control(f.owner, fork.sessionId, "send", { text: "fork turn" });
      await expect.poll(async () => (await f.owner.live(fork.sessionId, true)).status).toBe("idle");
      const forkArgs = f
        .frames()
        .filter((frame) => frame.args)
        .at(-1)!.args as string[];
      expect(forkArgs).toContain("--fork-session");
      expect(forkArgs.some((value) => value.startsWith("--resume-session-at="))).toBe(true);
      await control(f.owner, fork.sessionId, "settings", { resetDefaults: true });
      const resumed = f
        .frames()
        .filter((frame) => frame.args)
        .at(-1)!.args as string[];
      expect(resumed).not.toContain("--fork-session");
      expect(resumed).toContain(`--resume=${fork.sourceSessionId}`);
    });

    it.each([false, true])(
      "preserves a lazy fork through release and adoption (restart=%s)",
      async (restart) => {
        const f = fixture();
        const created = await create(f.owner);
        await control(f.owner, created.sessionId, "send", { text: "parent turn" });
        await expect
          .poll(async () => (await f.owner.live(created.sessionId, true)).status)
          .toBe("idle");
        const fork = await control(f.owner, created.sessionId, "fork");
        const metadata = JSON.parse(
          readFileSync(path.join(f.root, "claude-managed", `${fork.sessionId}.json`), "utf8"),
        );
        const before = f.frames().length;
        await f.owner.request({
          operation: "release",
          sessionId: fork.sessionId,
          requestId: randomUUID(),
          deviceId: "browser-device-a",
          runtimeBootId: f.owner.bootId,
          expectedRevision: (await f.owner.live(fork.sessionId, true)).revision,
        });
        let owner = f.owner;
        if (restart) {
          await owner.shutdown();
          owner = f.makeOwner();
        }
        const inspected = await owner.inspect(fork.sessionId);
        await owner.request({
          operation: "adopt",
          sessionId: fork.sessionId,
          requestId: randomUUID(),
          deviceId: "browser-device-a",
          handoffFingerprint: inspected.handoffFingerprint,
        });
        expect(f.frames()).toHaveLength(before);
        await control(owner, fork.sessionId, "send", { text: "child continuation" });
        await expect.poll(async () => (await owner.live(fork.sessionId, true)).status).toBe("idle");
        expect(
          f
            .frames()
            .filter((frame) => frame.args)
            .at(-1)!.args,
        ).toEqual(
          expect.arrayContaining([
            `--resume=${created.sourceSessionId}`,
            "--fork-session",
            `--session-id=${fork.sourceSessionId}`,
            `--resume-session-at=${metadata.forkCutoff}`,
          ]),
        );
      },
    );

    it("binds the unstarted fork source and cutoff to the handoff fingerprint", async () => {
      const f = fixture();
      const created = await create(f.owner);
      await control(f.owner, created.sessionId, "send", { text: "parent turn" });
      await expect
        .poll(async () => (await f.owner.live(created.sessionId, true)).status)
        .toBe("idle");
      const fork = await control(f.owner, created.sessionId, "fork");
      await f.owner.request({
        operation: "release",
        sessionId: fork.sessionId,
        requestId: randomUUID(),
        deviceId: "browser-device-a",
        runtimeBootId: f.owner.bootId,
        expectedRevision: (await f.owner.live(fork.sessionId, true)).revision,
      });
      const inspected = await f.owner.inspect(fork.sessionId);
      const file = path.join(f.root, "claude-managed", `${fork.sessionId}.json`);
      const metadata = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...metadata, forkCutoff: randomUUID() }));
      await expect(
        f.owner.request({
          operation: "adopt",
          sessionId: fork.sessionId,
          requestId: randomUUID(),
          deviceId: "browser-device-a",
          handoffFingerprint: inspected.handoffFingerprint,
        }),
      ).rejects.toThrow("handoff-fingerprint-changed");
      writeFileSync(file, JSON.stringify({ ...metadata, forkCutoff: undefined }));
      await expect(f.owner.inspect(fork.sessionId)).rejects.toThrow("invalid-Claude-metadata");
    });

    it("settles accepted steering only when its bound original turn completes and supports a fork after steering", async () => {
      const f = fixture("2.1.286", 0, "steer");
      const created = await create(f.owner);
      const id = created.sessionId;
      const turnId = randomUUID();
      await control(f.owner, id, "send", { requestId: turnId, text: "First input" });
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("running");
      const steerId = randomUUID();
      expect(
        await control(f.owner, id, "steer", {
          requestId: steerId,
          turnId,
          text: "Clarifying input",
        }),
      ).toMatchObject({ accepted: true });
      const receipt = () =>
        f.owner.receipt(
          readControlReceipt(f.root, { requestId: steerId, deviceId: "browser-device-a" }),
        );
      expect(await receipt()).toMatchObject({
        operation: "steer",
        status: "accepted",
        turnId,
        completionObserved: false,
      });
      f.releaseResult();
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
      expect(await receipt()).toMatchObject({ operation: "steer", completionObserved: true });
      expect(
        await f.owner.receipt({
          ...readControlReceipt(f.root, { requestId: steerId, deviceId: "browser-device-a" }),
          turnId: randomUUID(),
        }),
      ).toMatchObject({ completionObserved: false });
      expect(
        await f.owner.receipt({
          ...readControlReceipt(f.root, { requestId: steerId, deviceId: "browser-device-a" }),
          status: "unknown",
        }),
      ).toMatchObject({ completionObserved: false });
      expect(await control(f.owner, id, "fork")).toMatchObject({
        accepted: true,
        forkSourceSessionId: created.sourceSessionId,
      });
    });

    it("does not mistake a successful natural language result for a completed goal", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      await control(f.owner, id, "goal-set", {
        goal: { objective: "Synthetic complete objective", tokenBudget: 100 },
      });
      const permit = await prepare(f.owner, id);
      await dispatch(f.owner, permit);
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
      const state = new ClaudeHostStateStore(f.root, f.owner.bootId).read(id);
      expect(state.goal).toMatchObject({
        status: "paused",
        reason: "report-required",
        tokensUsed: 15,
      });
      expect((await next(f.owner, id)).next).toBeNull();
      await control(f.owner, id, "goal-set", {
        goal: { intent: "update", objective: "Same task at its known budget", tokenBudget: 15 },
      });
      expect(await f.owner.capabilities(id, true)).toMatchObject({
        features: { "goal-resume": { available: false, reason: "token-budget-exhausted" } },
      });
      await control(f.owner, id, "send", { text: "A manual follow up" });
      await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
      const args = f
        .frames()
        .filter((frame) => frame.args)
        .at(-1)!.args as string[];
      expect(args).not.toContain("--mcp-config");
    });

    it.each(["missing-usage", "cancelled"])(
      "keeps %s accounting gaps across budget edits and only resumes after explicit budget removal",
      async (mode) => {
        const f = fixture("2.1.286", 0, mode === "cancelled" ? "steer" : mode);
        const created = await create(f.owner);
        const id = created.sessionId;
        await control(f.owner, id, "goal-set", {
          goal: { objective: "Bounded task", tokenBudget: 100 },
        });
        const permit = await prepare(f.owner, id);
        await dispatch(f.owner, permit);
        if (mode === "cancelled") {
          await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("running");
          await control(f.owner, id, "stop", { turnId: permit.requestId });
        }
        await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
        const state = new ClaudeHostStateStore(f.root, f.owner.bootId);
        const before = state.read(id).goal!;
        expect(before).toMatchObject({ usageIncomplete: true, tokensUsed: 0 });
        expect(before.missingUsageStepIds).toContain(permit.itemId);
        expect(await f.owner.capabilities(id, true)).toMatchObject({
          features: { "goal-resume": { available: false, reason: "usage-unavailable" } },
        });
        await expect(control(f.owner, id, "goal-resume")).rejects.toThrow("usage-unavailable");
        await control(f.owner, id, "goal-set", {
          goal: { intent: "update", objective: "Revised bounded task" },
        });
        const updated = state.read(id).goal!;
        expect(updated.generation).not.toBe(before.generation);
        expect(updated).toMatchObject({
          tokenBudget: 100,
          tokensUsed: 0,
          elapsedMs: before.elapsedMs,
          usageIncomplete: true,
          status: "paused",
        });
        await control(f.owner, id, "goal-set", {
          goal: { intent: "update", objective: "Larger budget", tokenBudget: 1000 },
        });
        await expect(control(f.owner, id, "goal-resume")).rejects.toThrow("usage-unavailable");
        expect((await next(f.owner, id)).next).toBeNull();
        await control(f.owner, id, "goal-set", {
          goal: { intent: "update", objective: "Explicitly unbounded", tokenBudget: null },
        });
        await control(f.owner, id, "goal-resume");
        expect((await next(f.owner, id)).next).toMatchObject({
          kind: "goal",
          deviceId: "browser-device-a",
        });
        expect(state.read(id).goal).toMatchObject({
          tokenBudget: null,
          usageIncomplete: true,
          tokensUsed: 0,
        });
        await control(f.owner, id, "goal-set", {
          goal: { intent: "update", objective: "Bounded again", tokenBudget: 2000 },
        });
        expect((await next(f.owner, id)).next).toBeNull();
        expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
      },
    );

    it("rejects attachment queue edits and attachment replacement while preserving a text item's original author", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      const attachmentRequestId = randomUUID();
      const attachment = await control(f.owner, id, "queue-add", {
        requestId: attachmentRequestId,
        input: [{ type: "text", text: "User attached file fixture" }],
      });
      const attachmentId = attachment.queuedSubmission.id;
      await expect(
        control(f.owner, id, "queue-update", {
          deviceId: "browser-device-b",
          queuedSubmissionId: attachmentId,
          text: "Replace pinned file",
        }),
      ).rejects.toThrow("queue-attachment-item-not-editable");
      const plain = await control(f.owner, id, "queue-add", { text: "Original text" });
      const plainId = plain.queuedSubmission.id;
      await expect(
        control(f.owner, id, "queue-update", {
          queuedSubmissionId: plainId,
          input: [{ type: "text", text: "Attachment input array" }],
        }),
      ).rejects.toThrow("queue-update-requires-text");
      await control(f.owner, id, "queue-update", {
        deviceId: "browser-device-b",
        queuedSubmissionId: plainId,
        text: "Edited text",
      });
      const state = new ClaudeHostStateStore(f.root, f.owner.bootId).read(id);
      expect(state.work.find((work) => work.id === plainId)).toMatchObject({
        input: "Edited text",
        deviceId: "browser-device-a",
        originDeviceId: "browser-device-a",
        requiresAttachments: false,
      });
      expect(state.work.find((work) => work.id === attachmentId)).toMatchObject({
        originRequestId: attachmentRequestId,
        deviceId: "browser-device-a",
        requiresAttachments: true,
      });
      expect(state.settledRequests).not.toContain(attachmentRequestId);
    });

    it("durably classifies rolled-back preflight rejection and preserves accepted receipts after a post-commit error", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      const request = {
        operation: "queue-add",
        sessionId: id,
        requestId: randomUUID(),
        deviceId: "browser-device-a",
        runtimeBootId: f.owner.bootId,
        expectedRevision: 9999,
        experimentalEnabled: true,
        text: "Stale input",
        publicInputHash: "d".repeat(64),
      };
      const error = await f.owner.request(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClaudeHostControlPreflightError);
      expect((error as ClaudeHostControlPreflightError).result).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: "control-preflight-rejected",
        publicInputHash: "d".repeat(64),
      });
      expect(
        readControlReceipt(f.root, { requestId: request.requestId, deviceId: request.deviceId }),
      ).toMatchObject({ found: true, status: "not-dispatched" });
      expect(await f.owner.request(request)).toEqual(
        (error as ClaudeHostControlPreflightError).result,
      );
      const reused = await f.owner
        .request({ ...request, text: "Changed input" })
        .catch((caught: unknown) => caught);
      expect(reused).not.toBeInstanceOf(ClaudeHostControlPreflightError);
      expect(reused).toBeInstanceOf(Error);
      const original = ClaudeHostStateStore.prototype.command;
      const fault = vi
        .spyOn(ClaudeHostStateStore.prototype, "command")
        .mockImplementation(function (...args) {
          const result = original.apply(this, args);
          if (args[1].operation === "queue-add") throw new Error("synthetic post-commit crash");
          return result;
        });
      const committedId = randomUUID();
      const committedError = await control(f.owner, id, "queue-add", {
        requestId: committedId,
        text: "Committed input",
      }).catch((caught: unknown) => caught);
      fault.mockRestore();
      expect(committedError).not.toBeInstanceOf(ClaudeHostControlPreflightError);
      expect(
        readControlReceipt(f.root, { requestId: committedId, deviceId: request.deviceId }),
      ).toMatchObject({ found: true, status: "accepted" });
      expect(new ClaudeHostStateStore(f.root, f.owner.bootId).read(id).work).toHaveLength(1);
    });

    it("does not let another owner read-trigger recovery or claim scheduled work", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const id = created.sessionId;
      await control(f.owner, id, "queue-add", { text: "Retain original owner" });
      const original = new ClaudeHostStateStore(f.root, f.owner.bootId).read(id);
      const second = f.makeOwner();
      expect(second.catalog()).toHaveLength(1);
      expect(
        (
          (await second.request({ operation: "schedule-list", sessionId: id })) as Record<
            string,
            any
          >
        ).sessions,
      ).toEqual([]);
      await expect(second.request({ operation: "queue-list", sessionId: id })).rejects.toThrow(
        "session-managed-by-another-runtime",
      );
      await expect(
        second.request({
          operation: "rename",
          sessionId: id,
          deviceId: "browser-device-b",
          requestId: randomUUID(),
          runtimeBootId: second.bootId,
          expectedRevision: 0,
          experimentalEnabled: true,
          name: "Cannot steal",
        }),
      ).rejects.toThrow("session-managed-by-another-runtime");
      expect(new ClaudeHostStateStore(f.root, f.owner.bootId).read(id)).toEqual(original);
    });

    it("scopes permit invalidation to its session while honoring device revocation during handshake", async () => {
      const f = fixture("2.1.286", 200);
      const first = await create(f.owner);
      const second = await create(f.owner);
      await control(f.owner, first.sessionId, "queue-add", { text: "A" });
      await control(f.owner, second.sessionId, "queue-add", { text: "B" });
      const pending = prepare(f.owner, second.sessionId);
      await expect
        .poll(() => f.frames().some((frame) => frame.request?.subtype === "initialize"))
        .toBe(true);
      await control(f.owner, first.sessionId, "queue-pause");
      const permit = await pending;
      expect(await dispatch(f.owner, permit)).toMatchObject({ accepted: true });
      await expect
        .poll(async () => (await f.owner.live(second.sessionId, true)).status)
        .toBe("idle");
      const third = await create(f.owner, { deviceId: "device-c" });
      await control(f.owner, third.sessionId, "queue-add", { deviceId: "device-c", text: "C" });
      const initializations = f
        .frames()
        .filter((frame) => frame.request?.subtype === "initialize").length;
      const revoked = prepare(f.owner, third.sessionId);
      const rejected = expect(revoked).rejects.toThrow("schedule-paused");
      await expect
        .poll(() => f.frames().filter((frame) => frame.request?.subtype === "initialize").length)
        .toBe(initializations + 1);
      f.owner.invalidateSchedulePermits(undefined, "device-c");
      await rejected;
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    });

    it("keeps a persisted unknown outcome above cached external ownership in the read-only catalog", async () => {
      const f = fixture();
      const created = await create(f.owner);
      const file = path.join(f.root, "claude-managed", `${created.sessionId}.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      record.snapshot.status = "outcome-unknown";
      record.snapshot.reason = "synthetic unconfirmed request";
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      f.setExternalOwner(created.sourceSessionId);
      expect(await f.owner.live(created.sessionId, true)).toMatchObject({
        status: "outcome-unknown",
        ownershipReason: "claude-owner-busy",
      });
      expect(
        f.owner.catalog().find((row) => row.id === created.sessionId)?.continuation,
      ).toMatchObject({
        status: "outcome-unknown",
        reason: "control-outcome-unconfirmed",
        ownershipReason: null,
      });
      expect(f.frames()).toEqual([]);
    });

    it.each(["independent-host-operation", "completing-send"] as const)(
      "projects an authoritative unknown outcome above the resident runner and refreshes it after %s settles",
      async (kind) => {
        const f = fixture("2.1.286", 0, "steer");
        const created = await create(f.owner);
        const id = created.sessionId;
        const turnId = randomUUID();
        await control(f.owner, id, "send", {
          requestId: turnId,
          text: "Ongoing synthetic request",
        });
        await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("running");
        // This fixture starts its result gate on a priority clarification frame.
        await control(f.owner, id, "steer", {
          turnId,
          text: "Release through the synthetic result gate",
        });
        const unknownId = kind === "completing-send" ? turnId : randomUUID();
        if (kind === "independent-host-operation") {
          claimManagedCommand(
            f.root,
            unknownId,
            id,
            "synthetic host mutation",
            "browser-device-b",
            { operation: "queue-add" },
          );
          dispatchManagedCommand(f.root, unknownId);
        } else {
          const ledger = openManagedLedger(f.root)!;
          try {
            ledger
              .prepare(
                "UPDATE managed_commands SET phase='dispatched',result=NULL WHERE request_id=?",
              )
              .run(turnId);
          } finally {
            ledger.close();
          }
        }
        expect(await f.owner.live(id, true)).toMatchObject({
          status: "outcome-unknown",
          reason: "control-outcome-unconfirmed",
        });
        expect(f.owner.catalogContinuation(id)).toMatchObject({
          status: "outcome-unknown",
          reason: "control-outcome-unconfirmed",
          ownershipReason: null,
        });
        f.releaseResult();
        const metadata = () =>
          JSON.parse(readFileSync(path.join(f.root, "claude-managed", `${id}.json`), "utf8"));
        await expect.poll(() => metadata().snapshot.status).toBe("idle");
        if (kind === "independent-host-operation") {
          // A normal runner completion cannot settle another host mutation.
          expect(f.owner.catalogContinuation(id)).toMatchObject({
            status: "outcome-unknown",
            reason: "control-outcome-unconfirmed",
          });
          finishManagedCommand(f.root, unknownId, {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            requestId: unknownId,
            sessionId: id,
          });
          expect(await f.owner.live(id, true)).toMatchObject({ status: "idle", reason: null });
        }
        expect(f.owner.catalogContinuation(id)).toMatchObject({
          status: "idle",
          executionLocation: "agentkib",
        });
        expect(f.owner.catalogContinuation(id)).not.toHaveProperty(
          "reason",
          "control-outcome-unconfirmed",
        );
      },
    );
    it("keeps legacy send but gates advanced settings and queues below the verified version", async () => {
      const f = fixture("2.1.263");
      const created = await create(f.owner);
      const id = created.sessionId;
      expect(await f.owner.capabilities(id, true)).toMatchObject({
        features: {
          send: { available: true },
          steer: { available: false },
          settings: { available: false },
          "queue-add": { available: false },
        },
      });
      expect(await f.owner.settingsState(id)).toMatchObject({
        available: false,
        reason: "unsupported-Claude-version",
      });
      await expect(
        control(f.owner, id, "queue-add", { text: "no advanced dispatch" }),
      ).rejects.toThrow("unsupported-Claude-version");
      expect(f.frames()).toHaveLength(0);
    });

    it.each(["rename", "fork"])(
      "records unknown before %s filesystem side effects and never replays them after a receipt-commit crash",
      async (operation) => {
        const f = fixture();
        const created = await create(f.owner);
        const id = created.sessionId;
        await control(f.owner, id, "send", { text: "Completed source turn" });
        await expect.poll(async () => (await f.owner.live(id, true)).status).toBe("idle");
        const live = await f.owner.live(id, true);
        const request = {
          operation,
          sessionId: id,
          deviceId: "browser-device-a",
          requestId: randomUUID(),
          runtimeBootId: f.owner.bootId,
          expectedRevision: live.revision,
          experimentalEnabled: true,
          ...(operation === "rename" ? { name: "Durable rename" } : {}),
        };
        const original = ClaudeHostStateStore.prototype.command;
        const fault = vi
          .spyOn(ClaudeHostStateStore.prototype, "command")
          .mockImplementation(function (...args) {
            if (args[1].operation === operation)
              throw new Error("synthetic crash before receipt commit");
            return original.apply(this, args);
          });
        const failed = await f.owner.request(request).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).toContain("synthetic crash");
        expect(failed).not.toBeInstanceOf(ClaudeHostControlPreflightError);
        fault.mockRestore();
        expect(
          readControlReceipt(f.root, { requestId: request.requestId, deviceId: request.deviceId }),
        ).toMatchObject({ found: true, status: "unknown", operation });
        const history = readFileSync(f.transcript(created.sourceSessionId), "utf8");
        const catalog = f.owner.catalog();
        expect(await f.owner.request(request)).toMatchObject({
          accepted: false,
          controlOutcome: "unknown",
        });
        expect(readFileSync(f.transcript(created.sourceSessionId), "utf8")).toBe(history);
        expect(f.owner.catalog()).toEqual(catalog);
        expect(
          readControlReceipt(f.root, {
            requestId: request.requestId,
            deviceId: "browser-device-b",
          }),
        ).toMatchObject({ found: false });
      },
    );
  },
);
