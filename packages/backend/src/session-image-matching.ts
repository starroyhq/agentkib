import type { ConversationEvent, ConversationEventPage } from "./session-events";

type LedgerPage = {
  events: Array<Record<string, unknown>>;
  next_cursor: string | null;
  warnings: string[];
};

function key(event: Record<string, unknown>): string | null {
  if (
    typeof event.turn_id !== "string" ||
    !["user-message", "agent-message"].includes(String(event.kind)) ||
    typeof event.content !== "string"
  )
    return null;
  // Native app-server projections bound text and add blank image-content lines.
  const content = [...event.content].slice(0, 32_768).join("").replace(/\n+$/, "");
  return JSON.stringify([event.turn_id, event.kind, content]);
}

/**
 * Connected managed sessions keep their ledger IDs and cursors. Image authority
 * still comes exclusively from verified native rows. Scan through each target
 * turn before accepting a unique match; repeated text is never guessed.
 */
export async function enrichLedgerImages(
  page: LedgerPage,
  read: (
    cursor: string | null,
    budget: { remainingBytes: number },
  ) => Promise<ConversationEventPage>,
): Promise<LedgerPage> {
  const targets = new Map<string, Record<string, unknown> | null>();
  const turns = new Set<string>();
  for (const event of page.events) {
    const identity = key(event);
    if (!identity) continue;
    targets.set(identity, targets.has(identity) ? null : event);
    turns.add(String(event.turn_id));
  }
  if (!targets.size) return page;
  const matches = new Map<string, ConversationEvent | null>();
  const settled = new Set<string>();
  const seen = new Set<string>();
  const budget = { remainingBytes: 32 * 1024 * 1024 };
  let cursor: string | null = null;
  let lastTurn: string | undefined;
  let complete = false;
  try {
    for (let count = 0; count < 64 && budget.remainingBytes > 0; count++) {
      const native = await read(cursor, budget);
      for (const event of [...native.events].reverse()) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (event.turn_id) {
          if (lastTurn && event.turn_id !== lastTurn && turns.has(lastTurn)) settled.add(lastTurn);
          lastTurn = event.turn_id;
        }
        const identity = key(event as unknown as Record<string, unknown>);
        if (!identity || !targets.has(identity)) continue;
        matches.set(identity, matches.has(identity) ? null : event);
      }
      cursor = native.next_cursor;
      if (!cursor) {
        for (const turn of turns) settled.add(turn);
        complete = true;
        break;
      }
      if ([...turns].every((turn) => settled.has(turn))) {
        complete = true;
        break;
      }
    }
  } catch {
    // History is optional enrichment of already readable ledger text. Never
    // return partially matched media when native identity or its snapshot fails.
    return { ...page, warnings: [...page.warnings, "SESSION_IMAGES_UNAVAILABLE"] };
  }
  for (const [identity, target] of targets) {
    const match = matches.get(identity);
    if (!target || !match?.images?.length || !settled.has(String(target.turn_id))) continue;
    target.images = match.images;
    target.attachment_count = Math.max(
      Number(target.attachment_count) || 0,
      match.attachment_count,
    );
  }
  return complete ? page : { ...page, warnings: [...page.warnings, "SESSION_IMAGES_SCAN_BUDGET"] };
}
