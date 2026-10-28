/** Transport-independent conversation state shared by desktop and Remote. */
export interface ConversationItem {
  id: string;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string | null;
  message_phase?: "commentary" | "final_answer" | null;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  truncated: boolean;
  /** Live-only identity that an authoritative native history response may replace. */
  ephemeral?: boolean;
  /** Text the CLI wrote itself (a local command's output, an API or failed-turn error). */
  cli_output?: boolean;
}

interface StreamEnvelope {
  protocolVersion: 2;
  subscriptionId: string;
  sessionId: string;
  runtimeBootId: string;
  epoch: string | number;
  seq: number;
  cursor: string;
}

export type SessionStreamEvent<Live extends object = Record<string, unknown>> = StreamEnvelope &
  (
    | {
        type: "snapshot";
        payload: {
          live: Live;
          items?: ConversationItem[];
          replaceItems?: boolean;
          /** Only covered or explicitly removed turns replace already displayed history. */
          preserveItemsOutsideCoverage?: boolean;
          removedItemIds?: string[];
          /** Changes only when bounded deletion records require a full history reread. */
          historyCacheEpoch?: string;
          removedTurnIds?: string[];
          authoritativeTurnIds?: string[];
        };
      }
    | { type: "state"; payload: Partial<Live> }
    | {
        type: "text-delta";
        /** offset is UTF-16 code units, matching JavaScript string.length. */
        payload: {
          text: string;
          offset: number;
          turnId?: string;
          itemId?: string;
          ephemeral?: boolean;
        };
      }
    | { type: "item-upsert"; payload: ConversationItem }
    | { type: "invalidate"; payload: { domains: string[] } }
    | { type: "resync-required"; payload: { reason: string } }
  );

export interface ConversationState<Live extends object = Record<string, unknown>> {
  sessionId: string;
  subscriptionId?: string;
  runtimeBootId?: string;
  epoch?: string | number;
  /** Delivery ordering only. Never use this as the control/CAS revision. */
  seq: number;
  cursor?: string;
  live?: Live;
  items: ConversationItem[];
  streamText: string;
  resyncRequired?: string;
  invalidatedDomains: string[];
  retiredEpochs: string[];
}

export interface ConversationSubscription<Live extends object = Record<string, unknown>> {
  subscriptionId: string;
  events: SessionStreamEvent<Live>[];
  cursor?: string;
}

export interface ConversationTransport<Live extends object = Record<string, unknown>> {
  request<Result>(path: string, body?: unknown, signal?: AbortSignal): Promise<Result>;
  subscribe(sessionId: string, cursor?: string): Promise<ConversationSubscription<Live>>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onEvent(listener: (event: SessionStreamEvent<Live>) => void): () => void;
}

export function createConversationState<Live extends object = Record<string, unknown>>(
  sessionId: string,
): ConversationState<Live> {
  return {
    sessionId,
    seq: -1,
    items: [],
    streamText: "",
    invalidatedDomains: [],
    retiredEpochs: [],
  };
}

/** Identity wins over content: identical text in separate messages must stay separate. */
export function mergeConversationItems(
  previous: readonly ConversationItem[],
  incoming: readonly ConversationItem[],
): ConversationItem[] {
  const items = [...previous];
  const positions = new Map(items.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const index = positions.get(item.id);
    if (index === undefined) {
      positions.set(item.id, items.length);
      items.push(item);
    } else items[index] = item;
  }
  return items;
}

function streamTextOf(live: object): string {
  return "streamText" in live && typeof live.streamText === "string" ? live.streamText : "";
}

function resync<Live extends object>(state: ConversationState<Live>, reason: string) {
  return state.resyncRequired === reason ? state : { ...state, resyncRequired: reason };
}

/** A cursor advances only after the corresponding event has actually been applied. */
export function reduceSessionStreamEvent<Live extends object>(
  state: ConversationState<Live>,
  event: SessionStreamEvent<Live>,
): ConversationState<Live> {
  if (event.sessionId !== state.sessionId) return state;
  if (event.protocolVersion !== 2) return resync(state, "incompatible-protocol");
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return resync(state, "invalid-sequence");
  const sameEpoch = state.epoch === event.epoch && state.runtimeBootId === event.runtimeBootId;
  const eventEpoch = JSON.stringify([event.runtimeBootId, event.epoch]);
  if (state.retiredEpochs.includes(eventEpoch)) return state;
  if (event.type === "snapshot") {
    // A new subscription may replay its baseline; it must never overwrite newer items.
    if (sameEpoch && event.seq < state.seq) return state;
    return {
      sessionId: state.sessionId,
      subscriptionId: event.subscriptionId,
      runtimeBootId: event.runtimeBootId,
      epoch: event.epoch,
      seq: event.seq,
      cursor: event.cursor,
      live: event.payload.live,
      items: mergeConversationItems([], event.payload.items ?? []),
      streamText: streamTextOf(event.payload.live),
      invalidatedDomains: [],
      retiredEpochs:
        !sameEpoch && state.epoch !== undefined
          ? [...state.retiredEpochs, JSON.stringify([state.runtimeBootId, state.epoch])].slice(-16)
          : state.retiredEpochs,
    };
  }
  if (!sameEpoch) return resync(state, "epoch-changed");
  if (event.seq <= state.seq) return state;
  if (event.type === "resync-required") return resync(state, event.payload.reason);
  if (state.resyncRequired) return state;
  if (event.seq !== state.seq + 1) return resync(state, "sequence-gap");
  const next = {
    ...state,
    subscriptionId: event.subscriptionId,
    seq: event.seq,
    cursor: event.cursor,
  };
  switch (event.type) {
    case "state":
      if (!state.live) return resync(state, "snapshot-required");
      return {
        ...next,
        live: { ...state.live, ...event.payload },
        streamText: "streamText" in event.payload ? streamTextOf(event.payload) : state.streamText,
      };
    case "item-upsert":
      return { ...next, items: mergeConversationItems(state.items, [event.payload]) };
    case "invalidate":
      return {
        ...next,
        invalidatedDomains: [...new Set([...state.invalidatedDomains, ...event.payload.domains])],
      };
    case "text-delta": {
      const { text, offset, itemId, turnId, ephemeral } = event.payload;
      const existing = itemId ? state.items.find((item) => item.id === itemId) : undefined;
      const previous = itemId ? (existing?.content ?? "") : state.streamText;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > previous.length)
        return resync(state, "text-offset-gap");
      // Replayed overlapping bytes are allowed only when they agree with applied content.
      const overlap = Math.min(text.length, previous.length - offset);
      if (previous.slice(offset, offset + overlap) !== text.slice(0, overlap))
        return resync(state, "text-offset-conflict");
      const content = previous + text.slice(overlap);
      if (!itemId) return { ...next, streamText: content };
      const item: ConversationItem = {
        id: itemId,
        kind: "agent-message",
        attachment_count: 0,
        truncated: false,
        ...existing,
        ...(turnId ? { turn_id: turnId } : {}),
        ...(ephemeral !== undefined ? { ephemeral } : {}),
        content,
      };
      return { ...next, items: mergeConversationItems(state.items, [item]) };
    }
  }
}

export const reduceConversationEvent = reduceSessionStreamEvent;

export function createConversationStore<Live extends object = Record<string, unknown>>(
  sessionId: string,
) {
  let state = createConversationState<Live>(sessionId);
  const listeners = new Set<() => void>();
  const publish = (next: ConversationState<Live>) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(event: SessionStreamEvent<Live>) {
      publish(reduceSessionStreamEvent(state, event));
      return state;
    },
    /** Replace complete control state, including omitted fields, without advancing delivery. */
    replaceLive(live: Live) {
      if (state.live)
        publish({
          ...state,
          live,
          streamText: "streamText" in live ? streamTextOf(live) : state.streamText,
        });
      return state;
    },
    clearInvalidations() {
      if (state.invalidatedDomains.length) publish({ ...state, invalidatedDomains: [] });
    },
    reset(nextSessionId = state.sessionId) {
      publish(createConversationState<Live>(nextSessionId));
    },
  };
}

export * from "./history-pagination";
export * from "./session-events";
export * from "./session-model";
