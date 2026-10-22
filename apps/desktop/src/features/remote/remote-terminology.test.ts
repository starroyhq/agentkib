// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { conversationWords, initializeI18n, localeResources, tr } from "@/core/i18n";
import { dictionaries as webWords } from "../../../../web/src/features/conversation/i18n";
import { remoteAccountCopy } from "./remote-account-copy";
import { remoteEntryCopy } from "./remote-entry-copy";
import { remoteNetworkCopy } from "./remote-network-copy";
import { remotePhoneCopy } from "./remote-phone-copy";
import { remoteSettingsCopy } from "./remote-settings-copy";
import { webSettingsCopy } from "./web-settings-copy";

const copyGroups = [
  remoteEntryCopy,
  remoteAccountCopy,
  remoteNetworkCopy,
  remotePhoneCopy,
  remoteSettingsCopy,
  webSettingsCopy,
];

const connectionKeys = [
  "lanPermission",
  "lanFailure",
  "lanIncompatible",
  "connect",
  "pairTitle",
  "pairInfo",
  "scope",
  "pending",
  "verify",
  "selectInfo",
  "unavailable",
  "error",
] as const;

const wording = [
  {
    locale: "zh-CN",
    hint: "在对方电脑的 AgentKib 的远程连接设置中获取配对码。",
    code: "配对码",
    nearby: "附近的电脑",
    control: "远程控制操作",
    access: "远程访问",
  },
  {
    locale: "zh-TW",
    hint: "在對方電腦的 AgentKib 的遠端連線設定中取得配對碼。",
    code: "配對碼",
    nearby: "附近的電腦",
    control: "遠端控制操作",
    access: "遠端存取",
  },
  {
    locale: "en-US",
    hint: "Get the pairing code from Remote connections settings in AgentKib on the other computer.",
    code: "Pairing code",
    nearby: "nearby computers",
    control: "remote control operations",
    access: "remote access",
  },
  {
    locale: "ja-JP",
    hint: "接続先のコンピューターの AgentKib のリモート接続設定でペアリングコードを取得してください。",
    code: "ペアリングコード",
    nearby: "近くのコンピューター",
    control: "リモート操作",
    access: "リモートアクセス",
  },
] as const;

function flattenCopy(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof entry === "string" ? [[path, entry]] : Object.entries(flattenCopy(entry, path));
    }),
  );
}

function placeholders(value: string) {
  return (value.match(/\{\{?[^{}]+\}?\}/g) ?? []).sort();
}

describe("remote connection terminology", () => {
  it.each(wording)("uses the current translated pairing guidance in $locale", async (copy) => {
    await initializeI18n(copy.locale);
    expect(tr("remote.quick.codeHint")).toBe(copy.hint);
    expect(tr("remote.code")).toBe(copy.code);
    const entry = remoteEntryCopy[copy.locale];
    expect(entry.nativeDescription).toContain(copy.nearby);
    expect(entry.legacyPermissionsHint).toContain(copy.control);
    expect(entry.reasons["lease-expired"]).toContain(copy.access);
    expect(entry.pause.toLowerCase()).toContain(copy.access);
    expect(tr("remote.listening", { address: "192.0.2.10:42987" })).toContain("192.0.2.10:42987");
    expect(tr("remote.listening", { address: "192.0.2.10:42987" })).not.toContain("{{");
  });

  it.each(wording)(
    "keeps desktop connection guidance aligned with Web in $locale",
    async ({ locale }) => {
      await initializeI18n(locale);
      const translated = conversationWords(locale);
      for (const key of connectionKeys) {
        expect(translated[key], key).toBe(webWords[locale][key]);
        expect(tr(`conversation.${key}`), key).toBe(webWords[locale][key]);
      }
    },
  );

  it.each(wording)(
    "keeps remote copy keys and interpolation parameters aligned in $locale",
    ({ locale }) => {
      for (const copies of copyGroups) {
        const reference = flattenCopy(copies["en-US"]);
        const localized = flattenCopy(copies[locale]);
        expect(Object.keys(localized).sort()).toEqual(Object.keys(reference).sort());
        for (const [key, value] of Object.entries(localized)) {
          expect(value.trim(), key).not.toBe("");
          expect(placeholders(value), key).toEqual(placeholders(reference[key]));
        }
      }
      const english = localeResources["en-US"];
      const englishKeys = Object.keys(english)
        .filter((key) => key.startsWith("remote."))
        .sort();
      const resources = localeResources[locale];
      expect(
        Object.keys(resources)
          .filter((key) => key.startsWith("remote."))
          .sort(),
      ).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(resources[key as keyof typeof resources]), key).toEqual(
          placeholders(english[key as keyof typeof english]),
        );
      }
    },
  );

  it.each(["zh-CN", "zh-TW"] as const)(
    "removes retired terms only from connection copy in %s",
    (locale) => {
      const resources = localeResources[locale];
      const connectionCopy = Object.entries(resources).filter(
        ([key]) =>
          key.startsWith("remote.") ||
          connectionKeys.some((name) => key === `conversation.${name}`),
      );
      for (const [key, value] of [
        ...connectionCopy,
        ...copyGroups.flatMap((copies) => Object.entries(flattenCopy(copies[locale]))),
      ]) {
        expect(value, key).not.toMatch(/远控|遠控|公网访问|公網存取|公網訪問|八位|一次性|桌面/);
      }
      // Public reachability and protocol diagnostics keep their precise technical meaning.
      expect(remoteEntryCopy[locale].manualAccess).toContain("HTTPS");
      expect(remoteEntryCopy[locale].frpcHint).toContain("SHA-256");
      expect(resources["remote.codeHint"]).toContain("5");
      expect(resources["remote.readonly"]).toMatch(/不支持|不支援/);
    },
  );
});
