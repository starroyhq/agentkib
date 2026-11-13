// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import enUS from "../locales/en-US.json";
import jaJP from "../locales/ja-JP.json";
import zhCN from "../locales/zh-CN.json";
import zhHant from "../locales/zh-Hant.json";
import {
  cacheEffectiveLocale,
  cachedEffectiveLocale,
  changeLocale,
  formatCompactNumber,
  initializeI18n,
  normalizeLocale,
  tr,
} from "./i18n";

const dictionaries = { "en-US": enUS, "zh-CN": zhCN, "zh-Hant": zhHant, "ja-JP": jaJP } as const;

describe("i18n resources", () => {
  it.each(["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const)(
    "describes the actual ignored-workspace recovery destination in %s",
    async (locale) => {
      await initializeI18n(locale);
      const message = tr("workspace.ignoreConfirm");
      expect(message).toContain(tr("nav.settings"));
      expect(message).toContain(tr("settings.section.discovery"));
      expect(message).toContain(tr("settings.excluded"));
      expect(tr("workspace.changesApplying")).not.toEqual(tr("dialog.quit.changesApplying"));
    },
  );

  it("keeps keys and interpolation parameters identical", () => {
    const englishKeys = Object.keys(enUS).sort();
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        const placeholders = (
          String(dictionary[key as keyof typeof dictionary]).match(/{{[^}]+}}/g) ?? []
        ).sort();
        const englishPlaceholders = (
          String(enUS[key as keyof typeof enUS]).match(/{{[^}]+}}/g) ?? []
        ).sort();
        expect(placeholders, key).toEqual(englishPlaceholders);
      }
    }
  });

  it("normalizes system locale variants and falls back to English", () => {
    expect(normalizeLocale("zh_Hans_CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-HK")).toBe("zh-Hant");
    expect(normalizeLocale("ja")).toBe("ja-JP");
    expect(normalizeLocale("en-GB")).toBe("en-US");
    expect(normalizeLocale("fr-FR")).toBe("en-US");
    expect(normalizeLocale()).toBe("en-US");
  });

  it.each([
    ["en-US", "120K"],
    ["zh-CN", "12万"],
    ["zh-Hant", "12萬"],
    ["ja-JP", "12万"],
  ] as const)("formats compact numbers for %s", async (locale, expected) => {
    await initializeI18n(locale);
    expect(formatCompactNumber(120_000)).toBe(expected);
  });

  it("changes language immediately", async () => {
    await initializeI18n("en-US");
    expect(tr("nav.home")).toBe("Home");
    await changeLocale("ja-JP");
    expect(tr("nav.home")).toBe("ホーム");
    expect(document.documentElement.lang).toBe("ja-JP");
  });

  it("caches the last explicit locale for non-blocking startup", () => {
    cacheEffectiveLocale("ja-JP", "ja-JP");

    expect(cachedEffectiveLocale("en-US")).toBe("ja-JP");
  });

  it("reads Traditional Chinese cached as zh-TW, before it became zh-Hant", () => {
    window.localStorage.setItem("agentkib.effective-locale", "zh-TW");
    window.localStorage.setItem("agentkib.cached-locale-preference", "zh-TW");

    expect(cachedEffectiveLocale("en-US")).toBe("zh-Hant");
    expect(normalizeLocale("zh-TW")).toBe("zh-Hant");
  });

  it("uses the current system locale when the cached preference follows the system", () => {
    cacheEffectiveLocale("ja-JP", "system");

    expect(cachedEffectiveLocale("zh-CN")).toBe("zh-CN");
  });
});
