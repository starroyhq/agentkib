import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preferenceSnapshot, writePreference } from "../../../packages/backend/src/preferences";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("locale preference", () => {
  it("reads Traditional Chinese saved as zh-TW, before it became zh-Hant", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "agentkib-locale-"));
    roots.push(dataDir);
    writePreference(dataDir, "locale_preference", "zh-TW");
    expect(preferenceSnapshot(dataDir, {})).toMatchObject({
      locale_preference: "zh-Hant",
      effective_locale: "zh-Hant",
    });
    writePreference(dataDir, "locale_preference", "ja-JP");
    expect(preferenceSnapshot(dataDir, {})).toMatchObject({ effective_locale: "ja-JP" });
    writePreference(dataDir, "locale_preference", "system");
    expect(preferenceSnapshot(dataDir, { AGENTKIB_LOCALE: "zh-Hant" })).toMatchObject({
      locale_preference: "system",
      effective_locale: "zh-Hant",
    });
  });
});
