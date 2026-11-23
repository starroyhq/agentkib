import { createTranscriptPageCache } from "@agentkib/conversation-state";
import { createWarmSessionStreamPool, warmSessionAuthority } from "@agentkib/session-ui";
import type { Access, ConversationEventPage, Live, WebClient } from "@agentkib/web-client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import { useAppStore } from "@/stores/app-store";
import { subscribeDesktopReadScope } from "./read-state-scope";

export function createDesktopWarmSessionStreamPool(client: WebClient) {
  // The IPC limit of four also covers the directory, the controller's catalog
  // observation, and the selected conversation.
  return createWarmSessionStreamPool(client, 1);
}

function createWindowConversation() {
  const client = createDesktopConversationClient();
  const warmStreams = createDesktopWarmSessionStreamPool(client);
  const pageCache = createTranscriptPageCache<ConversationEventPage>();
  const drafts = createTranscriptPageCache<{ text: string }>({ maxBytes: 512 * 1024 });
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let authority: string | undefined;
  let activeLive: Live | undefined;
  return {
    client,
    warmStreams,
    pageCache,
    streamEpoch: 0,
    revision: 0,
    getDraft(id: string) {
      return drafts.peek(id)?.text ?? "";
    },
    setDraft(id: string, text: string) {
      if (text === (drafts.peek(id)?.text ?? "")) return;
      drafts.set(id, { text });
      notify();
    },
    clearPresentation() {
      drafts.clear();
      activeLive = undefined;
      notify();
    },
    publishLive(live: Live | undefined) {
      if (activeLive === live) return;
      activeLive = live;
      notify();
    },
    getDisplayLive(id: string) {
      return (
        warmStreams.peekParkedLive(id) ?? (activeLive?.sessionId === id ? activeLive : undefined)
      );
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = warmStreams.subscribeParked(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    acceptAccess(access: Access) {
      const next = warmSessionAuthority(access, 0);
      if (authority !== next) {
        this.revision++;
        warmStreams.clear();
        pageCache.clear();
        this.clearPresentation();
        authority = next;
      }
    },
  };
}

const DesktopConversationWindow = createContext<ReturnType<typeof createWindowConversation> | null>(
  null,
);

export function DesktopConversationWindowProvider({ children }: { children: ReactNode }) {
  const [conversation] = useState(createWindowConversation);
  useEffect(() => {
    const { warmStreams, pageCache } = conversation;
    const invalidateRetained = () => {
      conversation.revision++;
      warmStreams.discardParked();
      pageCache.clear();
      conversation.clearPresentation();
    };
    const stopScope = subscribeDesktopReadScope(invalidateRetained);
    const stopIndex = useAppStore.subscribe((state, previous) => {
      if (previous.runtime?.session_index_enabled && !state.runtime?.session_index_enabled)
        invalidateRetained();
    });
    return () => {
      stopScope();
      stopIndex();
      warmStreams.clear();
      pageCache.clear();
      conversation.clearPresentation();
    };
  }, [conversation]);
  return <DesktopConversationWindow value={conversation}>{children}</DesktopConversationWindow>;
}

export function useDesktopConversationWindow() {
  return useContext(DesktopConversationWindow);
}

const noSubscription = () => () => {};

function sameRunState(previous: Live, next: Live) {
  return (
    previous.sessionId === next.sessionId &&
    previous.status === next.status &&
    previous.turnId === next.turnId &&
    previous.activity === next.activity &&
    previous.cancelling === next.cancelling &&
    previous.executionLocation === next.executionLocation &&
    previous.stopEnabled === next.stopEnabled &&
    previous.reason === next.reason &&
    previous.ownershipReason === next.ownershipReason &&
    previous.approvals?.length === next.approvals?.length &&
    previous.questions?.length === next.questions?.length &&
    previous.backgroundTasks?.length === next.backgroundTasks?.length
  );
}

/** List and transcript use this presentation only. Command readiness stays in the controller. */
export function useConversationDisplayLive(id: string | undefined) {
  const windowConversation = useDesktopConversationWindow();
  const displayed = useRef<Live | undefined>(undefined);
  return useSyncExternalStore(windowConversation?.subscribe ?? noSubscription, () => {
    const next = id ? windowConversation?.getDisplayLive(id) : undefined;
    if (next && displayed.current && sameRunState(displayed.current, next))
      return displayed.current;
    return (displayed.current = next);
  });
}

export function useConversationDraft(id: string | undefined) {
  const windowConversation = useDesktopConversationWindow();
  return useSyncExternalStore(windowConversation?.subscribe ?? noSubscription, () =>
    id ? (windowConversation?.getDraft(id) ?? "") : "",
  );
}
