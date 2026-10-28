/**
 * How a managed Claude session reacts to stream-json frames it does not fully understand.
 *
 * Every class of frame gets one of three treatments: observe (ignore and count), refuse (answer the
 * CLI with an error or a denial and carry on), or terminate (stop the session with a coded reason).
 * Nothing in here ever approves anything: an unknown request is refused, never allowed.
 *
 * Only synthetic frames exercise this; a real CLI has not been run against it.
 */

export type FrameOrigin =
  | { kind: "main" }
  | { kind: "subagent"; spawner: string }
  | { kind: "unattributed" };

/**
 * Whose frame this is. A missing or null `parent_tool_use_id` is the main thread; a bounded
 * non-empty string is the spawning Agent call of a sub-agent; anything else cannot be attributed,
 * and is never mistaken for the main thread.
 */
export function frameOrigin(frame: { parent_tool_use_id?: unknown }): FrameOrigin {
  const parent = frame.parent_tool_use_id;
  if (parent === undefined || parent === null) return { kind: "main" };
  if (typeof parent === "string" && parent !== "" && Buffer.byteLength(parent) <= 256)
    return { kind: "subagent", spawner: parent };
  return { kind: "unattributed" };
}

export type ClaudeTerminationCode =
  | "claude-background-task"
  | "claude-unrequested-turn"
  | "claude-protocol-violation";

export const CLAUDE_TERMINATION_CODES: readonly ClaudeTerminationCode[] = [
  "claude-background-task",
  "claude-unrequested-turn",
  "claude-protocol-violation",
];

/**
 * A turn the CLI ended itself for a reason the user can fix. Unlike a termination code it does
 * not stop the session: the reason is shown while the session stays idle and usable.
 */
export type ClaudeTurnFailureCode = "claude-auth-failed";

/** A reason that stops the session. `message` stays the English text tests and logs rely on. */
export class ClaudeProtocolError extends Error {
  constructor(
    readonly code: ClaudeTerminationCode,
    message: string,
  ) {
    super(message);
  }
}

/** A turn the CLI itself reports as failed: its text is for the user and carries no code. */
export class ClaudeTurnFailure extends Error {}

/** The code at the start of a stored failure reason, or null for any other reason. */
export function terminationCodeOf(reason: unknown): ClaudeTerminationCode | null {
  if (typeof reason !== "string") return null;
  return (
    CLAUDE_TERMINATION_CODES.find((code) => reason === code || reason.startsWith(`${code}: `)) ??
    null
  );
}

const stripControl = (value: string) =>
  Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");

/** `<code>: <detail>`, with the detail cleaned and bounded; `version` is added only when newer. */
export function formatTermination(
  code: ClaudeTerminationCode | ClaudeTurnFailureCode,
  detail: string,
  newerThanVerified?: { version: string; verified: string },
): string {
  const clean = stripControl(detail).slice(0, 200);
  const note = newerThanVerified
    ? ` (Claude Code ${newerThanVerified.version}, newer than the ${newerThanVerified.verified} AgentKib verified)`
    : "";
  return `${code}: ${clean}${note}`;
}

export const REFUSED_REQUEST_TEXT = "This request is not supported by AgentKib managed sessions.";
export const REFUSED_INTERACTION_TEXT =
  "AgentKib managed sessions cannot show this tool's approval interface, so the call was not run. Tell the user to run this step in the Claude Code terminal.";

/** The CLI sees this as a failed request. It can never be mistaken for an approval. */
export const controlError = (requestId: string, error = REFUSED_REQUEST_TEXT) => ({
  type: "control_response",
  response: { subtype: "error", request_id: requestId, error },
});

export const controlDeny = (requestId: string, message = REFUSED_INTERACTION_TEXT) => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message } },
});

/** At most this many unsupported control requests are answered in one turn before the stream is judged broken. */
export const MAX_UNKNOWN_REQUESTS_PER_TURN = 1024;

const MAX_UNKNOWN_FIELDS = 32;
const MAX_UNKNOWN_FIELD_BYTES = 4096;
const TRUNCATED = "[truncated]";
const FORBIDDEN_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const clipBytes = (text: string, max: number): string => {
  if (Buffer.byteLength(text) <= max) return text;
  let end = Math.min(text.length, max);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > max) end--;
  return `${text.slice(0, end)}${TRUNCATED}`;
};

/**
 * Permission-request fields that this version does not know, bounded for display only. They can
 * never widen what an approval allows: the answer carries just the decision and the original input.
 * Names that are not plain identifiers, that collide with `reserved` or object internals, or that
 * exceed the cap are dropped and reported in `dropped`.
 */
export function boundedUnknownFields(
  request: Record<string, unknown>,
  known: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): { fields: Record<string, string>; accepted: string[]; dropped: string[] } {
  const entries: Array<[string, string]> = [];
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(request)) {
    if (known.has(name)) continue;
    if (
      !/^[A-Za-z0-9_]{1,64}$/.test(name) ||
      FORBIDDEN_FIELD_NAMES.has(name) ||
      reserved.has(name) ||
      entries.length >= MAX_UNKNOWN_FIELDS
    ) {
      dropped.push(name);
      continue;
    }
    let text: string;
    try {
      text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
    } catch {
      text = "[unserializable]";
    }
    entries.push([name, clipBytes(text, MAX_UNKNOWN_FIELD_BYTES)]);
  }
  return {
    fields: Object.fromEntries(entries),
    accepted: entries.map(([name]) => name),
    dropped,
  };
}

export type DiagnosticCategory =
  | "ignoredFrameTypes"
  | "refusedRequests"
  | "refusedTools"
  | "unknownPermissionFields"
  | "observedTaskTypes"
  | "unattributedFrames";

const DIAGNOSTIC_LABELS: Record<DiagnosticCategory, string> = {
  ignoredFrameTypes: "ignored frame type",
  refusedRequests: "refused control request",
  refusedTools: "refused tool that needs user interaction",
  unknownPermissionFields: "showed unknown permission field",
  observedTaskTypes: "observed task type",
  unattributedFrames: "ignored unattributed frame",
};

const MAX_KEYS_PER_CATEGORY = 32;

/** Counts by category and bounded key. Never holds frame content and never throws. */
export class ClaudeProtocolDiagnostics {
  readonly #counts = new Map<DiagnosticCategory, Map<string, number>>();
  #fresh: Array<{ category: DiagnosticCategory; key: string }> = [];

  /** Keys are cut to a safe shape so nothing the CLI sends can reach a log line unfiltered. */
  static key(value: unknown): string {
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "other";
  }

  record(category: DiagnosticCategory, value: unknown): void {
    try {
      let counts = this.#counts.get(category);
      if (!counts) this.#counts.set(category, (counts = new Map()));
      let key = ClaudeProtocolDiagnostics.key(value);
      if (!counts.has(key) && counts.size >= MAX_KEYS_PER_CATEGORY) key = "other";
      const seen = counts.get(key);
      counts.set(key, (seen ?? 0) + 1);
      if (seen === undefined) this.#fresh.push({ category, key });
    } catch {
      // Diagnostics must never affect the frame path.
    }
  }

  /** Keys seen for the first time since the last call, for a single log line each. */
  takeNew(): Array<{ category: DiagnosticCategory; key: string; label: string }> {
    const fresh = this.#fresh;
    this.#fresh = [];
    return fresh.map((entry) => ({ ...entry, label: DIAGNOSTIC_LABELS[entry.category] }));
  }

  snapshot(): Partial<Record<DiagnosticCategory, Record<string, number>>> {
    const out: Partial<Record<DiagnosticCategory, Record<string, number>>> = {};
    for (const [category, counts] of this.#counts) out[category] = Object.fromEntries(counts);
    return out;
  }
}
