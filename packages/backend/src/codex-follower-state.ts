type JsonRecord = Record<string, unknown>;

const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;
const MAX_PATCHES = 4096;
const MAX_PATCH_DEPTH = 64;

export type CodexFollowerStatus =
  | "waiting-for-snapshot"
  | "idle"
  | "running"
  | "awaiting-approval"
  | "outcome-unknown"
  | "unsupported"
  | "disconnected";

/** Validates and applies the official Codex desktop follower stream without mutating inputs. */
export class CodexFollowerState {
  #snapshot: JsonRecord | null = null;
  #revision: number | null = null;
  #snapshotCount = 0;
  #valid = true;
  #status: CodexFollowerStatus = "waiting-for-snapshot";
  readonly conversationId: string;
  readonly ownerClientId: string;

  constructor(conversationId: string, ownerClientId: string) {
    if (!conversationId || !ownerClientId) throw new Error("invalid-follower-identity");
    this.conversationId = conversationId;
    this.ownerClientId = ownerClientId;
  }

  get status(): CodexFollowerStatus {
    return this.#status;
  }

  get revision(): number | null {
    return this.#revision;
  }

  get snapshotCount(): number {
    return this.#snapshotCount;
  }

  snapshot(): Readonly<JsonRecord> | null {
    return this.#snapshot === null ? null : structuredClone(this.#snapshot);
  }

  activeTurn(): string | null {
    const turns = this.#conversationTurns();
    if (!turns) return null;
    const active = turns.find((turn) => turn.status === "inProgress")?.turnId;
    if (typeof active !== "string" || active.length === 0) return null;
    if (
      turns.some(
        (turn) =>
          (turn.status === "inProgress" && turn.turnId !== active) ||
          (turn.turnId === active && turn.status !== "inProgress"),
      )
    )
      return null;
    return active;
  }

  hasPendingRequest(requestId: unknown, turnId: string): boolean {
    const requests = this.#snapshot?.requests;
    return (
      Array.isArray(requests) &&
      requests.some(
        (request) =>
          isRecord(request) &&
          managedRequestKey(request.id) === managedRequestKey(requestId) &&
          isRecord(request.params) &&
          request.params.turnId === turnId &&
          request.params.threadId === this.conversationId,
      )
    );
  }

  approvals(controls: boolean): JsonRecord[] {
    const snapshot = this.#snapshot;
    const turnId = this.activeTurn();
    if (!snapshot || !turnId || !Array.isArray(snapshot.requests)) return [];
    const turns = this.#conversationTurns() ?? [];
    const result: JsonRecord[] = [];
    for (const request of snapshot.requests) {
      if (!isRecord(request) || !isRecord(request.params)) continue;
      const method = request.method;
      const params = structuredClone(request.params);
      if (
        !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
          String(method),
        ) ||
        params.threadId !== this.conversationId ||
        params.turnId !== turnId ||
        !validRequestId(request.id)
      )
        continue;
      if (method === "item/fileChange/requestApproval") {
        const item = turns
          .filter((turn) => turn.turnId === turnId)
          .flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []))
          .find(
            (value) =>
              isRecord(value) &&
              value.id === params.itemId &&
              value.type === "fileChange" &&
              Object.hasOwn(value, "changes"),
          );
        if (isRecord(item)) params.changes = item.changes;
      }
      result.push(projectFollowerApproval(request.id, turnId, String(method), params, controls));
    }
    return result;
  }

  questions(controls: boolean): JsonRecord[] {
    const snapshot = this.#snapshot;
    const turnId = this.activeTurn();
    if (!snapshot || !turnId || !Array.isArray(snapshot.requests)) return [];
    return snapshot.requests.flatMap((request) => {
      if (
        !isRecord(request) ||
        request.method !== "item/tool/requestUserInput" ||
        !isRecord(request.params) ||
        request.params.threadId !== this.conversationId ||
        request.params.turnId !== turnId ||
        !validRequestId(request.id)
      )
        return [];
      const projection = projectNativeQuestions(request.params);
      if (!projection) return [];
      return [
        {
          requestId: request.id,
          turnId,
          method: request.method,
          supported: controls && projection.supported,
          questions: projection.questions,
        },
      ];
    });
  }

  live(controls: boolean): JsonRecord {
    const approvals = this.approvals(controls);
    const questions = this.questions(controls);
    const turnId = this.activeTurn();
    const status = questions.length > 0 ? "waiting-input" : this.#status;
    return {
      sessionId: this.conversationId,
      executionMode: "codex-follower",
      status,
      revision: this.#revision,
      turnId,
      sendEnabled: controls && status === "idle",
      stopEnabled:
        controls &&
        turnId !== null &&
        (this.#status === "running" || this.#status === "awaiting-approval"),
      approvals,
      questions,
      reason: status === "unsupported" ? "follower-operation-unverified" : null,
    };
  }

  settingsState(supportsThreadSettings: boolean): JsonRecord {
    const snapshot = this.#snapshot;
    if (!snapshot)
      return {
        available: false,
        executionMode: "codex-follower",
        reason: "open-in-original-client",
      };
    const saved = isRecord(snapshot.latestThreadSettings) ? snapshot.latestThreadSettings : {};
    const current = isRecord(saved.collaborationMode) ? saved.collaborationMode : {};
    const currentMode = isRecord(current) ? current.mode : null;
    return {
      available: supportsThreadSettings,
      executionMode: "codex-follower",
      settings: {
        applicationStatus: supportsThreadSettings ? "confirmed" : "unknown",
        current: {
          model: Object.hasOwn(saved, "model") ? saved.model : (snapshot.latestModel ?? null),
          effort: Object.hasOwn(saved, "effort")
            ? saved.effort
            : (snapshot.latestReasoningEffort ?? null),
          mode:
            currentMode ??
            (isRecord(snapshot.latestCollaborationMode)
              ? (snapshot.latestCollaborationMode.mode ?? null)
              : null),
          serviceTier: saved.serviceTier ?? null,
          policyId: followerPolicyId(saved),
        },
        defaults: { model: null, effort: null, serviceTier: null },
        writable: {
          model: false,
          effort: false,
          mode: supportsThreadSettings,
          serviceTier: false,
          policy: supportsThreadSettings,
          restoreDefaults: false,
        },
      },
      collaborationModes: supportsThreadSettings
        ? [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ]
        : [],
      policies: [
        {
          id: "workspace-write-on-request",
          name: "Workspace write · ask when needed",
          description: "Can edit the workspace; risky actions still require user approval.",
        },
        {
          id: "full-access-on-request",
          name: "Full access · no approval prompts",
          description: "Can access the computer and network without prompting for approvals.",
        },
        {
          id: "workspace-write-auto-review",
          name: "Workspace write · agent review",
          description: "Can edit the workspace; the native agent reviews approval requests.",
        },
      ],
      revision: this.#revision,
      reason: supportsThreadSettings ? null : "follower-operation-unverified",
    };
  }

  /** Ignore unrelated owner traffic; malformed selected-thread changes invalidate this stream. */
  notification(value: unknown): void {
    if (!this.#valid || !isRecord(value) || value.type !== "broadcast") return;
    const params = isRecord(value.params) ? value.params : {};
    if (
      value.method === "client-status-changed" &&
      params.clientId === this.ownerClientId &&
      value.sourceClientId === this.ownerClientId &&
      value.version === 1 &&
      params.status === "disconnected"
    ) {
      this.invalidate("disconnected");
      return;
    }
    if (value.sourceClientId !== this.ownerClientId) return;
    if (value.method === "ipc-connection-reset") {
      this.invalidate("disconnected");
      return;
    }
    if (
      value.method !== "thread-stream-state-changed" ||
      params.conversationId !== this.conversationId ||
      params.hostId !== "local"
    )
      return;
    try {
      this.#applyChange(value, params);
    } catch {
      this.invalidate("unsupported");
    }
  }

  invalidate(status: "unsupported" | "disconnected" | "outcome-unknown"): void {
    this.#revision = null;
    this.#snapshot = null;
    this.#status = status;
    this.#valid = false;
  }

  markMutationDispatched(): void {
    if (this.#valid) this.#status = "outcome-unknown";
  }

  #applyChange(message: JsonRecord, params: JsonRecord): void {
    if (message.version !== 11 || !isRecord(params.change)) throw new Error("invalid-change");
    const change = params.change;
    const revision = safeRevision(change.revision);
    if (this.#revision === revision) {
      if (change.type !== "snapshot" || !deepEqual(this.#snapshot, change.conversationState))
        throw new Error("conflicting-stream-revision");
      this.#snapshotCount += 1;
      return;
    }
    if (this.#revision !== null && revision < this.#revision)
      throw new Error("stale-stream-revision");

    let candidate: unknown;
    if (change.type === "snapshot") {
      candidate = change.conversationState;
    } else if (change.type === "patches") {
      if (this.#revision === null || safeRevision(change.baseRevision) !== this.#revision)
        throw new Error("stream-revision-gap");
      if (!Array.isArray(change.patches) || change.patches.length > MAX_PATCHES)
        throw new Error("patch-limit-exceeded");
      candidate = structuredClone(this.#snapshot);
      for (const patch of change.patches) candidate = applyPatch(candidate, patch);
    } else {
      throw new Error("unknown-stream-change");
    }

    if (
      !isRecord(candidate) ||
      candidate.id !== this.conversationId ||
      candidate.hostId !== "local" ||
      !Array.isArray(candidate.turns) ||
      !Array.isArray(candidate.requests)
    )
      throw new Error("snapshot-identity-or-schema-mismatch");
    const turns = conversationTurns(candidate);
    if (!turns) throw new Error("unsupported-turn-history");
    const snapshotBytes = jsonBytes(candidate);
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) throw new Error("snapshot-limit-exceeded");

    let status: CodexFollowerStatus =
      isRecord(candidate.threadRuntimeStatus) && candidate.threadRuntimeStatus.type === "active"
        ? "running"
        : isRecord(candidate.threadRuntimeStatus) && candidate.threadRuntimeStatus.type === "idle"
          ? "idle"
          : "unsupported";
    if (turns.some((turn) => turn.status === "inProgress")) status = "running";
    if (candidate.requests.length > 0) status = "awaiting-approval";
    if (
      Array.isArray(candidate.unconfirmedTurnSubmissions) &&
      candidate.unconfirmedTurnSubmissions.length > 0
    )
      status = "outcome-unknown";
    this.#revision = revision;
    if (change.type === "snapshot") this.#snapshotCount += 1;
    this.#snapshot = candidate;
    this.#status = status;
    if ((status === "running" || status === "awaiting-approval") && this.activeTurn() === null)
      this.#status = "outcome-unknown";
  }

  #conversationTurns(): JsonRecord[] | null {
    return this.#snapshot === null ? null : conversationTurns(this.#snapshot);
  }
}

function conversationTurns(snapshot: JsonRecord): JsonRecord[] | null {
  if (!Array.isArray(snapshot.turns) || snapshot.turns.some((turn) => !isRecord(turn))) return null;
  const turns = [...snapshot.turns] as JsonRecord[];
  if (snapshot.turnHistory == null) return turns;
  if (!isRecord(snapshot.turnHistory) || snapshot.turnHistory.kind !== "canonical") return null;
  const history = snapshot.turnHistory.history;
  if (!isRecord(history) || !isRecord(history.entitiesByKey) || !Array.isArray(history.islands))
    return null;
  for (const island of history.islands) {
    if (!isRecord(island) || !Array.isArray(island.entries)) return null;
    for (const entry of island.entries) {
      if (!isRecord(entry) || typeof entry.value !== "string") return null;
      const turn = history.entitiesByKey[entry.value];
      if (!isRecord(turn)) return null;
      turns.push(turn);
    }
  }
  return turns;
}

/** Codex uses Immer-style array paths instead of JSON Pointer paths. */
function applyPatch(root: unknown, patchValue: unknown): unknown {
  if (!isRecord(patchValue) || !Array.isArray(patchValue.path))
    throw new Error("invalid-patch-path");
  const patch = patchValue;
  const path = patch.path as unknown[];
  if (path.length > MAX_PATCH_DEPTH) throw new Error("patch-path-too-deep");
  const operation = patch.op;
  if (!(["add", "replace", "remove"] as unknown[]).includes(operation))
    throw new Error("unsupported-patch-operation");
  if (operation !== "remove" && !Object.hasOwn(patch, "value"))
    throw new Error("patch-value-missing");
  if (path.length === 0) {
    if (operation !== "replace") throw new Error("unsupported-root-operation");
    return patch.value;
  }

  let parent = root;
  for (const component of path.slice(0, -1)) parent = getChild(parent, component);
  const key = path[path.length - 1];
  if (isRecord(parent)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("unsafe-patch-key");
    if (operation !== "add" && !Object.hasOwn(parent, key)) throw new Error("patch-key-missing");
    if (operation === "remove") delete parent[key];
    else parent[key] = patch.value;
  } else if (Array.isArray(parent)) {
    const index = arrayIndex(key);
    if (operation === "add") {
      if (index > parent.length) throw new Error("patch-index-out-of-bounds");
      parent.splice(index, 0, patch.value);
    } else {
      if (index >= parent.length) throw new Error("patch-index-out-of-bounds");
      if (operation === "remove") parent.splice(index, 1);
      else parent[index] = patch.value;
    }
  } else {
    throw new Error("patch-parent-not-container");
  }
  return root;
}

function getChild(parent: unknown, key: unknown): unknown {
  if (isRecord(parent)) {
    if (typeof key !== "string" || !Object.hasOwn(parent, key))
      throw new Error("patch-path-missing");
    return parent[key];
  }
  if (Array.isArray(parent)) {
    const index = arrayIndex(key);
    if (index >= parent.length) throw new Error("patch-index-out-of-bounds");
    return parent[index];
  }
  throw new Error("patch-parent-not-container");
}

function arrayIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid-patch-index");
  return Number(value);
}

function safeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid-stream-revision");
  return Number(value);
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("invalid-json-snapshot");
  return Buffer.byteLength(serialized, "utf8");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function managedRequestKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return "";
}

function validRequestId(value: unknown): boolean {
  return (
    (typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function projectNativeQuestions(params: JsonRecord): {
  supported: boolean;
  questions: JsonRecord[];
} | null {
  const rows = Array.isArray(params.questions) ? params.questions : [];
  if (rows.length === 0 || rows.length > 32) return null;
  let supported = true;
  const ids = new Set<string>();
  const questions = rows.map((value): JsonRecord => {
    const row = isRecord(value) ? value : {};
    const options = Array.isArray(row.options) ? row.options : [];
    const custom = row.isOther === true || row.options == null;
    const labels = new Set<string>();
    const valid =
      Object.keys(row).every((key) =>
        ["id", "header", "question", "isOther", "isSecret", "options"].includes(key),
      ) &&
      bounded(row.id, 256) &&
      !ids.has(String(row.id)) &&
      bounded(row.question, 16_384) &&
      (row.header == null || bounded(row.header, 1024)) &&
      (row.isOther == null || typeof row.isOther === "boolean") &&
      (row.isSecret == null || typeof row.isSecret === "boolean") &&
      (row.options == null || Array.isArray(row.options)) &&
      (custom || options.length > 0) &&
      options.length <= 100 &&
      options.every((option) => {
        if (!isRecord(option)) return false;
        const validOption =
          Object.keys(option).every((key) => ["label", "description"].includes(key)) &&
          bounded(option.label, 4096) &&
          !labels.has(String(option.label)) &&
          (option.description == null || bounded(option.description, 16_384));
        if (validOption) labels.add(String(option.label));
        return validOption;
      });
    supported &&= valid;
    if (typeof row.id === "string") ids.add(row.id);
    return {
      id: row.id ?? null,
      header: row.header ?? null,
      question: row.question ?? null,
      options,
      multiSelect: false,
      allowCustom: custom,
      isSecret: row.isSecret === true,
    };
  });
  return { supported, questions };
}

function projectFollowerApproval(
  requestId: unknown,
  turnId: string,
  method: string,
  details: JsonRecord,
  controls: boolean,
): JsonRecord {
  const commandRequest = method === "item/commandExecution/requestApproval";
  const validMetadata =
    !commandRequest ||
    ((details.kind == null || details.kind === "command") &&
      (details.startedAtMs == null ||
        (typeof details.startedAtMs === "number" &&
          Number.isSafeInteger(details.startedAtMs) &&
          details.startedAtMs >= 0)) &&
      (details.environmentId == null || details.environmentId === "local") &&
      (details.proposedExecpolicyAmendment == null ||
        (Array.isArray(details.proposedExecpolicyAmendment) &&
          details.proposedExecpolicyAmendment.length > 0 &&
          details.proposedExecpolicyAmendment.length <= 100 &&
          details.proposedExecpolicyAmendment.every((item) => bounded(item, 4096)))));
  const complete = commandRequest
    ? bounded(details.command, 16 * 1024) &&
      Boolean((details.command as string).trim()) &&
      absolutePath(details.cwd)
    : method === "item/fileChange/requestApproval" &&
      Array.isArray(details.changes) &&
      details.changes.length > 0 &&
      details.changes.length <= 100 &&
      details.changes.every(completeFileChange);
  const allowed = new Set([
    "threadId",
    "turnId",
    "itemId",
    "approvalId",
    "command",
    "cwd",
    "reason",
    "commandActions",
    "changes",
    "availableDecisions",
    ...(commandRequest
      ? ["kind", "startedAtMs", "environmentId", "proposedExecpolicyAmendment"]
      : []),
  ]);
  const unsupportedMetadata = Object.entries(details)
    .filter(([key, value]) => value !== null && !allowed.has(key))
    .slice(0, 32)
    .map(([key, value]) => ({
      field: [...key].slice(0, 80).join(""),
      type: valueType(value),
    }));
  const validDecisions =
    details.availableDecisions == null || Array.isArray(details.availableDecisions);
  const offered = Array.isArray(details.availableDecisions)
    ? details.availableDecisions
    : ["accept", "decline", "cancel"];
  const decisions = offered.filter((value) =>
    ["accept", "decline", "cancel"].includes(String(value)),
  );
  const supported =
    validDecisions &&
    validMetadata &&
    validRequestId(requestId) &&
    controls &&
    complete &&
    isRecord(details) &&
    unsupportedMetadata.length === 0 &&
    ["additionalPermissions", "networkApprovalContext", "grantRoot"].every(
      (key) => details[key] == null,
    ) &&
    decisions.length > 0;
  const unsupportedReason = supported
    ? null
    : !controls
      ? "control-disabled"
      : !complete
        ? "incomplete-operation-details"
        : unsupportedMetadata.length > 0
          ? "unsupported-metadata"
          : "unsupported-approval-contract";
  return {
    requestId,
    turnId,
    method,
    command: details.command ?? null,
    cwd: details.cwd ?? null,
    changes: details.changes ?? null,
    availableDecisions: supported ? decisions : [],
    supported,
    unsupportedReason,
    unsupportedMetadata,
    proposedExecpolicyAmendment:
      commandRequest && validMetadata ? (details.proposedExecpolicyAmendment ?? null) : null,
    environmentId: commandRequest && validMetadata ? (details.environmentId ?? null) : null,
  };
}

function completeFileChange(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !["path", "kind", "diff"].includes(key)))
    return false;
  if (!absolutePath(value.path) || !bounded(value.diff, 256 * 1024, true) || !isRecord(value.kind))
    return false;
  return (
    Object.keys(value.kind).every((key) => ["type", "movePath"].includes(key)) &&
    ["add", "update", "delete"].includes(String(value.kind.type)) &&
    (value.kind.movePath == null || absolutePath(value.kind.movePath))
  );
}

function absolutePath(value: unknown): boolean {
  return (
    typeof value === "string" && value.length > 0 && !value.includes("\0") && pathIsAbsolute(value)
  );
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/");
}

function bounded(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function followerPolicyId(settings: JsonRecord): string | null {
  const sandbox = isRecord(settings.sandboxPolicy) ? settings.sandboxPolicy : {};
  if (
    settings.approvalPolicy === "on-request" &&
    settings.approvalsReviewer === "user" &&
    sandbox.type === "workspaceWrite"
  )
    return "workspace-write-on-request";
  if (
    settings.approvalPolicy === "on-request" &&
    settings.approvalsReviewer === "agent" &&
    sandbox.type === "workspaceWrite"
  )
    return "workspace-write-auto-review";
  if (
    settings.approvalPolicy === "never" &&
    settings.approvalsReviewer === "user" &&
    sandbox.type === "dangerFullAccess"
  )
    return "full-access-on-request";
  return null;
}
