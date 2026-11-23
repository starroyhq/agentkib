import type { Live, SessionApprovalKind, SessionProviderDeclaration } from "@agentkib/web-client";
import type {
  ApprovalChoice,
  InteractionApproval,
  InteractionCardCopy,
  InteractionLocale,
} from "../interaction-model";
import type { SessionSurface } from "../session-surface-copy";
import { acpApprovalMethods } from "./antigravity/approvals";
import { terminalApprovalMethods, terminalApprovalRuntime } from "./claude-code/approvals";
import { nativeAppApproval, nativeAppApprovalMethods } from "./codex/approvals";
import { pluginApprovalMethods, pluginApprovalRuntime } from "./deepseek-harness/approvals";

export { namedApprovalChoices } from "./antigravity/approvals";
export { nativeApprovalChoices, networkHost } from "./codex/approvals";

export type LegacyApproval = {
  kind: SessionApprovalKind | ((approval: InteractionApproval) => SessionApprovalKind);
  nativeToolCall?: boolean;
  choices?: (approval: InteractionApproval, copy: InteractionCardCopy) => ApprovalChoice[];
};

export type LegacyApprovals = Readonly<Record<string, LegacyApproval>>;

const legacyMethods: LegacyApprovals = {
  ...nativeAppApprovalMethods,
  ...terminalApprovalMethods,
  ...pluginApprovalMethods,
  ...acpApprovalMethods,
};

export function resolveApprovalPresentation(approval: InteractionApproval) {
  const legacy = Object.hasOwn(legacyMethods, approval.method)
    ? legacyMethods[approval.method]
    : undefined;
  const kind =
    approval.presentation ??
    (typeof legacy?.kind === "function" ? legacy.kind(approval) : legacy?.kind) ??
    "unknown";
  return {
    kind,
    legacy,
    nativeToolCall: legacy?.nativeToolCall ?? approval.toolCall != null,
  };
}

export type ApprovalRuntime = {
  owner: NonNullable<Live["execution"]>["owner"];
  legacyMode: NonNullable<Live["executionMode"]>;
  handleThere?: (locale: InteractionLocale) => string;
  reportsWithdrawn?: boolean;
  observedText?: (
    live: Live,
    sessionId: string,
    locale: InteractionLocale,
    surface: SessionSurface,
  ) => string | undefined;
};

type ConnectionKind = NonNullable<SessionProviderDeclaration["connection"]>["kind"];

const runtimeApprovals: Partial<Record<ConnectionKind, ApprovalRuntime>> = {
  "native-app": nativeAppApproval,
  "terminal-bridge": terminalApprovalRuntime,
  "plugin-bridge": pluginApprovalRuntime,
};

export function sessionApprovalRuntime(
  live: { execution?: Live["execution"]; executionMode?: string | null },
  connection?: ConnectionKind,
) {
  const registration = connection
    ? Object.hasOwn(runtimeApprovals, connection)
      ? runtimeApprovals[connection]
      : undefined
    : Object.values(runtimeApprovals).find((entry) => entry.legacyMode === live.executionMode);
  if (!registration) return undefined;
  const owner = live.execution?.owner;
  return (owner ? owner === registration.owner : live.executionMode === registration.legacyMode)
    ? registration
    : undefined;
}
