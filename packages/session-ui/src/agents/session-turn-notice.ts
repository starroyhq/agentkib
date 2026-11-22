import type { ConversationSessionSummary, Live } from "@agentkib/web-client";
import { devinTurnNotice } from "./devin/turn-notice";

const notices = [devinTurnNotice];

export function sessionTurnNotice({
  current,
  selected,
  live,
  refused,
}: {
  current?: Pick<ConversationSessionSummary, "id" | "agent">;
  selected: string;
  live?: Live;
  refused?: string;
}) {
  if (!current || current.id !== selected) return;
  const idle = live?.sessionId === selected && live.status === "idle" ? live : undefined;
  const candidates = refused
    ? [refused]
    : [...(idle?.feedback ?? []).map(({ code }) => code), idle?.reason];
  for (const reason of candidates) {
    if (!reason) continue;
    const entry = notices.find(
      (notice) => notice.reasons.includes(reason) && notice.supports(current.agent),
    );
    if (entry) return { Component: entry.Component, reason };
  }
}
