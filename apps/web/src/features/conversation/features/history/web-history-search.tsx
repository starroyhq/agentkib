import { HistorySearchTrigger } from "@agentkib/session-ui";
import { useSession } from "../../web-session-context";

export function WebHistorySearchTrigger() {
  const session = useSession();
  return (
    <HistorySearchTrigger
      access={session.access}
      locale={session.locale}
      onOpen={() => session.setHistorySearchOpen(true)}
    />
  );
}
