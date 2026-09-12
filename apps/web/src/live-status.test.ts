import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";
import { unavailableReasonText } from "./live-status";

describe.each(Object.entries(dictionaries))("unavailable reason in %s", (_locale, words) => {
  it("only recommends opening the original client for an absent owner", () => {
    expect(unavailableReasonText("open-in-original-client", words)).toBe(words.openOriginalClient);
    expect(unavailableReasonText("unverified-installation", words)).toBe(
      words.unverifiedInstallation,
    );
    expect(words.unverifiedInstallation).not.toBe(words.openOriginalClient);
  });
  it.each(["platform-unsupported", "provider-unsupported"])("explains %s", (reason) => {
    expect(unavailableReasonText(reason, words)).toBe(words.unsupportedControl);
  });
  it.each(["live-session-busy", "session-identity-changed", "private raw error /Users/example"])(
    "uses safe generic copy for %s",
    (reason) => {
      expect(unavailableReasonText(reason, words)).toBe(words.unavailable);
      expect(words.unavailable).not.toContain(reason);
      expect(words.unavailable).not.toBe(words.openOriginalClient);
    },
  );
});
