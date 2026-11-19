import { describe, expect, it } from "vitest";
import { managedText } from "@/features/conversation/features/sessions/managed-copy";
import source from "@/features/conversation/features/sessions/session-receipt-recovery.tsx?raw";
import { surfaceText } from "@/features/conversation/features/sessions/session-surface-copy";

const calls = [
  ...source.matchAll(
    /managedText\(\s*locale,\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*,?\s*\)/g,
  ),
].map((match) => ({
  english: JSON.parse(match[1]) as string,
  chinese: JSON.parse(match[2]) as string,
  surface: JSON.parse(match[3]) as string,
}));

describe("management copy at actual call sites", () => {
  it("checks every literal managedText call instead of comparing dictionary key counts", () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength([...source.matchAll(/managedText\(/g)].length);
    expect(calls.every(({ surface }) => surface === "web")).toBe(true);
  });
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "resolves every rendered management string in %s without the Chinese fallback",
    (locale) => {
      for (const { english, chinese } of calls) {
        const translated = managedText(locale, english, chinese, "web");
        if (locale === "en-US") expect(translated).toBe(surfaceText(english, "web", locale));
        else if (locale === "zh-CN") expect(translated).toBe(surfaceText(chinese, "web", locale));
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
