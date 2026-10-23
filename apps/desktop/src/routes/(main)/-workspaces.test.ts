// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { DiscoveryReport } from "@/core/types";
import { discoveryStatusSummary } from "./workspaces";

const report: DiscoveryReport = {
  started_at: "2026-10-23T08:00:00Z",
  finished_at: "2026-10-23T08:00:01Z",
  discovered_count: 4,
  removed_count: 0,
  errors: [],
};

describe("workspace discovery status", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("does not claim discovery is running when no report exists", () => {
    expect(discoveryStatusSummary(undefined, false, tr, () => "not used")).toMatchObject({
      label: tr("workspace.discoveryNotScanned"),
      tone: "neutral",
    });
  });

  it("distinguishes an active scan from an unscanned workspace", () => {
    expect(discoveryStatusSummary(undefined, true, tr, () => "not used")).toMatchObject({
      label: tr("workspace.discoveryScanning"),
      tone: "neutral",
    });
  });

  it.each(["missing", "not-configured", "unsupported"])(
    "keeps an unavailable Agent source (%s) neutral while reporting successful discovery",
    (status) => {
      const discovery: DiscoveryReport = {
        ...report,
        source_diagnostics: [
          {
            agent: "claude-code",
            source: "history-and-index",
            status: "succeeded",
            included_count: 4,
          },
          { agent: "open-claw", source: "config-and-sessions", status },
        ],
      };
      expect(discoveryStatusSummary(discovery, false, tr, () => "a moment ago")).toMatchObject({
        label: tr("workspace.discoveryFoundFrom", {
          count: 4,
          sources: tr("workspace.discoveryHistorySource", { agent: "Claude Code" }),
        }),
        tone: "neutral",
        reportedAt: "a moment ago",
      });
    },
  );

  it.each(["failed", "permission-denied", "partial"])(
    "uses warning color for an actual source error (%s)",
    (status) => {
      const discovery: DiscoveryReport = {
        ...report,
        source_diagnostics: [{ source: "history-and-index", status }],
      };
      expect(discoveryStatusSummary(discovery, false, tr, () => "a moment ago")).toMatchObject({
        label: tr("workspace.discoveryAttention", { count: 1 }),
        tone: "warning",
        reportedAt: tr("workspace.discoveryReportedAt", { time: "a moment ago" }),
      });
    },
  );

  it("reports discovery errors without source diagnostics", () => {
    expect(
      discoveryStatusSummary({ ...report, errors: ["Read error"] }, false, tr, () => "now"),
    ).toMatchObject({
      label: tr("workspace.discoveryAttention", { count: 1 }),
      tone: "warning",
    });
  });

  it("marks a previous report as refreshing instead of presenting stale success", () => {
    expect(discoveryStatusSummary(report, true, tr, () => "a moment ago")).toMatchObject({
      label: tr("workspace.discoveryScanning"),
      tone: "neutral",
      reportedAt: tr("workspace.discoveryReportedAt", { time: "a moment ago" }),
    });
  });
});
