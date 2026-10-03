import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { resolveCommand } from "./command-resolution";
import type { Commands } from "./commands";
import { isReparseOrSymlink } from "./native-files";
import { canonicalProject } from "./files";

const VERSION = "2026.9.6";
const ENVIRONMENT_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
  "OPENCLAW_INCLUDE_ROOTS",
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;
const MODULES = [
  "agents.config-G5R7b0ly.mjs",
  "io.runtime-hPN4FOBi.mjs",
  "openclaw-agent-db.paths-C2YxM4Tj.mjs",
  "openclaw-state-db.paths-DYMh54HD.mjs",
  "embedded-state-lock-Cw9nQxv5.mjs",
  "openclaw-agent-db-CaQAStOA.mjs",
  "session-accessor.sqlite-entry-store-DTntRuil.mjs",
  "session-accessor.sqlite-transcript-store-CFksbmAY.mjs",
  "session-accessor.sqlite-read-DG0i0-yW.mjs",
  "openclaw-agent-db-readonly-IBx2zWDG.mjs",
] as const;
const COMMAND_TIMEOUT = 60_000;
const MAX_OUTPUT = 256 * 1024 * 1024;

function resolveOpenClawEntry(commandPath: string): string {
  const resolved = realpathSync(commandPath);
  if (path.basename(resolved) === "openclaw.mjs") return resolved;
  const require = createRequire(path.join(path.dirname(commandPath), "agentkib-resolver.cjs"));
  let directory = path.dirname(realpathSync(require.resolve("openclaw")));
  while (true) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      if (metadata.name === "openclaw") {
        const entry = path.join(directory, "openclaw.mjs");
        if (existsSync(entry) && path.basename(realpathSync(entry)) === "openclaw.mjs")
          return realpathSync(entry);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("OpenClaw package entry point is not verified");
}

export interface OpenClawContext {
  node: string;
  node_version: string;
  package: string;
  package_fingerprint: string;
  agent_id: string;
  agent_dir: string;
  state_database: string;
  config_fingerprint: string;
  config_path: string;
  environment: Array<[string, string | null]>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function captureEnvironment(env: NodeJS.ProcessEnv): Array<[string, string | null]> {
  const values = ENVIRONMENT_KEYS.map(
    (key) => [key, key.startsWith("NODE_") ? null : (env[key] ?? null)] as [string, string | null],
  );
  validateEnvironment(values);
  return values;
}

function validateEnvironment(values: Array<[string, string | null]>): void {
  if (values.length !== ENVIRONMENT_KEYS.length) throw new Error("Incomplete OpenClaw environment");
  for (const [index, [key, value]] of values.entries()) {
    if (
      key !== ENVIRONMENT_KEYS[index] ||
      (value !== null && /[\0\r\n]/.test(value)) ||
      (key.startsWith("NODE_") && !!value)
    )
      throw new Error("Invalid OpenClaw environment");
  }
}

function safeNativePath(value: string): void {
  if (!path.isAbsolute(value) || path.resolve(value) !== value)
    throw new Error("Invalid OpenClaw storage path");
  let cursor = value;
  for (;;) {
    try {
      const metadata = lstatSync(cursor);
      if (isReparseOrSymlink(cursor, metadata)) throw new Error("OpenClaw storage path is a link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function preflightGlobal(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) safeNativePath(`${databasePath}${suffix}`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const row = db
      .prepare("SELECT role,schema_version,app_version FROM schema_meta WHERE meta_key='primary'")
      .get() as { role: string; schema_version: number; app_version: string } | undefined;
    if (
      version.user_version !== 18 ||
      row?.role !== "global" ||
      row.schema_version !== 18 ||
      row.app_version !== VERSION
    )
      throw new Error("OpenClaw global database requires official migration before import");
  } finally {
    db.close();
  }
}

function preflight(context: OpenClawContext): void {
  validateOpenClawContext(context);
  const dbPath = path.join(context.agent_dir, "openclaw-agent.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) safeNativePath(`${dbPath}${suffix}`);
  const root = path.dirname(path.dirname(path.dirname(context.agent_dir)));
  if (context.agent_dir !== path.join(root, "agents", context.agent_id, "agent"))
    throw new Error("Nonstandard OpenClaw agent directory is not verified");
  if (path.join(root, "state", "openclaw.sqlite") !== context.state_database)
    throw new Error("OpenClaw environment and agent directory disagree");
  preflightGlobal(context.state_database);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const row = db
      .prepare(
        "SELECT role,schema_version,agent_id,app_version FROM schema_meta WHERE meta_key='primary'",
      )
      .get() as
      | { role: string; schema_version: number; agent_id: string; app_version: string }
      | undefined;
    if (
      version.user_version !== 23 ||
      row?.role !== "agent" ||
      row.schema_version !== 23 ||
      row.agent_id !== context.agent_id ||
      row.app_version !== VERSION
    )
      throw new Error(
        "OpenClaw requires an existing current agent database; migrate with OpenClaw first",
      );
  } finally {
    db.close();
  }
}

export function validateOpenClawContext(context: OpenClawContext): void {
  validateEnvironment(context.environment);
  if (
    ![
      context.node,
      context.package,
      context.agent_dir,
      context.state_database,
      context.config_path,
    ].every(path.isAbsolute) ||
    !/^[a-z0-9_-]{1,64}$/.test(context.agent_id) ||
    !/^[0-9a-f]{64}$/i.test(context.config_fingerprint) ||
    !/^[0-9a-f]{64}$/i.test(context.package_fingerprint)
  )
    throw new Error("Invalid OpenClaw import context");
  for (const value of [
    context.node,
    context.package,
    context.agent_dir,
    context.state_database,
    context.config_path,
  ])
    safeNativePath(value);
}

export async function inspectOpenClawContext(
  executable: string,
  workspace: string,
  commands: Commands,
  env: NodeJS.ProcessEnv,
): Promise<OpenClawContext> {
  const environment = captureEnvironment(env);
  const packageRoot = path.dirname(realpathSync(executable));
  const packageJsonPath = path.join(packageRoot, "package.json");
  safeNativePath(packageJsonPath);
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  if (
    metadata.name !== "openclaw" ||
    metadata.version !== VERSION ||
    path.basename(executable) !== "openclaw.mjs"
  )
    throw new Error("Native OpenClaw import requires the verified 2026.9.6 npm installation");
  const nodeResolved = resolveCommand("node", env);
  if (!nodeResolved || !path.isAbsolute(nodeResolved)) throw new Error("OpenClaw requires Node");
  const node = realpathSync(nodeResolved);
  const nodeVersionResult = await commands.run(node, ["--version"], {
    env,
    limit: 64 * 1024,
    timeout: 3000,
    allowFailure: true,
    terminateDescendantsOnExit: true,
  });
  if (!nodeVersionResult.success) throw new Error("OpenClaw Node runtime is unavailable");
  const nodeVersion = new TextDecoder("utf-8", { fatal: true })
    .decode(nodeVersionResult.bytes)
    .trim();
  const moduleHashes: string[] = [];
  for (const name of MODULES) {
    const modulePath = path.join(packageRoot, "dist", name);
    safeNativePath(modulePath);
    if (!realpathSync(modulePath).startsWith(`${packageRoot}${path.sep}`))
      throw new Error("OpenClaw module escapes installation");
    moduleHashes.push(sha256(readFileSync(modulePath)));
  }
  moduleHashes.push(sha256(readFileSync(packageJsonPath)));
  const storageScript =
    "import {pathToFileURL} from 'node:url'; const {s:path}=await import(pathToFileURL(process.argv[1]+'/dist/openclaw-state-db.paths-DYMh54HD.mjs')); console.log(JSON.stringify(path(process.env)));";
  const storageResult = await commands.run(
    node,
    ["--input-type=module", "-e", storageScript, packageRoot],
    {
      env: restoredOpenClawEnvironment(env, environment),
      cwd: workspace,
      limit: 64 * 1024,
      timeout: 3000,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    },
  );
  const stateDatabase = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(storageResult.bytes),
  ) as string;
  if (!path.isAbsolute(stateDatabase)) throw new Error("OpenClaw global state path is invalid");
  preflightGlobal(stateDatabase);
  const inventoryScript = String.raw`
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const get=n=>import(pathToFileURL(process.argv[1]+'/dist/'+n));
const {c:read}=await get('io.runtime-hPN4FOBi.mjs');
const {n:summaries}=await get('agents.config-G5R7b0ly.mjs');
const snapshot=await read({observe:false,skipPluginValidation:true,isolateEnv:true});
if(!snapshot.exists||!snapshot.valid)throw Error('Valid configured OpenClaw agent required');
console.log(JSON.stringify({entries:summaries(snapshot.config),path:snapshot.path,fingerprint:createHash('sha256').update(JSON.stringify(snapshot.config)).digest('hex')}));
`;
  const inventoryResult = await commands.run(
    node,
    ["--input-type=module", "-e", inventoryScript, packageRoot],
    {
      env: restoredOpenClawEnvironment(env, environment),
      cwd: workspace,
      limit: 2 * 1024 * 1024,
      timeout: COMMAND_TIMEOUT,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    },
  );
  const inventory = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(inventoryResult.bytes),
  ) as { entries?: unknown; path?: unknown; fingerprint?: unknown };
  if (
    !Array.isArray(inventory.entries) ||
    typeof inventory.path !== "string" ||
    typeof inventory.fingerprint !== "string"
  )
    throw new Error("OpenClaw agent inventory is unavailable");
  const canonicalWorkspace = canonicalProject(workspace);
  const matches = inventory.entries.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = (item as Record<string, unknown>).workspace;
    try {
      return typeof candidate === "string" && realpathSync(candidate) === canonicalWorkspace;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1)
    throw new Error("OpenClaw needs exactly one configured agent for this workspace");
  const match = matches[0]!;
  if (
    typeof match.id !== "string" ||
    !/^[a-z0-9_-]{1,64}$/.test(match.id) ||
    typeof match.agentDir !== "string"
  )
    throw new Error("Invalid OpenClaw configured agent");
  if (!path.isAbsolute(match.agentDir) || !path.isAbsolute(inventory.path))
    throw new Error("OpenClaw storage path is invalid");
  safeNativePath(match.agentDir);
  safeNativePath(inventory.path);
  const context: OpenClawContext = {
    node,
    node_version: nodeVersion,
    package: packageRoot,
    package_fingerprint: sha256(JSON.stringify(moduleHashes)),
    agent_id: match.id,
    agent_dir: realpathSync(match.agentDir),
    state_database: stateDatabase,
    config_fingerprint: inventory.fingerprint,
    config_path: inventory.path,
    environment,
  };
  preflight(context);
  return context;
}

export async function resolveOpenClawInstallation(
  commands: Commands,
  env: NodeJS.ProcessEnv,
): Promise<{ executable: string; version: string }> {
  const found = resolveCommand("openclaw", env);
  if (!found || !path.isAbsolute(found)) throw new Error("OpenClaw CLI is unavailable");
  const executable = resolveOpenClawEntry(found);
  const packageRoot = path.dirname(executable);
  const metadata = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    metadata.name !== "openclaw" ||
    metadata.version !== VERSION ||
    path.basename(executable) !== "openclaw.mjs"
  )
    throw new Error("Native OpenClaw import requires the verified 2026.9.6 npm installation");
  const node = resolveCommand("node", env);
  if (!node || !path.isAbsolute(node)) throw new Error("OpenClaw requires Node");
  const versionResult = await commands.run(node, [executable, "--version"], {
    env,
    limit: 64 * 1024,
    timeout: 3000,
    allowFailure: true,
    terminateDescendantsOnExit: true,
  });
  const versionText = new TextDecoder("utf-8", { fatal: true }).decode(versionResult.bytes).trim();
  if (
    !versionResult.success ||
    !new RegExp(`^OpenClaw ${VERSION.replaceAll(".", "\\.")}(?: \\([0-9a-f]{7,40}\\))?$`, "i").test(
      versionText,
    )
  )
    throw new Error("Unverified OpenClaw import version");
  return { executable, version: VERSION };
}

function restoredOpenClawEnvironment(
  env: NodeJS.ProcessEnv,
  values: OpenClawContext["environment"],
): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const [key, value] of values) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

export function openClawSessionKey(context: OpenClawContext, id: string): string {
  return `agent:${context.agent_id}:agentkib:${id}`;
}

export async function openClawBridge(
  plan: {
    openclaw: OpenClawContext | null;
    target_session_id: string;
    workspace: string;
    payload: string;
  },
  payloadPath: string,
  commands: Commands,
  write: boolean,
  probe = false,
): Promise<Record<string, unknown>> {
  const context = plan.openclaw;
  if (!context) throw new Error("OpenClaw target context missing");
  preflight(context);
  const payload = readFileSync(payloadPath);
  if (!payload.equals(Buffer.from(plan.payload)))
    throw new Error("OpenClaw payload changed after preview");
  const input = JSON.stringify({
    context,
    id: plan.target_session_id,
    key: openClawSessionKey(context, plan.target_session_id),
    workspace: plan.workspace,
    payload: payloadPath,
    payload_hash: sha256(plan.payload),
    write,
    probe,
  });
  const result = await commands.run(context.node, ["--input-type=module", "-e", BRIDGE, input], {
    cwd: plan.workspace,
    env: restoredOpenClawEnvironment(process.env, context.environment),
    limit: MAX_OUTPUT,
    timeout: COMMAND_TIMEOUT,
    strictOutput: true,
    terminateDescendantsOnExit: true,
  });
  if (!result.success) throw new Error("OpenClaw import verification failed");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)) as Record<
    string,
    unknown
  >;
}

const BRIDGE = String.raw`
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const p=JSON.parse(process.argv[1]), c=p.context;
for(const [k,v] of c.environment) { if(v===null) delete process.env[k]; else process.env[k]=v; }
const get=n=>import(pathToFileURL(c.package+'/dist/'+n));
const {a:resolveDatabase}=await get('openclaw-agent-db.paths-C2YxM4Tj.mjs');
const {s:statePath}=await get('openclaw-state-db.paths-DYMh54HD.mjs');
if(fs.realpathSync(resolveDatabase({agentId:c.agent_id,env:process.env}))!==fs.realpathSync(c.agent_dir+'/openclaw-agent.sqlite')||fs.realpathSync(statePath(process.env))!==fs.realpathSync(c.state_database))throw Error('OpenClaw environment does not match reviewed storage');
const {t:lockState}=await get('embedded-state-lock-Cw9nQxv5.mjs');
const lock=await lockState({options:{env:process.env,allowInTests:true,timeoutMs:1000},formatActiveGatewayRefusal:()=> 'Stop the local OpenClaw Gateway before native import or resume'});
try {
 const dbPath=c.agent_dir+'/openclaw-agent.sqlite';
 const db=new DatabaseSync(dbPath,{readOnly:true});
 const meta=db.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
 if(db.prepare('PRAGMA user_version').get().user_version!==23||meta.role!=='agent'||meta.schema_version!==23||meta.agent_id!==c.agent_id||meta.app_version!=='2026.9.6') throw Error('Unverified OpenClaw database');
 db.close();
 if(fs.realpathSync(resolveDatabase({agentId:c.agent_id,env:process.env}))!==fs.realpathSync(dbPath))throw Error('OpenClaw state and configured agent directory differ');
 const stateDb=new DatabaseSync(statePath(process.env),{readOnly:true});
 const stateMeta=stateDb.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
 if(stateDb.prepare('PRAGMA user_version').get().user_version!==18||stateMeta.role!=='global'||stateMeta.schema_version!==18||stateMeta.app_version!=='2026.9.6')throw Error('Unverified OpenClaw global database');
 stateDb.close();
 const options={agentId:c.agent_id,env:process.env,path:dbPath};
 const {f:transaction,r:close}=await get('openclaw-agent-db-CaQAStOA.mjs');
 const {f:writeEntry}=await get('session-accessor.sqlite-entry-store-DTntRuil.mjs');
 const {u:replace}=await get('session-accessor.sqlite-transcript-store-CFksbmAY.mjs');
 const {l:events}=await get('session-accessor.sqlite-read-DG0i0-yW.mjs');
 const {n:readOnly}=await get('openclaw-agent-db-readonly-IBx2zWDG.mjs');
 const bytes=fs.readFileSync(p.payload);
 if(createHash('sha256').update(bytes).digest('hex')!==p.payload_hash)throw Error('Reviewed OpenClaw payload changed');
 const expected=JSON.parse(bytes.toString('utf8'));
 if(p.probe) console.log(JSON.stringify({ready:true}));
 else {
  const scope={...options,sessionKey:p.key,sessionId:p.id};
  const verify=d=>{
   const n=d.db.prepare('SELECT * FROM session_nodes WHERE session_key=?').get(p.key);
   const w=d.db.prepare('SELECT * FROM session_windows WHERE session_id=?').get(p.id);
   if(!n||!w||n.current_session_id!==p.id||n.entry_valid!==1||w.session_key!==p.key||w.previous_session_id||w.acp_owned||w.plugin_owner_id||w.parent_session_key||n.parent_session_key||n.fork_source_session_id||w.session_scope!=='conversation'||(w.agent_harness_id&&w.agent_harness_id!=='pi'))throw Error('OpenClaw target ownership or window changed');
   const e=JSON.parse(n.entry_json);
   if(e.sessionId!==p.id||e.spawnedCwd!==p.workspace||e.spawnedWorkspaceDir!==p.workspace||e.label!=='AgentKib '+p.id)throw Error('OpenClaw import ownership changed');
   if(d.db.prepare('SELECT 1 FROM session_transcript_cold_archives WHERE session_id=?').get(p.id))throw Error('OpenClaw target archived');
   const idx=d.db.prepare('SELECT * FROM session_transcript_index_state WHERE session_id=?').get(p.id);
   const last=d.db.prepare('SELECT max(seq) AS seq FROM transcript_events WHERE session_id=?').get(p.id);
   if(!idx||idx.needs_rebuild||idx.indexed_seq!==last.seq)throw Error('OpenClaw target index is stale');
   const active=d.db.prepare('SELECT event_seq,active_position,message_position,context_eligible FROM session_transcript_active_events WHERE session_id=? ORDER BY active_position LIMIT ?').all(p.id,expected.length-1);
   if(active.length!==expected.length-1||active.some((e,i)=>e.event_seq!==i+1||e.active_position!==i||e.message_position!==i||e.context_eligible!==1))throw Error('OpenClaw reviewed history is no longer active');
   const generation=d.db.prepare('SELECT generation FROM transcript_rewrite_watermarks WHERE session_id=?').get(p.id)?.generation;
   const raw=events(d,p.id,{maxEventBytes:268435456});
   if(raw.some((event,i)=>i>=expected.length&&['reset','compaction','branch_summary','leaf'].includes(event.type)))throw Error('OpenClaw target context boundary changed');
   return {events:raw,generation};
  };
  if(p.write) transaction(d=>{
   if(d.db.prepare('SELECT 1 FROM session_nodes WHERE session_key=? OR current_session_id=?').get(p.key,p.id)||d.db.prepare('SELECT 1 FROM session_windows WHERE session_id=?').get(p.id)||d.db.prepare('SELECT 1 FROM transcript_events WHERE session_id=?').get(p.id))throw Error('OpenClaw target already exists');
   writeEntry(d,p.key,{sessionId:p.id,updatedAt:Date.now(),createdAt:Date.now(),label:'AgentKib '+p.id,spawnedCwd:p.workspace,spawnedWorkspaceDir:p.workspace,createdVia:'operator'});
   replace(d,scope,expected);
   const actual=verify(d);
   if(!isDeepStrictEqual(actual.events,expected))throw Error('OpenClaw writer changed reviewed payload');
  },options);
  const result=readOnly(d=>{d.db.exec('BEGIN');try{return verify(d)}finally{d.db.exec('ROLLBACK')}},options);
  if(!result.found)throw Error('OpenClaw target not found');
  console.log(JSON.stringify(result.value));
 }
 await close();
} finally {await lock.release();}
`;

export async function openClawReady(
  plan: {
    openclaw: OpenClawContext | null;
    target_session_id: string;
    workspace: string;
    payload: string;
  },
  payloadPath: string,
  commands: Commands,
): Promise<void> {
  const result = await openClawBridge(plan, payloadPath, commands, false, true);
  if (result.ready !== true) throw new Error("OpenClaw did not confirm import readiness");
}

export async function openClawVerify(
  plan: {
    openclaw: OpenClawContext | null;
    target_session_id: string;
    workspace: string;
    payload: string;
  },
  directory: string,
  commands: Commands,
  exact: boolean,
): Promise<string> {
  const result = await openClawBridge(plan, path.join(directory, "payload.json"), commands, false);
  const actual = result.events;
  const expected = JSON.parse(plan.payload) as unknown[];
  if (
    !Array.isArray(actual) ||
    actual.length < expected.length ||
    (exact && actual.length !== expected.length) ||
    expected.some((value, index) => !isDeepStrictEqual(value, actual[index]))
  )
    throw new Error("OpenClaw imported history differs from reviewed events");
  if (typeof result.generation !== "string" || !result.generation)
    throw new Error("OpenClaw generation missing");
  const generationPath = path.join(directory, "openclaw-generation");
  if (existsSync(generationPath)) {
    const current = readFileSync(generationPath);
    if (!current.equals(Buffer.from(result.generation)))
      throw new Error("OpenClaw target transcript generation changed");
  } else {
    const { openSync, writeSync, fsyncSync, closeSync } = await import("node:fs");
    const fd = openSync(generationPath, "wx", 0o600);
    try {
      writeSync(fd, result.generation);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return plan.target_session_id;
}

export function openClawInteractive(
  plan: {
    openclaw: OpenClawContext | null;
    target_session_id: string;
    executable: string;
    workspace: string;
    environment: Array<[string, string | null]>;
  },
  baseEnvironment: NodeJS.ProcessEnv,
): { executable: string; arguments: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  if (!plan.openclaw) throw new Error("OpenClaw target context missing");
  const env: NodeJS.ProcessEnv = { ...baseEnvironment };
  for (const [key, value] of [...plan.environment, ...plan.openclaw.environment]) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return {
    executable: plan.openclaw.node,
    arguments: [
      plan.executable,
      "tui",
      "--local",
      "--session",
      openClawSessionKey(plan.openclaw, plan.target_session_id),
    ],
    cwd: plan.workspace,
    env,
  };
}
