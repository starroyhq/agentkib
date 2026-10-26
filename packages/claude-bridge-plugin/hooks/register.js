// Host calls stay explicit for Claude Code's static plugin validation.
import {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
} from "./compatibility.js";

const CLI_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion;
const PLUGIN_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.pluginVersion;
// Native prompt.submit has no atomic idle/CAS option. Production sending stays
// closed; only an isolated test COPY replaces this literal to study the contract.
const SEND_CONTRACT_EXPERIMENT = false;
const MAX_STREAM = 96 * 1024;
const MAX_EVENTS = 256;
// The existing 250ms pump skips these ticks before retrying: about 1/2/4/8s.
const RECONNECT_BACKOFF_TICKS = [3, 7, 15, 31];
const PREVIEW_MARKER = "\n[AgentKib preview truncated; read the original history for full content]";
// A new session is pairable only after AgentKib indexes its transcript, so
// automatic pairing retries after later turns, a bounded number of times.
const AUTO_RETRY_LIMIT = 20;
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
    connectionFailure: null,
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
    streamText: "",
    streamBytes: 0,
    streamTruncated: false,
    nativeWorking: null,
    activeTools: new Map(),
    waits: new Map(),
    // A reload can happen mid-turn. Only native activity events establish idle.
    activityVerified: false,
    bufferPaused: false,
    overflowEpoch: 0,
    snapshotRecovery: null,
    sendDisabled: false,
    pendingSend: null,
    dirty: true,
    pumping: false,
    flushing: false,
    closed: false,
    needsReconnect: false,
    pairingRecoveryGeneration: null,
    reconnectGeneration: null,
    reconnectFailures: 0,
    reconnectDelayTicks: 0,
    lastSnapshot: null,
    termination: null,
    terminating: false,
    autoConnecting: false,
    autoTries: new Map(),
    autoDone: new Set(),
  };
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
  let cwd;
  try {
    nativeId = await $.session.id();
    requireGeneration(state, generation, "stale-native-identity");
    cwd = await $.session.cwd();
  } catch {
    requireGeneration(state, generation, "stale-native-identity");
    throw compatibilityFailure("bridge-capabilities-missing", version.version, [
      "session-identity",
    ]);
  }
  // A completed host read can belong to the session that just ended. It must
  // not overwrite or invalidate an identity explicitly paired in a later generation.
  requireGeneration(state, generation, "stale-native-identity");
  if (
    typeof nativeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ||
    typeof cwd !== "string" ||
    !cwd.startsWith("/")
  )
    throw new Error("unsupported-native-identity");
  if (state.identity && (state.identity.nativeId !== nativeId || state.identity.cwd !== cwd)) {
    invalidate(state, "native-identity-changed");
    void flush($, state);
    throw new Error("native-identity-changed");
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
  } catch {
    requireGeneration(state, generation, "stale-capability-probe");
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
    if (manifest?.version !== PLUGIN_VERSION)
      throw compatibilityFailure("bridge-plugin-update-required", observed.cliVersion);
  } catch (error) {
    requireGeneration(state, generation, "stale-capability-probe");
    if (error?.message === "bridge-plugin-update-required") throw error;
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
  state.activityVerified = false;
  state.nativeWorking = null;
  state.currentTurnId = null;
  state.streamText = "";
  state.streamBytes = 0;
  state.streamTruncated = false;
  state.activeTools.clear();
  state.waits.clear();
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
      usage: null,
      capabilities: { read: false, send: false, stop: false, approve: false, answer: false },
    };
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
  state.connectionFailure = null;
  state.needsReconnect = false;
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
  if (response?.status === 409 && decoded?.error === "bridge-lease-expired") {
    state.needsReconnect = true;
    throw new Error("bridge-lease-expired");
  }
  if ([401, 403, 410].includes(response?.status)) {
    invalidate(state, "binding-revoked");
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

async function snapshot($, state) {
  const observed = await identity($, state);
  const rows = await $.session.messages();
  const usage = await $.session.usage();
  const context = usage?.context;
  const numeric = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const waiting = waitingState(state);
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
    toolItems: visibleTools(rows),
    streamText: state.streamText,
    usage: context
      ? {
          tokens: numeric(context.tokens),
          window: numeric(context.window),
          percent: numeric(context.percent),
          observedAt: Date.now(),
        }
      : null,
    capabilities: {
      read: true,
      send:
        SEND_CONTRACT_EXPERIMENT &&
        !state.closed &&
        !state.needsReconnect &&
        state.activityVerified &&
        !state.sendDisabled &&
        !state.bufferPaused &&
        !state.currentTurnId &&
        !state.pendingSend,
      stop:
        !state.closed &&
        !state.needsReconnect &&
        !state.bufferPaused &&
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
  try {
    // Terminal evidence survives delta overflow and reconnect until acknowledged.
    for (const event of state.completions.values()) {
      if (state.events.length >= MAX_EVENTS) break;
      if (!state.events.some((entry) => entry.event === event))
        state.events.push({ seq: ++state.seq, event });
    }
    if (state.dirty && state.events.length < MAX_EVENTS) {
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
  if (command.expectedRevision !== state.revision) result.reason = "revision-conflict";
  else if (command.kind === "send") {
    if (!SEND_CONTRACT_EXPERIMENT) result.reason = "claude-native-send-experimental-disabled";
    else if (!validSend(command)) result.reason = "invalid-text";
    else if (
      state.closed ||
      state.sendDisabled ||
      state.bufferPaused ||
      !state.activityVerified ||
      state.currentTurnId ||
      state.pendingSend
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
  if (
    (!state.connection && !state.needsReconnect) ||
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
    const connection = state.connection;
    const response = await request($, state, "/v1/commands", {
      ...lease(state),
      afterCommandId: state.afterCommandId,
      waitMs: 20_000,
    });
    if (state.closed || state.connection !== connection) return;
    if (!Array.isArray(response?.commands) || response.commands.length > 1) {
      invalidate(state, "invalid-command-batch");
      return;
    }
    for (const command of response.commands) await execute($, state, command);
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
  state.credentialPath = response.credentialPath;
  state.closed = false;
  state.sendDisabled = false;
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
  const cwd = await $.session.cwd();
  if (!current()) return;
  if (
    typeof nativeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ||
    typeof cwd !== "string" ||
    !cwd.startsWith("/") ||
    cwd.includes("\0") ||
    cwd.split("/").includes("..")
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
  if (
    credential?.protocol !== 1 ||
    credential.nativeId !== nativeId ||
    credential.cwd !== cwd ||
    credential.pluginVersion !== PLUGIN_VERSION ||
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
    state.needsReconnect = false;
    return;
  }
  // A terminal with no saved binding does not need history/file/store-write
  // probes on startup. Every actual reconnect still repeats the full probe.
  const observed = await probeCapabilities($, state);
  if (state.generation !== generation || state.closed) throw new Error("stale-reconnect");
  const credential = JSON.parse(await $.fs.read(path));
  if (
    credential?.protocol !== 1 ||
    credential.nativeId !== observed.nativeId ||
    credential.cwd !== observed.cwd ||
    claudeBridgeCompatibility(credential.cliVersion) === "invalid" ||
    claudeBridgeCompatibility(credential.cliVersion) === "too-old" ||
    credential.pluginVersion !== PLUGIN_VERSION ||
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
    state.connectionFailure = null;
    state.credentialPath = path;
    state.closed = false;
    state.needsReconnect = false;
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
  if (state.connection || state.needsReconnect || state.autoConnecting || state.pendingSend) return;
  state.autoConnecting = true;
  let nativeId;
  try {
    nativeId = await $.session.id();
    if (typeof nativeId !== "string" || state.autoDone.has(nativeId)) return;
    // A session revoked in this terminal stays disconnected until a new code.
    if (state.closed && state.identity?.nativeId === nativeId) {
      state.autoDone.add(nativeId);
      return;
    }
    const tries = state.autoTries.get(nativeId) ?? 0;
    if (tries >= AUTO_RETRY_LIMIT) return;
    state.autoTries.set(nativeId, tries + 1);
    // A session paired earlier reconnects with its own credential instead.
    if (typeof (await $.store.get(`credentialPath:${nativeId}`)) === "string") {
      state.autoDone.add(nativeId);
      if (state.closed) {
        state.identity = null;
        state.closed = false;
        state.sendDisabled = false;
        state.needsReconnect = true;
      }
      return;
    }
    const sources = await discoverAgentKib($);
    if (!sources.length) return;
    // After /clear or /resume the previous conversation's identity no longer applies.
    if (state.closed) state.identity = null;
    const generation = ++state.generation;
    const observed = await probeCapabilities($, state);
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
        state.autoDone.add(nativeId);
        return;
      }
      // A stale key or a session not indexed yet: try the next source, then a later turn.
    }
  } catch (error) {
    // The local probe found this plugin or CLI unusable; retrying cannot change that.
    if (nativeId && INCOMPATIBLE_ERRORS.includes(error?.message)) {
      state.connectionFailure = {
        reason: error.message,
        ...(error.cliVersion ? { cliVersion: error.cliVersion } : {}),
      };
      state.autoDone.add(nativeId);
    }
    if (nativeId && AUTO_FINAL_ERRORS.includes(error?.message)) state.autoDone.add(nativeId);
  } finally {
    state.autoConnecting = false;
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

export function register(on) {
  const state = initialState();
  on("session.start", async ($, e, next) => {
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
    $.clock.every(250, () => flush($, state));
    $.clock.every(250, () => pump($, state));
    // Offline Runtime must not delay startup of the original terminal. A later
    // session.end or explicit pairing invalidates this background generation.
    // Without a saved binding, try automatic pairing for this workspace.
    void reconnect($, state)
      .catch(() => {})
      .then(() => autoConnect($, state))
      .catch(() => {});
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
          : "AgentKib bridge is not connected.",
  }));
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
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
      if (pending) pending.competing = true;
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
    state.currentTurnId = e.turnId;
    state.streamText = "";
    state.streamBytes = 0;
    state.streamTruncated = false;
    state.nativeWorking = true;
    state.activeTools.clear();
    state.waits.clear();
    state.activityVerified = true;
    state.revision += 1;
    const pending = state.pendingSend;
    if (pending?.observed && !pending.competing && pending.text === e.text)
      pending.turnId = e.turnId;
    record(state, { type: "turn-start", turnId: e.turnId, revision: state.revision });
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
        e.agentId === undefined &&
        e.turnId === state.currentTurnId &&
        chunk?.kind === "text" &&
        typeof chunk.text === "string"
      ) {
        if (state.closed || (!state.connection && !state.credentialPath)) return;
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
    if (e.turnId === state.currentTurnId || state.currentTurnId === null) {
      state.currentTurnId = null;
      state.nativeWorking = false;
      state.activeTools.clear();
      state.waits.clear();
      state.activityVerified = true;
      state.revision += 1;
    }
    // An end heard without a start is still evidence for the original receipt.
    // A late old end never clears the state of a newer identified turn.
    record(state, {
      type: "turn-complete",
      turnId: e.turnId,
      text: previewText(e.answer, MAX_STREAM),
      aborted: e.isAborted === true,
      revision: state.revision,
    });
    state.dirty = true;
    // A new session's transcript exists after its first turn, so AgentKib can index it now.
    if (!state.connection && !state.needsReconnect) void autoConnect($, state).catch(() => {});
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    if (e.agentId !== undefined || !state.currentTurnId || typeof e.tool_use_id !== "string")
      return next(e);
    const tool = { id: e.tool_use_id, name: e.tool, input: boundedJson(e), status: "running" };
    const active = { name: e.tool, input: e, turnId: state.currentTurnId };
    state.activeTools.set(tool.id, active);
    if (e.tool === "AskUserQuestion") state.waits.set(active, "question");
    record(state, { type: "tool-start", tool, revision: state.revision });
    state.dirty = true;
    try {
      const result = await next(e);
      record(state, {
        type: "tool-complete",
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
      state.waits.delete(active);
      for (const owner of state.waits.keys()) if (owner.tool === active) state.waits.delete(owner);
      state.dirty = true;
    }
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
  on("session.append", async ($, e, next) => {
    const pending = state.pendingSend;
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
