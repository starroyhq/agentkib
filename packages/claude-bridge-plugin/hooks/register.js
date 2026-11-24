// Host calls stay explicit for Claude Code's static plugin validation.
import {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  claudeBridgePluginCompatibility,
} from "./compatibility.js";
import { safeTerminalSubagentTitle } from "./terminal-subagents.js";

const CLI_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion;
const PLUGIN_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.pluginVersion;
// Native prompt.submit has no atomic idle/CAS option and waits for an idle
// session. A direct send is dispatched only when the terminal is verified idle,
// and its own hooks drop it if anything else entered first. Messages sent while
// a turn runs go through the outbox below instead, in the mode the person chose.
const MAX_STREAM = 96 * 1024;
// Messages AgentKib sent while a turn runs. A steer joins the running turn at its
// next tool call, or opens the next turn if this one ends first; a queued message
// starts a turn of its own once the terminal is idle, in order.
const MAX_OUTBOX = 20;
const OUTBOX_PREVIEW = 2 * 1024;
const MAX_EVENTS = 256;
// The existing 250ms pump skips these ticks before retrying: about 1/2/4/8s.
const RECONNECT_BACKOFF_TICKS = [3, 7, 15, 31];
// First discovery also needs to recover when the terminal predates AgentKib.
// Keep looking while idle, at most once every 30s after the initial backoff.
const AUTO_BACKOFF_TICKS = [3, 7, 15, 31, 63, 119];
const PREVIEW_MARKER = "\n[AgentKib preview truncated; read the original history for full content]";
// Versions AgentKib rejects; /agentkib-status explains them.
const INCOMPATIBLE_ERRORS = [
  "bridge-cli-too-old",
  "bridge-cli-unsupported",
  "bridge-capabilities-missing",
  "bridge-plugin-update-required",
];
// Refusals that a retry cannot change for this session. Other refusals retry
// after later turns: a workspace switched back on connects, and a version
// refusal reaches the AgentKib dialog once the new session is indexed.
const AUTO_FINAL_ERRORS = ["bridge-auto-declined", "unsupported-native-identity"];
// A more specific refusal in another discovered Runtime can explain the same
// session better than an unrelated Runtime with no registered workspace.
const AUTO_RETRY_REASONS = [
  "workspace-not-registered",
  "session-not-indexed",
  "auto-connect-disabled",
];
// A Project Agent (docs/agents/project-agent.md): when the Runtime names this feature, a session
// it makes one gets its worker tools here, under this plugin's name, and its reports as queued
// messages. A Runtime that does not name it hears nothing of it.
const LEAD_FEATURE = "lead-tools";
const LEAD_RATE_LIMIT_FEATURE = "lead-rate-limit-pause";
const RATE_LIMIT_RETRY_MS = 5 * 60_000;
const QUOTA_RESUME_NOTIFICATIONS = new Set([
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
]);
const TERMINAL_SUBAGENTS_FEATURE = "terminal-subagents";
const MAX_TERMINAL_SUBAGENTS = 16;
const TERMINAL_WORKER_ACTIVITY_FEATURE = "terminal-worker-activity";
const TERMINAL_HANDOVER_FEATURE = "terminal-handover";
const MAX_WORKER_COMMANDS = 64;
const WORKER_STREAM_SNAPSHOT_MS = 15_000;
const SUBAGENT_STATES = new Map([
  ["pending", "starting"],
  ["running", "running"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["killed", "stopped"],
]);
const FINISHED_SUBAGENTS = new Set(["completed", "failed", "killed"]);
// The engine takes one unmatched hook per event, so each tool AgentKib may give is served by a
// hook of its own; a tool of another name is not registered.
const LEAD_TOOL_PREFIX = "mcp__agentkib-bridge__";
// How long a turn's end waits to reach AgentKib before the hook returns (deliverNow).
const DELIVER_NOW_MS = 1_000;
// Prompts no one typed (prompt.submit's origin, as the engine stamps it): background work's
// notices, schedules, other sessions and plugins. Their turns count toward a Project Agent's
// turns without the person; a prompt of a kind not listed is taken as the person's.
const UNATTENDED_ORIGINS = new Set([
  "task-notification",
  "scheduled-trigger",
  "peer",
  "peer-send-message",
  "projects-relay",
  "channel",
  "coordinator",
  "observer",
  "observer-activity",
  "auto-continuation",
  "plugin",
]);
const LEAD_TOOLS = [
  "worker_list",
  "worker_open",
  "worker_send",
  "worker_read",
  "worker_stop",
  "worker_approve",
  "worker_answer",
  // 0.5.1: AgentKib lists it last, after the ones 0.5.0 knows.
  "worker_close",
  "worker_restart",
];
// $.tool.register is verified on 2.1.301 (the oldest CLI that connects) and 2.1.323.
function utf8Prefix(value, budget) {
  let read = 0;
  let written = 0;
  // The pinned Mods runtime only promises TextEncoder.encode, not encodeInto.
  // Count a bounded prefix directly without allocating an encoder per character.
  while (read < value.length) {
    const unit = value.charCodeAt(read);
    let units = 1;
    let width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(read + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        units = 2;
        width = 4;
      }
    }
    if (written + width > budget) break;
    read += units;
    written += width;
  }
  return { read, written };
}

export function previewText(value, budget = 16 * 1024) {
  if (typeof value !== "string") return "";
  // Every UTF-16 code unit costs at most three UTF-8 bytes. Small chunks need
  // neither an allocation nor an encoding pass just to prove they fit.
  if (value.length * 3 <= budget || utf8Prefix(value, budget).read === value.length) return value;
  // The marker is ASCII; the prefix count never splits a surrogate pair.
  // Slice the original text so even an unpaired surrogate is passed unchanged.
  const marker = PREVIEW_MARKER.slice(0, Math.max(0, budget));
  const { read } = utf8Prefix(value, Math.max(0, budget - marker.length));
  return value.slice(0, read) + marker;
}

function appendStreamText(state, text) {
  if (state.streamTruncated) return;
  const last = state.streamText.charCodeAt(state.streamText.length - 1);
  const first = text.charCodeAt(0);
  // Two lone-surrogate encodings cost six bytes; their joined pair costs four.
  const joined = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  const repair = joined ? 2 : 0;
  const { read, written } = utf8Prefix(text, MAX_STREAM - state.streamBytes + repair);
  if (read === text.length) {
    state.streamText += text;
    state.streamBytes += written - repair;
  } else {
    state.streamText = previewText(state.streamText + text, MAX_STREAM);
    state.streamTruncated = true;
  }
}

/**
 * Whether an AgentKib Runtime answers on this socket. Any reply counts; a missing socket, or one
 * a closed Runtime left behind, refuses the connection. The probe it saves reads the session's
 * whole history and rewrites the plugin store, which used to happen every few seconds for as
 * long as AgentKib stayed closed. It never goes through `request`, which would take the
 * Runtime's refusal of this request as a revoked binding.
 */
export async function runtimeReachable($, socketPath) {
  if (!safeSocket(socketPath)) return false;
  try {
    await $.http.fetch("http://localhost/v1/ping", { socketPath, method: "GET" });
    return true;
  } catch {
    return false;
  }
}

export function safeSocket(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..") &&
    new TextEncoder().encode(path).length <= 100
  );
}

export function decodeTicket(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(text))
    throw new Error("invalid-ticket");
  const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    value?.protocol !== 1 ||
    typeof value.ticket !== "string" ||
    !/^[A-Za-z0-9_-]{24,256}$/.test(value.ticket) ||
    !safeSocket(value.socketPath)
  )
    throw new Error("invalid-ticket");
  return { protocol: 1, socketPath: value.socketPath, ticket: value.ticket };
}

export function validSend(command) {
  return (
    typeof command?.text === "string" &&
    command.text.trim().length > 0 &&
    !command.text.trimStart().startsWith("/") &&
    [...command.text].length <= 16_000 &&
    new TextEncoder().encode(command.text).length <= 16_384 &&
    typeof command.requestId === "string" &&
    command.requestId.length > 0 &&
    command.requestId.length <= 256
  );
}

function boundedJson(value) {
  try {
    return previewText(JSON.stringify(value ?? {}));
  } catch {
    return "[unavailable]";
  }
}

export function visibleMessages(rows) {
  if (!Array.isArray(rows)) throw new Error("invalid-native-history");
  return rows
    .filter(
      (row) => (row?.role === "user" || row?.role === "assistant") && typeof row.text === "string",
    )
    .slice(-80)
    .map((row) => ({ role: row.role, text: previewText(row.text, 8 * 1024) }));
}

export function visibleTools(rows) {
  if (!Array.isArray(rows)) throw new Error("invalid-native-history");
  return rows
    .flatMap((row) => (Array.isArray(row?.toolUses) ? row.toolUses : []))
    .filter((tool) => typeof tool?.tool_use_id === "string" && typeof tool.tool === "string")
    .slice(-100)
    .map((tool) => ({
      id: tool.tool_use_id,
      name: tool.tool,
      input: boundedJson(tool.input),
      ...(typeof tool.text === "string" ? { output: previewText(tool.text) } : {}),
      status: tool.isError
        ? "failed"
        : tool.result !== undefined || typeof tool.text === "string"
          ? "completed"
          : "running",
    }));
}

export function initialState() {
  return {
    identity: null,
    instanceId: crypto.randomUUID(),
    connection: null,
    terminalSubagents: null,
    connectionFailure: null,
    connectionStatusReason: null,
    socketPath: null,
    credentialPath: null,
    revision: 0,
    seq: 0,
    events: [],
    completions: new Map(),
    generation: 0,
    results: new Map(),
    unacknowledgedResults: new Map(),
    afterCommandId: null,
    currentTurnId: null,
    currentTurnStartedAt: null,
    streamText: "",
    streamBytes: 0,
    streamTruncated: false,
    nativeWorking: null,
    compacting: false,
    activeTools: new Map(),
    workerToolCoverage: false,
    workerActivityRevision: 0,
    workerActivitySnapshottedAt: 0,
    waits: new Map(),
    // A reload can happen mid-turn. Only native activity events establish idle.
    activityVerified: false,
    bufferPaused: false,
    overflowEpoch: 0,
    snapshotRecovery: null,
    sendDisabled: false,
    pendingSend: null,
    // The last ambiguous report may still open its native turn after submit returns.
    unconfirmedReport: null,
    handoverExit: null,
    handoverSupported: undefined,
    modelPicker: null,
    modelPickerSupported: undefined,
    outbox: [],
    dispatching: null,
    dirty: true,
    bridgeStarted: false,
    pumping: false,
    flushing: false,
    closed: false,
    needsReconnect: false,
    pairingGeneration: null,
    pairingRecoveryGeneration: null,
    reconnectGeneration: null,
    reconnectFailures: 0,
    reconnectDelayTicks: 0,
    lastSnapshot: null,
    termination: null,
    terminating: false,
    autoConnecting: false,
    autoDelayTicks: 0,
    autoTries: new Map(),
    autoDone: new Set(),
    // The worker tools registered last; why registering them failed on this connection.
    leadToolsKey: null,
    leadUnavailable: null,
    // Whether the session leads now, and why its delegation is paused (undefined: not heard yet).
    leadActive: false,
    leadPaused: undefined,
    leadBindingId: null,
    leadRateLimit: null,
    leadRateLimitFallbackUsed: false,
    leadRateLimitReported: null,
    leadFailedTurnId: null,
    lastCompletedMainTurnId: null,
    // Reports put in the outbox, said to the Runtime on the next poll that succeeds.
    takenReports: new Set(),
    // The texts of the last prompts no one typed, until their turn starts.
    unattended: [],
  };
}

/** Runs a Project Agent's worker tool call in AgentKib and answers it as the tool. */
async function leadCall($, state, name, e) {
  if (state.handoverExit) return { deny: "AgentKib is transferring this session." };
  if (!leadFeature(state) || !state.connection || state.connection.leaseId === "reconnecting")
    return { deny: "AgentKib is not connected, so this session cannot direct its workers now." };
  const {
    tool: _tool,
    tool_use_id: _id,
    consent: _consent,
    agentId: _agent,
    requestMeta: _meta,
    ...input
  } = e;
  try {
    const answer = await request($, state, "/v1/lead-call", { ...lease(state), name, input });
    if (typeof answer?.text !== "string") return { deny: "AgentKib gave no answer." };
    return answer.isError ? { deny: answer.text } : { result: answer.text };
  } catch (error) {
    return { deny: `AgentKib could not run ${name} (${error?.message ?? "failed"}).` };
  }
}

/** Whether the Runtime takes a Project Agent on this connection (`features` of its reply). */
function leadOffered(state) {
  return (
    Array.isArray(state.connection?.features) && state.connection.features.includes(LEAD_FEATURE)
  );
}

/** Whether this session can be a Project Agent now: offered, and its tools could be added. */
function leadFeature(state) {
  return leadOffered(state) && !state.leadUnavailable;
}

function currentLead(state) {
  return (
    state.leadActive &&
    leadFeature(state) &&
    !state.closed &&
    !state.needsReconnect &&
    state.connection?.leaseId !== "reconnecting" &&
    state.connection?.bindingId === state.leadBindingId
  );
}

function resumeLeadReports(state) {
  if (state.leadRateLimit) {
    state.leadRateLimit = null;
    state.dirty = true;
  }
  state.leadRateLimitFallbackUsed = false;
}

function resetLeadRateLimit(state) {
  resumeLeadReports(state);
  state.leadRateLimitReported = null;
  state.leadFailedTurnId = null;
}

function leadReportsPaused(state) {
  const limit = state.leadRateLimit;
  if (!limit) return false;
  if (limit.until === null || Date.now() < limit.until) return true;
  state.leadRateLimit = null;
  if (!limit.resetKnown) state.leadRateLimitFallbackUsed = true;
  state.dirty = true;
  return false;
}

async function readLeadRateLimitReset($, state, limit) {
  try {
    const usage = await $.session.usage();
    if (state.leadRateLimit !== limit || !Array.isArray(usage?.rateLimits)) return;
    const now = Date.now();
    let latestReset = now;
    for (const window of usage.rateLimits) {
      if (
        !Number.isFinite(window?.percentUsed) ||
        window.percentUsed < 100 ||
        typeof window.resetsAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          window.resetsAt,
        )
      )
        continue;
      const reset = Date.parse(window.resetsAt);
      if (reset > latestReset) latestReset = reset;
    }
    if (latestReset > now) {
      limit.resetKnown = true;
      // Leave Claude Code time to run its own quota-resume prompt first.
      limit.until = latestReset + 30_000 + Math.floor(Math.random() * 60_001);
    }
  } catch {
    // A missing rate-limit window still permits one bounded retry.
  }
}

function pauseLeadReports($, state, turnId) {
  leadReportsPaused(state);
  if (state.leadRateLimit?.turnId === turnId) return;
  const limit = {
    turnId,
    until: state.leadRateLimitFallbackUsed ? null : Date.now() + RATE_LIMIT_RETRY_MS,
    resetKnown: false,
  };
  state.leadRateLimit = limit;
  state.dirty = true;
  if (limit.until !== null) void readLeadRateLimitReset($, state, limit);
}

function mainClassicEvent(state, event) {
  return (
    !state.closed &&
    event.agent_id === undefined &&
    event.agentId === undefined &&
    typeof event.session_id === "string" &&
    event.session_id === state.identity?.nativeId
  );
}

function validLeadTool(tool) {
  return (
    tool &&
    typeof tool === "object" &&
    LEAD_TOOLS.includes(tool.name) &&
    typeof tool.description === "string" &&
    tool.description.length > 0 &&
    tool.description.length <= 8192 &&
    tool.inputSchema &&
    typeof tool.inputSchema === "object" &&
    !Array.isArray(tool.inputSchema)
  );
}

/**
 * What the Runtime says of this Project Agent on a poll: its worker tools, registered again only
 * when they change (the engine cannot withdraw one, so a session that stops leading keeps the
 * names and AgentKib refuses their calls), and reports, each queued as a message of its own.
 */
async function applyLead($, state, lead, connection) {
  if (!lead || typeof lead !== "object") {
    state.leadActive = false;
    state.leadPaused = undefined;
    state.leadBindingId = null;
    resumeLeadReports(state);
    return;
  }
  const tools = (Array.isArray(lead.tools) ? lead.tools : [])
    .slice(0, LEAD_TOOLS.length)
    .filter(validLeadTool);
  const key = JSON.stringify(tools);
  if (key !== state.leadToolsKey) {
    try {
      for (const tool of tools)
        await $.tool.register({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          isDeferred: false,
        });
      if (state.connection !== connection) return;
      state.leadToolsKey = key;
    } catch (error) {
      if (state.connection !== connection) return;
      // The next poll tells the Runtime, which then takes no Project Agent here.
      state.leadUnavailable = String(error?.message ?? error).slice(0, 200);
      await note(
        $,
        `AgentKib could not add the Project Agent's worker tools to this session: ${state.leadUnavailable}`,
      );
      return;
    }
  }
  state.leadActive = tools.length > 0;
  state.leadBindingId = state.leadActive ? connection.bindingId : null;
  if (!state.leadActive) resumeLeadReports(state);
  // The person in the terminal hears when delegation pauses and how it goes on, once a change.
  const paused = typeof lead.paused === "string" ? lead.paused.slice(0, 64) : null;
  if (paused !== (state.leadPaused ?? null) && (paused || state.leadPaused !== undefined))
    await note($, leadPauseNote(paused));
  if (state.connection !== connection) return;
  state.leadPaused = paused;
  if (leadReportsPaused(state)) return;
  for (const report of Array.isArray(lead.reports) ? lead.reports : []) {
    if (
      typeof report?.id !== "string" ||
      state.takenReports.has(report.id) ||
      state.outbox.some((item) => item.id === report.id)
    )
      continue;
    if (!validSend({ text: report.text, requestId: report.id })) {
      state.takenReports.add(report.id);
      continue;
    }
    if (!writable(state)) break;
    if (state.outbox.length >= MAX_OUTBOX) {
      // Keep an old uncertain report visible until its space is needed by a new report.
      const old = state.outbox.find(
        (item) =>
          item.leadReport && item.status === "unknown" && item !== state.unconfirmedReport?.report,
      );
      if (!old) break;
      state.outbox = state.outbox.filter((item) => item !== old);
    }
    state.outbox.push({
      ...outboxItem({ commandId: report.id, text: report.text }, "queue", null),
      leadReport: true,
    });
    state.takenReports.add(report.id);
    state.dirty = true;
  }
}

const LEAD_PAUSES = {
  "auto-turn-limit":
    "AgentKib paused this Project Agent's delegation: its automatic turns reached the limit. Type a message here to continue.",
  "restart-confirmation-required":
    "AgentKib paused this Project Agent's delegation after it restarted. Type a message here to continue.",
  "report-undelivered":
    "AgentKib paused this Project Agent's delegation: it could not confirm a report reached this session. Resume it in AgentKib.",
  "authorization-changed":
    "AgentKib paused this Project Agent's delegation: the device that set it up no longer has the access it needs. Resume it in AgentKib.",
  "usage-limit":
    "AgentKib is holding Project Agent reports while Claude Code waits after a rate limit.",
};

function leadPauseNote(reason) {
  if (!reason) return "AgentKib resumed this Project Agent's delegation.";
  return (
    LEAD_PAUSES[reason] ?? "AgentKib paused this Project Agent's delegation. Resume it in AgentKib."
  );
}

/**
 * Whether a permission check of a worker tool may answer allow. Being made a Project Agent in
 * AgentKib is the person's permission for them, as for a session AgentKib runs; so only the
 * engine's default ask turns into allow, and a rule, hook, setting, another plugin or the
 * organization's ceiling still decides. AgentKib checks the Project Agent's scope on every call.
 */
function leadToolAllowed(state, e, verdict) {
  return (
    state.leadActive &&
    leadFeature(state) &&
    typeof e.tool === "string" &&
    e.tool.startsWith(LEAD_TOOL_PREFIX) &&
    LEAD_TOOLS.includes(e.tool.slice(LEAD_TOOL_PREFIX.length)) &&
    verdict?.decision === "ask" &&
    verdict.rule === undefined &&
    verdict.hook === undefined &&
    verdict.setting === undefined &&
    verdict.plugin === undefined &&
    (e.ceiling === undefined || e.ceiling === "allow")
  );
}

function lease(state) {
  if (!state.identity || !state.connection) throw new Error("not-connected");
  return {
    bindingId: state.connection.bindingId,
    leaseId: state.connection.leaseId,
    nativeId: state.identity.nativeId,
    cwd: state.identity.cwd,
    instanceId: state.instanceId,
  };
}

function compatibilityFailure(reason, cliVersion, missingCapabilities) {
  const error = new Error(reason);
  if (claudeBridgeCompatibility(cliVersion) !== "invalid") error.cliVersion = cliVersion;
  if (missingCapabilities) error.missingCapabilities = missingCapabilities;
  return error;
}

function requireGeneration(state, generation, reason) {
  if (state.generation !== generation) throw new Error(reason);
}

async function readSessionDirectories($) {
  const current = await $.session.cwd();
  // Claude changes cwd after shell commands, and changes root only when the
  // session itself moves (for example, native EnterWorktree).
  const workspace = await $.session.root();
  return { current, workspace };
}

async function isInsideSessionWorkspace($, current, workspace) {
  if (!safeAbsolute(current) || !safeAbsolute(workspace)) return false;
  if (current === workspace) return true;
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  if (!current.startsWith(prefix)) return false;
  // The Mod API exposes symlink metadata, but has no realpath operation.
  let path = prefix;
  for (const part of current.slice(prefix.length).split("/")) {
    if (!part || part === ".") return false;
    path += part;
    try {
      const entry = await $.fs.stat(path);
      if (entry?.kind !== "dir" || entry.isLink !== false) return false;
    } catch {
      return false;
    }
    path += "/";
  }
  return true;
}

async function identity($, state) {
  const generation = state.generation;
  let version;
  try {
    version = await $.session.version();
  } catch {
    requireGeneration(state, generation, "stale-native-identity");
    throw compatibilityFailure("bridge-capabilities-missing", undefined, ["session-identity"]);
  }
  requireGeneration(state, generation, "stale-native-identity");
  const compatibility = claudeBridgeCompatibility(version?.version);
  if (compatibility === "invalid") throw compatibilityFailure("bridge-cli-unsupported");
  if (compatibility === "too-old")
    throw compatibilityFailure("bridge-cli-too-old", version.version);
  let nativeId;
  let directories;
  try {
    nativeId = await $.session.id();
    requireGeneration(state, generation, "stale-native-identity");
    directories = await readSessionDirectories($);
  } catch {
    requireGeneration(state, generation, "stale-native-identity");
    throw compatibilityFailure("bridge-capabilities-missing", version.version, [
      "session-identity",
    ]);
  }
  // A completed host read can belong to the session that just ended. It must
  // not overwrite or invalidate an identity explicitly paired in a later generation.
  requireGeneration(state, generation, "stale-native-identity");
  const { current, workspace: cwd } = directories;
  if (
    typeof nativeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ||
    !safeAbsolute(cwd)
  )
    throw new Error("unsupported-native-identity");
  if (state.identity && (state.identity.nativeId !== nativeId || state.identity.cwd !== cwd)) {
    invalidate(state, "native-identity-changed");
    void flush($, state);
    throw new Error("native-identity-changed");
  }
  const insideWorkspace = await isInsideSessionWorkspace($, current, cwd);
  requireGeneration(state, generation, "stale-native-identity");
  if (!insideWorkspace) {
    if (state.connection) state.needsReconnect = true;
    throw new Error("native-working-directory-outside-workspace");
  }
  state.identity = {
    protocol: 1,
    nativeId,
    cwd,
    cliVersion: version.version,
    instanceId: state.instanceId,
    pluginVersion: PLUGIN_VERSION,
    nativeCapabilities: state.identity?.nativeCapabilities ?? {
      version: CLAUDE_BRIDGE_COMPATIBILITY.capabilityVersion,
      available: [],
    },
  };
  return state.identity;
}

/** Probe only on pair/reconnect. Never submit a prompt, abort a turn or read user configuration. */
export async function probeCapabilities($, state) {
  const generation = state.generation;
  const observed = await identity($, state);
  requireGeneration(state, generation, "stale-capability-probe");
  const missing = [];
  try {
    const rows = await $.session.messages();
    requireGeneration(state, generation, "stale-capability-probe");
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          typeof row.role !== "string" ||
          ((row.role === "user" || row.role === "assistant") && typeof row.text !== "string") ||
          (row.toolUses !== undefined && !Array.isArray(row.toolUses)),
      )
    )
      throw new Error("invalid-native-history");
    if (
      visibleTools(rows).some(
        (tool) =>
          tool.id.length === 0 ||
          tool.id.length > 256 ||
          tool.name.length === 0 ||
          tool.name.length > 256,
      )
    )
      throw new Error("invalid-native-history");
  } catch (error) {
    requireGeneration(state, generation, "stale-capability-probe");
    // session.start can run before the native REPL binds its session. This is
    // a readiness failure, not evidence that this CLI lacks the history API.
    if (
      typeof error?.message === "string" &&
      error.message.includes(
        "$.session.messages is not available in this mode: no session is bound in this process",
      )
    )
      throw new Error("native-session-not-ready");
    missing.push("session-messages");
  }
  try {
    const usage = await $.session.usage();
    requireGeneration(state, generation, "stale-capability-probe");
    if (usage !== null && (typeof usage !== "object" || Array.isArray(usage)))
      throw new Error("invalid-native-usage");
    const context = usage?.context;
    if (context !== undefined && context !== null) {
      if (typeof context !== "object" || Array.isArray(context))
        throw new Error("invalid-native-usage");
      for (const key of ["tokens", "window", "percent"]) {
        const value = context[key];
        if (
          value !== undefined &&
          value !== null &&
          (typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            (key === "percent" ? value > 100 : !Number.isSafeInteger(value)))
        )
          throw new Error("invalid-native-usage");
      }
    }
  } catch {
    requireGeneration(state, generation, "stale-capability-probe");
    missing.push("session-usage");
  }
  try {
    // A constant probe value avoids races between sessions sharing this store.
    // This separate key never overwrites a saved credential path.
    const value = `agentkib-bridge:${PLUGIN_VERSION}:capabilities:1`;
    await $.store.set("compatibility:credential-store:1", value);
    requireGeneration(state, generation, "stale-capability-probe");
    const stored = await $.store.get("compatibility:credential-store:1");
    requireGeneration(state, generation, "stale-capability-probe");
    if (stored !== value) throw new Error("invalid-native-store");
  } catch {
    requireGeneration(state, generation, "stale-capability-probe");
    missing.push("credential-store");
  }
  try {
    const root = $.plugin.root;
    if (
      typeof root !== "string" ||
      !root.startsWith("/") ||
      root.includes("\0") ||
      root.split("/").includes("..")
    )
      throw new Error("invalid-plugin-root");
    const manifest = JSON.parse(await $.fs.read(`${root}/package.json`));
    requireGeneration(state, generation, "stale-capability-probe");
    // AgentKib may update these files under a running terminal; the Runtime takes this plugin
    // all the same, so this only probes that a file can be read, not which release is on disk.
    if (typeof manifest?.version !== "string") throw new Error("invalid-plugin-manifest");
  } catch {
    requireGeneration(state, generation, "stale-capability-probe");
    missing.push("credential-read");
  }
  if (missing.length)
    throw compatibilityFailure("bridge-capabilities-missing", observed.cliVersion, missing);
  if (
    state.generation !== generation ||
    state.identity?.nativeId !== observed.nativeId ||
    state.identity?.cwd !== observed.cwd ||
    state.identity?.cliVersion !== observed.cliVersion
  )
    throw new Error("stale-capability-probe");
  const report = {
    version: CLAUDE_BRIDGE_COMPATIBILITY.capabilityVersion,
    available: [...CLAUDE_BRIDGE_REQUIRED_CAPABILITIES],
  };
  // Another identity read can replace the object while these calls await.
  // Publish the successful probe to the matching current identity too, so its
  // first snapshot cannot lose the report accepted in the pairing handshake.
  observed.nativeCapabilities = report;
  state.identity.nativeCapabilities = report;
  return observed;
}

function record(state, event) {
  if (state.closed || (!state.connection && !state.credentialPath)) return;
  if (event.type === "turn-complete") {
    if (state.completions.size >= MAX_EVENTS && !state.completions.has(event.turnId)) {
      invalidate(state, "completion-capacity-reached");
      return;
    }
    state.completions.set(event.turnId, event);
  }
  if (state.bufferPaused && event.type !== "snapshot") {
    // A lost start cannot be followed by deltas against the host's old turn.
    // Snapshots reconstruct previews; only terminal evidence bypasses the pause.
    state.overflowEpoch += 1;
    state.dirty = true;
    return;
  }
  if (state.events.length >= MAX_EVENTS) {
    markGap(state);
    return;
  }
  const seq = ++state.seq;
  state.events.push({ seq, event });
  return seq;
}

function markGap(state) {
  // Replace unacknowledged previews, retaining terminal evidence separately.
  // New sequence numbers keep an older in-flight ACK from deleting this fence.
  state.events = [{ seq: ++state.seq, event: { type: "gap", revision: state.revision } }];
  state.bufferPaused = true;
  state.overflowEpoch += 1;
  state.snapshotRecovery = null;
  state.dirty = true;
}

function waitingState(state) {
  const waits = [...state.waits.values()];
  if (waits.includes("question")) return "question";
  if (waits.includes("permission")) return "permission";
  return waits.includes("unknown") ? "unknown" : null;
}

function workerActivitySnapshot(state) {
  if (
    !state.connection?.features?.includes(TERMINAL_WORKER_ACTIVITY_FEATURE) ||
    !state.currentTurnId ||
    !state.workerToolCoverage ||
    state.activeTools.size > MAX_WORKER_COMMANDS
  )
    return undefined;
  return {
    revision: state.workerActivityRevision,
    commands: [...state.activeTools.values()].map(({ command }) => command),
  };
}

function sameNativeValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return (
    Array.isArray(left) === Array.isArray(right) &&
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameNativeValue(left[key], right[key]))
  );
}

function permissionTool(state, event) {
  if (!event.tool_input || typeof event.tool_input !== "object") return null;
  // PermissionRequest has no native tool-use ID. Associate only an unambiguous
  // matching call; rewritten or duplicate inputs remain explicitly unverified.
  const matches = [...state.activeTools.values()].filter(
    (tool) =>
      tool.name === event.tool_name &&
      Object.keys(event.tool_input).every(
        (key) =>
          Object.hasOwn(tool.input, key) && sameNativeValue(event.tool_input[key], tool.input[key]),
      ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function invalidate(state, reason) {
  state.generation += 1;
  state.sendDisabled = true;
  // A revoked or ended connection sends nothing more. A prompt already waiting
  // in the native submit is dropped at dispatch, because the state is closed.
  state.outbox = [];
  state.unconfirmedReport = null;
  state.handoverExit = null;
  state.handoverSupported = undefined;
  state.activityVerified = false;
  state.nativeWorking = null;
  state.compacting = false;
  state.compactStartedAt = undefined;
  state.currentTurnId = null;
  state.modelPicker = null;
  state.streamText = "";
  state.streamBytes = 0;
  state.streamTruncated = false;
  state.activeTools.clear();
  state.workerToolCoverage = false;
  state.waits.clear();
  state.terminalSubagents = null;
  state.revision += 1;
  if (state.connection && state.identity && state.lastSnapshot) {
    const revoked = {
      ...state.lastSnapshot,
      revision: state.revision,
      status: "disconnected",
      streamText: "",
      currentTurnId: null,
      waiting: null,
      messages: [],
      toolItems: [],
      ...(state.lastSnapshot.terminalSubagents !== undefined ? { terminalSubagents: [] } : {}),
      usage: null,
      outbox: [],
      capabilities: {
        read: false,
        send: false,
        steer: false,
        queue: false,
        stop: false,
        approve: false,
        answer: false,
      },
    };
    delete revoked.terminalWorkerActivity;
    state.termination = {
      socketPath: state.socketPath,
      token: state.connection.token,
      body: {
        ...lease(state),
        events: [
          { seq: ++state.seq, event: { type: "snapshot", snapshot: revoked } },
          { seq: ++state.seq, event: { type: "invalidated", reason, revision: state.revision } },
        ],
      },
    };
  }
  state.closed = true;
  state.connection = null;
  state.leadBindingId = null;
  state.lastCompletedMainTurnId = null;
  resetLeadRateLimit(state);
  state.connectionFailure = null;
  state.connectionStatusReason = null;
  state.needsReconnect = false;
  state.pairingGeneration = null;
  state.pairingRecoveryGeneration = null;
  state.reconnectGeneration = null;
  state.reconnectFailures = 0;
  state.reconnectDelayTicks = 0;
}

async function request($, state, path, body, authenticated = true) {
  if (!safeSocket(state.socketPath)) throw new Error("invalid-socket");
  const generation = state.generation;
  const connection = state.connection;
  let response;
  try {
    response = await $.http.fetch(`http://localhost${path}`, {
      socketPath: state.socketPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: `Bearer ${state.connection?.token ?? ""}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    if (state.generation === generation && state.connection === connection && !state.closed)
      state.needsReconnect = true;
    throw new Error("bridge-unavailable");
  }
  if (state.generation !== generation || (authenticated && state.connection !== connection))
    throw new Error("stale-bridge-response");
  const decoded = typeof response?.text === "string" ? JSON.parse(response.text) : null;
  if (
    (response?.status === 409 && decoded?.error === "bridge-lease-expired") ||
    (response?.status === 410 && decoded?.error === "bridge-source-unavailable")
  ) {
    // Older hosts reported unavailable sources with the same status as explicit revocation.
    state.needsReconnect = true;
    throw new Error("bridge-lease-expired");
  }
  if ([401, 403, 410].includes(response?.status)) {
    invalidate(state, "binding-revoked");
    if (authenticated && response.status === 410 && decoded?.error === "bridge-binding-revoked")
      state.connectionStatusReason = "session-disconnected";
    throw new Error("binding-revoked");
  }
  if (!response?.ok || typeof response.text !== "string")
    throw compatibilityFailure(
      [
        "invalid-bridge-challenge",
        "expired-bridge-challenge",
        "bridge-version-mismatch",
        "bridge-cli-too-old",
        "bridge-cli-unsupported",
        "bridge-capabilities-missing",
        "bridge-plugin-update-required",
        "bridge-identity-mismatch",
        "control-outcome-unconfirmed",
        "claude-bridge-binding-limit",
        "unsupported-native-identity",
        "native-identity-changed",
      ].includes(decoded?.error)
        ? decoded.error
        : "bridge-unavailable",
      state.identity?.cliVersion,
    );
  return decoded;
}

function connectionFrom(value) {
  if (
    value?.protocol !== 1 ||
    ![value.bindingId, value.token, value.leaseId].every(
      (v) => typeof v === "string" && v.length >= 16 && v.length <= 512,
    ) ||
    typeof value.credentialPath !== "string" ||
    !value.credentialPath.startsWith("/") ||
    value.credentialPath.includes("\0") ||
    value.credentialPath.split("/").includes("..")
  )
    throw new Error("invalid-bridge-connection");
  return value;
}

function publishTerminalSubagents(state, observation, rows) {
  if (JSON.stringify(rows) !== JSON.stringify(observation.rows)) {
    observation.rows = rows;
    state.dirty = true;
  }
}

async function refreshTerminalSubagents($, state) {
  const connection = state.connection;
  const nativeId = state.identity?.nativeId;
  if (
    !connection?.features?.includes(TERMINAL_SUBAGENTS_FEATURE) ||
    !nativeId ||
    state.needsReconnect
  )
    return;
  if (state.terminalSubagents?.connection !== connection)
    state.terminalSubagents = {
      connection,
      nativeId,
      ids: new Map(),
      rows: undefined,
      pending: null,
    };
  const observation = state.terminalSubagents;
  if (observation.pending) {
    // A stuck optional host read must neither block bridge snapshots nor keep old data live.
    observation.pending.expired = true;
    publishTerminalSubagents(state, observation, undefined);
    return;
  }
  const read = { expired: false };
  observation.pending = read;
  const current = () =>
    !read.expired &&
    state.terminalSubagents === observation &&
    state.connection === connection &&
    !state.needsReconnect;
  try {
    const before = await $.session.id();
    if (!current()) return;
    const agents = before === nativeId ? await $.agent.list() : undefined;
    if (!current()) return;
    const sameSession = Array.isArray(agents) && (await $.session.id()) === nativeId;
    if (!current()) return;
    if (!sameSession) {
      publishTerminalSubagents(state, observation, undefined);
      return;
    }
    const byId = new Map();
    const nativeIds = [];
    for (const agent of agents) {
      if (typeof agent?.id !== "string" || agent.id.length === 0 || agent.id.length > 256) continue;
      nativeIds.push(agent.id);
      if (agent.teammateId == null && agent.kind !== "in_process_teammate")
        byId.set(agent.id, agent);
    }
    const selected = [...byId.values()]
      .sort(
        (a, b) =>
          Number(FINISHED_SUBAGENTS.has(a.status)) - Number(FINISHED_SUBAGENTS.has(b.status)),
      )
      .slice(0, MAX_TERMINAL_SUBAGENTS);
    const ids = new Map();
    const rows = selected.map((agent) => {
      const id = observation.ids.get(agent.id) ?? crypto.randomUUID();
      ids.set(agent.id, id);
      const title = safeTerminalSubagentTitle(agent.description);
      return {
        id,
        title: nativeIds.some((nativeAgentId) => title.includes(nativeAgentId)) ? "" : title,
        status: SUBAGENT_STATES.get(agent.status) ?? "unknown",
      };
    });
    observation.ids = ids;
    publishTerminalSubagents(state, observation, rows);
  } catch {
    // The getter is optional and its errors may carry native details.
    if (current()) publishTerminalSubagents(state, observation, undefined);
  } finally {
    observation.pending = null;
  }
}

async function snapshot($, state) {
  const observed = await identity($, state);
  const rows = await $.session.messages();
  const usage = await $.session.usage();
  const context = state.compacting ? null : usage?.context;
  let model = null;
  try {
    const current = await $.session.model();
    if (typeof current === "string" && current.length > 0 && current.length <= 128) model = current;
  } catch {
    // This optional getter is absent in older native contracts.
  }
  const numeric = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const waiting = waitingState(state);
  const offersPicker = state.connection?.features?.includes("open-model-picker") === true;
  const offersHandover = state.connection?.features?.includes(TERMINAL_HANDOVER_FEATURE) === true;
  const observation = state.terminalSubagents;
  const terminalSubagents =
    observation?.connection === state.connection && observation?.nativeId === observed.nativeId
      ? observation.rows
      : undefined;
  if (offersPicker && state.modelPickerSupported === undefined)
    state.modelPickerSupported = await hasNativeModelPicker($);
  if (offersHandover && state.handoverSupported === undefined)
    state.handoverSupported = await hasNativeHandoverExit($);
  const terminalWorkerActivity = workerActivitySnapshot(state);
  if (terminalWorkerActivity !== undefined) state.workerActivitySnapshottedAt = Date.now();
  const result = {
    ...observed,
    revision: state.revision,
    currentTurnId: state.currentTurnId,
    status:
      waiting === "question" || waiting === "permission"
        ? "waiting"
        : state.currentTurnId || state.nativeWorking !== false || waiting === "unknown"
          ? "running"
          : "idle",
    waiting,
    messages: visibleMessages(rows),
    toolItems: state.currentTurnId ? visibleTools(rows) : [],
    ...(terminalSubagents !== undefined ? { terminalSubagents } : {}),
    ...(terminalWorkerActivity !== undefined ? { terminalWorkerActivity } : {}),
    streamText: state.streamText,
    model,
    ...(offersPicker ? { modelPickerOpen: state.modelPicker !== null } : {}),
    compacting: state.compacting,
    ...(state.compactStartedAt !== undefined ? { compactStartedAt: state.compactStartedAt } : {}),
    usage: context
      ? {
          tokens: numeric(context.tokens),
          window: numeric(context.window),
          percent: numeric(context.percent),
          observedAt: Date.now(),
        }
      : null,
    outbox: state.outbox.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: previewText(item.text, OUTBOX_PREVIEW),
      status: item.status,
      createdAt: item.createdAt,
    })),
    capabilities: {
      read: true,
      ...(offersPicker ? { modelPicker: canOpenModelPicker(state) } : {}),
      ...(offersHandover && state.handoverSupported && canHandoverExit(state)
        ? { handover: true }
        : {}),
      send:
        writable(state) &&
        state.activityVerified &&
        !state.currentTurnId &&
        !state.pendingSend &&
        !hasQueuedInput(state),
      steer: writable(state) && Boolean(state.currentTurnId) && state.outbox.length < MAX_OUTBOX,
      queue: writable(state) && state.outbox.length < MAX_OUTBOX,
      stop:
        !state.closed &&
        !state.needsReconnect &&
        !state.bufferPaused &&
        !state.handoverExit &&
        Boolean(state.currentTurnId),
      approve: false,
      answer: false,
    },
  };
  // JSON escaping counts too: a body of control characters must fit the same
  // transport budget as ordinary text. This is a preview, never the full log.
  while (new TextEncoder().encode(JSON.stringify(result)).length > 512 * 1024) {
    if (result.messages.length > 1) result.messages.shift();
    else if (result.toolItems.length) result.toolItems.shift();
    else {
      result.streamText = previewText(result.streamText, 8 * 1024);
      break;
    }
  }
  state.lastSnapshot = result;
  return result;
}

async function flush($, state) {
  if (state.termination && !state.terminating) {
    state.terminating = true;
    const ending = state.termination;
    // End the local lease immediately; this best-effort notification uses only
    // the old lease and does not read the newly selected native session.
    try {
      await $.http.fetch("http://localhost/v1/events", {
        socketPath: ending.socketPath,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ending.token}` },
        body: JSON.stringify(ending.body),
      });
    } catch {
      /* A closed socket is expected during application shutdown. */
    }
    state.termination = null;
    state.terminating = false;
    return;
  }
  if (
    !state.connection ||
    state.connection.leaseId === "reconnecting" ||
    state.needsReconnect ||
    state.reconnectGeneration === state.generation ||
    state.closed ||
    state.flushing
  )
    return;
  state.flushing = true;
  let done;
  state.flushDone = new Promise((resolve) => (done = resolve));
  try {
    // Terminal evidence survives delta overflow and reconnect until acknowledged.
    for (const event of state.completions.values()) {
      if (state.events.length >= MAX_EVENTS) break;
      if (!state.events.some((entry) => entry.event === event))
        state.events.push({ seq: ++state.seq, event });
    }
    // Text has its own deltas. Publish the opaque stream counter sparingly so thinking
    // or clipped text cannot cause a history snapshot on every bridge tick.
    const previousActivity = state.lastSnapshot?.terminalWorkerActivity;
    const publishStreamActivity =
      previousActivity !== undefined &&
      state.connection.features?.includes(TERMINAL_WORKER_ACTIVITY_FEATURE) &&
      previousActivity.revision !== state.workerActivityRevision &&
      Date.now() - state.workerActivitySnapshottedAt >= WORKER_STREAM_SNAPSHOT_MS;
    if ((state.dirty || publishStreamActivity) && state.events.length < MAX_EVENTS) {
      state.dirty = false;
      const epoch = state.overflowEpoch;
      const seq = record(state, { type: "snapshot", snapshot: await snapshot($, state) });
      if (seq !== undefined) state.snapshotRecovery = { seq, epoch };
    }
    const batch = [];
    for (const entry of state.events.slice(0, 32)) {
      if (new TextEncoder().encode(JSON.stringify([...batch, entry])).length > 900 * 1024) break;
      batch.push(entry);
    }
    if (!batch.length) return;
    const connection = state.connection;
    const response = await request($, state, "/v1/events", { ...lease(state), events: batch });
    if (state.connection !== connection) return;
    if (
      !Number.isSafeInteger(response?.ackSeq) ||
      response.ackSeq !== batch[batch.length - 1].seq
    ) {
      invalidate(state, "invalid-event-acknowledgement");
      return;
    }
    for (const entry of batch) {
      if (
        entry.event.type === "turn-complete" &&
        state.completions.get(entry.event.turnId) === entry.event
      )
        state.completions.delete(entry.event.turnId);
    }
    state.events = state.events.filter((entry) => entry.seq > response.ackSeq);
    if (
      state.bufferPaused &&
      state.snapshotRecovery &&
      state.snapshotRecovery.seq <= response.ackSeq &&
      state.snapshotRecovery.epoch === state.overflowEpoch
    ) {
      state.bufferPaused = false;
      state.dirty = true;
    }
  } catch {
    state.dirty = true;
  } finally {
    state.flushing = false;
    done();
  }
}

/**
 * Sends what is recorded now rather than on the next tick, for a turn's end: 2.1.301 applies a
 * changed hooks module as a turn ends, and what this module has not sent goes with it, the end
 * AgentKib needs to confirm a message it sent included. A flush already under way took its batch
 * before this event, so it is waited for first. Bounded: a slow AgentKib never holds a turn's end;
 * the next tick sends it then.
 */
async function deliverNow($, state) {
  const sent = (async () => {
    for (let round = 0; round < 2 && state.events.length; round++) {
      if (state.flushing) await state.flushDone;
      else await flush($, state);
    }
  })();
  await Promise.race([sent, $.clock.sleep(DELIVER_NOW_MS)]);
}

/** The lease is verified and may carry AgentKib's messages into this terminal. */
function writable(state) {
  return (
    !state.closed &&
    !state.needsReconnect &&
    !state.sendDisabled &&
    !state.bufferPaused &&
    !state.handoverExit &&
    !state.modelPicker &&
    !state.compacting
  );
}

function hasQueuedInput(state) {
  const reportsPaused = leadReportsPaused(state);
  return (
    state.unconfirmedReport !== null ||
    state.outbox.some((item) => !item.leadReport || (!reportsPaused && item.status !== "unknown"))
  );
}

async function hasNativeHandoverExit($) {
  try {
    const surfaces = await $.session.surfaces();
    if (!Array.isArray(surfaces) || !surfaces.includes("terminal")) return false;
    const exits = (await $.command.list()).filter((entry) => entry.name === "exit");
    return exits.length === 1 && exits[0].source === "builtin";
  } catch {
    return false;
  }
}

function canHandoverExit(state) {
  return (
    writable(state) &&
    state.activityVerified &&
    (state.currentTurnId !== null || (state.nativeWorking === false && !waitingState(state))) &&
    !state.pendingSend &&
    !state.dispatching &&
    !state.unconfirmedReport &&
    // The terminal owns its queued submissions and any reports it has claimed.
    // Leave them available for delivery rather than dropping them on exit.
    state.outbox.length === 0 &&
    state.takenReports.size === 0
  );
}

async function handoverExit($, state, command, result) {
  const connection = state.connection;
  const turnId = command.turnId ?? null;
  if (!connection?.features?.includes(TERMINAL_HANDOVER_FEATURE) || !canHandoverExit(state)) {
    result.reason = "session-state-unverified";
    return;
  }
  if (state.currentTurnId !== turnId) {
    result.reason = "turn-conflict";
    return;
  }
  if (!(await hasNativeHandoverExit($))) {
    state.handoverSupported = false;
    result.reason = "native-exit-unavailable";
    return;
  }
  await identity($, state);
  if (
    state.connection !== connection ||
    state.revision !== command.expectedRevision ||
    state.currentTurnId !== turnId ||
    !canHandoverExit(state)
  ) {
    result.reason = "session-state-unverified";
    return;
  }
  const handover = { competing: false };
  state.handoverExit = handover;
  state.dirty = true;
  const current = () =>
    state.handoverExit === handover &&
    state.connection === connection &&
    !state.needsReconnect &&
    !state.bufferPaused &&
    !handover.competing;
  const release = () => {
    if (state.handoverExit !== handover) return;
    state.handoverExit = null;
    state.dirty = true;
  };
  let nativeAttempted = false;
  try {
    if (turnId !== null) {
      nativeAttempted = true;
      await $.turn.abort({ turnId });
      // The native abort acknowledgement alone does not prove the turn ended.
      for (let attempt = 0; attempt < 100 && current() && state.currentTurnId === turnId; attempt++)
        await $.clock.sleep(50);
    }
    await identity($, state);
    if (!current() || state.currentTurnId !== null || state.nativeWorking !== false) {
      if (nativeAttempted) result.status = "unknown";
      result.reason = "native-stop-unconfirmed";
      return;
    }
    // A slash command is dispatched by the native command API; submitting the
    // same text through prompt.submit is refused by Claude Code.
    nativeAttempted = true;
    const exit = await $.command.run({ command: "exit" });
    if (exit?.isError === true) {
      result.status = "unknown";
      result.reason = "native-exit-refused";
      return;
    }
    result.status = "exit-initiated";
    delete result.reason;
    // An exit may be intercepted by another mod. Keep submissions fenced while
    // the observed process terminates, then recover if the terminal stayed open.
    $.clock.after(5_000, release);
  } catch {
    if (nativeAttempted) result.status = "unknown";
    result.reason = "native-exit-unconfirmed";
  } finally {
    if (result.status !== "exit-initiated") release();
  }
}

async function hasNativeModelPicker($) {
  try {
    // A command registered by a plugin under the same name cannot stand in for the built-in.
    const matches = (await $.command.list()).filter((entry) => entry.name === "model");
    return matches.length === 1 && matches[0].source === "builtin";
  } catch {
    return false;
  }
}

function canOpenModelPicker(state) {
  return (
    state.modelPickerSupported === true &&
    writable(state) &&
    state.activityVerified &&
    state.nativeWorking === false &&
    !state.currentTurnId &&
    !state.pendingSend &&
    !waitingState(state) &&
    state.outbox.length === 0
  );
}

async function openModelPicker($, state, command, result) {
  const connection = state.connection;
  if (!connection?.features?.includes("open-model-picker") || !canOpenModelPicker(state)) {
    result.reason = "session-not-idle";
    return;
  }
  if (!(await hasNativeModelPicker($))) {
    state.modelPickerSupported = false;
    result.reason = "native-model-picker-unavailable";
    return;
  }
  if (
    state.connection !== connection ||
    command.expectedRevision !== state.revision ||
    !canOpenModelPicker(state)
  ) {
    result.reason = "session-state-unverified";
    return;
  }
  const picker = command.commandId;
  const previousModel = state.lastSnapshot?.model;
  state.modelPicker = picker;
  state.dirty = true;
  try {
    // The native promise settles when the user dismisses the picker. Acknowledge dispatch;
    // the next native model observation, including after a cancellation, owns the setting.
    const native = $.command.run({ command: "model" });
    const dismissal = native
      .then(
        (response) => response?.isError !== true,
        () => false,
      )
      .then((ok) => {
        if (state.modelPicker !== picker) return ok;
        state.modelPicker = null;
        state.dirty = true;
        if (!ok) {
          state.modelPickerSupported = false;
          void note(
            $,
            "Claude Code could not open the model picker. Enter /model in this terminal.",
          );
        } else {
          // The selection can reach $.session.model() after the command's own result.
          for (const delay of [1_000, 3_000])
            $.clock.after(delay, () => {
              if (state.connection === connection && state.lastSnapshot?.model === previousModel)
                state.dirty = true;
            });
        }
        return ok;
      });
    // An immediately refused invocation gets a rejection, rather than a successful dispatch.
    if (await Promise.race([dismissal, $.clock.sleep(100).then(() => true)])) {
      result.status = "accepted";
      delete result.reason;
    } else result.reason = "native-model-picker-unavailable";
  } catch {
    state.modelPicker = null;
    state.dirty = true;
    result.reason = "native-model-picker-unavailable";
  }
}

/** Shows the person in the terminal what AgentKib sent; a lost notice changes no delivery. */
async function note($, text) {
  try {
    await $.ui.log(text);
  } catch {
    /* The message itself is already on its way. */
  }
}

function outboxItem(command, kind, turnId) {
  return {
    // The host lists and withdraws the message under the command that sent it.
    id: command.commandId,
    kind,
    text: command.text,
    // The turn a steer waits for; null once it waits for the next one.
    turnId,
    status: "pending",
    // The revision a refused dispatch was tried at; it is tried again once that changes.
    retryRevision: null,
    // A refused append waits for the end of its turn and goes out as the next prompt.
    appendRefused: false,
    createdAt: Date.now(),
  };
}

function toolRunning(state) {
  return [...state.activeTools.values()].some((tool) => tool.turnId === state.currentTurnId);
}

/** Appends a user row to the running turn; the model reads it with the tool's result. */
async function appendSteer($, state, item) {
  let appended;
  try {
    appended = await $.session.append({
      message: { type: "user", content: [{ type: "text", text: item.text }] },
    });
  } catch {
    return "unknown";
  }
  if (!appended || typeof appended !== "object" || "deny" in appended) return "refused";
  if (typeof appended.uuid !== "string") return "unknown";
  await note($, `AgentKib added to this turn: ${previewText(item.text, 512)}`);
  state.dirty = true;
  return "delivered";
}

/** Delivers the steers waiting for the running turn, at a tool call before the tool runs. */
async function deliverSteers($, state) {
  const turnId = state.currentTurnId;
  if (!turnId || !writable(state)) return;
  const ready = (item) =>
    item.kind === "steer" &&
    item.status === "pending" &&
    item.turnId === turnId &&
    !item.appendRefused;
  if (!state.outbox.some(ready)) return;
  try {
    await identity($, state);
  } catch {
    return;
  }
  if (state.currentTurnId !== turnId || !writable(state)) return;
  // Parallel tool calls run this concurrently: claim each row before appending.
  const claimed = state.outbox.filter(ready);
  for (const item of claimed) item.status = "dispatching";
  for (const item of claimed) {
    const outcome = await appendSteer($, state, item);
    if (outcome === "delivered") state.outbox = state.outbox.filter((entry) => entry !== item);
    else if (outcome === "refused") {
      item.status = "pending";
      item.appendRefused = true;
    } else {
      // The row may have been kept. Never send it again, and stop sending until re-paired.
      item.status = "unknown";
      state.sendDisabled = true;
    }
    state.dirty = true;
  }
}

async function steer($, state, command, result) {
  if (!validSend(command)) result.reason = "invalid-text";
  else if (!writable(state)) result.reason = "session-state-unverified";
  else if (!state.currentTurnId || command.turnId !== state.currentTurnId)
    result.reason = "turn-conflict";
  else if (state.outbox.length >= MAX_OUTBOX) result.reason = "outbox-full";
  else {
    const item = outboxItem(command, "steer", state.currentTurnId);
    if (toolRunning(state)) {
      // A tool is running: its result and this row reach the model together.
      const outcome = await appendSteer($, state, item);
      if (outcome === "refused") result.reason = "native-append-refused";
      else if (outcome === "unknown") {
        result.status = "unknown";
        result.reason = "native-append-result-unknown";
        state.sendDisabled = true;
        return;
      }
    } else {
      // The model is writing. It reads the row at its next tool call, or, if the
      // turn ends first, the row opens the next turn.
      state.outbox.push(item);
      state.dirty = true;
      await note($, `AgentKib will add to this turn: ${previewText(item.text, 512)}`);
    }
    if (result.reason !== "native-append-refused") {
      result.status = "accepted";
      delete result.reason;
      result.turnId = item.turnId;
    }
  }
}

async function enqueue($, state, command, result) {
  if (!validSend(command)) result.reason = "invalid-text";
  else if (!writable(state)) result.reason = "session-state-unverified";
  else if (state.outbox.length >= MAX_OUTBOX) result.reason = "outbox-full";
  else {
    state.outbox.push(outboxItem(command, "queue", null));
    state.dirty = true;
    result.status = "accepted";
    delete result.reason;
    if (state.currentTurnId)
      await note(
        $,
        `AgentKib queued a message for after this turn: ${previewText(command.text, 512)}`,
      );
  }
}

/** Withdraws a message the terminal has not taken; one of unknown outcome is never retried. */
function withdraw(state, command, result) {
  const item = state.outbox.find((entry) => entry.id === command.itemId);
  if (!item || !["pending", "unknown"].includes(item.status) || state.dispatching === item)
    result.reason = "outbox-item-unavailable";
  else {
    state.outbox = state.outbox.filter((entry) => entry !== item);
    if (state.unconfirmedReport?.report === item) state.unconfirmedReport = null;
    state.dirty = true;
    result.status = "accepted";
    delete result.reason;
  }
}

function markOutboxUnknown(state, item, pending) {
  item.status = "unknown";
  if (!pending.report) {
    state.sendDisabled = true;
  } else if (!pending.competing && state.revision === pending.expectedRevision) {
    // Wait for this prompt's native start, another main turn, or a verified reconnect.
    // The row stays unknown unless there is positive evidence, so it is never selected again.
    state.unconfirmedReport = pending;
  }
}

function reportDispatchPaused(state, pending) {
  if (!pending?.report || !leadReportsPaused(state)) return false;
  pending.reportHeld = true;
  return true;
}

/** Submits the next waiting message once the terminal is verified idle: steers, then the queue. */
async function dispatchOutbox($, state) {
  if (
    state.dispatching ||
    state.pendingSend ||
    state.unconfirmedReport ||
    !writable(state) ||
    !state.connection ||
    state.connection.leaseId === "reconnecting" ||
    state.currentTurnId ||
    !state.activityVerified ||
    state.nativeWorking !== false
  )
    return;
  const reportsPaused = leadReportsPaused(state);
  const ready = (item) =>
    item.status === "pending" &&
    item.retryRevision !== state.revision &&
    (!item.leadReport || !reportsPaused);
  const item =
    state.outbox.find((entry) => entry.kind === "steer" && entry.turnId === null && ready(entry)) ??
    state.outbox.find((entry) => entry.kind === "queue" && ready(entry));
  // Let the Runtime remove the report ID before submitting it, so a reloaded
  // plugin cannot be offered the same report after it executed here.
  if (!item || (item.leadReport && state.takenReports.has(item.id))) return;
  const connection = state.connection;
  try {
    await identity($, state);
  } catch {
    return;
  }
  if (
    state.connection !== connection ||
    state.dispatching ||
    state.pendingSend ||
    state.unconfirmedReport ||
    !writable(state) ||
    state.currentTurnId ||
    !state.activityVerified ||
    state.nativeWorking !== false ||
    !state.outbox.includes(item) ||
    !ready(item) ||
    (item.leadReport && leadReportsPaused(state))
  )
    return;
  const pending = {
    text: item.text,
    expectedRevision: state.revision,
    observed: false,
    competing: false,
    turnId: null,
    report: item.leadReport ? item : null,
    reportAppended: false,
  };
  state.pendingSend = pending;
  state.dispatching = item;
  item.status = "dispatching";
  state.dirty = true;
  try {
    const submitted = await $.prompt.submit({ text: item.text, asUser: true });
    if (!state.outbox.includes(item)) return;
    if (submitted?.drop && !pending.reportAppended && (!pending.report || !pending.turnId)) {
      // A terminal prompt entered first or a hook refused it. Try again once the
      // session has changed since this attempt, never in a loop against the same
      // state. A terminal turn that ran first has already changed it.
      item.status = "pending";
      item.retryRevision = pending.reportHeld ? null : pending.expectedRevision;
    } else if (
      state.pendingSend === pending &&
      pending.observed &&
      !pending.competing &&
      pending.turnId &&
      submitted?.text === pending.text
    ) {
      state.outbox = state.outbox.filter((entry) => entry !== item);
    } else {
      markOutboxUnknown(state, item, pending);
    }
  } catch {
    if (state.outbox.includes(item)) markOutboxUnknown(state, item, pending);
  } finally {
    if (state.pendingSend === pending) state.pendingSend = null;
    if (state.dispatching === item) state.dispatching = null;
    state.dirty = true;
  }
}

async function reportResult($, state, result) {
  if (!state.connection || state.closed) return;
  await request($, state, "/v1/results", { ...lease(state), ...result });
  state.unacknowledgedResults.delete(result.commandId);
}

async function execute($, state, command) {
  if (
    !command ||
    typeof command.commandId !== "string" ||
    !command.commandId ||
    command.commandId.length > 256
  ) {
    invalidate(state, "invalid-command");
    return;
  }
  const prior = state.results.get(command.commandId);
  const fingerprint = JSON.stringify(command);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      invalidate(state, "command-identity-conflict");
      return;
    }
    await reportResult($, state, prior.result);
    state.afterCommandId = command.commandId;
    return;
  }
  const result = {
    commandId: command.commandId,
    status: "rejected",
    reason: "unsupported-command",
    revision: state.revision,
  };
  // Lost acknowledgements replay this receipt, never a native action.
  state.results.set(command.commandId, { fingerprint, result });
  if (state.results.size > 2048) {
    invalidate(state, "receipt-capacity-reached");
    return;
  }
  await identity($, state);
  // A steer names the turn it joins and a queued message waits for any turn, so
  // neither depends on the revision a send or stop was decided against.
  if (command.kind === "steer") await steer($, state, command, result);
  else if (command.kind === "queue") await enqueue($, state, command, result);
  else if (command.kind === "cancel") withdraw(state, command, result);
  else if (command.expectedRevision !== state.revision) result.reason = "revision-conflict";
  else if (command.kind === "open-model-picker") await openModelPicker($, state, command, result);
  else if (command.kind === "handover-exit") await handoverExit($, state, command, result);
  else if (command.kind === "send") {
    if (!validSend(command)) result.reason = "invalid-text";
    else if (
      state.closed ||
      !writable(state) ||
      !state.activityVerified ||
      state.currentTurnId ||
      state.pendingSend ||
      hasQueuedInput(state)
    )
      result.reason = "session-not-idle";
    else {
      const pending = {
        text: command.text,
        expectedRevision: command.expectedRevision,
        observed: false,
        competing: false,
        turnId: null,
      };
      state.pendingSend = pending;
      try {
        const submitted = await $.prompt.submit({ text: command.text, asUser: true });
        if (submitted?.drop) result.reason = "native-prompt-refused";
        else if (
          state.pendingSend === pending &&
          pending.observed &&
          !pending.competing &&
          pending.turnId &&
          submitted?.text === pending.text
        ) {
          result.status = "accepted";
          delete result.reason;
          result.turnId = pending.turnId;
        } else {
          result.status = "unknown";
          result.reason = "native-turn-unconfirmed";
          state.sendDisabled = true;
        }
      } catch {
        result.status = "unknown";
        result.reason = "native-submit-result-unknown";
        state.sendDisabled = true;
      } finally {
        if (state.pendingSend === pending) state.pendingSend = null;
      }
    }
  } else if (command.kind === "stop") {
    if (state.closed || state.bufferPaused || state.needsReconnect)
      result.reason = "session-state-unverified";
    else if (!state.currentTurnId || command.turnId !== state.currentTurnId)
      result.reason = "turn-conflict";
    else {
      try {
        await $.turn.abort({ turnId: command.turnId });
        result.status = "accepted";
        delete result.reason;
        result.turnId = command.turnId;
      } catch {
        result.status = "unknown";
        result.reason = "native-stop-result-unknown";
      }
    }
  }
  result.revision = state.revision;
  state.unacknowledgedResults.set(command.commandId, result);
  state.dirty = true;
  await flush($, state);
  await reportResult($, state, result);
  state.afterCommandId = command.commandId;
}

async function pump($, state, nativeEvent = false) {
  if (!state.connection && !state.needsReconnect) {
    if (
      state.closed ||
      state.autoConnecting ||
      state.pendingSend ||
      state.pairingGeneration === state.generation
    )
      return;
    if (!nativeEvent && state.autoDelayTicks > 0) {
      state.autoDelayTicks -= 1;
      return;
    }
    await autoConnect($, state);
    return;
  }
  if (
    state.connection?.leaseId === "reconnecting" ||
    state.reconnectGeneration === state.generation ||
    state.closed ||
    state.pumping
  )
    return;
  if (state.needsReconnect && !state.pendingSend && !nativeEvent && state.reconnectDelayTicks > 0) {
    state.reconnectDelayTicks -= 1;
    return;
  }
  const generation = state.generation;
  state.pumping = true;
  try {
    if (state.needsReconnect && !state.pendingSend) await reconnect($, state);
    if (state.generation !== generation || !state.connection || state.closed) return;
    await identity($, state);
    for (const result of state.unacknowledgedResults.values()) await reportResult($, state, result);
    if (state.generation !== generation || !state.connection || state.closed) return;
    const connection = state.connection;
    const lead = leadFeature(state);
    const reportsPaused = leadReportsPaused(state);
    const rateLimitOffered = lead && connection.features.includes(LEAD_RATE_LIMIT_FEATURE);
    const rateLimitChanged = rateLimitOffered && reportsPaused !== state.leadRateLimitReported;
    const taken = leadOffered(state) && !reportsPaused ? [...state.takenReports] : [];
    const response = await request($, state, "/v1/commands", {
      ...lease(state),
      afterCommandId: state.afterCommandId,
      // Report ACKs and pause transitions do not need a long poll.
      waitMs: taken.length || rateLimitChanged ? 0 : 20_000,
      ...(leadOffered(state)
        ? { leadTools: lead, ...(taken.length ? { takenReports: taken } : {}) }
        : {}),
      ...(rateLimitOffered ? { leadReportsPaused: reportsPaused } : {}),
    });
    if (state.closed || state.connection !== connection) return;
    if (!Array.isArray(response?.commands) || response.commands.length > 1) {
      invalidate(state, "invalid-command-batch");
      return;
    }
    if (rateLimitOffered) state.leadRateLimitReported = reportsPaused;
    // The Runtime has dropped them; a report still listed again is taken only once.
    for (const id of taken)
      if (!response.lead?.reports?.some?.((r) => r?.id === id)) state.takenReports.delete(id);
    for (const command of response.commands) await execute($, state, command);
    if (lead && state.connection === connection && !state.handoverExit)
      await applyLead($, state, response.lead, connection);
  } catch {
    state.dirty = true;
  } finally {
    state.pumping = false;
  }
}

async function connect($, state, ticket) {
  // A new one-time ticket is the explicit authorization to bind the currently
  // selected native session after clear/resume or a prior disconnect.
  if (!state.connection && state.closed && !state.pendingSend) state.identity = null;
  if (state.connection && state.connection.leaseId !== "reconnecting")
    throw new Error("already-connected");
  // A newer code can supersede an awaiting pairing. Transfer only that current
  // attempt's saved-binding recovery intent without waking the pump mid-pair.
  const resumeRecovery =
    state.needsReconnect || state.pairingRecoveryGeneration === state.generation;
  const generation = ++state.generation;
  state.pairingGeneration = generation;
  state.pairingRecoveryGeneration = resumeRecovery ? generation : null;
  state.connection = null;
  state.connectionFailure = null;
  state.needsReconnect = false;
  state.reconnectFailures = 0;
  state.reconnectDelayTicks = 0;
  state.socketPath = ticket.socketPath;
  try {
    await connectOnce($, state, ticket, generation);
  } catch (error) {
    // A rejected replacement code does not revoke the saved binding. Resume its
    // full reconnect checks only if this attempt still owns the open generation.
    if (resumeRecovery && state.generation === generation && !state.closed && !state.connection)
      state.needsReconnect = true;
    throw error;
  } finally {
    if (state.pairingGeneration === generation) state.pairingGeneration = null;
    if (state.pairingRecoveryGeneration === generation) state.pairingRecoveryGeneration = null;
  }
}

async function connectOnce($, state, ticket, generation) {
  let observed;
  try {
    observed = await probeCapabilities($, state);
  } catch (error) {
    if (
      [
        "bridge-version-mismatch",
        "bridge-cli-too-old",
        "bridge-cli-unsupported",
        "bridge-capabilities-missing",
        "bridge-plugin-update-required",
        "unsupported-native-identity",
        "native-identity-changed",
      ].includes(error?.message)
    ) {
      try {
        await request(
          $,
          state,
          "/v1/pair",
          {
            ticket: ticket.ticket,
            connectionError: error.message,
            ...(error.cliVersion ? { cliVersion: error.cliVersion } : {}),
            ...(error.missingCapabilities
              ? { missingCapabilities: error.missingCapabilities }
              : {}),
          },
          false,
        );
      } catch {
        // Preserve the native validation error even when the broker is offline.
      }
    }
    throw error;
  }
  if (state.generation !== generation) throw new Error("stale-connect");
  const response = await request(
    $,
    state,
    "/v1/pair",
    { ...observed, ticket: ticket.ticket },
    false,
  );
  if (state.generation !== generation) throw new Error("stale-connect");
  await adopt($, state, observed, response);
}

async function adopt($, state, observed, response) {
  state.connection = connectionFrom(response);
  state.leadBindingId = null;
  resetLeadRateLimit(state);
  state.terminalSubagents = null;
  state.connectionStatusReason = null;
  state.modelPickerSupported = undefined;
  state.leadUnavailable = null;
  state.leadToolsKey = null;
  state.leadActive = false;
  state.leadPaused = undefined;
  state.credentialPath = response.credentialPath;
  state.closed = false;
  state.sendDisabled = false;
  state.unconfirmedReport = null;
  state.needsReconnect = false;
  state.seq = 0;
  state.events = [];
  state.completions.clear();
  state.bufferPaused = false;
  state.snapshotRecovery = null;
  state.afterCommandId = null;
  await $.store.set(`credentialPath:${observed.nativeId}`, response.credentialPath);
  state.dirty = true;
  await flush($, state);
}

// Diagnostic reports authenticate an existing binding without establishing a
// lease. Fresh native identity reads are required even when version probing
// failed before identity() could complete; cached identity is not evidence.
async function reportReconnectFailure($, state, generation, failure) {
  const current = () => state.generation === generation && !state.closed;
  const nativeId = await $.session.id();
  if (!current()) return;
  const { current: workingDirectory, workspace: cwd } = await readSessionDirectories($);
  if (!current()) return;
  const insideWorkspace = await isInsideSessionWorkspace($, workingDirectory, cwd);
  if (!current()) return;
  if (
    typeof nativeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ||
    !insideWorkspace
  )
    return;
  const path = await $.store.get(`credentialPath:${nativeId}`);
  if (!current()) return;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    return;
  const credential = JSON.parse(await $.fs.read(path));
  if (!current()) return;
  // The Runtime writes the oldest plugin it takes, not necessarily this one; it judges this
  // plugin by the version the plugin itself reports.
  if (
    credential?.protocol !== 1 ||
    credential.nativeId !== nativeId ||
    credential.cwd !== cwd ||
    claudeBridgePluginCompatibility(credential.pluginVersion) !== "supported" ||
    ["invalid", "too-old"].includes(claudeBridgeCompatibility(credential.cliVersion)) ||
    !safeSocket(credential.socketPath) ||
    typeof credential.bindingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credential.bindingId) ||
    typeof credential.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(credential.token)
  )
    return;
  await $.http.fetch("http://localhost/v1/reconnect", {
    socketPath: credential.socketPath,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
    body: JSON.stringify({
      protocol: 1,
      pluginVersion: PLUGIN_VERSION,
      bindingId: credential.bindingId,
      nativeId,
      cwd,
      instanceId: state.instanceId,
      connectionError: failure.reason,
      ...(failure.cliVersion ? { cliVersion: failure.cliVersion } : {}),
      ...(failure.missingCapabilities ? { missingCapabilities: failure.missingCapabilities } : {}),
    }),
  });
}

async function reconnect($, state) {
  const generation = state.generation;
  if (state.closed || state.reconnectGeneration === generation) return;
  state.reconnectGeneration = generation;
  state.needsReconnect = true;
  // Once a lease needs recovery, no event may reuse it while probes/backoff run.
  state.connection = null;
  state.terminalSubagents = null;
  try {
    await reconnectOnce($, state);
    if (state.generation === generation && !state.closed) {
      state.reconnectFailures = 0;
      state.reconnectDelayTicks = 0;
    }
  } catch (error) {
    if (state.generation === generation && !state.closed) {
      state.needsReconnect = true;
      state.reconnectFailures = Math.min(
        state.reconnectFailures + 1,
        RECONNECT_BACKOFF_TICKS.length,
      );
      state.reconnectDelayTicks = RECONNECT_BACKOFF_TICKS[state.reconnectFailures - 1];
    }
    if (
      state.generation === generation &&
      !state.closed &&
      INCOMPATIBLE_ERRORS.includes(error?.message)
    ) {
      const failure = {
        reason: error.message,
        ...(error.cliVersion ? { cliVersion: error.cliVersion } : {}),
        ...(error.missingCapabilities ? { missingCapabilities: error.missingCapabilities } : {}),
      };
      state.connection = null;
      state.connectionFailure = failure;
      try {
        await reportReconnectFailure($, state, generation, failure);
      } catch {
        // A local compatibility reason remains useful when the authenticated
        // diagnostic cannot be delivered. Never substitute raw host errors.
      }
    }
    throw error;
  } finally {
    if (state.generation === generation && state.reconnectGeneration === generation)
      state.reconnectGeneration = null;
  }
}

async function reconnectOnce($, state) {
  const generation = state.generation;
  const previousIdentity = await identity($, state);
  const path = await $.store.get(`credentialPath:${previousIdentity.nativeId}`);
  if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    state.connectionStatusReason = null;
    state.needsReconnect = false;
    return;
  }
  // A terminal with no saved binding does not need history/file/store-write
  // probes on startup. Every actual reconnect still repeats the full probe.
  let credential;
  try {
    credential = JSON.parse(await $.fs.read(path));
  } catch (error) {
    if (state.generation === generation && !state.closed)
      state.connectionStatusReason = "saved-connection-unreadable";
    throw error;
  }
  if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
  if (safeSocket(credential?.socketPath)) {
    const reachable = await runtimeReachable($, credential.socketPath);
    if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
    if (!reachable) {
      state.connectionStatusReason = "agentkib-unreachable";
      throw new Error("bridge-unavailable");
    }
  }
  state.connectionStatusReason = null;
  const observed = await probeCapabilities($, state);
  if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
  if (
    credential?.protocol !== 1 ||
    credential.nativeId !== observed.nativeId ||
    credential.cwd !== observed.cwd ||
    claudeBridgeCompatibility(credential.cliVersion) === "invalid" ||
    claudeBridgeCompatibility(credential.cliVersion) === "too-old" ||
    claudeBridgePluginCompatibility(credential.pluginVersion) !== "supported" ||
    !safeSocket(credential.socketPath) ||
    typeof credential.bindingId !== "string" ||
    typeof credential.token !== "string"
  )
    throw new Error("invalid-reconnect-credential");
  if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
  state.socketPath = credential.socketPath;
  state.credentialPath = path;
  const connecting = {
    protocol: 1,
    bindingId: credential.bindingId,
    token: credential.token,
    leaseId: "reconnecting",
    credentialPath: path,
  };
  state.connection = connecting;
  try {
    const response = await request($, state, "/v1/reconnect", {
      ...observed,
      bindingId: credential.bindingId,
    });
    if (state.generation !== generation || state.closed || state.connection !== connecting)
      throw new Error("stale-reconnect");
    state.connection = connectionFrom(response);
    if (state.connection.bindingId !== state.leadBindingId) resetLeadRateLimit(state);
    state.leadRateLimitReported = null;
    state.modelPickerSupported = undefined;
    state.connectionFailure = null;
    state.credentialPath = path;
    state.closed = false;
    state.needsReconnect = false;
    // A new lease can release an unresolved attempt, but not lose a prompt
    // the native session has already appended and may still open a turn for.
    if (!state.unconfirmedReport?.reportAppended) state.unconfirmedReport = null;
    state.seq = 0;
    state.events = [];
    state.snapshotRecovery = null;
    state.afterCommandId = null;
    state.dirty = true;
  } finally {
    // A failed HTTP call must release only its own placeholder. A newer ticket
    // or session.end has already replaced this generation and must stay intact.
    if (state.generation === generation && state.connection === connecting) state.connection = null;
  }
}

function safeAbsolute(path) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

/** AgentKib's 0600 discovery files, production first. Missing or invalid files are skipped. */
export async function discoverAgentKib($) {
  const roots = [];
  try {
    const custom = await $.env.get("AGENTKIB_HOME");
    if (safeAbsolute(custom)) roots.push(custom);
    const home = await $.env.get("HOME");
    if (safeAbsolute(home)) roots.push(`${home}/.agentkib`, `${home}/.agentkib-dev`);
  } catch {
    return [];
  }
  const found = [];
  for (const root of roots) {
    const file = `${root.replace(/\/+$/, "")}/claude-bridge/auto-v1.json`;
    try {
      if (!(await $.fs.exists(file))) continue;
      const value = JSON.parse(await $.fs.read(file));
      if (
        value?.protocol === 1 &&
        safeSocket(value.socketPath) &&
        typeof value.autoKey === "string" &&
        /^[a-f0-9]{64}$/.test(value.autoKey) &&
        !found.some((item) => item.socketPath === value.socketPath)
      )
        found.push({ socketPath: value.socketPath, autoKey: value.autoKey });
    } catch {
      // An unreadable discovery file means that AgentKib is not available here.
    }
  }
  return found;
}

/**
 * Pairs this terminal's own session without a code when AgentKib allows it for
 * the session's workspace. A saved binding, an explicit code or a disconnect in
 * AgentKib always takes precedence.
 */
export async function autoConnect($, state) {
  if (
    state.connection ||
    state.needsReconnect ||
    state.autoConnecting ||
    state.pendingSend ||
    state.pairingGeneration === state.generation
  )
    return;
  state.autoConnecting = true;
  let generation = state.generation;
  let nativeId;
  try {
    nativeId = await $.session.id();
    requireGeneration(state, generation, "stale-auto-connect");
    if (typeof nativeId !== "string" || state.autoDone.has(nativeId)) return;
    // A session revoked in this terminal stays disconnected until a new code.
    if (state.closed && state.identity?.nativeId === nativeId) {
      state.autoDone.add(nativeId);
      return;
    }
    const tries = state.autoTries.get(nativeId) ?? 0;
    state.autoTries.set(nativeId, Math.min(tries + 1, AUTO_BACKOFF_TICKS.length));
    // A session paired earlier reconnects with its own credential instead.
    const credentialPath = await $.store.get(`credentialPath:${nativeId}`);
    requireGeneration(state, generation, "stale-auto-connect");
    if (typeof credentialPath === "string") {
      state.autoDone.add(nativeId);
      if (state.closed) {
        state.identity = null;
        state.closed = false;
        state.sendDisabled = false;
      }
      state.needsReconnect = true;
      await reconnect($, state);
      return;
    }
    // A discovery file a closed Runtime left behind names a socket nothing answers on.
    const sources = [];
    const discovered = await discoverAgentKib($);
    requireGeneration(state, generation, "stale-auto-connect");
    for (const source of discovered) {
      const reachable = await runtimeReachable($, source.socketPath);
      requireGeneration(state, generation, "stale-auto-connect");
      if (reachable) sources.push(source);
    }
    if (!sources.length) {
      state.connectionStatusReason = discovered.length
        ? "agentkib-unreachable"
        : "agentkib-not-found";
      return;
    }
    // After /clear or /resume the previous conversation's identity no longer applies.
    if (state.closed) state.identity = null;
    generation = ++state.generation;
    let statusReason = null;
    const observed = await probeCapabilities($, state);
    if (observed.nativeId !== nativeId) throw new Error("stale-auto-connect");
    for (const source of sources) {
      let response;
      try {
        response = await $.http.fetch("http://localhost/v1/auto-pair", {
          socketPath: source.socketPath,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...observed, autoKey: source.autoKey }),
        });
      } catch {
        requireGeneration(state, generation, "stale-auto-connect");
        continue;
      }
      if (state.generation !== generation || state.connection) return;
      let decoded = null;
      try {
        decoded = typeof response?.text === "string" ? JSON.parse(response.text) : null;
      } catch {
        decoded = null;
      }
      if (response?.ok) {
        state.socketPath = source.socketPath;
        state.connectionFailure = null;
        state.needsReconnect = false;
        await adopt($, state, observed, decoded);
        state.autoDone.add(nativeId);
        return;
      }
      if (INCOMPATIBLE_ERRORS.includes(decoded?.error)) {
        state.connectionFailure = {
          reason: decoded.error,
          ...(typeof decoded.cliVersion === "string" ? { cliVersion: decoded.cliVersion } : {}),
        };
        return;
      }
      if (AUTO_FINAL_ERRORS.includes(decoded?.error)) {
        state.connectionStatusReason =
          response?.status === 409 && decoded.error === "bridge-auto-declined"
            ? "session-disconnected"
            : null;
        if (state.connectionStatusReason) state.connectionFailure = null;
        state.autoDone.add(nativeId);
        return;
      }
      // Legacy Runtime errors distinguish disabled workspaces and revocations.
      // Its unavailable error alone cannot distinguish registration from indexing.
      if (response?.status !== 409) continue;
      const reason =
        decoded?.error === "bridge-auto-disabled"
          ? "auto-connect-disabled"
          : decoded?.error === "bridge-auto-unavailable" &&
              ["workspace-not-registered", "session-not-indexed"].includes(decoded.reason)
            ? decoded.reason
            : null;
      if (AUTO_RETRY_REASONS.indexOf(reason) > AUTO_RETRY_REASONS.indexOf(statusReason))
        statusReason = reason;
      // A stale key or a session not indexed yet: try the next source, then back off.
    }
    if (statusReason) state.connectionFailure = null;
    state.connectionStatusReason = statusReason;
  } catch (error) {
    // A delegated reconnect can already have recorded its own diagnosis.
    if (state.generation === generation && !state.connection && !state.needsReconnect)
      state.connectionStatusReason = null;
    // The local probe found this plugin or CLI unusable; retrying cannot change that.
    if (
      state.generation === generation &&
      nativeId &&
      INCOMPATIBLE_ERRORS.includes(error?.message)
    ) {
      state.connectionFailure = {
        reason: error.message,
        ...(error.cliVersion ? { cliVersion: error.cliVersion } : {}),
      };
      state.autoDone.add(nativeId);
    }
    if (state.generation === generation && nativeId && AUTO_FINAL_ERRORS.includes(error?.message))
      state.autoDone.add(nativeId);
  } finally {
    if (state.generation === generation && !state.connection && !state.closed) {
      const tries = nativeId ? (state.autoTries.get(nativeId) ?? 1) : 1;
      state.autoDelayTicks = AUTO_BACKOFF_TICKS[Math.max(tries - 1, 0)];
    }
    state.autoConnecting = false;
  }
}

function connectionStatusText(reason) {
  switch (reason) {
    case "agentkib-not-found":
      return "AgentKib is not running or could not be found. Open AgentKib on this computer and wait for automatic connection.";
    case "agentkib-unreachable":
      return "AgentKib is not responding on this computer. Open AgentKib and wait for this terminal to connect.";
    case "saved-connection-unreadable":
      return "The saved AgentKib connection for this session could not be read. Generate a new connection code in AgentKib and run it in this terminal.";
    case "workspace-not-registered":
      return "This terminal's workspace is not registered in AgentKib. Add it in AgentKib, then wait for automatic connection.";
    case "session-not-indexed":
      return "AgentKib has not indexed this Claude Code session yet. Make sure session indexing is enabled in AgentKib, then start or continue the conversation in this terminal and wait for automatic connection.";
    case "auto-connect-disabled":
      return "Automatic connection is disabled for this workspace. Enable it in AgentKib or generate a new connection code.";
    case "session-disconnected":
      return "This session was disconnected or cleared in AgentKib. Generate a new connection code in AgentKib and run it in this terminal.";
    default:
      return "AgentKib bridge is not connected. Check the terminal connection in AgentKib or generate a new connection code.";
  }
}

export function connectionFailureText(reason, cliVersion) {
  const version =
    claudeBridgeCompatibility(cliVersion) === "invalid" ? "(unknown version)" : cliVersion;
  switch (reason) {
    case "invalid-ticket":
    case "invalid-bridge-challenge":
      return "The connection code is invalid or already used. Generate a new connection code in AgentKib and copy the full command.";
    case "expired-bridge-challenge":
      return "The connection code has expired. Generate a new connection code in AgentKib and run the new command.";
    case "bridge-cli-too-old":
      return `This terminal uses Claude Code ${version}; AgentKib requires Claude Code ${CLI_VERSION} or later. Update Claude Code, then reconnect.`;
    case "bridge-cli-unsupported":
      return "AgentKib could not read a supported stable Claude Code version. Continue in the terminal; a future AgentKib release may support this version.";
    case "bridge-capabilities-missing":
      return `Claude Code ${version} does not currently support connecting to AgentKib. Continue in the terminal; a future AgentKib release will adapt to it.`;
    case "bridge-version-mismatch":
    case "bridge-plugin-update-required":
      return "The terminal connection plugin needs updating. Reinstall it using step 1 in AgentKib, then generate a new connection code.";
    case "bridge-identity-mismatch":
    case "unsupported-native-identity":
    case "native-identity-changed":
      return "This terminal does not match the selected session or workspace. Open the original Claude Code session in the registered workspace and use a new connection code.";
    case "already-connected":
      return "This terminal is already connected to AgentKib. Use /agentkib-status to check the connection.";
    case "control-outcome-unconfirmed":
      return "A previous operation still needs to be checked. Open session actions in AgentKib and check its outcome before connecting again.";
    default:
      return "AgentKib could not connect. Check that AgentKib is running on this computer, then generate a new connection code and retry.";
  }
}

function startBridge($, state) {
  if (state.bridgeStarted || state.closed) return;
  state.bridgeStarted = true;
  $.clock.every(250, () => flush($, state));
  $.clock.every(250, () => pump($, state));
  // A native submit waits for the turn ending in its hook, so dispatch outside that hook.
  $.clock.every(250, () => dispatchOutbox($, state));
  $.clock.every(1_000, () => {
    void refreshTerminalSubagents($, state);
  });
  const generation = state.generation;
  // The original terminal can continue even while its saved connection is recovering.
  void reconnect($, state)
    .catch(() => {})
    .then(() => {
      if (state.generation === generation && !state.closed) return autoConnect($, state);
    })
    .catch(() => {});
}

export function register(on) {
  const state = initialState();
  on("session.start", async ($, e, next) => {
    const generation = state.generation;
    await $.command.register({
      name: "agentkib-connect",
      description: "Connect this session using the one-time connection code shown in AgentKib",
      argumentHint: "<connection-code>",
      immediate: true,
    });
    await $.command.register({
      name: "agentkib-status",
      description: "Show local AgentKib connection status without calling a model",
      immediate: true,
    });
    if (state.generation === generation) startBridge($, state);
    return next(e);
  });
  on("command.run", { command: "agentkib-connect" }, async ($, e) => {
    try {
      await connect($, state, decodeTicket(e.args.trim()));
      return {
        text: "AgentKib connected to this Claude Code session. Approvals and questions stay here.",
      };
    } catch (error) {
      return {
        text: connectionFailureText(error?.message, error?.cliVersion),
      };
    }
  });
  on("command.run", { command: "agentkib-status" }, async () => ({
    text:
      state.connection && state.connection.leaseId !== "reconnecting" && !state.closed
        ? "AgentKib is connected to this session. Approvals and questions remain in the original terminal."
        : state.connectionFailure
          ? connectionFailureText(
              state.connectionFailure.reason,
              state.connectionFailure.cliVersion,
            )
          : connectionStatusText(state.connectionStatusReason),
  }));
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // Reloading the plugin into a running terminal may not replay session.start.
    startBridge($, state);
    // Claude's interactive /model command also sets isWorking while its UI is open.
    // A real turn is still established independently by turn.start or turn.step.
    if (state.modelPicker && !state.currentTurnId && e.props?.isWorking === true) return next(e);
    if (typeof e.props?.isWorking === "boolean" && !state.pendingSend) {
      const verified = !e.props.isWorking;
      if (verified !== state.activityVerified || e.props.isWorking !== state.nativeWorking) {
        state.activityVerified = verified;
        state.nativeWorking = e.props.isWorking;
        state.dirty = true;
      }
    }
    return next(e);
  });
  on("ui.render", { component: "ToolProgress" }, async ($, e, next) => {
    if (e.props?.kind === "background_hint" && typeof e.props.tool_use_id === "string") {
      const tool = state.activeTools.get(e.props.tool_use_id);
      if (tool) {
        for (const owner of state.waits.keys()) {
          if (owner.tool === tool) {
            state.waits.delete(owner);
            state.dirty = true;
          }
        }
      }
    }
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => {
    const pending = state.pendingSend;
    if (e.origin?.kind === "plugin" && e.origin.name === "agentkib-bridge") {
      if (reportDispatchPaused(state, pending))
        return { drop: "AgentKib is holding Project Agent reports until Claude Code resumes." };
      if (
        !pending ||
        state.closed ||
        state.sendDisabled ||
        state.currentTurnId ||
        pending.expectedRevision !== state.revision ||
        e.text !== pending.text ||
        pending.competing
      ) {
        return { drop: "AgentKib session changed before dispatch; no queued retry was created." };
      }
      pending.observed = true;
    } else {
      if (state.handoverExit) state.handoverExit.competing = true;
      if (e.origin?.kind === "composer") resumeLeadReports(state);
      if (pending) pending.competing = true;
      if (state.unconfirmedReport) state.unconfirmedReport.competing = true;
      if (UNATTENDED_ORIGINS.has(e.origin?.kind)) {
        state.unattended.push(e.text);
        if (state.unattended.length > 8) state.unattended.shift();
      }
      // A real terminal prompt bypasses background backoff without waiting on
      // an offline Runtime or changing the native prompt's execution path.
      if (state.needsReconnect) void pump($, state, true);
    }
    return next(e);
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    if (
      next.error.kind === "re-entry" &&
      next.error.cause === undefined &&
      state.pendingSend &&
      e.origin?.kind === "plugin" &&
      e.origin.name === "agentkib-bridge"
    ) {
      const pending = state.pendingSend;
      if (reportDispatchPaused(state, pending))
        return { drop: "AgentKib is holding Project Agent reports until Claude Code resumes." };
      if (
        state.closed ||
        state.sendDisabled ||
        state.currentTurnId ||
        pending.expectedRevision !== state.revision ||
        e.text !== pending.text ||
        pending.competing
      ) {
        return { drop: "AgentKib session changed before dispatch; no queued retry was created." };
      }
      pending.observed = true;
      return next(e);
    }
    if (!next.called && e.origin?.kind === "plugin" && e.origin.name === "agentkib-bridge") {
      return { drop: "AgentKib could not verify this dispatch. It was not retried." };
    }
    return next(e);
  });
  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    if (state.handoverExit) state.handoverExit.competing = true;
    startBridge($, state);
    state.currentTurnId = e.turnId;
    state.currentTurnStartedAt = Date.now();
    state.streamText = "";
    state.streamBytes = 0;
    state.streamTruncated = false;
    state.nativeWorking = true;
    state.activeTools.clear();
    state.workerToolCoverage = true;
    state.workerActivityRevision = 0;
    state.waits.clear();
    state.activityVerified = true;
    state.revision += 1;
    const pending = state.pendingSend ?? state.unconfirmedReport;
    const fromAgentKib = pending?.observed && !pending.competing && pending.text === e.text;
    if (fromAgentKib) {
      pending.turnId = e.turnId;
      if (pending.report && pending.reportAppended) {
        // The engine attributed the prompt row to this plugin and opened its
        // turn. A missing or late submit response cannot undo that delivery.
        state.outbox = state.outbox.filter((item) => item !== pending.report);
        if (state.unconfirmedReport === pending) state.unconfirmedReport = null;
      }
    }
    const unattendedAt = e.text ? state.unattended.lastIndexOf(e.text) : -1;
    if (unattendedAt >= 0) state.unattended.splice(unattendedAt, 1);
    // Steers waiting for the next turn join whichever turn starts, the terminal's too.
    for (const item of state.outbox)
      if (item.kind === "steer" && item.status === "pending" && item.turnId === null)
        item.turnId = e.turnId;
    record(state, {
      type: "turn-start",
      turnId: e.turnId,
      revision: state.revision,
      // Who started it, for a Project Agent's count of turns without the person: the person
      // typing, or AgentKib. A turn no one typed (a continuation, background work's notice, a
      // schedule) has neither.
      ...(leadFeature(state) && (fromAgentKib || (e.text && unattendedAt < 0))
        ? { origin: fromAgentKib ? "agentkib" : "terminal" }
        : {}),
    });
    state.dirty = true;
    if (state.needsReconnect) void pump($, state, true);
    return next(e);
  });
  on("turn.step", async function* ($, e, next) {
    let recovered = false;
    let recoveryReady = true;
    if (e.agentId === undefined && state.currentTurnId === null) {
      // Freshly loaded modules may miss turn.start. A native step establishes
      // the actual turn, without inventing a start event or replaying a prompt.
      recovered = true;
      state.currentTurnId = e.turnId;
      state.streamText = "";
      state.streamBytes = 0;
      state.streamTruncated = false;
      state.nativeWorking = true;
      state.revision += 1;
      state.dirty = true;
      try {
        const view = await snapshot($, state);
        if (state.currentTurnId === e.turnId)
          recoveryReady = record(state, { type: "snapshot", snapshot: view }) !== undefined;
      } catch {
        recoveryReady = false;
        if (!state.closed && (state.connection || state.credentialPath)) markGap(state);
      }
    }
    return yield* observeNativeStream(next(e), (chunk) => {
      if (
        e.agentId !== undefined ||
        e.turnId !== state.currentTurnId ||
        state.closed ||
        (!state.connection && !state.credentialPath)
      )
        return;
      // Keep thinking private. Only its arrival is relevant to supervision.
      if (
        (chunk?.kind === "text" || chunk?.kind === "thinking") &&
        typeof chunk.text === "string" &&
        chunk.text.length > 0
      )
        state.workerActivityRevision += 1;
      if (chunk?.kind === "text" && typeof chunk.text === "string") {
        appendStreamText(state, chunk.text);
        if (!recovered || recoveryReady)
          record(state, {
            type: "text",
            turnId: e.turnId,
            text: state.bufferPaused ? "" : previewText(chunk.text, MAX_STREAM),
            revision: state.revision,
          });
        else state.dirty = true;
      }
    });
  });
  on("turn.complete", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const startedAt = e.turnId === state.currentTurnId ? state.currentTurnStartedAt : null;
    if (
      e.turnId === state.currentTurnId &&
      e.turnId !== state.leadFailedTurnId &&
      e.isAborted !== true &&
      e.reason === "answer"
    )
      resumeLeadReports(state);
    if (e.turnId === state.currentTurnId) state.unconfirmedReport = null;
    if (e.turnId === state.currentTurnId || state.currentTurnId === null) {
      state.lastCompletedMainTurnId = e.turnId;
      state.currentTurnId = null;
      state.currentTurnStartedAt = null;
      state.nativeWorking = false;
      state.activeTools.clear();
      state.workerToolCoverage = false;
      state.waits.clear();
      state.activityVerified = true;
      state.revision += 1;
    }
    // The turn ended before a tool call took its steers: they open the next turn.
    for (const item of state.outbox)
      if (item.kind === "steer" && item.status === "pending" && item.turnId === e.turnId) {
        item.turnId = null;
        item.appendRefused = false;
        state.dirty = true;
      }
    // An end heard without a start is still evidence for the original receipt.
    // A late old end never clears the state of a newer identified turn.
    record(state, {
      type: "turn-complete",
      turnId: e.turnId,
      text: previewText(e.answer, MAX_STREAM),
      aborted: e.isAborted === true,
      revision: state.revision,
      occurredAt: Date.now(),
      ...(startedAt !== null ? { startedAt } : {}),
    });
    state.dirty = true;
    await deliverNow($, state).catch(() => {});
    // A new session's transcript exists after its first turn, so AgentKib can index it now.
    if (!state.connection && !state.needsReconnect) void autoConnect($, state).catch(() => {});
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    if (e.agentId !== undefined || !state.currentTurnId) return next(e);
    if (typeof e.tool_use_id !== "string" || !e.tool_use_id) {
      state.workerToolCoverage = false;
      state.dirty = true;
      return next(e);
    }
    const turnId = state.currentTurnId;
    const tool = { id: e.tool_use_id, name: e.tool, input: boundedJson(e), status: "running" };
    if (state.activeTools.has(tool.id)) state.workerToolCoverage = false;
    const active = {
      name: e.tool,
      input: e,
      turnId,
      command: { id: crypto.randomUUID(), startedAt: Date.now() },
    };
    state.activeTools.set(tool.id, active);
    state.workerActivityRevision += 1;
    if (e.tool === "AskUserQuestion") state.waits.set(active, "question");
    record(state, { type: "tool-start", turnId, tool, revision: state.revision });
    state.dirty = true;
    try {
      // Rows appended now reach the model with this tool's result, in this turn.
      await deliverSteers($, state);
      const result = await next(e);
      if (state.currentTurnId === turnId)
        record(state, {
          type: "tool-complete",
          turnId,
          tool: {
            ...tool,
            status: result?.isError || result?.deny ? "failed" : "completed",
            output: boundedJson(result),
          },
          revision: state.revision,
        });
      return result;
    } finally {
      if (state.activeTools.get(tool.id) === active) state.activeTools.delete(tool.id);
      if (state.currentTurnId === turnId) state.workerActivityRevision += 1;
      state.waits.delete(active);
      for (const owner of state.waits.keys()) if (owner.tool === active) state.waits.delete(owner);
      state.dirty = true;
    }
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    return next(e);
  });
  // A Project Agent's worker tools: AgentKib runs each call for this session and answers it. They
  // run without asking while the session leads, unless the person's rules say otherwise
  // (leadToolAllowed).
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_list" }, ($, e) =>
    leadCall($, state, "worker_list", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_open" }, ($, e) =>
    leadCall($, state, "worker_open", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_send" }, ($, e) =>
    leadCall($, state, "worker_send", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_read" }, ($, e) =>
    leadCall($, state, "worker_read", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_stop" }, ($, e) =>
    leadCall($, state, "worker_stop", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_approve" }, ($, e) =>
    leadCall($, state, "worker_approve", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_answer" }, ($, e) =>
    leadCall($, state, "worker_answer", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_close" }, ($, e) =>
    leadCall($, state, "worker_close", e),
  );
  on("tool.call", { tool: "mcp__agentkib-bridge__worker_restart" }, ($, e) =>
    leadCall($, state, "worker_restart", e),
  );
  // Managed settings or a Team or Enterprise login load sec-default, which skips classic hooks of
  // user-installed plugins, so the PermissionRequest hook below never runs there. tool.check still
  // does, after tool.call: an `ask` verdict that a person answers (not a host) means the mode's
  // decider takes the call, normally the terminal's approval dialog. When that is answered is not
  // observable here, so the wait is the unconfirmed kind; it ends with the tool, its progress hint
  // or the turn, like the classic one. The verdict passes on unchanged.
  on("tool.check", async ($, e, next) => {
    let result = await next(e);
    if (leadToolAllowed(state, e, result))
      result = { decision: "allow", reason: "This session is a Project Agent in AgentKib." };
    const tool =
      e.agentId === undefined &&
      result?.decision === "ask" &&
      e.approver !== "host" &&
      typeof e.tool_use_id === "string"
        ? state.activeTools.get(e.tool_use_id)
        : undefined;
    if (tool && state.currentTurnId && tool.turnId === state.currentTurnId) {
      state.waits.set({ tool, turnId: state.currentTurnId }, "unknown");
      state.dirty = true;
    }
    return result;
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    return next(e);
  });
  on("classic.PermissionRequest", async ($, e, next) => {
    const owner = { tool: permissionTool(state, e), turnId: state.currentTurnId };
    state.waits.set(owner, "permission");
    state.dirty = true;
    try {
      // This classic hook runs before the native dialog. An empty answer does
      // not prove whether a person is still being asked or the tool has begun.
      const result = await next(e);
      if (state.waits.has(owner)) {
        if (["allow", "deny"].includes(result?.decision?.behavior)) state.waits.delete(owner);
        else state.waits.set(owner, "unknown");
      }
      return result;
    } catch (error) {
      if (state.waits.has(owner)) state.waits.set(owner, "unknown");
      throw error;
    } finally {
      state.dirty = true;
    }
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    return next(e);
  });
  on("classic.StopFailure", ($, e, next) => {
    if (currentLead(state) && mainClassicEvent(state, e)) {
      const turnId = state.currentTurnId ?? state.lastCompletedMainTurnId;
      state.leadFailedTurnId = turnId;
      if (e.error === "rate_limit") pauseLeadReports($, state, turnId);
    }
    return next(e);
  });
  on("classic.Notification", (_$, e, next) => {
    if (mainClassicEvent(state, e) && QUOTA_RESUME_NOTIFICATIONS.has(e.notification_type))
      resumeLeadReports(state);
    return next(e);
  });
  on("session.compact", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const generation = state.generation;
    state.compacting = true;
    state.compactStartedAt = Date.now();
    state.dirty = true;
    try {
      return await next(e);
    } finally {
      if (state.generation === generation) {
        state.compacting = false;
        state.dirty = true;
      }
    }
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    return next(e);
  });
  on("session.append", async ($, e, next) => {
    const pending = state.pendingSend ?? state.unconfirmedReport;
    if (e.agentId === undefined && pending && (e.door === "prompt" || e.door === "queue")) {
      const text = Array.isArray(e.message?.content)
        ? e.message.content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
      if (
        e.origin?.kind === "plugin" &&
        e.origin.name === "agentkib-bridge" &&
        e.door === "prompt" &&
        text === pending.text
      ) {
        // Self-raised prompt.submit hooks are skipped by Claude's re-entry
        // guard. This engine-stamped row proves which prompt actually entered.
        pending.observed = true;
        if (pending.report && e.message?.type === "user") pending.reportAppended = true;
      } else {
        pending.competing = true;
      }
    }
    state.dirty = true;
    return next(e);
  }).catch(async ($, e, next) => {
    if (next.called) throw new Error(next.error.message);
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    invalidate(state, "native-session-ended");
    // The original terminal must never wait for an offline AgentKib on exit,
    // clear or resume. The old lease notification is deliberately best-effort.
    void flush($, state);
    return next(e);
  });
}

/** Delegation forwards next, return, throw and the final native value unchanged. */
export function observeNativeStream(stream, observe) {
  const item = async (result) => {
    const value = await result;
    if (!value.done) observe(value.value);
    return value;
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(value) {
      return item(stream.next(value));
    },
    return(value) {
      return stream.return ? item(stream.return(value)) : Promise.resolve({ done: true, value });
    },
    throw(error) {
      if (stream.throw) return item(stream.throw(error));
      return Promise.reject(error);
    },
  };
}
