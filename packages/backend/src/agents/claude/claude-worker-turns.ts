import type { LaneEndedTurn } from "../../orchestration-service";
import { verifiedNativeJsonlTail } from "../../native-jsonl-tail";
import { historyReadResult } from "../../read-state-history";
import type { ReadCheckpoint } from "../../read-state-ledger";
import { jsonTimestamp } from "../../session-history";

const MAX_TURNS = 50;
const nativeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A quit candidate must still be the latest native prompt and have no terminal marker. */
export function claudeWorkerHistoryHasOpenTurn(file: string, nativeId: string, turnId: string) {
  const cursor: ReadCheckpoint = {
    file,
    identity: "",
    offset: 0,
    baselineEnd: 0,
    lastItemId: null,
    lastTurnId: null,
  };
  for (const [position, line] of verifiedNativeJsonlTail(file, true).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.sessionId !== nativeId) continue;
    if (historyReadResult("claude-code", row, position, cursor)) cursor.lastTurnId = null;
  }
  return cursor.lastTurnId === turnId;
}

/** Only native completion markers in the verified parent transcript can prove an offline turn. */
export function claudeWorkerHistoryTurns(file: string, nativeId: string): LaneEndedTurn[] {
  const cursor: ReadCheckpoint = {
    file,
    identity: "",
    offset: 0,
    baselineEnd: 0,
    lastItemId: null,
    lastTurnId: null,
  };
  const turns: LaneEndedTurn[] = [];
  let startedAt: string | null = null;
  for (const [position, line] of verifiedNativeJsonlTail(file).entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.sessionId !== nativeId) continue;
    const previousTurn = cursor.lastTurnId;
    const result = historyReadResult("claude-code", row, position, cursor);
    if (cursor.lastTurnId !== previousTurn) startedAt = jsonTimestamp(row.timestamp);
    if (!result) continue;
    const endedAt = result.completedAt;
    const explicitId =
      typeof row.turn_id === "string" && nativeIdPattern.test(row.turn_id) ? row.turn_id : null;
    const markerId =
      typeof row.uuid === "string" && nativeIdPattern.test(row.uuid) ? row.uuid : null;
    const fallbackId =
      markerId ??
      result.itemId ??
      (result.turnId && nativeIdPattern.test(result.turnId) ? result.turnId : null);
    const turnId = explicitId ?? (fallbackId ? `claude-history:${fallbackId}` : null);
    const duration = row.duration_ms ?? row.durationMs;
    const startFromDuration =
      endedAt &&
      typeof duration === "number" &&
      Number.isSafeInteger(duration) &&
      duration > 0 &&
      duration < Date.parse(endedAt)
        ? new Date(Date.parse(endedAt) - duration).toISOString()
        : null;
    const start = startedAt ?? startFromDuration;
    if (turnId && endedAt && start && Date.parse(start) <= Date.parse(endedAt)) {
      turns.push({
        turnId,
        outcome: result.outcome === "ended" ? "completed" : result.outcome,
        startedAt: start,
        endedAt,
        ...(result.itemId ? { historyTurnId: result.itemId } : {}),
      });
    }
    cursor.lastTurnId = null;
    cursor.lastItemId = null;
    startedAt = null;
  }
  return turns.slice(-MAX_TURNS);
}

/** Consider uncertain aliases overlapping a recorded completion handled by the live observer. */
export function claudeWorkerUnobservedTurns(
  history: readonly LaneEndedTurn[],
  observed: readonly LaneEndedTurn[],
): LaneEndedTurn[] {
  return history.filter(
    (turn) =>
      !observed.some((live) => {
        if (
          turn.turnId === live.turnId ||
          (turn.historyTurnId !== undefined && turn.historyTurnId === live.historyTurnId)
        )
          return true;
        if (!turn.endedAt || !turn.startedAt || !live.endedAt) return false;
        const liveEnd = Date.parse(live.endedAt);
        const nativeEnd = Date.parse(turn.endedAt);
        if (Math.abs(nativeEnd - liveEnd) <= 2_000) return true;
        return (
          live.startedAt !== null &&
          Date.parse(live.startedAt) < nativeEnd &&
          Date.parse(turn.startedAt) < liveEnd
        );
      }),
  );
}
