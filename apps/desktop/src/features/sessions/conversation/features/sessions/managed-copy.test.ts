import { describe, expect, it } from "vitest";
import { managedText, surfaceText } from "@agentkib/session-ui";
import source from "../../../../../../../../packages/session-ui/src/conversation/sessions/session-receipt-recovery.tsx?raw";

const calls = [
  ...source.matchAll(
    /managedText\(\s*locale,\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*,\s*kind\s*,?\s*\)/g,
  ),
].map((match) => ({
  english: JSON.parse(match[1]) as string,
  chinese: JSON.parse(match[2]) as string,
}));

describe("management copy at actual call sites", () => {
  it("checks every literal managedText call instead of comparing dictionary key counts", () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength([...source.matchAll(/managedText\(/g)].length);
  });
  describe.each(["desktop", "web"] as const)("on %s", (surface) => {
    it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
      "passes the active surface and resolves all recovery copy in %s",
      (locale) => {
        for (const { english, chinese } of calls) {
          const translated = managedText(locale, english, chinese, surface);
          if (locale === "en-US") expect(translated).toBe(surfaceText(english, surface, locale));
          else if (locale === "zh-CN")
            expect(translated).toBe(surfaceText(chinese, surface, locale));
          // This label has the same valid spelling in both Chinese locales.
          else if (locale === "zh-Hant" && chinese === "模型") expect(translated).toBe("模型");
          else {
            expect(translated, chinese).not.toBe(chinese);
            expect(translated, chinese).not.toBe(english);
          }
        }
      },
    );
  });
});
