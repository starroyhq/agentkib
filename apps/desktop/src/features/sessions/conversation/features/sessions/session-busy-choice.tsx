import { codexReason } from "./codex-copy";
import type { ContinuationComposerDraft } from "./continuation-draft";
import { SessionContinuationChoice } from "@agentkib/session-ui";
import { useSession } from "./session-context";
import { useSessionNavigate } from "./session-navigation";
import { managedControlCopy } from "./managed-control-copy";

export function SessionBusyChoice({
  onReturn,
  composerDraft,
}: {
  onReturn: () => void;
  composerDraft?: () => ContinuationComposerDraft;
}) {
  const session = useSession();
  const navigate = useSessionNavigate();
  const draft = composerDraft?.();
  const unavailableReason =
    session.actionUnavailableReason ??
    (!session.capabilities?.features.fork?.available
      ? (session.capabilities?.features.fork?.reason ??
        session.capabilities?.reason ??
        "session-state-unavailable")
      : undefined);
  return (
    <div className="w-full max-w-3xl self-center space-y-2">
      <SessionContinuationChoice
        compact
        locale={session.locale}
        agent={session.current?.agent === "claude-code" ? "Claude Code" : "Codex"}
        title={session.currentTitle || session.current?.title || session.t.untitled}
        hasDraft={Boolean(
          session.message?.trim() ||
          session.historyReferences?.length ||
          draft?.files.length ||
          draft?.resources.length,
        )}
        disabled={session.busy}
        forkDisabled={
          !session.online ||
          !(session.forkCheckAvailable ?? session.controlReady) ||
          !session.access?.device?.manage ||
          !session.capabilities?.features.fork?.available
        }
        onFork={async () => {
          const id = await session.forkContinuation(composerDraft?.());
          if (id) await navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
        }}
        onReturn={onReturn}
      />
      {unavailableReason && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {codexReason(session.locale, unavailableReason).text}
        </p>
      )}
      {!session.access?.device?.manage && (
        <p className="px-3 text-xs text-muted-foreground">
          {managedControlCopy[session.locale].management}
        </p>
      )}
    </div>
  );
}
