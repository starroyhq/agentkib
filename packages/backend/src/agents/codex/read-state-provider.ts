import { within } from "../../files";
import { readManagedRecord } from "../../managed-ledger";
import { canonicalize, pathIdentity } from "../../paths";
import { observeReadHistory } from "../../read-state-history";
import {
  emptyReadState,
  type ReadStateProvider,
  type ReadStateProviderContext,
  type ReadStateTarget,
} from "../../sessions/read-state-provider";
import { codexExecutable } from "./codex-executable";
import { CodexReadStateObserver } from "./codex-read-state";
import { codexRollouts } from "./codex-rollout-files";
import { hasManagedCatalogWorkspace, managedRecordSchema } from "./managed-session-catalog";

function resolveManagedTarget(context: ReadStateProviderContext, id: string) {
  const parsed = managedRecordSchema.safeParse(readManagedRecord(context.dataDir, id));
  return parsed.success ? managedTarget(context, parsed.data) : null;
}

async function managedTarget(
  { store, sessions }: ReadStateProviderContext,
  record: ReturnType<typeof managedRecordSchema.parse>,
): Promise<ReadStateTarget> {
  if (
    !hasManagedCatalogWorkspace(store, record) ||
    pathIdentity(record.home) !== pathIdentity(sessions.codexHome()) ||
    !record.native_id
  )
    throw new Error("read-state-unavailable");

  let transcript: string | null = null;
  const alias = store.sessions.id("codex", record.native_id);
  if (store.sessions.get(alias)) {
    const source = await sessions.resolve(alias);
    transcript = "transcript" in source ? (source.transcript ?? null) : null;
  }
  const verified = sessions.verifiedCodexControlDirectory(record.native_id);
  if (
    !verified ||
    !within(canonicalize(verified.cwd), canonicalize(record.workspace)) ||
    (record.cwd !== undefined && pathIdentity(verified.cwd) !== pathIdentity(record.cwd))
  )
    throw new Error("read-state-unavailable");
  transcript ??= sessions.verifiedCodexReadTranscript(record.native_id, record.workspace);
  return {
    provider: "codex",
    home: record.home,
    nativeId: record.native_id,
    workspace: verified.cwd,
    transcript,
  };
}

export const codexReadStateProvider: ReadStateProvider = {
  agent: "codex",
  home: ({ sessions }) => sessions.codexHome(),
  indexedWorkspace: ({ sessions }, source) =>
    sessions.verifiedCodexControlDirectory(source.native.native_ref)?.cwd,
  managed: {
    priority: 1,
    resolve: resolveManagedTarget,
    beforeGet: ({ dataDir, sessions }, id) => {
      // Codex writes a thread AgentKib started only with its first message.
      const parsed = managedRecordSchema.safeParse(readManagedRecord(dataDir, id));
      if (
        parsed.success &&
        parsed.data.native_id &&
        pathIdentity(parsed.data.home) === pathIdentity(sessions.codexHome()) &&
        !sessions.codexThreadWritten(parsed.data.native_id)
      )
        return emptyReadState("codex-native");
    },
  },
  readTranscript: (transcript) => codexRollouts.plain(transcript),
  observeTranscript: (ledger, key, file) => observeReadHistory(ledger, key, "codex", file),
  native: {
    source: "codex-native",
    executable: codexExecutable,
    observe: (environment, changed, activeTurn) =>
      new CodexReadStateObserver(environment, changed, undefined, activeTurn),
  },
};
