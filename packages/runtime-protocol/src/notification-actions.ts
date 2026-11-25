export interface PushApprovalAction {
  /** All choices on this interaction use a single device-scoped receipt. */
  requestId: string;
  bootId: string;
  /** UNIX milliseconds. Expiring a notification does not expire an original receipt. */
  expiresAt: number;
  /** The token for each available R25 decision ID. A paired device still authenticates normally. */
  choices: Record<string, string>;
}
