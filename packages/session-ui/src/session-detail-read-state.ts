import { useCallback, type RefObject } from "react";
import {
  sessionDetailCapabilities,
  type Access,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Live,
  type WebClient,
} from "@agentkib/web-client";
import {
  publishSessionInvalidation,
  subscribeSessionInvalidation,
} from "@agentkib/conversation-state";
import { useVisibleReadState, type SessionReadState } from "./read-state";
import { sessionTurnStatus } from "./session-turn-status";

const READ_DOMAINS = new Set(["catalog", "history", "live", "read-state", "read-state-refresh"]);

export function useSessionDetailReadState({
  session,
  blocked,
  localAuthority,
}: {
  session: {
    client: WebClient;
    selected: string;
    origin: string;
    online: boolean;
    page?: ConversationEventPage | null;
    current?: ConversationSessionSummary;
    live?: Live;
    access?: Access;
    scroll: RefObject<HTMLElement | null>;
  };
  blocked: boolean;
  localAuthority?: {
    key: string;
    ready: boolean;
    isCurrent: () => boolean;
    onReadState?: (
      sessionId: string,
      state: SessionReadState,
      catalogVersionAtDispatch: string | null | undefined,
    ) => void;
  };
}) {
  const { client, selected, origin, access, current, online, page, scroll, live } = session;
  const enabled = sessionDetailCapabilities(current?.agent).history.readState;
  const readSubscription = useCallback(
    (listener: (userAction?: boolean) => void) =>
      subscribeSessionInvalidation(client, (id, domains) => {
        if ((!id || id === selected) && domains.some((domain) => READ_DOMAINS.has(domain)))
          listener(domains.includes("read-state-refresh"));
      }),
    [client, selected],
  );
  const observation = useVisibleReadState({
    client,
    sessionId: selected,
    reviewContext: localAuthority ? "desktop-local" : undefined,
    isCurrent: localAuthority?.isCurrent,
    scope: JSON.stringify([
      localAuthority?.key,
      origin,
      access?.bootId,
      access?.device?.id,
      access?.historySearchScope,
      access?.accountLogin?.accountId,
    ]),
    source: current?.readState?.source,
    catalogVersion: current?.readState?.version,
    activeTurnId: sessionTurnStatus(
      selected,
      live,
      current?.id === selected ? current.externalTurn : undefined,
    )?.turnId,
    supported: access?.readStateVersion === 1 && enabled,
    ready: (localAuthority?.ready ?? true) && !!page && online && access?.status === "approved",
    blocked,
    events: page?.events ?? [],
    viewportRef: scroll,
    subscribe: readSubscription,
    onAcknowledged: (state, catalogVersionAtDispatch) => {
      localAuthority?.onReadState?.(selected, state, catalogVersionAtDispatch);
      publishSessionInvalidation(client, selected, ["catalog"]);
    },
  });
  return enabled ? observation : undefined;
}
