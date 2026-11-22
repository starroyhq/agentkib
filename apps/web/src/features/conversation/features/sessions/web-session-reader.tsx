import { agentName } from "@agentkib/agent-identity";
import {
  SessionReader as SharedSessionReader,
  SessionTranscript,
  useSessionImageLoader,
} from "@agentkib/session-ui";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { claudeComposerNotice, claudeSessionBanner } from "./claude-session-banner";
import { WebSessionOperations } from "./web-session-operations";
import { SessionComposer } from "./session-composer";
import { useSessionPanels } from "./session-panels";
import { useSession } from "./session-context";
import { ContextUsageGauge } from "./context-usage";
import { basicSendQueue } from "./dsh-queue";
import { webSessionImages } from "../../web-session-images";

export function SessionReader() {
  const session = useSession();
  const panels = useSessionPanels();
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
      queue={basicSendQueue(session)}
      Transcript={SessionTranscript}
      Operations={WebSessionOperations}
      Composer={SessionComposer}
      ContextUsage={ContextUsageGauge}
    />
  );
}
