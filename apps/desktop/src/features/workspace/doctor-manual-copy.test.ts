// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { initializeI18n, localeResources, tr } from "@/core/i18n";
import { doctorManualAction } from "./doctor-manual-actions";

const codes = [
  "manifest.invalid",
  "native.invalid",
  "skill.source-unavailable",
  "skill.target-missing",
  "managed.missing",
  "managed.drift",
  "instruction.missing",
  "instruction.expected-content-missing",
  "instruction.exact-duplicate",
  "instruction.unmanaged-duplicate",
  "context.warning",
  "context.unavailable",
  "mcp.config-unavailable",
  "mcp.target-missing",
  "agent.read-only",
  "unrecognized.issue",
];
const guidance = [...new Set(codes.map((code) => doctorManualAction(code).guidanceKey))];
const evidenceKeys = [
  "manifest",
  "native",
  "skillSource",
  "managed",
  "instruction",
  "context",
  "mcpConfig",
  "other",
];
const parameters = (text: string) =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((item) => item[1]).sort();

describe.each([
  ["zh-CN", "详情"],
  ["zh-TW", "詳細資料"],
  ["en-US", "Details"],
  ["ja-JP", "詳細"],
] as const)("diagnostic manual guidance in %s", (locale, details) => {
  it("resolves every manual action through its actual locale without sentence-ending periods", async () => {
    await initializeI18n(locale);
    const resources = localeResources[locale] as Record<string, string>;
    expect(
      Object.keys(resources)
        .filter((key) => key.startsWith("doctor.manual."))
        .sort(),
    ).toEqual([...guidance].sort());
    for (const key of guidance) {
      const copy = tr(key);
      expect(copy).toBe(resources[key]);
      expect(copy).not.toBe(key);
      expect(copy).not.toMatch(/[.。．]\s*$/u);
      expect(copy).not.toMatch(/上方|上記|\babove\b/iu);
      expect(parameters(resources[key]!)).toEqual(
        parameters((localeResources["en-US"] as Record<string, string>)[key]!),
      );
    }
    expect(tr("doctor.manual.manifest")).toContain(".agentkib/manifest.yaml");
    expect(tr("doctor.manual.skillSource")).toContain("SKILL.md");
    expect(tr("doctor.manual.skillTarget")).toContain("targets");
    expect(tr("doctor.manual.mcpTarget")).toContain("targets");
    expect(tr("doctor.manual.mcpTarget")).toContain("MCP");
  });

  it("names the actual instruction page in the action and guidance", async () => {
    await initializeI18n(locale);
    const page = tr("nav.context").toLocaleLowerCase();
    expect(tr("doctor.openContext").toLocaleLowerCase()).toContain(page);
    for (const key of ["instruction", "duplicate", "context"])
      expect(tr(`doctor.manual.${key}`).toLocaleLowerCase()).toContain(page);
  });

  it("points to collapsed details rather than evidence supposedly above the guidance", async () => {
    await initializeI18n(locale);
    for (const key of evidenceKeys) expect(tr(`doctor.manual.${key}`)).toContain(details);
  });
});
