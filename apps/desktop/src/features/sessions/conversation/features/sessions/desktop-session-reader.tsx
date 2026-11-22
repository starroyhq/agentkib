import { agentName } from "@agentkib/agent-identity";
import {
  SessionReader as SharedSessionReader,
  SessionTranscript,
  useSessionImageLoader,
  useBasicSendQueue,
  type ReaderContextUsageProps,
} from "@agentkib/session-ui";
import { codexCopy, codexReason } from "../../codex-copy";
import { sessionBannerAtComposer, sessionConnectionBanner } from "@agentkib/session-ui";
import { DesktopSessionOperations } from "./desktop-session-operations";
import { SessionComposer } from "../../desktop-session-composer";
import { useSessionPanels } from "@agentkib/session-ui";
import { useSession } from "../../desktop-session-context";
import { ContextUsageGauge } from "../../context-usage";
import { desktopSessionImages } from "../../desktop-session-images";
import {
  desktopReadScope as currentDesktopReadScope,
  useDesktopReadScope,
} from "../../../read-state-scope";
import { useConversationDisplayLive } from "../../../DesktopConversationWindow";

function ReaderContextUsage({ source, capacity }: ReaderContextUsageProps) {
  return <ContextUsageGauge source={source} limit={capacity} />;
}

export function SessionReader() {
  const session = useSession();
  const panels = useSessionPanels();
  const queue = useBasicSendQueue(session);
  const { client, access, selected, locale, current, indexEnabled, imageRequestVersion } = session;
  const desktopRead = useDesktopReadScope();
  const displayLive = useConversationDisplayLive(selected);
  const imageLoader = useSessionImageLoader({
    images: desktopSessionImages,
    client,
    access,
    sessionId: selected,
    indexEnabled,
    requestVersion: imageRequestVersion,
    scopeKey: desktopRead.key,
    getScope: currentDesktopReadScope,
  });
  const banner = sessionConnectionBanner(session);
  return (
    <SharedSessionReader
      session={session}
      panels={panels}
      agent={agentName(current?.agent)}
      addContextLabel={codexCopy[locale].addContext}
      explainReason={(reason) => codexReason(locale, reason).text}
      banner={banner}
      composerBanner={sessionBannerAtComposer(banner)}
      connectionNoticeInToolbar={!!(banner?.connection && panels?.statusInToolbar)}
      displayLive={displayLive}
      localAuthority={{
        key: desktopRead.key,
        ready: desktopRead.ready,
        isCurrent: () => currentDesktopReadScope().key === desktopRead.key,
      }}
      imageLoader={imageLoader}
      queue={queue}
      Transcript={SessionTranscript}
      Operations={DesktopSessionOperations}
      Composer={SessionComposer}
      ContextUsage={ReaderContextUsage}
    />
  );
}
