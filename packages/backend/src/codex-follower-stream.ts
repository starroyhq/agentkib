import { isCodexTurnEndEvent } from "./codex-turn-end";

type Item = Record<string, unknown>;
export interface CodexFollowerSnapshot {
  items: Item[];
  authoritativeTurnIds: string[];
}
const MAX_KNOWN_IDENTITIES = 4096;
const MAX_KNOWN_IDENTITY_BYTES = 256 * 1024;
const MAX_OBSERVED_TURNS = 128;
const MAX_OBSERVED_TURN_BYTES = 64 * 1024;
type Publish = (
  type: "state" | "text-delta" | "item-upsert" | "snapshot",
  payload: Item,
  live: Item,
  textItem?: Item,
) => void;

/** Native history owns persisted rows; the follower supplies per-message live overlays. */
export class CodexFollowerStream {
  #items = new Map<string, Item>();
  #outsideWindow = new Map<string, string>();
  #observedTurns = new Set<string>();
  #snapshot: CodexFollowerSnapshot = { items: [], authoritativeTurnIds: [] };

  snapshot(): CodexFollowerSnapshot {
    return {
      items: this.#snapshot.items.map((item) => ({ ...item })),
      authoritativeTurnIds: [...this.#snapshot.authoritativeTurnIds],
    };
  }

  publish(
    snapshot: { items: Item[]; authoritativeTurnIds?: string[] },
    live: Item,
    publish: Publish,
  ): void {
    // Consumers already render item-scoped deltas. Concatenating the whole turn
    // as fallback text duplicates commentary and hides subsequent messages.
    live = { ...live, streamText: "" };
    publish("state", live, live);
    const current = new Map<string, Item>();
    for (const item of snapshot.items) {
      if (
        typeof item.id === "string" &&
        item.kind === "agent-message" &&
        (item.turn_id === live.turnId ||
          (item.turn_meta && this.#observedTurns.has(String(item.turn_id))) ||
          this.#items.has(item.id) ||
          this.#outsideWindow.has(item.id))
      )
        current.set(item.id, item);
    }
    const covered = new Set(snapshot.authoritativeTurnIds ?? []);
    for (const [id, item] of this.#items)
      if (!current.has(id) && typeof item.turn_id === "string")
        this.#outsideWindow.set(id, item.turn_id);
    const removed: string[] = [];
    for (const [id, turnId] of this.#outsideWindow) {
      if (current.has(id)) this.#outsideWindow.delete(id);
      else if (covered.has(turnId)) {
        removed.push(id);
        this.#outsideWindow.delete(id);
      }
    }
    // Keep identities, not old message bodies, until their turn is covered again.
    let identityBytes = 0;
    for (const [id, turnId] of [...this.#outsideWindow].reverse()) {
      identityBytes += Buffer.byteLength(id) + Buffer.byteLength(turnId);
      if (identityBytes > MAX_KNOWN_IDENTITY_BYTES) this.#outsideWindow.delete(id);
    }
    while (this.#outsideWindow.size > MAX_KNOWN_IDENTITIES)
      this.#outsideWindow.delete(this.#outsideWindow.keys().next().value!);
    for (const turn of [
      ...[...current.values()].map((item) => String(item.turn_id)),
      ...this.#outsideWindow.values(),
      ...(typeof live.turnId === "string" ? [live.turnId] : []),
    ])
      this.#observedTurns.add(turn);
    let turnBytes = 0;
    for (const turn of [...this.#observedTurns].reverse()) {
      turnBytes += Buffer.byteLength(turn);
      if (turnBytes > MAX_OBSERVED_TURN_BYTES) this.#observedTurns.delete(turn);
    }
    while (this.#observedTurns.size > MAX_OBSERVED_TURNS)
      this.#observedTurns.delete(this.#observedTurns.values().next().value!);
    this.#snapshot = {
      items: snapshot.items.filter((item) => this.#observedTurns.has(String(item.turn_id))),
      authoritativeTurnIds: (snapshot.authoritativeTurnIds ?? []).filter((turn) =>
        this.#observedTurns.has(turn),
      ),
    };
    if (removed.length)
      publish("snapshot", { items: [], replaceItemIds: removed, completeItems: false }, live);
    for (const [id, item] of current) {
      const previous = this.#items.get(id);
      if (JSON.stringify(previous) === JSON.stringify(item)) continue;
      const { content, ...metadata } = item;
      const { content: before, ...oldMetadata } = previous ?? {};
      if (
        typeof content === "string" &&
        typeof before === "string" &&
        content.length > before.length &&
        content.startsWith(before) &&
        JSON.stringify(metadata) === JSON.stringify(oldMetadata)
      )
        publish(
          "text-delta",
          {
            itemId: id,
            turnId: item.turn_id,
            offset: before.length,
            text: content.slice(before.length),
            ephemeral: true,
          },
          live,
          item,
        );
      else publish("item-upsert", item, live);
    }
    this.#items = current;
  }
}

/** Replace only verified, fully covered native message ranges; file rows keep their rich metadata. */
export function mergeCodexFollowerSnapshot(
  history: { items: Item[]; completeItems: boolean },
  snapshot: CodexFollowerSnapshot,
): { items: Item[]; completeItems: boolean; authoritativeTurnIds: string[] } {
  const covered = new Set(snapshot.authoritativeTurnIds);
  const nativeTurns = new Map<string, Item[]>();
  for (const item of snapshot.items) {
    if (typeof item.turn_id !== "string") continue;
    const rows = nativeTurns.get(item.turn_id) ?? [];
    rows.push(item);
    nativeTurns.set(item.turn_id, rows);
  }
  const historyTurns = new Map<string, Item[]>();
  for (const item of history.items) {
    if (typeof item.turn_id !== "string" || !covered.has(item.turn_id)) continue;
    const rows = historyTurns.get(item.turn_id) ?? [];
    rows.push(item);
    historyTurns.set(item.turn_id, rows);
  }
  for (const turn of covered) {
    const rows = historyTurns.get(turn);
    // Native message coverage cannot prove that a bounded file page also has
    // all rich tool/user rows. Its user boundary proves that whole turn fits.
    if (!history.completeItems && rows?.length && rows[0].kind !== "user-message")
      covered.delete(turn);
  }
  const emitted = new Set<string>();
  const items: Item[] = [];
  for (const row of history.items) {
    const turn = typeof row.turn_id === "string" ? row.turn_id : null;
    if (!turn || !covered.has(turn)) {
      items.push(row);
      continue;
    }
    if (emitted.has(turn)) continue;
    emitted.add(turn);
    items.push(...mergeTurn(historyTurns.get(turn) ?? [], nativeTurns.get(turn) ?? []));
  }
  for (const [turn, native] of nativeTurns) {
    if (!covered.has(turn) || emitted.has(turn)) continue;
    emitted.add(turn);
    items.push(...mergeTurn([], native));
  }
  const ids = new Set(items.map((item) => item.id));
  const fileMessageTurns = new Set(
    history.items.filter((item) => item.kind === "agent-message").map((item) => item.turn_id),
  );
  for (const item of snapshot.items) {
    if (item.kind !== "agent-message" || covered.has(String(item.turn_id))) continue;
    const position = items.findIndex((row) => row.id === item.id);
    if (position >= 0) {
      const row = items[position];
      const fuller =
        item.truncated === true &&
        typeof row.content === "string" &&
        typeof item.content === "string" &&
        row.content.startsWith(item.content);
      items[position] = {
        ...row,
        ...item,
        ...(fuller ? { content: row.content, truncated: row.truncated } : {}),
        ...(Array.isArray(row.images) ? { images: row.images } : {}),
      };
      continue;
    }
    // A partial file turn has no reliable native-to-file ordinal mapping.
    // Do not replay its historical native rows under a second set of IDs;
    // subsequent live notifications can still deliver the growing tail.
    if (ids.has(item.id)) continue;
    const marker = isCodexTurnEndEvent(item);
    if (marker || isCodexTurnError(item)) {
      let after = items.length;
      while (after > 0 && items[after - 1]?.turn_id !== item.turn_id) after--;
      if (after > 0) {
        if (marker && items.some((row) => row.turn_id === item.turn_id && row.turn_meta)) continue;
        ids.add(item.id);
        items.splice(after, 0, item);
        continue;
      }
    }
    if (fileMessageTurns.has(item.turn_id)) continue;
    ids.add(item.id);
    items.push(item);
  }
  return { ...history, items, authoritativeTurnIds: [...covered] };
}

function mergeTurn(history: Item[], native: Item[]): Item[] {
  if (!history.length) return native.map((item) => ({ ...item }));
  const marker = native.find(isCodexTurnEndEvent);
  if (marker) {
    // The marker is metadata, so it cannot substitute for a persisted message
    // when the follower has no text item for that turn.
    return history.some((item) => item.turn_meta) ? history : [...history, marker];
  }
  const failure = native.find(isCodexTurnError);
  if (failure && !native.some((item) => item.kind === "agent-message" && item !== failure)) {
    // A failure row is not a replacement for the assistant's preceding reply.
    const persisted = history.find((item) => item.id === failure.id);
    return [...history.filter((item) => item.id !== failure.id), { ...persisted, ...failure }];
  }
  const persistedMessages = history.filter((item) => item.kind === "agent-message");
  const nativeMessages = native.filter((item) => item.kind === "agent-message");
  let matched = 0;
  const messages = nativeMessages.map((item) => {
    const found = persistedMessages.findIndex(
      (row, index) =>
        index >= matched &&
        (row.id === item.id ||
          (typeof row.content === "string" &&
            typeof item.content === "string" &&
            (row.content === item.content ||
              (item.truncated === true && row.content.startsWith(item.content))) &&
            (!row.message_phase ||
              !item.message_phase ||
              row.message_phase === item.message_phase))),
    );
    if (found < 0) return item;
    matched = found + 1;
    const row = persistedMessages[found];
    const fuller =
      item.truncated === true &&
      typeof row.content === "string" &&
      typeof item.content === "string" &&
      row.content.startsWith(item.content);
    return {
      ...row,
      ...item,
      ...(fuller ? { content: row.content, truncated: row.truncated } : {}),
      ...(Array.isArray(row.images) ? { images: row.images } : {}),
      attachment_count: Math.max(
        Number(item.attachment_count) || 0,
        Number(row.attachment_count) || 0,
      ),
    };
  });
  const nativeAnchors = native.filter((item) => item.kind !== "agent-message");
  const historyAnchors = history.filter((item) => item.kind !== "agent-message");
  const sameShape =
    nativeAnchors.length === historyAnchors.length &&
    nativeAnchors.every((item, index) => item.kind === historyAnchors[index].kind);
  if (sameShape) {
    let anchor = 0;
    let message = 0;
    return native.flatMap((item) =>
      item.kind === "agent-message" ? [messages[message++]] : [historyAnchors[anchor++]],
    );
  }
  // A bounded file page may miss native anchors. Keep every file user/tool row
  // and its order, and use existing message positions before appending new replies.
  const result: Item[] = [];
  let message = 0;
  for (const item of history) {
    if (item.kind !== "agent-message") result.push(item);
    else if (message < messages.length) result.push(messages[message++]);
  }
  result.push(...messages.slice(message));
  return result;
}

function isCodexTurnError(item: Item): boolean {
  return typeof item.turn_id === "string" && item.id === `codex-turn-error:${item.turn_id}`;
}
