type UnavailableReasonCopy = {
  openOriginalClient: string;
  unverifiedInstallation: string;
  antigravityCliUnavailable: string;
  antigravityAppSession: string;
  unsupportedControl: string;
  unavailable: string;
};

/** Only known reason codes get specific advice. Runtime errors can contain private details. */
export function unavailableReasonText(reason: string, words: UnavailableReasonCopy): string {
  switch (reason) {
    case "open-in-original-client":
      return words.openOriginalClient;
    case "unverified-installation":
      return words.unverifiedInstallation;
    // Antigravity is controlled through its CLI's `agy acp`, which the Antigravity App lacks.
    case "antigravity-cli-unavailable":
      return words.antigravityCliUnavailable;
    // Antigravity App and IDE conversations are browsed from their own stores.
    case "session-read-only":
      return words.antigravityAppSession;
    case "platform-unsupported":
    case "provider-unsupported":
      return words.unsupportedControl;
    default:
      return words.unavailable;
  }
}
