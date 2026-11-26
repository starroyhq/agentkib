import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { lstatSync } from "node:fs";
import type { SessionCollection } from "@agentkib/runtime-protocol";
import { within } from "../../files";
import { canonicalize, pathIdentity } from "../../paths";
import { readCodexDocument } from "../../session-document-providers";
import {
  withSessionDirectory,
  type SessionHistoryContext,
  type SessionHistoryProvider,
} from "../../sessions/history-provider";
import { codexRollouts } from "./codex-rollout-files";

export function createCodexHistoryReader({
  codex,
  store,
  paging,
  imageScope,
  verifiedCodexControlDirectory,
  verifiedCodexSubagentParent,
}: SessionHistoryContext): SessionHistoryProvider {
  // Opaque IDs cannot be reversed. Remember the native lookup key, never the workspace or file.
  const nativeRefs = new Map<string, string>();
  const remember = (id: string, nativeRef: string) => {
    nativeRefs.delete(id);
    nativeRefs.set(id, nativeRef);
    if (nativeRefs.size > 1_024) nativeRefs.delete(nativeRefs.keys().next().value!);
  };

  function indexedSource(id: string, workspace: string | null, collection?: SessionCollection) {
    const matches = (nativeRef: string) => store.id("codex", nativeRef) === id;
    const source = codex
      .list(workspace, {
        ...(collection === undefined ? {} : { collection }),
        nativeRef: nativeRefs.get(id),
        matches,
      })
      .sessions.find(
        (candidate) =>
          (collection === undefined || candidate.collection === collection) &&
          matches(candidate.session.native_ref),
      );
    if (source) remember(id, source.session.native_ref);
    return source;
  }

  return {
    list(workspace, matches) {
      const listing = codex.list(workspace, { matches });
      return {
        sessions: listing.sessions.map(withSessionDirectory),
        incomplete: listing.incomplete,
      };
    },
    listCollection(collection, matches) {
      const listing = codex.list(null, { collection, matches });
      return {
        sessions: listing.sessions.map(withSessionDirectory),
        incomplete: listing.incomplete,
      };
    },
    resolve(id, workspace) {
      const source = indexedSource(id, workspace);
      return source
        ? { native: withSessionDirectory(source), workspace, transcript: source.transcript }
        : undefined;
    },
    resolveCollection(id, collection) {
      const source = indexedSource(id, null, collection);
      return source
        ? { native: source.session, workspace: source.cwd, transcript: source.transcript }
        : undefined;
    },
    nativeDirectorySource(nativeRef, workspace, directory, unavailable) {
      const cwd = canonicalize(directory);
      if (!lstatSync(cwd).isDirectory() || !within(cwd, canonicalize(workspace)))
        throw new Error("session-workspace-mismatch");
      const verify = () => {
        const identity = verifiedCodexControlDirectory(nativeRef);
        if (
          !identity ||
          identity.id !== nativeRef.toLowerCase() ||
          pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
        )
          throw new Error("unverified-session-identity");
      };
      verify();
      const source = codex
        .list(null, { nativeRefs: [nativeRef] })
        .sessions.find(
          (candidate) =>
            candidate.session.native_ref.toLowerCase() === nativeRef.toLowerCase() &&
            candidate.session.origin !== "auxiliary",
        );
      if (!source) throw new Error(unavailable);
      return { native: source.session, transcript: source.transcript, cwd, verify };
    },
    async events({ native, workspace, offset, count, transcript, retain, imageScanBudget }) {
      let file = transcript;
      if (!file) {
        const source = codex
          .list(null)
          .sessions.find((value) => value.session.native_ref === native.native_ref);
        if (!source) throw new Error("Codex session is no longer available");
        file = source.transcript;
      }
      // Extract a plain rollout for backwards pages with the original transcript offsets.
      return paging.read(
        await codexRollouts.plain(file),
        offset,
        count,
        "codex",
        { workspace, cwd: native.cwd ?? workspace },
        retain,
        imageScope(native, workspace),
        imageScanBudget,
      );
    },
    async image({ native, workspace, imageId, transcript }) {
      if (!transcript) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
      return paging.image(
        await codexRollouts.plain(transcript),
        imageId,
        imageScope(native, workspace),
      );
    },
    async document({ summary, transcript }) {
      if (!transcript) throw new Error("Codex session is no longer available");
      return readCodexDocument(
        summary as Parameters<typeof readCodexDocument>[0],
        await codexRollouts.plain(transcript),
      );
    },
    subagentParent({ native, workspace }, sessionId) {
      return verifiedCodexSubagentParent(sessionId, native.native_ref, workspace);
    },
    collectSubagentCandidates(parent, candidates) {
      const seen = new Set([parent.nativeId]);
      let parents = new Set([parent.nativeId]);
      for (let depth = 0; depth < 8 && candidates.length < 128; depth++) {
        const listing = codex.list(parent.workspace, { parents, limit: 128 - candidates.length });
        const next = new Set<string>();
        for (const source of listing.sessions) {
          if (seen.has(source.session.native_ref) || !source.session.spawned_by_session_id)
            continue;
          seen.add(source.session.native_ref);
          next.add(source.session.native_ref);
          candidates.push({
            nativeId: source.session.native_ref,
            parentNativeId: source.session.spawned_by_session_id,
            name: source.session.title ?? "Codex",
            transcript: source.transcript,
          });
        }
        if (!next.size) break;
        parents = next;
      }
    },
    clear: () => nativeRefs.clear(),
  };
}
