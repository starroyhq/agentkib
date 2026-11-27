import {
  CLAUDE_COMMAND_REFUSALS,
  DSH_COMMAND_REFUSALS,
  REMOTE_ERROR_CODES,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";

const continuationReasons: readonly RemoteErrorCode[] = [
  // A slash command AgentKib did not send; clients explain each one.
  ...CLAUDE_COMMAND_REFUSALS,
  REMOTE_ERROR_CODES.sessionCompacting,
  REMOTE_ERROR_CODES.codexOwnerBusy,
  REMOTE_ERROR_CODES.codexCliVersionTooOld,
  REMOTE_ERROR_CODES.codexCliUnavailable,
  REMOTE_ERROR_CODES.codexCliVersionUnavailable,
  REMOTE_ERROR_CODES.codexOwnerCheckUnavailable,
  REMOTE_ERROR_CODES.unsupportedCodexCliVersion,
  REMOTE_ERROR_CODES.unsupportedModelDetail,
  REMOTE_ERROR_CODES.unsupportedEffortDetail,
  REMOTE_ERROR_CODES.nativeModelUnconfirmed,
  REMOTE_ERROR_CODES.nativeEffortUnconfirmed,
  REMOTE_ERROR_CODES.createPermissionUnconfirmed,
  // Verified Codex policy diagnostics. Raw native settings stay on the host.
  REMOTE_ERROR_CODES.nativePolicyUnconfirmed,
  REMOTE_ERROR_CODES.nativePolicyFullAccessRequired,
  REMOTE_ERROR_CODES.nativePolicyCwdMismatch,
  REMOTE_ERROR_CODES.nativePolicyApprovalPolicyMismatch,
  REMOTE_ERROR_CODES.nativePolicyApprovalsReviewerMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxTypeMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxNetworkMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxWritableRootsMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxTmpdirMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxSlashTmpMismatch,
  REMOTE_ERROR_CODES.nativePolicySandboxReadAccessMismatch,
  REMOTE_ERROR_CODES.claudeOwnerBusy,
  REMOTE_ERROR_CODES.claudeBackgroundSessionRunning,
  REMOTE_ERROR_CODES.claudeOwnerCheckUnavailable,
  REMOTE_ERROR_CODES.claudeTerminalHandoverModelUnconfirmed,
  REMOTE_ERROR_CODES.claudeTerminalHandoverPermissionUnconfirmed,
  REMOTE_ERROR_CODES.claudeTerminalHandoverUnavailable,
  REMOTE_ERROR_CODES.claudeTerminalHandoverWorkspaceUnavailable,
  REMOTE_ERROR_CODES.claudeTerminalReportOwnerUnavailable,
  REMOTE_ERROR_CODES.claudeTerminalReportUnconfirmed,
  REMOTE_ERROR_CODES.ownerOpenedElsewhere,
  REMOTE_ERROR_CODES.claudeCliUnavailable,
  REMOTE_ERROR_CODES.claudeCliTooOld,
  REMOTE_ERROR_CODES.platformUnsupported,
  REMOTE_ERROR_CODES.followerOperationUnverified,
  // The executor refused an image: its model takes none, or the image is outside its limits.
  REMOTE_ERROR_CODES.modelImagesUnsupported,
  REMOTE_ERROR_CODES.attachmentInvalid,
  // The attachment file no longer held the checked bytes when the executor read it.
  REMOTE_ERROR_CODES.attachmentChangedDetail,
  REMOTE_ERROR_CODES.attachmentUnavailable,
  REMOTE_ERROR_CODES.dshAttachmentsUnavailable,
  // DeepSeek Harness: a slash command it did not take or did not finish, and goal changes it
  // refused because the goal changed meanwhile or allows no such change now.
  ...DSH_COMMAND_REFUSALS,
  REMOTE_ERROR_CODES.dshCommandUnavailable,
  REMOTE_ERROR_CODES.dshCommandFailed,
  // Starting DeepSeek Harness in the background failed, or another DSH holds the session.
  REMOTE_ERROR_CODES.dshStartFailed,
  REMOTE_ERROR_CODES.dshVersionUnsupported,
  REMOTE_ERROR_CODES.dshLauncherUnavailable,
  REMOTE_ERROR_CODES.dshExited,
  REMOTE_ERROR_CODES.dshSessionInUse,
  REMOTE_ERROR_CODES.dshNativeStatusUnknown,
  REMOTE_ERROR_CODES.goalChanged,
  REMOTE_ERROR_CODES.goalActionUnavailable,
  REMOTE_ERROR_CODES.goalRoundsExhausted,
  REMOTE_ERROR_CODES.goalTokenBudgetUnavailable,
  // Devin CLI refused before running a turn; clients explain each one, and the desktop offers
  // to open Devin's own login or workspace trust in a terminal.
  REMOTE_ERROR_CODES.devinLoginRequired,
  REMOTE_ERROR_CODES.devinWorkspaceUntrusted,
  REMOTE_ERROR_CODES.devinCliUnavailable,
  REMOTE_ERROR_CODES.devinCliUpdateRequired,
  REMOTE_ERROR_CODES.devinRunFailed,
  REMOTE_ERROR_CODES.devinRunStopped,
  REMOTE_ERROR_CODES.devinSessionNotFound,
  REMOTE_ERROR_CODES.sessionOpenElsewhere,
  REMOTE_ERROR_CODES.attachmentsUnsupported,
  // Antigravity CLI's `agy acp` could not run or finish a turn; clients explain each one.
  REMOTE_ERROR_CODES.antigravityCliUnavailable,
  REMOTE_ERROR_CODES.antigravityLoginRequired,
  REMOTE_ERROR_CODES.antigravityUsageLimited,
  REMOTE_ERROR_CODES.antigravityRunFailed,
];

/** Only these owner diagnostics may cross the host boundary as public reasons. */
export function continuationPreflightReason(
  reason: unknown,
  fallback: RemoteErrorCode = REMOTE_ERROR_CODES.controlPreflightRejected,
): RemoteErrorCode {
  return continuationReasons.find((code) => code === reason) ?? fallback;
}
