import path from "node:path";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { readClaudeDocument } from "../../session-document-providers";
import {
  withSessionDirectory,
  type SessionHistoryContext,
  type SessionHistoryProvider,
} from "../../sessions/history-provider";

export function createClaudeHistoryReader({
  claude,
  store,
  paging,
  imageScope,
  verifiedClaudeImageSource,
  verifiedClaudeNativeSource,
}: SessionHistoryContext): SessionHistoryProvider {
  return {
    list(workspace) {
      const listing = claude.list(workspace);
      return {
        sessions: listing.sessions.map(withSessionDirectory),
        incomplete: listing.incomplete,
      };
    },
    catalogListing(paths) {
      if (!paths) {
        const listing = claude.list(null);
        return {
          sessions: listing.sessions.map(withSessionDirectory),
          incomplete: listing.incomplete,
          retainUnobservedTitles: true,
        };
      }
      const versions = paths.map((file) => ({ file, listing: claude.catalogTranscript(file) }));
      return {
        sessions: versions.flatMap(({ listing }) => listing.sessions),
        incomplete: versions.some(({ listing }) => listing.incomplete),
        retainUnobservedTitles: true,
        nativeRefs: versions.flatMap(({ file, listing }) =>
          listing.incomplete ? [] : [path.basename(file, ".jsonl")],
        ),
        issues: versions.flatMap(({ listing }) => listing.issues ?? []),
      };
    },
    resolve(id, workspace) {
      const source = claude
        .list(workspace)
        .sessions.find((candidate) => store.id("claude-code", candidate.session.native_ref) === id);
      return source
        ? { native: withSessionDirectory(source), workspace, transcript: source.transcript }
        : undefined;
    },
    imageSource: verifiedClaudeImageSource,
    nativeWorkspaceSource: verifiedClaudeNativeSource,
    events({ native, workspace, offset, count, transcript, retain, imageScanBudget }) {
      let file = transcript;
      if (!file) {
        const source = claude
          .list(null)
          .sessions.find((value) => value.session.native_ref === native.native_ref);
        if (!source) throw new Error("Claude session is no longer available");
        file = source.transcript;
      }
      return paging.readTranscript(
        file,
        offset,
        count,
        "claude-code",
        { workspace, cwd: native.cwd ?? workspace },
        retain,
        imageScope(native, workspace),
        imageScanBudget,
      );
    },
    image({ native, workspace, imageId, transcript }) {
      if (!transcript) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
      return paging.image(transcript, imageId, imageScope(native, workspace));
    },
    document({ native, summary, transcript, options }) {
      if (!transcript) throw new Error("Claude session is no longer available");
      return readClaudeDocument(
        summary as Parameters<typeof readClaudeDocument>[0],
        transcript,
        native.sidechain,
        options,
      );
    },
    subagentParent({ native, workspace, transcript }, sessionId) {
      return {
        sessionId,
        nativeId: native.native_ref,
        workspace,
        transcript,
        agent: "claude-code",
      };
    },
  };
}
