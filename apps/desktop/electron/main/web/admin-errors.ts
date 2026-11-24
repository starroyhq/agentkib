import type { WebAdminStatus } from "./service";

/** Exact reason codes allowed across the desktop Web admin boundary. */
const webAdminReasons = [
  "web_unavailable",
  "invalid_admin_request",
  "invalid_admin_operation",
  "invalid_web_target",
  "invalid_input",
  "web_not_running",
  "remote_enable_unavailable",
  "invitation_required_for_reenrollment",
  "invalid_configuration",
  "invalid_external_origin",
  "invalid_lan_address",
  "plaintext_confirmation_required",
  "invalid_workspace_grants",
  "invalid_relay_configuration",
  "invalid_preview_bandwidth",
  "acceptance_is_local_only",
  "device_not_found",
  "pairing_expired",
  "device_limit",
  "port_in_use",
  "web_state_save_failed",
  "web_start_failed",
  "lan_address_unavailable",
  "invalid_saved_configuration",
  "web_server_error",
  "account_login_required",
  "account_claim_pending",
  "account_registration_pending",
  "account_registration_mismatch",
  "invalid_account_registration",
  "account_device_missing",
  "account_identity_changed",
  "account_secure_storage_unavailable",
  "account_forbidden",
  "account_device_conflict",
  "account_device_limit",
  "account_rate_limited",
  "account_request_failed",
  "account_connection_failed",
  "account_response_invalid",
  "account_invalid_name",
  "account_name_already_set",
  "relay_invitation_required",
  "relay_setup_failed",
  "web_request_failed",
] as const;
export type WebAdminReason = (typeof webAdminReasons)[number];
const reasonCodes: ReadonlySet<string> = new Set(webAdminReasons);

export function readWebAdminReason(error: unknown): WebAdminReason {
  const code = error instanceof Error ? error.message : error;
  return typeof code === "string" && reasonCodes.has(code)
    ? (code as WebAdminReason)
    : "web_request_failed";
}

export type WebAdminReply =
  | { ok: true; status: WebAdminStatus }
  | { ok: false; reason: WebAdminReason };

/** Serialize the code explicitly: Electron decorates exceptions crossing an IPC invoke. */
export async function webAdminReply(
  request: () => Promise<WebAdminStatus>,
): Promise<WebAdminReply> {
  try {
    return { ok: true, status: await request() };
  } catch (error) {
    return { ok: false, reason: readWebAdminReason(error) };
  }
}
