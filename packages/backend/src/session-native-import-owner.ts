import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  fstatSync,
  lstatSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveCommand } from "./command-resolution";
import { Commands } from "./commands";
import { isReparseOrSymlink } from "./native-files";
import type { SessionDocument } from "./session-model";
import {
  prepareNativeImportPayload,
  type NativeTargetModel,
} from "./session-native-import-projection";
import type { ChangeSet } from "./change-plan";
import { changeSet as changeSetSchema } from "./change-apply";
import { applyRequest } from "./changes";
import { fingerprintSessionDocument } from "./session-handoff";
import type { BackendStore } from "./store";
import type { SessionStore } from "./session-store";
import { userHome } from "./mcp-config-read";
import {
  inspectOpenClawContext,
  openClawBridge,
  openClawReady,
  openClawVerify,
  resolveOpenClawInstallation,
  validateOpenClawContext,
  type OpenClawContext,
} from "./openclaw-native-import";

export type ImportTarget = "opencode" | "open-claw" | "hermes";
const STORAGE_ENVIRONMENT = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "HERMES_HOME",
  "OPENCODE_TEST_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
] as const;
const MAX_OUTPUT = 256 * 1024 * 1024;
const IMPORT_TIMEOUT = 60_000;

export interface ImportTargetSnapshot {
  target: ImportTarget;
  executable: string;
  version: string;
  model: NativeTargetModel | null;
  targetHome: string | null;
  profile: string | null;
  environment: Array<[string, string | null]>;
  expected: SessionDocument;
  payload: string;
  fingerprint: string;
  openclaw: OpenClawContext | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validStoredEnvironment(values: Array<[string, string | null]>): void {
  if (values.length !== STORAGE_ENVIRONMENT.length)
    throw new Error("Storage environment is incomplete");
  for (const [index, entry] of values.entries()) {
    const [key, value] = entry;
    if (
      key !== STORAGE_ENVIRONMENT[index] ||
      (key === "OPENCODE_CONFIG_CONTENT" && value !== null) ||
      (value !== null && /[\0\r\n]/.test(value))
    )
      throw new Error("Invalid storage environment");
    if (key.startsWith("NODE_") && value)
      throw new Error("Node injection environment is not supported");
  }
}

function captureEnvironment(env: NodeJS.ProcessEnv): Array<[string, string | null]> {
  const values = STORAGE_ENVIRONMENT.map(
    (key) =>
      [key, key === "OPENCODE_CONFIG_CONTENT" ? null : (env[key] ?? null)] as [
        string,
        string | null,
      ],
  );
  validStoredEnvironment(values);
  return values;
}

function safeNativePath(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.relative(path.parse(value).root, value).split(path.sep).includes("..")
  )
    throw new Error("Invalid native storage path");
  let current = path.resolve(value);
  const ancestors: string[] = [];
  for (;;) {
    ancestors.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const ancestor of ancestors) {
    try {
      const metadata = lstatSync(ancestor);
      if (isReparseOrSymlink(ancestor, metadata)) throw new Error("Native storage path is a link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return value;
}

function hermesTargetHome(env: NodeJS.ProcessEnv): { home: string; profile: string } {
  const base = path.resolve(env.HERMES_HOME ?? path.join(userHome(env), ".hermes"));
  if (!path.isAbsolute(base)) throw new Error("Hermes home unavailable");
  const parentName = path.basename(path.dirname(base));
  let selected: string;
  let profile: string;
  if (parentName === "profiles") {
    profile = path.basename(base);
    selected = base;
  } else {
    const activeFile = path.join(base, "active_profile");
    let active = "default";
    if (existsSync(activeFile)) {
      const fd = openSync(activeFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const metadata = fstatSync(fd);
        if (!metadata.isFile() || metadata.size > 256)
          throw new Error("Invalid Hermes active profile");
        active = readFileSync(fd, "utf8").trim() || "default";
      } finally {
        closeSync(fd);
      }
    }
    profile = active;
    selected = active === "default" ? base : path.join(base, "profiles", active);
  }
  if (!profile || profile.length > 64 || !/^[A-Za-z0-9_-]+$/.test(profile))
    throw new Error("Invalid Hermes profile name");
  selected = safeNativePath(selected);
  try {
    selected = realpathSync(selected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { home: selected, profile };
}

function readOpenCodeModel(output: Buffer): NativeTargetModel {
  const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)) as {
    model?: unknown;
  };
  if (typeof config.model !== "string")
    throw new Error("Configure an explicit OpenCode provider/model before native import");
  const [provider_id, model_id, ...rest] = config.model.split("/");
  if (!provider_id || !model_id || rest.length)
    throw new Error("Invalid OpenCode configured model");
  return { provider_id, model_id };
}

export async function inspectNativeImportTarget(
  target: ImportTarget,
  document: SessionDocument,
  workspace: string,
  commands: Commands,
  env: NodeJS.ProcessEnv,
): Promise<ImportTargetSnapshot> {
  let executable: string;
  let version: string;
  let openclaw: OpenClawContext | null = null;
  if (target === "open-claw") {
    ({ executable, version } = await resolveOpenClawInstallation(commands, env));
    openclaw = await inspectOpenClawContext(executable, workspace, commands, env);
  } else {
    const resolved = resolveCommand(target === "hermes" ? "hermes" : "opencode", env);
    if (!resolved || !path.isAbsolute(resolved)) throw new Error("Target CLI is unavailable");
    executable = resolved;
    const versionResult = await commands.run(executable, ["--version"], {
      env,
      limit: 64 * 1024,
      timeout: 3_000,
      allowFailure: true,
      terminateDescendantsOnExit: true,
    });
    const versionText = new TextDecoder("utf-8", { fatal: true })
      .decode(versionResult.bytes)
      .trim();
    version = target === "hermes" ? "0.21.5" : "1.18.32";
    const versionMatches =
      target === "hermes"
        ? versionText
            .split(/\r?\n/)
            .some((line) => line.trim() === "Hermes Agent v0.21.5 (2026.9.24)")
        : versionText === version;
    if (!versionResult.success || !versionMatches)
      throw new Error(`Unverified ${target} import version`);
  }
  let model: NativeTargetModel | null = null;
  let targetHome: string | null = null;
  let profile: string | null = null;
  if (target === "open-claw") {
    // OpenClaw stores no provider model in imported transcript metadata.
  } else if (target === "opencode") {
    if (env.OPENCODE_CONFIG_CONTENT)
      throw new Error("Inline OpenCode configuration cannot be imported safely");
    const config = await commands.run(executable, ["debug", "config"], {
      cwd: workspace,
      env,
      limit: 2 * 1024 * 1024,
      timeout: 10_000,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    });
    if (!config.success) throw new Error("Could not read OpenCode target configuration");
    model = readOpenCodeModel(config.bytes);
  } else {
    const targetState = hermesTargetHome(env);
    targetHome = targetState.home;
    profile = targetState.profile;
  }
  const environment = captureEnvironment(env);
  const prepared = prepareNativeImportPayload(
    target,
    document,
    target === "opencode"
      ? "ses_00000000000000000000000000000000"
      : "00000000-0000-4000-8000-000000000000",
    workspace,
    model ?? undefined,
  );
  const fingerprint = sha256(
    JSON.stringify([
      executable,
      version,
      model,
      targetHome,
      profile,
      environment,
      prepared,
      openclaw,
    ]),
  );
  return {
    target,
    executable,
    version,
    model,
    targetHome,
    profile,
    environment,
    expected: prepared.expected,
    payload: prepared.payload,
    fingerprint,
    openclaw,
  };
}

function ensureInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    !path.isAbsolute(root) ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
    throw new Error("Import path escapes application data");
  let cursor = path.dirname(candidate);
  const ancestors: string[] = [];
  for (;;) {
    ancestors.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor || path.relative(root, parent).startsWith("..")) break;
    cursor = parent;
  }
  for (const directory of ancestors) {
    try {
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory() || isReparseOrSymlink(directory, metadata))
        throw new Error("Import path contains an unsafe directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function planNativeImport(
  dataDir: string,
  workspace: string,
  workspaceId: string,
  sourceSessionId: string,
  sourceFingerprint: string,
  target: ImportTarget,
  document: SessionDocument,
  snapshot: ImportTargetSnapshot,
): Promise<{ change_set: ChangeSet; launch_request: Record<string, unknown> }> {
  if (target !== snapshot.target) throw new Error("Native import target changed after preview");
  const operationId = randomUUID();
  const targetSessionId =
    target === "opencode" ? `ses_${operationId.replaceAll("-", "")}` : operationId;
  const prepared = prepareNativeImportPayload(
    target,
    document,
    targetSessionId,
    workspace,
    snapshot.model ?? undefined,
  );
  if (JSON.stringify(prepared.expected) !== JSON.stringify(snapshot.expected))
    throw new Error("Target import settings changed after preview");
  const plan = {
    schema_version: 1,
    operation_id: operationId,
    workspace_id: workspaceId,
    workspace,
    source_session_id: sourceSessionId,
    source_fingerprint: sourceFingerprint,
    target_agent: target,
    executable: snapshot.executable,
    version: snapshot.version,
    model: snapshot.model,
    target_home: snapshot.targetHome,
    target_profile: snapshot.profile,
    environment: snapshot.environment,
    openclaw: snapshot.openclaw,
    target_session_id: targetSessionId,
    document,
    expected: prepared.expected,
    payload: prepared.payload,
  };
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const root = path.resolve(dataDir);
  const workspaceHash = sha256(workspaceId).slice(0, 32);
  const destination = path.join(
    root,
    "continuations",
    workspaceHash,
    operationId,
    "import",
    "plan.json",
  );
  ensureInside(root, destination);
  const planHash = sha256(content);
  return {
    change_set: {
      id: operationId,
      project_root: workspace,
      created_at: new Date().toISOString(),
      requires_home_approval: true,
      changes: [
        {
          target: destination,
          scope: "application-data",
          original_hash: null,
          before: "",
          after: content,
          risk: "high",
          validator: "json",
        },
      ],
    },
    launch_request: {
      mode: "native-import",
      operation_id: operationId,
      workspace_id: workspaceId,
      target_agent: target,
      plan_hash: planHash,
    },
  };
}

interface NativeImportPlan extends Record<string, unknown> {
  schema_version: 1;
  operation_id: string;
  workspace_id: string;
  workspace: string;
  source_session_id: string;
  source_fingerprint: string;
  target_agent: ImportTarget;
  executable: string;
  version: string;
  model: NativeTargetModel | null;
  target_home: string | null;
  target_profile: string | null;
  environment: Array<[string, string | null]>;
  openclaw: OpenClawContext | null;
  target_session_id: string;
  document: SessionDocument;
  expected: SessionDocument;
  payload: string;
}

interface NativeImportRequest {
  operation_id: string;
  workspace_id: string;
  target_agent: ImportTarget;
  plan_hash: string;
}

interface NativeImportReceipt {
  schema_version: 1;
  plan_hash: string;
  target_session_id: string;
  verified: boolean;
  launched: boolean;
  terminal: string | null;
}

function importDirectory(dataDir: string, workspaceId: string, operationId: string): string {
  const workspaceHash = sha256(workspaceId).slice(0, 32);
  return path.join(dataDir, "continuations", workspaceHash, operationId, "import");
}

function safeRegularFile(file: string, maxBytes: number): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata) || metadata.size > maxBytes)
    throw new Error("Import record is not a bounded regular file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes)
      throw new Error("Import record exceeds its read limit");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicPrivateWrite(directory: string, target: string, content: Buffer): void {
  ensureInside(directory, target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.agentkib-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    if (process.platform !== "win32") {
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function createPrivateFile(directory: string, target: string, content: Buffer): void {
  ensureInside(directory, target);
  const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

function restoredEnvironment(env: NodeJS.ProcessEnv, plan: NativeImportPlan): NodeJS.ProcessEnv {
  const restored = { ...env };
  for (const [key, value] of plan.environment) {
    if (value === null) delete restored[key];
    else restored[key] = value;
  }
  return restored;
}

function validateImportRequest(value: unknown): NativeImportRequest {
  const request = value as Partial<NativeImportRequest> | null;
  if (
    !request ||
    typeof request !== "object" ||
    typeof request.operation_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      request.operation_id,
    ) ||
    typeof request.workspace_id !== "string" ||
    !["opencode", "open-claw", "hermes"].includes(String(request.target_agent)) ||
    typeof request.plan_hash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(request.plan_hash)
  )
    throw new Error("Invalid native import request");
  return request as NativeImportRequest;
}

function loadNativeImportPlan(
  dataDir: string,
  value: unknown,
): { request: NativeImportRequest; directory: string; plan: NativeImportPlan; content: Buffer } {
  const request = validateImportRequest(value);
  const directory = importDirectory(dataDir, request.workspace_id, request.operation_id);
  const file = path.join(directory, "plan.json");
  ensureInside(path.resolve(dataDir), file);
  const content = safeRegularFile(file, MAX_OUTPUT);
  if (sha256(content) !== request.plan_hash) throw new Error("Import plan changed");
  const plan = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(content),
  ) as NativeImportPlan;
  if (
    plan.schema_version !== 1 ||
    plan.operation_id !== request.operation_id ||
    plan.workspace_id !== request.workspace_id ||
    plan.target_agent !== request.target_agent ||
    plan.target_session_id !==
      (plan.target_agent === "opencode"
        ? `ses_${request.operation_id.replaceAll("-", "")}`
        : request.operation_id) ||
    !path.isAbsolute(plan.workspace) ||
    !path.isAbsolute(plan.executable) ||
    !Array.isArray(plan.environment)
  )
    throw new Error("Import plan identity mismatch");
  if (plan.document.source.workspace_id !== request.workspace_id)
    throw new Error("Import plan workspace or context mismatch");
  if (fingerprintSessionDocument(plan.document) !== plan.source_fingerprint)
    throw new Error("Import document differs from its approved source fingerprint");
  if (
    plan.target_agent === "hermes" &&
    (!plan.target_home || !plan.target_profile || plan.model !== null)
  )
    throw new Error("Hermes import settings mismatch");
  if (
    plan.target_agent === "opencode" &&
    (!plan.model || plan.target_home !== null || plan.target_profile !== null)
  )
    throw new Error("OpenCode import settings mismatch");
  if (
    (plan.target_agent === "open-claw" &&
      (!plan.openclaw ||
        plan.model !== null ||
        plan.target_home !== null ||
        plan.target_profile !== null)) ||
    (plan.target_agent !== "open-claw" && plan.openclaw !== null)
  )
    throw new Error("OpenClaw import context mismatch");
  if (plan.openclaw) validateOpenClawContext(plan.openclaw);
  validStoredEnvironment(plan.environment);
  const prepared = prepareNativeImportPayload(
    plan.target_agent,
    plan.document,
    plan.target_session_id,
    plan.workspace,
    plan.model ?? undefined,
  );
  if (
    prepared.payload !== plan.payload ||
    JSON.stringify(prepared.expected) !== JSON.stringify(plan.expected)
  )
    throw new Error("Import payload does not match its reviewed document");
  return { request, directory, plan, content };
}

async function executeNativeImport(
  payload: {
    request: NativeImportRequest;
    directory: string;
    plan: NativeImportPlan;
    content: Buffer;
  },
  commands: Commands,
  env: NodeJS.ProcessEnv,
  approveHome: boolean,
  reopen: boolean,
): Promise<{ target_session_id: string; receipt: NativeImportReceipt }> {
  const { request, directory, plan, content } = payload;
  const currentEnvironment = captureEnvironment(env);
  if (JSON.stringify(currentEnvironment) !== JSON.stringify(plan.environment))
    throw new Error("Target storage environment changed after preview");
  const snapshot = await inspectNativeImportTarget(
    plan.target_agent,
    plan.document,
    plan.workspace,
    commands,
    env,
  );
  if (
    snapshot.executable !== plan.executable ||
    snapshot.version !== plan.version ||
    JSON.stringify(snapshot.model) !== JSON.stringify(plan.model) ||
    snapshot.targetHome !== plan.target_home ||
    snapshot.profile !== plan.target_profile ||
    JSON.stringify(snapshot.openclaw) !== JSON.stringify(plan.openclaw) ||
    JSON.stringify(snapshot.expected) !== JSON.stringify(plan.expected)
  )
    throw new Error("Target installation or configuration changed after preview");

  const receiptPath = path.join(directory, "receipt.json");
  let receipt: NativeImportReceipt;
  if (existsSync(receiptPath)) {
    receipt = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(safeRegularFile(receiptPath, 1024 * 1024)),
    ) as NativeImportReceipt;
    if (
      receipt.schema_version !== 1 ||
      receipt.plan_hash !== request.plan_hash ||
      typeof receipt.target_session_id !== "string"
    )
      throw new Error("Import receipt mismatch");
  } else {
    receipt = {
      schema_version: 1,
      plan_hash: request.plan_hash,
      target_session_id: plan.target_session_id,
      verified: false,
      launched: false,
      terminal: null,
    };
  }
  if (!receipt.verified) {
    if (!approveHome) throw new Error("Native import requires Agent Home approval");
    const attemptedPath = path.join(directory, "attempted.json");
    const attempted = existsSync(attemptedPath);
    if (attempted && !safeRegularFile(attemptedPath, 256).equals(Buffer.from(request.plan_hash)))
      throw new Error("Import attempt marker mismatch");
    if (!attempted) {
      if (reopen)
        throw new Error("Import has not started; prepare and approve a new import preview");
      const payloadPath = path.join(directory, "payload.json");
      ensureInside(directory, payloadPath);
      if (existsSync(payloadPath)) {
        if (!safeRegularFile(payloadPath, MAX_OUTPUT).equals(Buffer.from(plan.payload)))
          throw new Error("Import payload changed");
      } else {
        createPrivateFile(directory, payloadPath, Buffer.from(plan.payload));
      }
      if (plan.target_agent === "open-claw") await openClawReady(plan, payloadPath, commands);
      createPrivateFile(directory, attemptedPath, Buffer.from(request.plan_hash));
      if (plan.target_agent === "open-claw") {
        await openClawBridge(plan, payloadPath, commands, true);
      } else {
        const args =
          plan.target_agent === "hermes"
            ? [
                "--profile",
                plan.target_profile!,
                "sessions",
                "import",
                "--from",
                "claude",
                payloadPath,
              ]
            : ["import", payloadPath];
        await commands.run(plan.executable, args, {
          cwd: plan.workspace,
          env: restoredEnvironment(env, plan),
          limit: MAX_OUTPUT,
          timeout: IMPORT_TIMEOUT,
          allowFailure: true,
          strictOutput: true,
          terminateDescendantsOnExit: true,
        });
      }
    }
    const id = await verifyNativeImport(plan, directory, commands, env, !attempted);
    receipt.target_session_id = id;
    receipt.verified = true;
    atomicPrivateWrite(directory, receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`));
  } else {
    const id = await verifyNativeImport(plan, directory, commands, env, false);
    if (id !== receipt.target_session_id) throw new Error("Native import target identity changed");
  }
  return { target_session_id: receipt.target_session_id, receipt };
}

async function verifyNativeImport(
  plan: NativeImportPlan,
  directory: string,
  commands: Commands,
  env: NodeJS.ProcessEnv,
  exact: boolean,
): Promise<string> {
  env = restoredEnvironment(env, plan);
  if (plan.target_agent === "open-claw") return openClawVerify(plan, directory, commands, exact);
  if (plan.target_agent === "opencode") {
    const exported = await commands.run(plan.executable, ["export", plan.target_session_id], {
      cwd: plan.workspace,
      env,
      limit: MAX_OUTPUT,
      timeout: IMPORT_TIMEOUT,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    });
    if (!exported.success) throw new Error("Native import export could not be verified");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(exported.bytes),
    ) as Record<string, any>;
    if (value.info?.directory !== plan.workspace || value.info?.id !== plan.target_session_id)
      throw new Error("Imported OpenCode workspace or identity mismatch");
    if (value.info?.permission != null || value.info?.revert != null)
      throw new Error("Imported OpenCode session has changed execution state");
    const messages = value.messages;
    if (
      !Array.isArray(messages) ||
      (exact
        ? messages.length !== plan.expected.turns.length
        : messages.length < plan.expected.turns.length)
    )
      throw new Error("Imported OpenCode turn count differs from preview");
    const identity = plan.target_session_id.slice(4);
    let parent = "";
    for (const [index, expected] of plan.expected.turns.entries()) {
      const message = messages[index];
      const info = message?.info;
      const role = expected.role === "user" ? "user" : "assistant";
      if (
        !info ||
        info.sessionID !== plan.target_session_id ||
        info.role !== role ||
        info.agent !== "build" ||
        info.id !== `msg_${identity}_${index.toString(16).padStart(8, "0")}`
      )
        throw new Error(`Imported OpenCode identity mismatch at turn ${index + 1}`);
      if (role === "user") {
        parent = info.id;
        if (
          info.model?.providerID !== plan.model?.provider_id ||
          info.model?.modelID !== plan.model?.model_id
        )
          throw new Error("Imported OpenCode model differs from preview");
      } else if (
        info.parentID !== parent ||
        info.finish !== "stop" ||
        info.mode !== "build" ||
        info.error != null ||
        info.summary === true
      ) {
        throw new Error(`Imported OpenCode execution state differs at turn ${index + 1}`);
      }
      const parts = message.parts;
      if (!Array.isArray(parts) || parts.length !== expected.blocks.length)
        throw new Error("Imported OpenCode parts differ from preview");
      for (const [partIndex, block] of expected.blocks.entries()) {
        const part = parts[partIndex];
        if (
          block.type !== "text" ||
          part?.type !== "text" ||
          part.text !== block.text ||
          part.sessionID !== plan.target_session_id ||
          part.messageID !== info.id ||
          part.id !==
            `prt_${identity}_${index.toString(16).padStart(8, "0")}_${partIndex.toString(16).padStart(8, "0")}` ||
          part.ignored === true ||
          part.synthetic === true
        )
          throw new Error(`Imported OpenCode text differs at turn ${index + 1}`);
      }
    }
    return plan.target_session_id;
  }
  // Hermes identity and messages are verified from its authoritative database.
  const targetHome = plan.target_home;
  if (!targetHome) throw new Error("Hermes home missing");
  const database = path.join(targetHome, "state.db");
  safeNativePath(database);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("BEGIN");
    const payloadPath = path.join(directory, "payload.json");
    const rows = db
      .prepare(
        "SELECT id,cwd FROM sessions WHERE CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.foreign_session_id') END = ? AND CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.path') END = ? AND CASE WHEN json_valid(origin_json) THEN json_extract(origin_json,'$.imported_from.tool') END = 'claude-code' LIMIT 2",
      )
      .all(plan.operation_id, payloadPath) as Array<{ id: string; cwd: string | null }>;
    if (rows.length !== 1) throw new Error("Hermes import identity is missing or ambiguous");
    const { id, cwd } = rows[0]!;
    const redirects = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE parent_session_id=?) OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND parent_session_id IS NOT NULL) AS found",
      )
      .get(id, id) as { found: number };
    if (redirects.found || cwd !== plan.workspace || !/^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(id))
      throw new Error("Hermes imported identity or workspace differs from preview");
    const messages = db
      .prepare(
        "SELECT id,role,CASE WHEN length(CAST(content AS BLOB))<=? THEN content ELSE NULL END AS content,tool_calls,tool_call_id,active FROM messages WHERE session_id=? ORDER BY id LIMIT ?",
      )
      .all(MAX_OUTPUT, id, plan.expected.turns.length + Number(exact)) as Array<{
      id: number;
      role: string;
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
      active: number;
    }>;
    if (
      exact
        ? messages.length !== plan.expected.turns.length
        : messages.length < plan.expected.turns.length
    )
      throw new Error("Hermes imported turn count differs from preview");
    let totalBytes = 0;
    for (const [index, expected] of plan.expected.turns.entries()) {
      const found = messages[index]!;
      const role = expected.role === "user" ? "user" : "assistant";
      const block = expected.blocks[0];
      if (found.content === null)
        throw new Error("Hermes imported history exceeds the verification limit");
      totalBytes += Buffer.byteLength(found.content, "utf8");
      if (totalBytes > MAX_OUTPUT)
        throw new Error("Hermes imported history exceeds the verification limit");
      if (
        block?.type !== "text" ||
        found.role !== role ||
        found.content !== block.text ||
        (found.tool_calls && found.tool_calls !== "[]" && found.tool_calls !== "null") ||
        found.tool_call_id ||
        found.active !== 1
      )
        throw new Error(`Hermes imported text differs at turn ${index + 1}`);
    }
    return id;
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {}
    db.close();
  }
}

export async function continueNativeImport(
  value: unknown,
  sessions: { document(id: string): Promise<SessionDocument> },
  sessionStore: SessionStore,
  store: BackendStore,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  commands: Commands,
): Promise<{ status: "verified"; targetSessionId: string }> {
  const envelope = value as { changeSet?: unknown; launchRequest?: unknown; approveHome?: unknown };
  if (!envelope || typeof envelope !== "object")
    throw new Error("Invalid native import continuation");
  const request = validateImportRequest(envelope.launchRequest);
  if (envelope.approveHome !== true) throw new Error("Native import requires Agent Home approval");
  const { changes, directory, plan, content } = validateNativeImportApplicationData(
    envelope.changeSet,
    envelope.launchRequest,
    request.workspace_id,
    dataDir,
  );
  const root = realpathSync(store.workspacePath(request.workspace_id));
  if (root !== plan.workspace) throw new Error("Import workspace changed");
  const session = sessionStore.get(plan.source_session_id);
  const sessionWorkspace =
    session &&
    (store.listWorkspaces() as Array<Record<string, unknown>>).find(
      (workspace) => workspace.id === session.workspace_id,
    );
  const effectiveWorkspaceId = sessionWorkspace
    ? String(sessionWorkspace.manifest_workspace_id ?? sessionWorkspace.id)
    : null;
  if (!session || effectiveWorkspaceId !== request.workspace_id)
    throw new Error("Import source workspace changed");
  const source = await sessions.document(plan.source_session_id);
  source.source.workspace_id = request.workspace_id;
  if (fingerprintSessionDocument(source) !== plan.source_fingerprint)
    throw new Error("Source changed after import preview");
  const persistedPath = path.join(directory, "plan.json");
  if (existsSync(persistedPath)) {
    if (!safeRegularFile(persistedPath, MAX_OUTPUT).equals(content))
      throw new Error("Persisted import plan differs from the reviewed plan");
  } else {
    applyRequest(
      { changeSet: changes, approveHome: true },
      store,
      dataDir,
      env,
      (reviewed, applicationId, currentDataDir) => {
        if (
          applicationId !== request.workspace_id ||
          currentDataDir !== dataDir ||
          reviewed.id !== request.operation_id ||
          reviewed.changes.length !== 1 ||
          !reviewed.requires_home_approval
        )
          throw new Error("Native import application data does not match its operation");
        const candidate = reviewed.changes[0]!;
        const expectedPath = path.join(directory, "plan.json");
        if (
          candidate.scope !== "application-data" ||
          candidate.validator !== "json" ||
          candidate.target !== expectedPath ||
          candidate.original_hash !== null ||
          candidate.before !== "" ||
          candidate.after !== content.toString("utf8")
        )
          throw new Error("Unexpected native import plan destination");
        return [expectedPath];
      },
    );
  }
  const persisted = loadNativeImportPlan(dataDir, request);
  const result = await executeNativeImport(persisted, commands, env, true, false);
  return { status: "verified", targetSessionId: result.target_session_id };
}

export function validateNativeImportApplicationData(
  value: unknown,
  launchRequest: unknown,
  applicationId: string,
  dataDir: string,
): {
  changes: ReturnType<typeof changeSetSchema.parse>;
  directory: string;
  plan: NativeImportPlan;
  content: Buffer;
} {
  const request = validateImportRequest(launchRequest);
  const changes = changeSetSchema.parse(value);
  if (
    request.workspace_id !== applicationId ||
    changes.id !== request.operation_id ||
    changes.changes.length !== 1 ||
    !changes.requires_home_approval
  )
    throw new Error("Native import requires one reviewed plan and Agent Home approval");
  const change = changes.changes[0]!;
  if (
    change.scope !== "application-data" ||
    change.validator !== "json" ||
    change.original_hash !== null ||
    change.before !== ""
  )
    throw new Error("Unexpected native import plan change");
  const { directory, plan, content } = loadNativeImportPlanFromChange(
    dataDir,
    request,
    change.after,
  );
  if (change.target !== path.join(directory, "plan.json") || sha256(content) !== request.plan_hash)
    throw new Error("Native import request does not match its reviewed plan");
  return { changes, directory, plan, content };
}

function loadNativeImportPlanFromChange(
  dataDir: string,
  request: NativeImportRequest,
  after: string,
): { directory: string; plan: NativeImportPlan; content: Buffer } {
  const directory = importDirectory(dataDir, request.workspace_id, request.operation_id);
  const target = path.join(directory, "plan.json");
  ensureInside(path.resolve(dataDir), target);
  const content = Buffer.from(after);
  if (sha256(content) !== request.plan_hash) throw new Error("Native import plan hash mismatch");
  const plan = JSON.parse(after) as NativeImportPlan;
  if (
    plan.schema_version !== 1 ||
    plan.operation_id !== request.operation_id ||
    plan.workspace_id !== request.workspace_id ||
    plan.target_agent !== request.target_agent ||
    plan.target_session_id !==
      (plan.target_agent === "opencode"
        ? `ses_${request.operation_id.replaceAll("-", "")}`
        : request.operation_id) ||
    !path.isAbsolute(plan.workspace) ||
    !path.isAbsolute(plan.executable) ||
    !Array.isArray(plan.environment)
  )
    throw new Error("Import plan identity mismatch");
  if (
    plan.document.source.workspace_id !== request.workspace_id ||
    fingerprintSessionDocument(plan.document) !== plan.source_fingerprint
  )
    throw new Error("Import plan source identity mismatch");
  if (
    (plan.target_agent === "hermes" &&
      (!plan.target_home || !plan.target_profile || plan.model !== null)) ||
    (plan.target_agent === "opencode" &&
      (!plan.model || plan.target_home !== null || plan.target_profile !== null)) ||
    (plan.target_agent === "open-claw" &&
      (!plan.openclaw ||
        plan.model !== null ||
        plan.target_home !== null ||
        plan.target_profile !== null)) ||
    (plan.target_agent !== "open-claw" && plan.openclaw !== null)
  )
    throw new Error("Import plan target settings mismatch");
  if (plan.openclaw) validateOpenClawContext(plan.openclaw);
  validStoredEnvironment(plan.environment);
  const prepared = prepareNativeImportPayload(
    plan.target_agent,
    plan.document,
    plan.target_session_id,
    plan.workspace,
    plan.model ?? undefined,
  );
  if (
    prepared.payload !== plan.payload ||
    JSON.stringify(prepared.expected) !== JSON.stringify(plan.expected)
  )
    throw new Error("Import payload does not match its reviewed document");
  return { directory, plan, content };
}

export async function reconcileNativeImport(
  dataDir: string,
  value: unknown,
  commands: Commands,
  env: NodeJS.ProcessEnv,
): Promise<{ targetSessionId: string; verified: boolean }> {
  const loaded = loadNativeImportPlan(dataDir, value);
  const result = await executeNativeImport(loaded, commands, env, true, true);
  return { targetSessionId: result.target_session_id, verified: result.receipt.verified };
}

export async function nativeImportLaunchInfo(
  dataDir: string,
  value: unknown,
  commands: Commands,
  env: NodeJS.ProcessEnv,
): Promise<{
  request: NativeImportRequest;
  plan: NativeImportPlan;
  targetSessionId: string;
  environment: Record<string, string | null>;
  alreadyLaunched: boolean;
}> {
  const loaded = loadNativeImportPlan(dataDir, value);
  const receiptPath = path.join(loaded.directory, "receipt.json");
  const receipt = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(safeRegularFile(receiptPath, 1024 * 1024)),
  ) as NativeImportReceipt;
  const validTargetId =
    loaded.plan.target_agent === "hermes"
      ? /^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(receipt.target_session_id)
      : receipt.target_session_id === loaded.plan.target_session_id;
  if (
    receipt.schema_version !== 1 ||
    receipt.plan_hash !== loaded.request.plan_hash ||
    !receipt.verified ||
    !validTargetId
  )
    throw new Error("Native import receipt is not verified");
  const verifiedId = await verifyNativeImport(loaded.plan, loaded.directory, commands, env, false);
  if (verifiedId !== receipt.target_session_id)
    throw new Error("Native import target identity changed");
  return {
    request: loaded.request,
    plan: loaded.plan,
    targetSessionId: receipt.target_session_id,
    environment: Object.fromEntries([
      ...loaded.plan.environment,
      ...(loaded.plan.openclaw?.environment ?? []),
    ]),
    alreadyLaunched: receipt.launched,
  };
}

export function markNativeImportLaunched(dataDir: string, value: unknown, terminal: string): void {
  const loaded = loadNativeImportPlan(dataDir, value);
  const receiptPath = path.join(loaded.directory, "receipt.json");
  const receipt = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(safeRegularFile(receiptPath, 1024 * 1024)),
  ) as NativeImportReceipt;
  if (
    receipt.schema_version !== 1 ||
    receipt.plan_hash !== loaded.request.plan_hash ||
    !receipt.verified
  )
    throw new Error("Native import receipt is not verified");
  receipt.launched = true;
  receipt.terminal = terminal;
  atomicPrivateWrite(loaded.directory, receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`));
}
