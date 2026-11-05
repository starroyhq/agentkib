import { createHash, randomUUID } from "node:crypto";
import type { SessionStreamEvent, SessionSubscription } from "@agentkib/runtime-protocol";

const MAX_SUBSCRIPTIONS = 128;
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BATCH_BYTES = 32 * 1024;
const MAX_ITEM_COUNT = 4096;
const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_REMOVED_IDENTITIES = 4096;
const MAX_REMOVED_BYTES = 256 * 1024;
const TEXT_BATCH_DELAY_MS = 20;
const SNAPSHOT_INTERVAL_MS = 250;

interface Snapshot {
  live: Record<string, unknown>;
  items: Record<string, unknown>[];
  completeItems: boolean;
  authoritativeTurnIds?: string[];
}

interface Source {
  epoch: string;
  seq: number;
  historyRevision: number;
  snapshot: Snapshot;
  replay: SessionStreamEvent[];
  replayBytes: number;
  nextPollAt: number;
  removedItemIds: Set<string>;
  removedTurnIds: Set<string>;
  completeItemsFingerprint?: string;
  retentionOverflowed: boolean;
  historyCacheEpoch?: string;
  pendingText?: {
    payload: Record<string, unknown>;
    timer: ReturnType<typeof setTimeout>;
  };
}

interface Subscription {
  id: string;
  sessionId: string;
  delivered: number;
}

/** Bounded runtime event stream for native sessions; native history remains authoritative. */
export class SessionStreamHub {
  #sources = new Map<string, Source>();
  #subscriptions = new Map<string, Subscription>();
  #snapshotReads = new Map<
    string,
    { source: Source | undefined; historyRevision: number | undefined; promise: Promise<Snapshot> }
  >();
  #pendingSubscriptions = 0;
  #timer: ReturnType<typeof setInterval>;
  #polling = false;
  #closed = false;

  constructor(
    private readonly bootId: string,
    private readonly readSnapshot: (sessionId: string) => Promise<Snapshot>,
    private readonly notify: (event: SessionStreamEvent) => void,
    private readonly onSubscribed?: (sessionId: string) => void,
  ) {
    this.#timer = setInterval(() => void this.#poll(), SNAPSHOT_INTERVAL_MS);
    this.#timer.unref();
  }

  async subscribe(sessionId: string, afterCursor?: string): Promise<SessionSubscription> {
    if (this.#closed) throw new Error("session-stream-unavailable");
    if (sessionId.length > 256) throw new Error("invalid-session-id");
    if (this.#subscriptions.size + this.#pendingSubscriptions >= MAX_SUBSCRIPTIONS)
      throw new Error("session-subscription-limit");

    this.#pendingSubscriptions += 1;
    try {
      return await this.#subscribe(sessionId, afterCursor);
    } finally {
      this.#pendingSubscriptions -= 1;
    }
  }

  async #subscribe(sessionId: string, afterCursor?: string): Promise<SessionSubscription> {
    const previousSource = this.#sources.get(sessionId);
    const previousHistoryRevision = previousSource?.historyRevision;
    const snapshot = await this.#readSnapshot(sessionId, previousSource);
    if (this.#closed) throw new Error("session-stream-unavailable");
    let source = this.#sources.get(sessionId);
    if (!source) {
      const initialItems = [...snapshot.items];
      const retainedAll = this.#retainItems(initialItems);
      const completeItems = snapshot.completeItems && retainedAll;
      source = {
        epoch: randomUUID(),
        seq: 0,
        historyRevision: 0,
        snapshot: {
          ...snapshot,
          items: initialItems,
          completeItems,
          authoritativeTurnIds: retainedCoverage(
            snapshot.authoritativeTurnIds,
            snapshot.items,
            initialItems,
          ),
        },
        replay: [],
        replayBytes: 0,
        nextPollAt: Date.now() + (sessionId ? SNAPSHOT_INTERVAL_MS : 2_000),
        removedItemIds: new Set(),
        removedTurnIds: new Set(),
        ...(snapshot.completeItems
          ? { completeItemsFingerprint: this.#itemsFingerprint(snapshot.items) }
          : {}),
        retentionOverflowed: snapshot.completeItems && !retainedAll,
        ...(snapshot.completeItems && !retainedAll ? { historyCacheEpoch: randomUUID() } : {}),
      };
      this.#sources.set(sessionId, source);
    } else {
      this.#flushText(sessionId, source);
      const reconciled =
        source !== previousSource || source.historyRevision !== previousHistoryRevision
          ? source.snapshot
          : this.#reconcileSnapshot(source, snapshot);
      if (JSON.stringify(source.snapshot) === JSON.stringify(reconciled)) {
        // Keep the live object fresh even when its JSON projection is equal.
        source.snapshot = reconciled;
      } else {
        source.snapshot = reconciled;
        this.#append(sessionId, source, "snapshot", {
          ...this.#snapshotPayload(source),
        });
        this.#broadcastLatest(sessionId, source);
      }
      // A completed read replaces the history projection even when its JSON
      // happens to match. In-flight older reads must not be allowed to commit.
      source.historyRevision += 1;
    }

    const subscriptionId = randomUUID();
    const cursorSequence = this.#sequence(afterCursor, source.epoch);
    const earliest = source.replay[0]?.seq ?? source.seq;
    const replayIsAvailable =
      cursorSequence !== undefined &&
      cursorSequence <= source.seq &&
      cursorSequence + 1 >= earliest;
    const events = replayIsAvailable
      ? source.replay
          .filter((event) => event.seq > cursorSequence)
          .map((event) => ({ ...event, subscriptionId }))
      : [
          this.#event(sessionId, subscriptionId, source, "snapshot", {
            ...this.#snapshotPayload(source),
          }),
        ];
    this.#subscriptions.set(subscriptionId, {
      id: subscriptionId,
      sessionId,
      delivered: source.seq,
    });
    if (sessionId) this.onSubscribed?.(sessionId);
    const last = events.at(-1);
    return {
      subscriptionId,
      events,
      cursor: last?.cursor ?? this.#cursor(source.epoch, source.seq),
    };
  }

  unsubscribe(subscriptionId: string): { removed: boolean } {
    const subscription = this.#subscriptions.get(subscriptionId);
    const removed = this.#subscriptions.delete(subscriptionId);
    if (
      subscription &&
      ![...this.#subscriptions.values()].some((item) => item.sessionId === subscription.sessionId)
    ) {
      const source = this.#sources.get(subscription.sessionId);
      if (source?.pendingText) clearTimeout(source.pendingText.timer);
      this.#sources.delete(subscription.sessionId);
    }
    return { removed };
  }

  hasSubscribers(sessionId: string): boolean {
    return [...this.#subscriptions.values()].some((item) => item.sessionId === sessionId);
  }

  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
    textItem?: Record<string, unknown>,
  ): void {
    const source = this.#sources.get(sessionId);
    if (!source || ![...this.#subscriptions.values()].some((item) => item.sessionId === sessionId))
      return;
    if (type === "text-delta") {
      this.#queueText(sessionId, source, payload, live, textItem);
      return;
    }
    this.#flushText(sessionId, source);
    if (type === "snapshot" && Array.isArray(payload.items)) {
      source.historyRevision += 1;
      const incoming = payload.items.filter(isRecord);
      const incomingIds = new Set(incoming.map((item) => item.id).filter(isString));
      const complete = payload.completeItems === true;
      const replaceIds = new Set(
        Array.isArray(payload.replaceItemIds) ? payload.replaceItemIds.filter(isString) : [],
      );
      const previousItems = source.snapshot.items.filter((item) => isString(item.id));
      if (complete || replaceIds.size)
        for (const item of previousItems) {
          if (!complete && !replaceIds.has(item.id as string)) continue;
          if (incomingIds.has(item.id as string)) continue;
          source.removedItemIds.add(item.id as string);
          if (complete && isString(item.turn_id)) source.removedTurnIds.add(item.turn_id);
        }
      const items = complete
        ? []
        : source.snapshot.items.filter((item) => !replaceIds.has(String(item.id)));
      for (const item of incoming) {
        const index = items.findIndex((candidate) => candidate.id === item.id);
        if (index >= 0) items[index] = item;
        else items.push(item);
        if (isString(item.id)) source.removedItemIds.delete(item.id);
        if (isString(item.turn_id)) source.removedTurnIds.delete(item.turn_id);
      }
      const beforeRetention = [...items];
      const retainedAll = this.#retainItems(items);
      source.snapshot = {
        live: live ?? (isRecord(payload.live) ? payload.live : source.snapshot.live),
        items,
        completeItems: complete && retainedAll,
        authoritativeTurnIds: retainedCoverage(
          source.snapshot.authoritativeTurnIds,
          beforeRetention,
          items,
        ),
      };
      this.#recordCompleteCoverage(source, incoming, complete, retainedAll);
      this.#boundRemoved(source);
      this.#append(sessionId, source, "snapshot", this.#snapshotPayload(source));
      this.#broadcastLatest(sessionId, source);
      return;
    }
    if (live) {
      source.snapshot = { ...source.snapshot, live };
      source.historyRevision += 1;
    }
    if (type === "item-upsert" && typeof payload.id === "string") {
      source.historyRevision += 1;
      const items = [...source.snapshot.items];
      const index = items.findIndex((item) => item.id === payload.id);
      if (index >= 0) items[index] = payload;
      else items.push(payload);
      const retainedAll = this.#retainItems(items);
      source.retentionOverflowed ||= !retainedAll;
      source.snapshot = {
        ...source.snapshot,
        items,
        completeItems: false,
        authoritativeTurnIds: retainedAll ? source.snapshot.authoritativeTurnIds : [],
      };
      source.removedItemIds.delete(payload.id);
      if (typeof payload.turn_id === "string") source.removedTurnIds.delete(payload.turn_id);
    }
    this.#append(sessionId, source, type, payload);
    const event = source.replay.at(-1);
    if (!event) return;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      this.notify({ ...event, subscriptionId: subscription.id });
      subscription.delivered = event.seq;
    }
  }

  aliasItem(
    sessionId: string,
    previousId: string,
    itemId: string,
    live: Record<string, unknown>,
  ): void {
    const source = this.#sources.get(sessionId);
    if (!source || ![...this.#subscriptions.values()].some((item) => item.sessionId === sessionId))
      return;
    if (previousId === itemId) return;
    const previous = source.snapshot.items.find((item) => item.id === previousId);
    if (!previous) return;
    source.historyRevision += 1;
    this.#flushText(sessionId, source);
    const replacement: Record<string, unknown> = { ...previous, id: itemId, ephemeral: false };
    const items = [...source.snapshot.items];
    const previousIndex = items.findIndex((item) => item.id === previousId);
    const targetIndex = items.findIndex((item) => item.id === itemId);
    if (previousIndex >= 0) items[previousIndex] = replacement;
    if (targetIndex >= 0 && targetIndex !== previousIndex) items.splice(targetIndex, 1);
    const retainedAll = this.#retainItems(items);
    source.retentionOverflowed ||= !retainedAll;
    source.snapshot = {
      ...source.snapshot,
      live,
      completeItems: false,
      authoritativeTurnIds: retainedAll ? source.snapshot.authoritativeTurnIds : [],
      items,
    };
    source.removedItemIds.add(previousId);
    source.removedItemIds.delete(itemId);
    if (typeof replacement.turn_id === "string") source.removedTurnIds.delete(replacement.turn_id);
    this.#boundRemoved(source);
    this.#append(sessionId, source, "snapshot", this.#snapshotPayload(source));
    this.#broadcastLatest(sessionId, source);
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const source of this.#sources.values())
      if (source.pendingText) clearTimeout(source.pendingText.timer);
    this.#subscriptions.clear();
    this.#sources.clear();
    this.#snapshotReads.clear();
  }

  #readSnapshot(sessionId: string, source: Source | undefined): Promise<Snapshot> {
    const historyRevision = source?.historyRevision;
    const pending = this.#snapshotReads.get(sessionId);
    if (pending && pending.source === source && pending.historyRevision === historyRevision)
      return pending.promise;

    // Share overlapping reads only. A published update or retired source must
    // start a fresh read; reusing its older result could undo a newer event.
    const read = { source, historyRevision, promise: this.readSnapshot(sessionId) };
    this.#snapshotReads.set(sessionId, read);
    const release = () => {
      if (this.#snapshotReads.get(sessionId) === read) this.#snapshotReads.delete(sessionId);
    };
    void read.promise.then(release, release);
    return read.promise;
  }

  async #poll(): Promise<void> {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    try {
      const sessionIds = new Set([...this.#subscriptions.values()].map((item) => item.sessionId));
      for (const sessionId of sessionIds) {
        if (this.#closed) return;
        const source = this.#sources.get(sessionId);
        if (!source || source.nextPollAt > Date.now()) continue;
        source.nextPollAt = Date.now() + (sessionId ? SNAPSHOT_INTERVAL_MS : 2_000);
        try {
          const historyRevision = source.historyRevision;
          const read = await this.#readSnapshot(sessionId, source);
          if (this.#sources.get(sessionId) !== source) continue;
          if (source.historyRevision !== historyRevision) {
            source.nextPollAt = Date.now();
            continue;
          }
          const snapshot = this.#reconcileSnapshot(source, read);
          if (JSON.stringify(source.snapshot) === JSON.stringify(snapshot)) continue;
          this.#flushText(sessionId, source);
          source.snapshot = snapshot;
          source.historyRevision += 1;
          this.#append(
            sessionId,
            source,
            sessionId === "" ? "invalidate" : "snapshot",
            sessionId === "" ? { domains: ["catalog"] } : this.#snapshotPayload(source),
          );
          for (const subscription of this.#subscriptions.values()) {
            if (subscription.sessionId !== sessionId) continue;
            const event = source.replay.at(-1);
            if (!event || event.seq <= subscription.delivered) continue;
            this.notify({ ...event, subscriptionId: subscription.id });
            subscription.delivered = event.seq;
          }
        } catch {
          // A transient provider read must not tear down other live sessions.
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #append(
    sessionId: string,
    source: Source,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    source.seq += 1;
    const event = this.#event(sessionId, "", source, type, payload);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    source.replay.push(event);
    source.replayBytes += bytes;
    while (source.replay.length > MAX_REPLAY_EVENTS || source.replayBytes > MAX_REPLAY_BYTES) {
      const removed = source.replay.shift();
      if (removed) source.replayBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }

  #queueText(
    sessionId: string,
    source: Source,
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
    textItem?: Record<string, unknown>,
  ): void {
    const itemId = payload.itemId;
    const text = payload.text;
    const offset = payload.offset;
    if (typeof itemId === "string") source.removedItemIds.delete(itemId);
    if (typeof payload.turnId === "string") source.removedTurnIds.delete(payload.turnId);
    if (
      typeof itemId !== "string" ||
      typeof text !== "string" ||
      !text ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      this.#flushText(sessionId, source);
      this.#append(sessionId, source, "snapshot", {
        live: live ?? source.snapshot.live,
        items: source.snapshot.items,
        replaceItems: true,
      });
      this.#broadcastLatest(sessionId, source);
      return;
    }

    const items = [...source.snapshot.items];
    const existingIndex = items.findIndex((item) => item.id === itemId);
    const existing = existingIndex >= 0 ? items[existingIndex] : undefined;
    const content = typeof existing?.content === "string" ? existing.content : "";
    if (content.length !== offset) {
      // A history read can already contain bytes that arrived on the native
      // socket just before this delta. Keep that agreeing, fuller copy.
      if (
        textItem?.id === itemId &&
        typeof textItem.content === "string" &&
        content.startsWith(textItem.content)
      )
        return;
      this.#flushText(sessionId, source);
      const replacement =
        textItem?.id === itemId
          ? textItem
          : {
              id: itemId,
              kind: "agent-message",
              turn_id: payload.turnId ?? null,
              content: typeof live?.streamText === "string" ? live.streamText : content,
              attachment_count: 0,
              truncated: false,
              ephemeral: payload.ephemeral === true,
            };
      if (existingIndex >= 0) items[existingIndex] = replacement;
      else items.push(replacement);
      const retainedAll = this.#retainItems(items);
      source.retentionOverflowed ||= !retainedAll;
      source.snapshot = {
        ...source.snapshot,
        live: live ?? source.snapshot.live,
        items,
        completeItems: false,
        authoritativeTurnIds: retainedAll ? source.snapshot.authoritativeTurnIds : [],
      };
      source.historyRevision += 1;
      this.#append(sessionId, source, "item-upsert", replacement);
      this.#broadcastLatest(sessionId, source);
      return;
    }

    const item = {
      ...existing,
      ...(textItem?.id === itemId ? textItem : {}),
      id: itemId,
      kind: "agent-message",
      turn_id: payload.turnId ?? existing?.turn_id ?? null,
      content: content + text,
      attachment_count: 0,
      truncated: textItem?.truncated ?? existing?.truncated ?? false,
      ephemeral: payload.ephemeral === true,
    };
    if (existingIndex >= 0) items[existingIndex] = item;
    else items.push(item);
    const retainedAll = this.#retainItems(items);
    source.retentionOverflowed ||= !retainedAll;
    source.snapshot = {
      ...source.snapshot,
      live: live ?? source.snapshot.live,
      items,
      completeItems: false,
      authoritativeTurnIds: retainedAll ? source.snapshot.authoritativeTurnIds : [],
    };
    source.historyRevision += 1;

    const pending = source.pendingText;
    const pendingPayload = pending?.payload;
    const pendingText = typeof pendingPayload?.text === "string" ? pendingPayload.text : "";
    const contiguous =
      pendingPayload?.itemId === itemId &&
      pendingPayload?.turnId === payload.turnId &&
      pendingPayload?.ephemeral === payload.ephemeral &&
      typeof pendingPayload.offset === "number" &&
      pendingPayload.offset + pendingText.length === offset;
    if (
      pending &&
      contiguous &&
      Buffer.byteLength(pendingText + text, "utf8") <= MAX_TEXT_BATCH_BYTES
    ) {
      pending.payload = { ...pendingPayload, text: pendingText + text };
      return;
    }

    this.#flushText(sessionId, source);
    const timer = setTimeout(() => this.#flushText(sessionId, source), TEXT_BATCH_DELAY_MS);
    timer.unref();
    source.pendingText = { payload, timer };
    if (Buffer.byteLength(text, "utf8") >= MAX_TEXT_BATCH_BYTES) this.#flushText(sessionId, source);
  }

  #flushText(sessionId: string, source: Source): void {
    const pending = source.pendingText;
    if (!pending) return;
    clearTimeout(pending.timer);
    source.pendingText = undefined;
    this.#append(sessionId, source, "text-delta", pending.payload);
    this.#broadcastLatest(sessionId, source);
  }

  #broadcastLatest(sessionId: string, source: Source): void {
    const event = source.replay.at(-1);
    if (!event) return;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      this.notify({ ...event, subscriptionId: subscription.id });
      subscription.delivered = event.seq;
    }
  }

  #reconcileSnapshot(source: Source, next: Snapshot): Snapshot {
    const covered = new Set(next.authoritativeTurnIds ?? []);
    const previous = new Map(source.snapshot.items.map((item) => [item.id, item]));
    const items = next.items.map((item) => {
      const live = previous.get(item.id);
      // A file can lag behind a live prefix even when no notification arrived
      // during this read. Verified native coverage still permits real rewrites.
      if (
        !covered.has(String(item.turn_id)) &&
        next.live.status !== "idle" &&
        item.turn_id === next.live.turnId &&
        live?.ephemeral === true &&
        live.kind === item.kind &&
        live.turn_id === item.turn_id &&
        typeof live.content === "string" &&
        typeof item.content === "string" &&
        live.content.length > item.content.length &&
        live.content.startsWith(item.content)
      )
        return { ...item, ...live };
      return item;
    });
    const ids = new Set(items.map((item) => item.id));
    const activeTurn =
      next.live.status !== "idle" && typeof next.live.turnId === "string" ? next.live.turnId : null;
    for (const item of source.snapshot.items) {
      if (
        item.ephemeral === true &&
        typeof item.id === "string" &&
        !ids.has(item.id) &&
        !covered.has(String(item.turn_id)) &&
        (!next.completeItems || (activeTurn !== null && item.turn_id === activeTurn))
      )
        items.push(item);
    }
    const coveredIds = new Set(items.map((item) => item.id));
    let completeItems = next.completeItems;
    if (next.completeItems || covered.size) {
      const missingTurns = new Set<string>();
      for (const item of source.snapshot.items) {
        if (
          (next.completeItems || covered.has(String(item.turn_id))) &&
          typeof item.id === "string" &&
          !coveredIds.has(item.id)
        )
          source.removedItemIds.add(item.id);
        if (
          typeof item.turn_id === "string" &&
          (next.completeItems || covered.has(item.turn_id)) &&
          !items.some((candidate) => candidate.turn_id === item.turn_id)
        )
          missingTurns.add(item.turn_id);
      }
      for (const turnId of missingTurns) source.removedTurnIds.add(turnId);
      for (const item of items) {
        if (typeof item.id === "string") source.removedItemIds.delete(item.id);
        if (typeof item.turn_id === "string") source.removedTurnIds.delete(item.turn_id);
      }
      this.#boundRemoved(source);
    }
    const retainedAll = this.#retainItems(items);
    if (!retainedAll) completeItems = false;
    this.#recordCompleteCoverage(source, next.items, next.completeItems, retainedAll);
    return {
      live: next.live,
      items,
      completeItems,
      authoritativeTurnIds: retainedCoverage(next.authoritativeTurnIds, next.items, items),
    };
  }

  #itemsFingerprint(items: Record<string, unknown>[]): string {
    const hash = createHash("sha256");
    for (const item of items) hash.update(JSON.stringify(item));
    return hash.digest("hex");
  }

  #recordCompleteCoverage(
    source: Source,
    items: Record<string, unknown>[],
    complete: boolean,
    retainedAll: boolean,
  ): void {
    if (!complete) {
      source.retentionOverflowed ||= !retainedAll;
      return;
    }
    const fingerprint = this.#itemsFingerprint(items);
    if (
      source.retentionOverflowed &&
      source.completeItemsFingerprint &&
      source.completeItemsFingerprint !== fingerprint
    ) {
      source.historyCacheEpoch = randomUUID();
      source.removedItemIds.clear();
      source.removedTurnIds.clear();
    }
    source.completeItemsFingerprint = fingerprint;
    source.retentionOverflowed = !retainedAll;
  }

  #retainItems(items: Record<string, unknown>[]): boolean {
    const originalCount = items.length;
    let bytes = 0;
    const bounded: Record<string, unknown>[] = [];
    for (const item of items.slice(-MAX_ITEM_COUNT)) {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (size > MAX_ITEM_BYTES) continue;
      while (bounded.length && bytes + size > MAX_ITEM_BYTES) {
        bytes -= Buffer.byteLength(JSON.stringify(bounded.shift()), "utf8");
      }
      bounded.push(item);
      bytes += size;
    }
    items.splice(0, items.length, ...bounded);
    return items.length === originalCount;
  }

  #boundRemoved(source: Source): void {
    const bytes = Buffer.byteLength(
      JSON.stringify([[...source.removedItemIds], [...source.removedTurnIds]]),
      "utf8",
    );
    if (
      source.removedItemIds.size + source.removedTurnIds.size > MAX_REMOVED_IDENTITIES ||
      bytes > MAX_REMOVED_BYTES
    ) {
      source.historyCacheEpoch = randomUUID();
      source.removedItemIds.clear();
      source.removedTurnIds.clear();
    }
  }

  #snapshotPayload(source: Source): Record<string, unknown> {
    return {
      live: source.snapshot.live,
      items: source.snapshot.items,
      replaceItems: true,
      preserveItemsOutsideCoverage: !source.snapshot.completeItems,
      authoritativeTurnIds: [
        ...new Set([
          ...(source.snapshot.authoritativeTurnIds ?? []),
          ...(source.snapshot.completeItems
            ? [
                ...new Set(
                  source.snapshot.items.flatMap((item) =>
                    typeof item.turn_id === "string" ? [item.turn_id] : [],
                  ),
                ),
              ]
            : []),
        ]),
      ],
      removedItemIds: [...source.removedItemIds],
      removedTurnIds: [...source.removedTurnIds],
      ...(source.historyCacheEpoch ? { historyCacheEpoch: source.historyCacheEpoch } : {}),
    };
  }

  #event(
    sessionId: string,
    subscriptionId: string,
    source: Source,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
  ): SessionStreamEvent {
    return {
      protocolVersion: 2,
      subscriptionId,
      sessionId,
      runtimeBootId: this.bootId,
      epoch: source.epoch,
      seq: source.seq,
      cursor: this.#cursor(source.epoch, source.seq),
      type,
      payload,
    };
  }

  #cursor(epoch: string, seq: number): string {
    return `${this.bootId}:${epoch}:${seq}`;
  }

  #sequence(cursor: string | undefined, epoch: string): number | undefined {
    if (!cursor || cursor.length > 1024) return undefined;
    const prefix = `${this.bootId}:${epoch}:`;
    if (!cursor.startsWith(prefix)) return undefined;
    const sequence = Number(cursor.slice(prefix.length));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function retainedCoverage(
  turns: string[] | undefined,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): string[] {
  const retained = new Set(after.map((item) => item.id));
  return (turns ?? []).filter((turn) =>
    before.every((item) => item.turn_id !== turn || retained.has(item.id)),
  );
}
