import { AgentMark, agentName } from "@agentkib/agent-identity";
import {
  SessionReader as SharedSessionReader,
  SessionTranscript,
  useSessionImageLoader,
  useBasicSendQueue,
} from "@agentkib/session-ui";
import { sessionCopyForSurface, sessionReason } from "../../session-copy";
import { sessionBannerAtComposer, sessionConnectionBanner } from "@agentkib/session-ui";
import { WebSessionOperations } from "./web-session-operations";
import { SessionComposer } from "../../web-session-composer";
import { useSessionPanels } from "@agentkib/session-ui";
import { useSession } from "../../web-session-context";
import { ContextUsageGauge } from "../../context-usage";
import { webSessionImages } from "../../web-session-images";

export function SessionReader() {
  const session = useSession();
  const panels = useSessionPanels();
  const queue = useBasicSendQueue(session);
  const { client, access, selected, locale, current, indexEnabled, imageRequestVersion } = session;
  const imageLoader = useSessionImageLoader({
    images: webSessionImages,
    client,
    access,
    sessionId: selected,
    indexEnabled,
    requestVersion: imageRequestVersion,
  });
  const banner = sessionConnectionBanner(session, "web");
  return (
    <SharedSessionReader
      session={session}
      panels={panels}
      agent={agentName(current?.agent)}
      addContextLabel={sessionCopyForSurface(locale, "web").addContext}
      explainReason={(reason) => sessionReason(locale, reason, "web").text}
      banner={banner}
      composerBanner={sessionBannerAtComposer(banner)}
      connectionNoticeInToolbar={!!(banner?.connection && panels?.statusOutsideComposer)}
      imageLoader={imageLoader}
      queue={queue}
      agentMark={(workerAgent) => <AgentMark agent={workerAgent} size={16} />}
      Transcript={SessionTranscript}
      Operations={WebSessionOperations}
      Composer={SessionComposer}
      ContextUsage={ContextUsageGauge}
    />
  );
}
