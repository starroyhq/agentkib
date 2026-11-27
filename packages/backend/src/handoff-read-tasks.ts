import { validateCursorPlan, loadCursorRecoveryPlan } from "./cursor-native-import";
import { createHash } from "node:crypto";
import type { Commands } from "./commands";
import type { CursorBridgeContext } from "./cursor-bridge";
import { CursorIdeSessions, prepareCursorIdePayload } from "./cursor-ide-sessions";
import {
  fingerprintSessionDocument,
  planSessionWindow,
  renderHandoff,
  sessionImportStats,
} from "./session-handoff";
import { buildSessionArchive, validateSessionArchive } from "./session-archive";
import { renderNative } from "./session-handoff-plan";
import { validateHandoffFile, verifyNativeSession } from "./session-handoff-launch";
import { prepareNativeImportPayload } from "./session-native-import-projection";
import {
  buildNativeImportPlan,
  validateNativeImportApplicationData,
  loadNativeImportPlan,
  verifyOpenCodeExport,
  verifyHermesImport,
} from "./session-native-import-owner";
import { SessionReaders } from "./session-readers";
import { sessionIdentity, type NativeSession, type SessionStore } from "./session-store";
import type { DocumentOptions, SessionDocument } from "./session-model";
import { DevinSessions } from "./agents/devin/devin-sessions";
import { readVerifiedDshHistory } from "./agents/dsh/dsh-local-readers";
import { catalogClaudeTranscripts } from "./agents/claude/claude-sessions";

type Profile = CursorBridgeContext["profile"];
type Source = {
  sessionId: string;
  summary: NonNullable<ReturnType<SessionStore["get"]>>;
  workspace: string;
  profiles: Profile[];
  environment: NodeJS.ProcessEnv;
  identitySalt: string;
  options?: DocumentOptions;
};
type CursorRead = {
  profiles: Profile[];
  workspace: string;
  workspaceId: string;
  native: NativeSession;
  expected?: SessionDocument;
  exact?: boolean;
};
type DevinRead =
  | "list"
  | "events"
  | "image"
  | "document"
  | "subagents"
  | "subagentEvents"
  | "activitySubagents"
  | "model"
  | "lastContextInput";
type DevinTasks = {
  [K in DevinRead as `devin-${K}`]: [
    [filename: string, ...args: Parameters<DevinSessions[K]>],
    ReturnType<DevinSessions[K]>,
  ];
};
type Tasks = DevinTasks & {
  "claude-catalog-transcripts": [
    Parameters<typeof catalogClaudeTranscripts>,
    ReturnType<typeof catalogClaudeTranscripts>,
  ];
  "dsh-history": [
    Parameters<typeof readVerifiedDshHistory>,
    Awaited<ReturnType<typeof readVerifiedDshHistory>>,
  ];
  "cursor-plan": [Parameters<typeof validateCursorPlan>, ReturnType<typeof validateCursorPlan>];
  "cursor-recovery": [
    Parameters<typeof loadCursorRecoveryPlan>,
    ReturnType<typeof loadCursorRecoveryPlan>,
  ];
  "source-document": [Source, SessionDocument];
  fingerprint: [SessionDocument, string];
  window: [Parameters<typeof planSessionWindow>, ReturnType<typeof planSessionWindow>];
  render: [Parameters<typeof renderHandoff>, string];
  stats: [SessionDocument, ReturnType<typeof sessionImportStats>];
  "native-render": [Parameters<typeof renderNative>, string];
  archive: [Parameters<typeof buildSessionArchive>, ReturnType<typeof buildSessionArchive>];
  "validate-archive": [
    Parameters<typeof validateSessionArchive>,
    ReturnType<typeof validateSessionArchive>,
  ];
  "validate-handoff-file": [Parameters<typeof validateHandoffFile>, string];
  "validate-native-session": [Parameters<typeof verifyNativeSession>, void];
  "native-projection": [
    Parameters<typeof prepareNativeImportPayload>,
    ReturnType<typeof prepareNativeImportPayload>,
  ];
  "cursor-projection": [
    Parameters<typeof prepareCursorIdePayload>,
    ReturnType<typeof prepareCursorIdePayload>,
  ];
  "cursor-list": [
    { profiles: Profile[]; workspace: string },
    ReturnType<CursorIdeSessions["list"]>,
  ];
  "cursor-read": [CursorRead, { document: SessionDocument; nativeId: string }];
  serialize: [
    { value: unknown; pretty: boolean; newline: boolean },
    { content: string; hash: string },
  ];
  "native-plan": [Parameters<typeof loadNativeImportPlan>, ReturnType<typeof loadNativeImportPlan>];
  "native-import-plan": [
    Parameters<typeof buildNativeImportPlan>,
    Awaited<ReturnType<typeof buildNativeImportPlan>>,
  ];
  "native-change": [
    Parameters<typeof validateNativeImportApplicationData>,
    ReturnType<typeof validateNativeImportApplicationData>,
  ];
  "opencode-verify": [
    Parameters<typeof verifyOpenCodeExport>,
    ReturnType<typeof verifyOpenCodeExport>,
  ];
  "hermes-verify": [
    Parameters<typeof verifyHermesImport>,
    Awaited<ReturnType<typeof verifyHermesImport>>,
  ];
};
export type HandoffReadKind = keyof Tasks;
export type HandoffReadInput<K extends HandoffReadKind> = Tasks[K][0];
export type HandoffReadOutput<K extends HandoffReadKind> = Tasks[K][1];

let devin: DevinSessions | undefined;
function devinReader(filename: string): DevinSessions {
  if (devin?.database() !== filename) devin = new DevinSessions({}, filename);
  return devin!;
}

export function cursorReader(profiles: Profile[], workspace: string): CursorIdeSessions {
  return new CursorIdeSessions({
    profiles: (requested) => {
      if (requested !== workspace) throw new Error("Cursor read escaped its bound workspace");
      return profiles;
    },
  });
}

export async function readCursorSnapshot(
  input: CursorRead,
): Promise<{ document: SessionDocument; nativeId: string }> {
  const provider = cursorReader(input.profiles, input.workspace);
  const document = provider.document(input.native, input.workspaceId, input.workspace);
  if (input.expected) {
    const projection = (value: SessionDocument) =>
      value.turns.map((turn) => ({
        role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
        text: turn.blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n"),
      }));
    provider.verifyPromptProjection(
      input.native.native_ref,
      input.workspace,
      projection(input.expected),
      input.exact ?? true,
    );
    if (
      (input.exact !== false && document.turns.length !== input.expected.turns.length) ||
      JSON.stringify(projection(document).slice(0, input.expected.turns.length)) !==
        JSON.stringify(projection(input.expected))
    )
      throw new Error("Cursor imported history differs from the approved preview");
  }
  return { document, nativeId: provider.nativeId(input.native.native_ref, input.workspace) };
}

/** The wire is private to this process; each operation has one fixed parser and return type. */
export async function executeHandoffRead<K extends HandoffReadKind>(
  kind: K,
  input: HandoffReadInput<K>,
  commands: Commands,
): Promise<HandoffReadOutput<K>> {
  let value: unknown;
  switch (kind) {
    case "claude-catalog-transcripts":
      value = catalogClaudeTranscripts(...(input as Tasks["claude-catalog-transcripts"][0]));
      break;
    case "dsh-history":
      value = await readVerifiedDshHistory(...(input as Tasks["dsh-history"][0]));
      break;
    case "devin-list": {
      const [filename, ...args] = input as Tasks["devin-list"][0];
      value = devinReader(filename).list(...args);
      break;
    }
    case "devin-events": {
      const [filename, ...args] = input as Tasks["devin-events"][0];
      value = devinReader(filename).events(...args);
      break;
    }
    case "devin-image": {
      const [filename, ...args] = input as Tasks["devin-image"][0];
      value = devinReader(filename).image(...args);
      break;
    }
    case "devin-document": {
      const [filename, ...args] = input as Tasks["devin-document"][0];
      value = devinReader(filename).document(...args);
      break;
    }
    case "devin-activitySubagents": {
      const [filename, ...args] = input as Tasks["devin-activitySubagents"][0];
      value = devinReader(filename).activitySubagents(...args);
      break;
    }
    case "devin-subagents": {
      const [filename, ...args] = input as Tasks["devin-subagents"][0];
      value = devinReader(filename).subagents(...args);
      break;
    }
    case "devin-subagentEvents": {
      const [filename, ...args] = input as Tasks["devin-subagentEvents"][0];
      value = devinReader(filename).subagentEvents(...args);
      break;
    }
    case "devin-model": {
      const [filename, ...args] = input as Tasks["devin-model"][0];
      value = devinReader(filename).model(...args);
      break;
    }
    case "devin-lastContextInput": {
      const [filename, ...args] = input as Tasks["devin-lastContextInput"][0];
      value = devinReader(filename).lastContextInput(...args);
      break;
    }
    case "cursor-plan":
      value = validateCursorPlan(...(input as Tasks["cursor-plan"][0]));
      break;
    case "cursor-recovery":
      value = loadCursorRecoveryPlan(...(input as Tasks["cursor-recovery"][0]));
      break;
    case "source-document": {
      const source = input as Source;
      const store = {
        get: (id: string) => (id === source.sessionId ? source.summary : null),
        workspacePath: (id: string) => {
          if (id !== source.summary.workspace_id)
            throw new Error("History read escaped its workspace");
          return source.workspace;
        },
        identitySalt: () => source.identitySalt,
        id: (agent: Parameters<SessionStore["id"]>[0], ref: string) =>
          sessionIdentity(source.identitySalt, agent, ref),
      };
      const reader = new SessionReaders(
        store,
        commands,
        source.environment,
        cursorReader(source.profiles, source.workspace).bridge,
      );
      try {
        value = await reader.document(source.sessionId, source.options);
      } finally {
        reader.close();
      }
      break;
    }
    case "fingerprint":
      value = fingerprintSessionDocument(input as SessionDocument);
      break;
    case "window":
      value = planSessionWindow(...(input as Tasks["window"][0]));
      break;
    case "render":
      value = renderHandoff(...(input as Tasks["render"][0]));
      break;
    case "stats":
      value = sessionImportStats(input as SessionDocument);
      break;
    case "native-render":
      value = renderNative(...(input as Tasks["native-render"][0]));
      break;
    case "archive":
      value = buildSessionArchive(...(input as Tasks["archive"][0]));
      break;
    case "validate-archive":
      value = validateSessionArchive(...(input as Tasks["validate-archive"][0]));
      break;
    case "validate-handoff-file":
      value = validateHandoffFile(...(input as Tasks["validate-handoff-file"][0]));
      break;
    case "validate-native-session":
      value = verifyNativeSession(...(input as Tasks["validate-native-session"][0]));
      break;
    case "native-projection":
      value = prepareNativeImportPayload(...(input as Tasks["native-projection"][0]));
      break;
    case "cursor-projection":
      value = prepareCursorIdePayload(...(input as Tasks["cursor-projection"][0]));
      break;
    case "cursor-list": {
      const source = input as Tasks["cursor-list"][0];
      value = cursorReader(source.profiles, source.workspace).list(source.workspace);
      break;
    }
    case "cursor-read":
      value = await readCursorSnapshot(input as CursorRead);
      break;
    case "serialize": {
      const data = input as Tasks["serialize"][0];
      const content =
        JSON.stringify(data.value, null, data.pretty ? 2 : undefined) + (data.newline ? "\n" : "");
      value = { content, hash: createHash("sha256").update(content).digest("hex") };
      break;
    }
    case "native-plan":
      value = loadNativeImportPlan(...(input as Tasks["native-plan"][0]));
      break;
    case "native-import-plan":
      value = await buildNativeImportPlan(...(input as Tasks["native-import-plan"][0]));
      break;
    case "native-change":
      value = validateNativeImportApplicationData(...(input as Tasks["native-change"][0]));
      break;
    case "opencode-verify": {
      const args = input as Tasks["opencode-verify"][0];
      value = verifyOpenCodeExport(args[0], Buffer.from(args[1]), args[2]);
      break;
    }
    case "hermes-verify":
      value = await verifyHermesImport(...(input as Tasks["hermes-verify"][0]));
      break;
    default:
      throw new Error("Unknown handoff read operation");
  }
  return value as HandoffReadOutput<K>;
}
