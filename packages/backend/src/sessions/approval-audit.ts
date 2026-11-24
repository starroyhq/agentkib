import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MANAGED_AGENTS,
  type ManagedAgent,
  type SessionApprovalAuditDecision,
  type SessionApprovalAuditEntry,
  type SessionApprovalAuditOutcome,
  type SessionApprovalAuditPage,
  type SessionApprovalAuditRisk,
  type SessionApprovalAuditSource,
} from "@agentkib/runtime-protocol";
import { z } from "zod";

const ENTRY_LIMIT = 1000;
const PAGE_LIMIT = 100;
const FILE_LIMIT = 2 * 1024 * 1024;
const TECHNICAL_ID = /^[a-z\d_.:@-]{1,256}$/i;
const DIGEST = /^[a-f\d]{64}$/;

const riskReasons = {
  deletion: ["high", "Requested a deletion."],
  network: ["high", "Requested network access."],
  "dependency-install": ["high", "Requested a dependency installation."],
  "outside-workspace": ["high", "Requested access outside the workspace."],
  "git-push": ["high", "Requested a Git push."],
  "unknown-operation": ["high", "Requested approval for an unclassified operation."],
  "unknown-workspace": ["high", "Requested approval without a verified workspace."],
  "workspace-write": ["file-modification", "Requested a change in the workspace."],
  "read-only": ["low", "Requested a read-only operation."],
  test: ["low", "Requested to run tests."],
  "static-check": ["low", "Requested to run a static check."],
  question: ["low", "Asked the user a question."],
} as const;

type RiskReason = keyof typeof riskReasons;
const isRiskReason = (value: unknown): value is RiskReason =>
  typeof value === "string" && Object.hasOwn(riskReasons, value);
const technicalId = z.string().regex(TECHNICAL_ID);
const storedEntry = z.strictObject({
  id: z.string().regex(DIGEST),
  sessionId: technicalId,
  agent: z.enum(MANAGED_AGENTS),
  workspaceId: technicalId.optional(),
  workspacePathDigest: z.string().regex(DIGEST).optional(),
  kind: z.enum(["approval", "question"]),
  risk: z.strictObject({
    level: z.enum(["high", "file-modification", "low"]),
    reason: z.custom<RiskReason>(isRiskReason),
  }),
  decision: z.strictObject({
    kind: z.enum(["allow", "deny", "cancel", "answer", "native"]),
    scope: z.enum(["once", "session", "persistent", "unknown"]),
  }),
  source: z.strictObject({
    kind: z.enum(["desktop", "web", "phone", "project-agent"]),
    deviceId: technicalId.optional(),
  }),
  time: z.iso.datetime({ precision: 3 }),
  result: z.enum(["executed", "denied", "expired", "unknown"]),
});

const storedDocument = z.strictObject({
  version: z.literal(1),
  entries: z.array(storedEntry).max(ENTRY_LIMIT),
});
type StoredEntry = z.infer<typeof storedEntry>;

export interface SessionApprovalAuditInput {
  requestId: string;
  sessionId: string;
  agent: ManagedAgent;
  workspaceId?: string;
  workspacePath?: string;
  kind: "approval" | "question";
  risk: SessionApprovalAuditRisk;
  decision: SessionApprovalAuditDecision;
  source: SessionApprovalAuditSource;
}

type WorkspaceScope = { id?: string; path?: string };
type ReceiptIdentity = Pick<SessionApprovalAuditInput, "requestId" | "sessionId" | "agent"> & {
  deviceId?: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryId({ agent, sessionId, deviceId, requestId }: ReceiptIdentity): string {
  return digest(JSON.stringify([agent, sessionId, deviceId, requestId]));
}

function sortableKey(entry: StoredEntry): string {
  return `${entry.time}|${entry.id}`;
}

function cursorKey(cursor: string): string {
  if (!/^[a-z\d_-]{1,160}$/i.test(cursor)) throw new Error("invalid_approval_audit_cursor");
  const key = Buffer.from(cursor, "base64url").toString("utf8");
  const [time, id, extra] = key.split("|");
  if (
    extra !== undefined ||
    !storedEntry.shape.time.safeParse(time).success ||
    !id ||
    !DIGEST.test(id) ||
    Buffer.from(key).toString("base64url") !== cursor
  )
    throw new Error("invalid_approval_audit_cursor");
  return key;
}

function normalizedRisk(input: SessionApprovalAuditInput): StoredEntry["risk"] {
  const risk = input.risk;
  if (
    isRiskReason(risk.reason) &&
    (risk.reason !== "question" || input.kind === "question") &&
    riskReasons[risk.reason][0] === risk.level
  )
    return { level: risk.level, reason: risk.reason };
  return { level: "high", reason: "unknown-operation" };
}

function publicEntry(entry: StoredEntry): SessionApprovalAuditEntry {
  const { workspacePathDigest: _pathDigest, ...fields } = entry;
  return { ...fields, summary: riskReasons[entry.risk.reason][1] };
}

/** The local runtime serializes all approval audit reads and writes through one store. */
export class SessionApprovalAuditStore {
  readonly #file: string;
  readonly #limit: number;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly options: { maxEntries?: number; now?: () => number } = {},
  ) {
    this.#file = join(directory, "approval-audit.json");
    const limit = options.maxEntries;
    this.#limit =
      limit !== undefined && Number.isSafeInteger(limit) && limit > 0
        ? Math.min(limit, ENTRY_LIMIT)
        : ENTRY_LIMIT;
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(work);
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #load(): Promise<StoredEntry[]> {
    try {
      const metadata = await lstat(this.#file);
      if (!metadata.isFile() || metadata.size > FILE_LIMIT)
        throw new Error("approval-audit-invalid");
      const handle = await open(
        this.#file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error("approval-audit-invalid");
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error("approval-audit-invalid");
          offset += bytesRead;
        }
        const document = storedDocument.safeParse(JSON.parse(bytes.toString("utf8")));
        if (!document.success) throw new Error("approval-audit-invalid");
        return document.data.entries;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // Avoid putting unreadable on-disk evidence (including JSON parser excerpts) in errors.
      throw new Error("approval-audit-unavailable");
    }
  }

  async #save(entries: StoredEntry[]) {
    const document = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(document) > FILE_LIMIT) throw new Error("approval-audit-unavailable");
    const temporary = `${this.#file}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await rm(temporary, { force: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(document);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#file);
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("approval-audit-unavailable");
    }
  }

  /** Reserve a single record per submitted decision before it can have an unknown outcome. */
  begin(
    input: SessionApprovalAuditInput,
    initial: "unknown" | "expired" = "unknown",
  ): Promise<{ id: string; created: boolean }> {
    return this.#serialize(async () => {
      const id = entryId({ ...input, deviceId: input.source.deviceId });
      const entries = await this.#load();
      if (entries.some((entry) => entry.id === id)) return { id, created: false };

      // Project only technical identities and fixed vocabulary. Driver text can quote a command,
      // a private path, a credential, or an answer without naming the sensitive value.
      const entry = storedEntry.safeParse({
        id,
        sessionId: input.sessionId,
        agent: input.agent,
        workspaceId: input.workspaceId,
        workspacePathDigest: input.workspacePath ? digest(input.workspacePath) : undefined,
        kind: input.kind,
        risk: normalizedRisk(input),
        decision: { kind: input.decision.kind, scope: input.decision.scope },
        source: { kind: input.source.kind, deviceId: input.source.deviceId },
        time: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        result: initial,
      });
      if (!entry.success) throw new Error("approval-audit-unavailable");
      entries.unshift(entry.data);
      await this.#save(entries.slice(0, this.#limit));
      return { id, created: true };
    });
  }

  finish(id: string, outcome: SessionApprovalAuditOutcome): Promise<void> {
    if (outcome === "unknown") return Promise.resolve();
    return this.#finish(id, () => outcome);
  }

  /** Upgrade a pending result after an authorized native receipt lookup, without replaying it. */
  finishReceipt(
    receipt: ReceiptIdentity & { result: "accepted" | "denied" | "expired" },
  ): Promise<void> {
    return this.#finish(entryId(receipt), ({ decision }) => {
      if (receipt.result !== "accepted") return receipt.result;
      return decision.kind === "deny" || decision.kind === "cancel" ? "denied" : "executed";
    });
  }

  #finish(
    id: string,
    outcome: (entry: StoredEntry) => Exclude<SessionApprovalAuditOutcome, "unknown">,
  ): Promise<void> {
    return this.#serialize(async () => {
      const entries = await this.#load();
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.result !== "unknown") return;
      entry.result = outcome(entry);
      await this.#save(entries);
    });
  }

  list(
    options: {
      limit?: number;
      before?: string;
      /** Omit only for the trusted desktop caller. Empty authorizes no workspace. */
      workspaceScopes?: readonly WorkspaceScope[];
    } = {},
  ): Promise<SessionApprovalAuditPage> {
    return this.#serialize(async () => {
      const { workspaceScopes, limit: requestedLimit = 50 } = options;
      const before = options.before === undefined ? undefined : cursorKey(options.before);
      const limit = Number.isSafeInteger(requestedLimit)
        ? Math.max(1, Math.min(PAGE_LIMIT, requestedLimit))
        : 50;
      const ids = new Set(workspaceScopes?.flatMap(({ id }) => (id ? [id] : [])));
      const pathDigests = new Set(
        workspaceScopes?.flatMap(({ path }) => (path ? [digest(path)] : [])),
      );
      const entries = (await this.#load())
        .filter((entry) => {
          if (before !== undefined && sortableKey(entry) >= before) return false;
          if (!workspaceScopes) return true;
          if (entry.workspaceId) return ids.has(entry.workspaceId);
          return !!entry.workspacePathDigest && pathDigests.has(entry.workspacePathDigest);
        })
        .sort((left, right) => {
          const first = sortableKey(left);
          const second = sortableKey(right);
          return first === second ? 0 : first > second ? -1 : 1;
        })
        .slice(0, limit + 1);
      const page = entries.slice(0, limit);
      return {
        entries: page.map(publicEntry),
        ...(entries.length > limit
          ? { nextCursor: Buffer.from(sortableKey(page[limit - 1]!)).toString("base64url") }
          : {}),
      };
    });
  }
}
