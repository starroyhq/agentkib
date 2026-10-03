import { performance } from "node:perf_hooks";
import { parseAntigravityReplay } from "./antigravity-replay";
import type { AntigravitySession } from "./antigravity-sessions";
import type { ConversationEvent, ConversationEventPage } from "./session-events";
export interface AntigravityHistory {
  executable(): string;
  resolve(nativeRef: string, deadline: number): Promise<AntigravitySession>;
  replay(
    nativeRef: string,
    deadline: number,
  ): Promise<{ session: AntigravitySession; updates: Record<string, unknown>[] }>;
}
interface Snapshot {
  id: bigint;
  executable: string;
  nativeRef: string;
  workspace: string;
  created: number;
  bytes: number;
  events: ConversationEvent[];
  warnings: string[];
}
type Cursor =
  | { type: "latest" }
  | { type: "legacy"; end: bigint }
  | { type: "snapshot"; id: bigint; end: bigint };
const MAX_BYTES = 256 * 1024 * 1024,
  MAX_U64 = 18446744073709551615n;
const MAX_USIZE = process.arch === "ia32" ? 4294967295n : MAX_U64;
let snapshots: Snapshot[] = [],
  nextId = 1n;
const length = (value: string | null | undefined) =>
  value === null || value === undefined ? 0 : Buffer.byteLength(value);
function integer(value: string, max: bigint): bigint {
  if (!/^\+?\d+$/.test(value)) throw new Error("Invalid Antigravity event cursor");
  const number = BigInt(value);
  if (number > max) throw new Error("Invalid Antigravity event cursor");
  return number;
}
function cursor(value: string | null): Cursor {
  if (value === null) return { type: "latest" };
  if (value.startsWith("antigravity-v1-"))
    return { type: "legacy", end: integer(value.slice("antigravity-v1-".length), MAX_USIZE) };
  if (!value.startsWith("antigravity-v2-")) throw new Error("Invalid Antigravity event cursor");
  const parts = value.slice("antigravity-v2-".length).split("-");
  if (parts.length !== 2) throw new Error("Invalid Antigravity event cursor");
  const id = integer(parts[0]!, MAX_U64),
    end = integer(parts[1]!, MAX_USIZE);
  if (id === 0n) throw new Error("Invalid Antigravity event cursor");
  return { type: "snapshot", id, end };
}
function prune(): void {
  const now = performance.now();
  snapshots = snapshots.filter((snapshot) => now - snapshot.created < 120_000);
}
function page(
  events: ConversationEvent[],
  warnings: string[],
  end: bigint,
  limit: number,
  id: bigint | null,
): ConversationEventPage {
  if (end > BigInt(events.length)) throw new Error("Invalid Antigravity event cursor");
  const offset = Number(end),
    start = Math.max(0, offset - limit);
  return {
    events: structuredClone(events.slice(start, offset)),
    warnings: [...warnings],
    next_cursor:
      start > 0
        ? id === null
          ? `antigravity-v1-${start}`
          : `antigravity-v2-${id}-${start}`
        : null,
  };
}
/** Four immutable snapshots share one 256 MiB budget, with native offset fallback after eviction. */
export class AntigravityPaging {
  constructor(readonly history: AntigravityHistory) {}
  async readEvents(
    nativeRef: string,
    value: string | null,
    limit: number,
  ): Promise<ConversationEventPage> {
    const deadline = performance.now() + 15_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid event page size");
    const position = cursor(value);
    const check = () => {
      if (performance.now() >= deadline)
        throw new Error("Antigravity ACP replay timed out while paginating history");
    };
    if (position.type === "snapshot") {
      const executable = this.history.executable();
      prune();
      const snapshot = snapshots.find(
        (snapshot) =>
          snapshot.id === position.id &&
          snapshot.executable === executable &&
          snapshot.nativeRef === nativeRef,
      );
      if (
        snapshot &&
        (await this.history.resolve(nativeRef, deadline)).workspace === snapshot.workspace
      ) {
        const result = page(snapshot.events, snapshot.warnings, position.end, limit, snapshot.id);
        check();
        return result;
      }
    }
    const { session, updates } = await this.history.replay(nativeRef, deadline),
      parsed = parseAntigravityReplay(updates, deadline);
    check();
    const end = position.type === "latest" ? BigInt(parsed.events.length) : position.end;
    if (position.type === "legacy") {
      const result = page(parsed.events, parsed.warnings, end, limit, null);
      check();
      return result;
    }
    if (end > BigInt(parsed.events.length)) throw new Error("Invalid Antigravity event cursor");
    // ConversationEvent is 160 bytes on the supported 64-bit Rust targets; retain its cache accounting.
    let bytes = parsed.warnings.reduce((total, warning) => total + length(warning), 0);
    for (const event of parsed.events)
      bytes +=
        160 +
        length(event.id) +
        length(event.turn_id) +
        length(event.content) +
        length(event.tool_name) +
        length(event.tool_status);
    if (bytes > MAX_BYTES) {
      const result = page(parsed.events, parsed.warnings, end, limit, null);
      check();
      return result;
    }
    const snapshot: Snapshot = {
      id: nextId,
      executable: this.history.executable(),
      nativeRef: session.id,
      workspace: session.workspace,
      created: performance.now(),
      bytes,
      events: parsed.events,
      warnings: parsed.warnings,
    };
    nextId = (nextId + 1n) & MAX_U64;
    prune();
    snapshots.push(snapshot);
    let total = snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0);
    while (snapshots.length > 4 || total > MAX_BYTES) total -= snapshots.shift()!.bytes;
    const result = page(snapshot.events, snapshot.warnings, end, limit, snapshot.id);
    check();
    return result;
  }
}
