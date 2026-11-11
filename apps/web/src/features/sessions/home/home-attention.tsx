import { createContext, use, useMemo, type ReactNode } from "react";
import { homeSessionGroups, type HomeSessionGroups } from "@agentkib/session-catalog";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { useHomeReplies, type HomeReplies } from "./home-replies";

export interface HomeAttention {
  replies: HomeReplies;
  /** The home's groups; "needs you" is also the count beside Home and on the bell. */
  groups: HomeSessionGroups<ConversationSessionSummary>;
}

const HomeAttentionContext = createContext<HomeAttention | undefined>(undefined);

/** One reading of what needs the person, shared by the home, the sidebar and the bell. */
export function HomeAttentionProvider({ children }: { children: ReactNode }) {
  const { sessions, indexEnabled } = useSession();
  const replies = useHomeReplies(sessions);
  const groups = useMemo(() => {
    const value = homeSessionGroups(indexEnabled ? sessions : [], {
      recent: 3,
      unconfirmed: replies.unconfirmed,
    });
    // An answered request stays off the list until the catalog reports the session again.
    return replies.answered.size
      ? {
          ...value,
          needsYou: value.needsYou.filter(
            ({ session, need }) => need === "verify" || !replies.answered.has(session.id),
          ),
        }
      : value;
  }, [sessions, indexEnabled, replies.unconfirmed, replies.answered]);
  const value = useMemo(() => ({ replies, groups }), [replies, groups]);
  return <HomeAttentionContext value={value}>{children}</HomeAttentionContext>;
}

export function useHomeAttention(): HomeAttention | undefined {
  return use(HomeAttentionContext);
}
