import { agentName } from "@agentkib/agent-identity";
import {
  SessionReader as SharedSessionReader,
  SessionTranscript,
  useSessionImageLoader,
  useBasicSendQueue,
} from "@agentkib/session-ui";
import { codexCopyForSurface, codexReason } from "../../codex-copy";
import { claudeComposerNotice, claudeSessionBanner } from "@agentkib/session-ui";
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
  const banner = current?.agent === "claude-code" ? claudeSessionBanner(session, "web") : null;
  return (
    <SharedSessionReader
      session={session}
      panels={panels}
      agent={agentName(current?.agent)}
      addContextLabel={codexCopyForSurface(locale, "web").addContext}
      explainReason={(reason) => codexReason(locale, reason, "web").text}
      banner={banner}
      composerBanner={claudeComposerNotice(banner)}
      imageLoader={imageLoader}
      queue={queue}
      Transcript={SessionTranscript}
      Operations={WebSessionOperations}
      Composer={SessionComposer}
      ContextUsage={ContextUsageGauge}
    />
  );
}
