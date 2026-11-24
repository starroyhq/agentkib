import type { WebAdminReason } from "../../../electron/main/web/admin-errors";
import { lanSettingsCopy } from "./lan-settings-copy";
import { remoteAccountCopy } from "./remote-account-copy";
import { remoteEntryCopy } from "./remote-entry-copy";
import { webRecoveryCopy } from "./web-recovery-copy";
import { webSettingsCopy } from "./web-settings-copy";

type Locale = keyof typeof webRecoveryCopy;
type RecoveryAction = "reload" | "settings" | "account" | "restart" | "generate-code" | "retry";
type RecoveryReason =
  | keyof (typeof webRecoveryCopy)["en-US"]["reasons"]
  | "port"
  | "save"
  | "start"
  | "addressLost"
  | "accountLimit"
  | "accountName"
  | "fallback";

const recoveries: Record<WebAdminReason, [RecoveryReason, RecoveryAction]> = {
  web_unavailable: ["serviceUnavailable", "reload"],
  invalid_admin_request: ["requestInvalid", "reload"],
  invalid_admin_operation: ["requestInvalid", "reload"],
  invalid_web_target: ["requestInvalid", "reload"],
  invalid_input: ["requestInvalid", "reload"],
  web_not_running: ["serviceStopped", "settings"],
  remote_enable_unavailable: ["remoteUnsupported", "settings"],
  invitation_required_for_reenrollment: ["invitationRequired", "settings"],
  invalid_configuration: ["configurationInvalid", "settings"],
  invalid_external_origin: ["originInvalid", "settings"],
  invalid_lan_address: ["lanAddressInvalid", "settings"],
  plaintext_confirmation_required: ["plaintextConfirmation", "settings"],
  invalid_workspace_grants: ["workspaceGrantsInvalid", "settings"],
  invalid_relay_configuration: ["relayConfigurationInvalid", "settings"],
  invalid_preview_bandwidth: ["bandwidthInvalid", "settings"],
  acceptance_is_local_only: ["remoteUnsupported", "settings"],
  device_not_found: ["deviceMissing", "reload"],
  pairing_expired: ["pairingExpired", "generate-code"],
  device_limit: ["deviceLimit", "reload"],
  port_in_use: ["port", "settings"],
  web_state_save_failed: ["save", "settings"],
  web_start_failed: ["start", "settings"],
  lan_address_unavailable: ["addressLost", "settings"],
  invalid_saved_configuration: ["savedConfigurationInvalid", "settings"],
  web_server_error: ["serverInterrupted", "restart"],
  account_login_required: ["loginRequired", "account"],
  account_claim_pending: ["claimPending", "account"],
  account_registration_pending: ["registrationPending", "account"],
  account_registration_mismatch: ["wrongAccount", "account"],
  invalid_account_registration: ["registrationInvalid", "account"],
  account_device_missing: ["registrationInvalid", "account"],
  account_identity_changed: ["wrongAccount", "account"],
  account_secure_storage_unavailable: ["secureStorageUnavailable", "account"],
  account_forbidden: ["accountForbidden", "account"],
  account_device_conflict: ["wrongAccount", "account"],
  account_device_limit: ["accountLimit", "account"],
  account_rate_limited: ["accountRateLimited", "retry"],
  account_request_failed: ["accountUnavailable", "retry"],
  account_connection_failed: ["accountUnavailable", "retry"],
  account_response_invalid: ["accountResponseInvalid", "account"],
  account_invalid_name: ["accountName", "account"],
  account_name_already_set: ["accountName", "account"],
  relay_invitation_required: ["invitationRequired", "settings"],
  relay_setup_failed: ["relaySetupFailed", "settings"],
  web_request_failed: ["fallback", "reload"],
};

export function webAdminRecovery(locale: Locale, code: WebAdminReason, save: boolean) {
  const [reason, action] = recoveries[code];
  const settings = webSettingsCopy[locale];
  const entry = remoteEntryCopy[locale];
  const account = remoteAccountCopy[locale];
  const messages = {
    ...webRecoveryCopy[locale].reasons,
    port: settings.portError,
    save: entry.saveFailed,
    start: entry.startFailed,
    addressLost: lanSettingsCopy[locale].addressLost,
    accountLimit: account.limit,
    accountName: account.failed,
    fallback: `${save ? entry.saveFailed : settings.unavailable} (${code})`,
  };
  return {
    message: reason === "relaySetupFailed" ? `${messages[reason]} (${code})` : messages[reason],
    action,
  };
}
