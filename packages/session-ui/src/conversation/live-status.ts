type UnavailableReasonCopy = {
  openOriginalClient: string;
  unverifiedInstallation: string;
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
    case "platform-unsupported":
    case "provider-unsupported":
      return words.unsupportedControl;
    default:
      return words.unavailable;
  }
}
