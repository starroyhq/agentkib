import {
  reduceSessionStreamEvent,
  type ConversationState,
  type NativeCoverage,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import type { Access, Live, SessionStreamHandlers, WebClient } from "@agentkib/web-client";
import { capabilityAccessBinding } from "./use-session-capabilities";

export const WARM_SESSION_IDLE_MS = 10 * 60_000;
const MAX_PARKED_SESSIONS = 4;
const MAX_PARKED_EVENTS = 256;
const MAX_PARKED_BYTES = 2 * 1024 * 1024;

export type WarmSessionCheckpoint = {
  state: ConversationState<Live>;
  coverage: NativeCoverage;
};

type Packet = Parameters<SessionStreamHandlers["event"]>;
type ParkedStream = {
  checkpoint: WarmSessionCheckpoint;
  accepted: ConversationState<Live>;
  packets: Packet[];
  bytes: number;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
};
type Entry = {
  scope: string;
  id: string;
  owner?: object;
  handlers?: SessionStreamHandlers;
  close?: () => void;
  parked?: ParkedStream;
  cursor?: string;
  ready: boolean;
};

export function warmSessionAuthority(access: Access | undefined, streamEpoch: number) {
  if (access?.status !== "approved" || access.protocolVersion !== 2 || !access.bootId)
    return undefined;
  return JSON.stringify([
    streamEpoch,
    capabilityAccessBinding(access),
    access.accountLogin?.bound,
    access.accountLogin?.accountId,
  ]);
}

/** Only healthy, validated streams can outlive a selection. */
export function createWarmSessionStreamPool(
  client: Pick<WebClient, "stream">,
  maxParkedSessions = MAX_PARKED_SESSIONS,
) {
  const entries = new Map<string, Entry>();
  const parkedListeners = new Set<() => void>();
  const notifyParked = () => {
    for (const listener of parkedListeners) listener();
  };
  const current = (entry: Entry) => entries.get(entry.id) === entry;
  const close = (entry: Entry) => {
    if (!current(entry)) return;
    const parked = entry.parked;
    entries.delete(entry.id);
    clearTimeout(parked?.timer);
    entry.parked = undefined;
    entry.handlers = undefined;
    entry.close?.();
    if (parked) notifyParked();
  };
  const clear = () => {
    for (const entry of entries.values()) close(entry);
  };
  const discardParked = (id?: string) => {
    for (const entry of entries.values()) {
      if (entry.parked && (id === undefined || entry.id === id)) close(entry);
    }
  };

  const forward = (entry: Entry, handlers: SessionStreamHandlers, packet: Packet) => {
    const accepted = handlers.event(...packet);
    if (packet[0] === "session-event") {
      if (typeof accepted === "string") entry.cursor = accepted;
      else entry.ready = false;
    }
    if (packet[0] === "session-ready")
      entry.ready = typeof accepted === "string" && accepted === entry.cursor;
    if (packet[0] === "unavailable") entry.ready = false;
    return accepted;
  };

  const receive = (entry: Entry, packet: Packet) => {
    if (!current(entry)) return false;
    const [type, data, cursor] = packet;
    if (type === "access-ended") {
      const listeners = [...entries.values()].flatMap((item) =>
        item.handlers ? [item.handlers] : [],
      );
      clear();
      for (const handlers of listeners) handlers.event(type, data, cursor);
      return false;
    }
    if (type === "access-changed") {
      // A cached control projection cannot certify an authority after a grant change.
      discardParked();
      for (const item of entries.values()) item.ready = false;
    }
    if (entry.handlers) return forward(entry, entry.handlers, packet);
    const parked = entry.parked;
    if (!parked) return false;
    if (
      type === "unavailable" ||
      type === "session-ready" ||
      Date.now() >= parked.expires ||
      parked.packets.length >= MAX_PARKED_EVENTS ||
      parked.bytes + data.length * 2 > MAX_PARKED_BYTES
    ) {
      close(entry);
      return false;
    }
    if (type !== "session-event" && type !== "control-changed") return false;
    if (type === "control-changed") {
      parked.packets.push(packet);
      parked.bytes += data.length * 2;
      return false;
    }
    try {
      const event = JSON.parse(data) as SessionStreamEvent<Live>;
      if (
        event.sessionId !== entry.id ||
        event.runtimeBootId !== parked.accepted.runtimeBootId ||
        event.epoch !== parked.accepted.epoch
      ) {
        close(entry);
        return false;
      }
      const next = reduceSessionStreamEvent(parked.accepted, event);
      if (next.resyncRequired || !next.cursor || next.live?.sessionId !== entry.id) {
        close(entry);
        return false;
      }
      if (next !== parked.accepted) {
        const liveChanged = next.live !== parked.accepted.live;
        parked.packets.push(packet);
        parked.bytes += data.length * 2;
        parked.accepted = next;
        entry.cursor = next.cursor;
        if (liveChanged) notifyParked();
      }
      return next.cursor;
    } catch {
      close(entry);
      return false;
    }
  };

  const peek = (scope: string, id: string) => {
    const entry = entries.get(id);
    if (!entry?.parked || entry.owner || entry.scope !== scope) return undefined;
    if (Date.now() >= entry.parked.expires) {
      close(entry);
      return undefined;
    }
    return entry.parked.checkpoint;
  };

  return {
    peek,
    clear,
    discardParked,
    // Rendering may consult a parked stream but cannot claim it or change its lease.
    hasParked(id: string) {
      const entry = entries.get(id);
      return !!entry?.parked && !entry.owner && Date.now() < entry.parked.expires;
    },
    peekParkedLive(id: string) {
      const parked = entries.get(id)?.parked;
      return parked && Date.now() < parked.expires ? parked.accepted.live : undefined;
    },
    subscribeParked(listener: () => void) {
      parkedListeners.add(listener);
      return () => {
        parkedListeners.delete(listener);
      };
    },
    claim(scope: string, id: string) {
      const checkpoint = peek(scope, id);
      const previous = entries.get(id);
      if (previous && !checkpoint) close(previous);
      const entry: Entry = checkpoint && previous ? previous : { scope, id, ready: false };
      entries.set(id, entry);
      const owner = {};
      entry.owner = owner;
      if (checkpoint) notifyParked();
      return {
        checkpoint,
        start(handlers: SessionStreamHandlers) {
          if (!current(entry) || entry.owner !== owner) return false;
          const parked = entry.parked;
          entry.handlers = handlers;
          if (parked) {
            if (Date.now() >= parked.expires) {
              close(entry);
              return false;
            }
            clearTimeout(parked.timer);
            // Resume from the active checkpoint, so playback includes only
            // changes since leaving and never repeats a handled invalidation.
            entry.cursor = parked.checkpoint.state.cursor;
            for (const packet of parked.packets) {
              forward(entry, handlers, packet);
              if (!current(entry) || entry.owner !== owner) return false;
            }
            forward(entry, handlers, [
              "session-ready",
              JSON.stringify({ cursor: parked.accepted.cursor }),
            ]);
            entry.parked = undefined;
            notifyParked();
            return true;
          }
          const stop = client.stream(id, {
            open() {
              if (!current(entry)) return;
              if (entry.handlers) entry.handlers.open();
              else close(entry);
            },
            error(error) {
              if (!current(entry)) return;
              entry.ready = false;
              if (entry.handlers) entry.handlers.error(error);
              else close(entry);
            },
            event: (...packet) => receive(entry, packet),
          });
          if (current(entry)) entry.close = stop;
          else stop();
          return true;
        },
        release(checkpoint?: WarmSessionCheckpoint) {
          if (!current(entry) || entry.owner !== owner) return;
          entry.owner = undefined;
          entry.handlers = undefined;
          if (
            !checkpoint ||
            !entry.ready ||
            !checkpoint.state.cursor ||
            checkpoint.state.cursor !== entry.cursor ||
            checkpoint.state.resyncRequired ||
            checkpoint.state.live?.sessionId !== id
          ) {
            close(entry);
            return;
          }
          const bytes = JSON.stringify(checkpoint.state).length * 2;
          if (bytes > MAX_PARKED_BYTES) {
            close(entry);
            return;
          }
          entries.delete(id);
          entries.set(id, entry);
          const expires = Date.now() + WARM_SESSION_IDLE_MS;
          entry.parked = {
            checkpoint,
            accepted: checkpoint.state,
            packets: [],
            bytes,
            expires,
            timer: setTimeout(() => close(entry), WARM_SESSION_IDLE_MS),
          };
          const parked = [...entries.values()].filter((item) => item.parked);
          for (const item of parked.slice(0, Math.max(0, parked.length - maxParkedSessions)))
            close(item);
          notifyParked();
        },
      };
    },
  };
}

export type WarmSessionStreamPool = ReturnType<typeof createWarmSessionStreamPool>;
