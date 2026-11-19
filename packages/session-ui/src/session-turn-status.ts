import type { ConversationSessionSummary, Live } from "@agentkib/web-client";

export type SessionTurnLive = Pick<
  Live,
  | "sessionId"
  | "status"
  | "turnId"
  | "activity"
  | "approvals"
  | "questions"
  | "cancelling"
  | "reason"
  | "ownershipReason"
>;
export type SessionExternalTurn = NonNullable<ConversationSessionSummary["externalTurn"]> & {
  turnId?: string | null;
};

type SessionTurnStatus = {
  kind: "running" | "starting" | "waiting" | "compacting" | "cancelling";
  turnId?: string | null;
  startedAt?: string | null;
};

const waiting = ["awaiting-approval", "waiting-approval", "awaiting-input", "waiting-input"];
const externalOwners = [
  "codex-owner-busy",
  "claude-owner-busy",
  "claude-background-session-running",
  "owner-opened-elsewhere",
];

/** Activity follows the selected session's executor, independently of device control grants. */
export function sessionTurnStatus(
  sessionId: string,
  value?: SessionTurnLive | null,
  external?: SessionExternalTurn | null,
): SessionTurnStatus | undefined {
  const live = value?.sessionId === sessionId ? value : undefined;
  if (live?.cancelling) return { kind: "cancelling", turnId: live.turnId };
  if (live && (waiting.includes(live.status) || live.approvals?.length || live.questions?.length))
    return { kind: "waiting", turnId: live.turnId };
  if (live?.activity === "compacting") return { kind: "compacting", turnId: live.turnId };
  if (live?.status === "running" || live?.status === "starting")
    return {
      kind: live.status,
      turnId: live.turnId ?? external?.turnId,
      startedAt: external?.startedAt,
    };

  // An owner that has not attached can leave the detail idle while the native turn is verified.
  const owner = live?.ownershipReason ?? live?.reason;
  if (
    external?.status === "running" &&
    (!live ||
      (["idle", "unsupported"].includes(live.status) && !!owner && externalOwners.includes(owner)))
  )
    return { kind: "running", turnId: external.turnId, startedAt: external.startedAt };
}

const runningLabels = {
  "zh-CN": [
    "忙活中…",
    "琢磨中…",
    "酝酿中…",
    "梳理中…",
    "推敲中…",
    "正在理顺…",
    "手头正忙…",
    "正在处理…",
    "正在推进…",
    "正在干活…",
  ],
  "zh-Hant": [
    "忙碌中…",
    "構思中…",
    "醞釀中…",
    "整理中…",
    "推敲中…",
    "正在理順…",
    "手邊正忙…",
    "正在處理…",
    "正在推進…",
    "正在作業…",
  ],
  "en-US": [
    "Cooking…",
    "Baking…",
    "Brewing…",
    "Simmering…",
    "Stirring…",
    "Mixing…",
    "Whisking…",
    "Prepping…",
    "Warming up…",
    "Working…",
  ],
  "ja-JP": [
    "作業中…",
    "考え中…",
    "構想中…",
    "検討中…",
    "取り組み中…",
    "整理中…",
    "組み立て中…",
    "処理中…",
    "進行中…",
    "手を動かしています…",
  ],
} as const;

export function runningTurnLabel(locale: string, sessionId: string, turn: SessionTurnStatus) {
  const options =
    runningLabels[
      locale === "zh-Hant"
        ? "zh-Hant"
        : locale.startsWith("zh")
          ? "zh-CN"
          : locale.startsWith("ja")
            ? "ja-JP"
            : "en-US"
    ];
  const key = JSON.stringify([sessionId, turn.turnId ?? turn.startedAt ?? null]);
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++)
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return options[(hash >>> 0) % options.length];
}
