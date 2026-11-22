import type { SessionTurnControlRegistration } from "../session-turn-controls";

export function isDshNativeStatusUnknown(
  state?: {
    status: string;
    reason?: string | null;
    ownershipReason?: string | null;
  } | null,
) {
  return (
    state?.status === "unavailable" ||
    state?.reason === "dsh-native-status-unknown" ||
    state?.ownershipReason === "dsh-native-status-unknown"
  );
}

export const dshTurnControls: SessionTurnControlRegistration = {
  allowsSendStatus: (live) => live.status === "unsupported" && isDshNativeStatusUnknown(live),
};
