import type {
  ConversationReadResult,
  ConversationReadState,
  ConversationReadStateMark,
  ReadStateProvider as ReadStateAgent,
} from "@agentkib/runtime-protocol";
import type { ReadStateLedger } from "../read-state-ledger";
import type { SessionReaders } from "../session-readers";
import type { BackendStore } from "../store";

export interface ReadStateTarget {
  provider: ReadStateAgent;
  home: string;
  nativeId: string;
  workspace: string;
  transcript: string | null;
}

export type ReadStateProviderContext = {
  store: BackendStore;
  sessions: SessionReaders;
  dataDir: string;
  environment: NodeJS.ProcessEnv;
  claudeManagedTarget(id: string): ReadStateTarget | null;
};

export type ReadStateIndexedSource = Awaited<ReturnType<SessionReaders["resolve"]>>;
export type NativeReadStateTarget = ReadStateTarget & { key: string; executable: string };
export type ReadStateActiveTurn = (
  target: Pick<ReadStateTarget, "home" | "workspace" | "nativeId">,
) => string | null;

export interface NativeReadStateObserver {
  cached(target: NativeReadStateTarget, scope: string): ConversationReadState | null;
  lastVerified(target: NativeReadStateTarget, scope: string): ConversationReadState | null;
  refresh(target: NativeReadStateTarget, scope: string): Promise<ConversationReadState | null>;
  update(
    target: NativeReadStateTarget,
    scope: string,
    expectedVersion: string,
    seenResultId: string | null,
    mark?: ConversationReadStateMark,
  ): Promise<ConversationReadState>;
  revision(target: NativeReadStateTarget): string | null;
  pollPage(target: NativeReadStateTarget): Promise<void>;
  close(): Promise<void>;
}

export interface ReadStateProvider {
  readonly agent: ReadStateAgent;
  home(context: ReadStateProviderContext): string;
  indexedWorkspace?(
    context: ReadStateProviderContext,
    source: ReadStateIndexedSource,
  ): string | undefined;
  readonly managed?: {
    priority: number;
    resolve(
      context: ReadStateProviderContext,
      id: string,
    ): ReadStateTarget | Promise<ReadStateTarget> | null;
    beforeGet?(context: ReadStateProviderContext, id: string): ConversationReadState | undefined;
  };
  readonly reuseTarget?: true;
  readTranscript?(transcript: string): Promise<string> | string;
  observeTranscript?(
    ledger: ReadStateLedger,
    key: string,
    file: string,
  ): { changed: boolean; complete: boolean };
  transcriptReply?(
    ledger: ReadStateLedger,
    key: string,
    result: ConversationReadResult,
  ): string | undefined;
  /** This reader records all results at their source and has no older history to scan. */
  ledgerOnly?(state: ConversationReadState): ConversationReadState;
  readonly native?: {
    source: Exclude<ConversationReadState["source"], "agentkib">;
    executable(environment: NodeJS.ProcessEnv): string | null;
    observe(
      environment: NodeJS.ProcessEnv,
      changed: () => void,
      activeTurn?: ReadStateActiveTurn,
    ): NativeReadStateObserver;
  };
}

export function emptyReadState(source: ConversationReadState["source"]): ConversationReadState {
  return {
    source,
    status: "read",
    freshness: "current",
    version: null,
    firstUnread: null,
    latestResult: null,
  };
}
