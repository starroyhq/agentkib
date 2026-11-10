import { describe, expect, it } from "vitest";
import type {
  AgentToolStatus,
  ContextDoctorSummary,
  MemoryRecord,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
  WorkspaceSummary,
} from "@/core/types";
import { homeMaintenance, homeQuotaRows, homeRemote } from "./home-side";

const quotaWindow = (label: string, used: number | null, kind = "session"): QuotaWindow => ({
  kind,
  label,
  used_percent: used,
  remaining_percent: used === null ? null : 100 - used,
});
const provider = (
  id: string,
  name: string,
  windows: QuotaWindow[],
  extra: Partial<QuotaProvider> = {},
): QuotaProvider => ({ id, name, enabled: true, windows, accounts: [], ...extra });
const snapshot = (providers: QuotaProvider[]) => ({ providers }) as QuotaSnapshot;
const shown = { hidden_providers: [], hidden_windows: [] };

describe("homeQuotaRows", () => {
  it("shows each provider's first visible window, the one closest to its limit first", () => {
    const rows = homeQuotaRows(
      snapshot([
        provider("claude", "Claude Code", [quotaWindow("This week", 40, "weekly")]),
        provider("codex", "Codex", [quotaWindow("5 hours", 62), quotaWindow("This week", 20)]),
      ]),
      shown,
    );

    expect(rows.map((row) => [row.name, row.window.label, row.usedPercent])).toEqual([
      ["Codex", "5 hours", 62],
      ["Claude Code", "This week", 40],
    ]);
  });

  it("skips hidden windows, unknown usage and disabled providers", () => {
    const rows = homeQuotaRows(
      snapshot([
        provider("codex", "Codex", [quotaWindow("5 hours", 62), quotaWindow("This week", 20)]),
        provider("claude", "Claude Code", [
          { ...quotaWindow("This week", 40), usage_known: false },
        ]),
        provider("gemini", "Gemini", [quotaWindow("Today", 10)], { enabled: false }),
      ]),
      {
        hidden_providers: [],
        hidden_windows: [{ provider_id: "codex", kind: "session", label: "5 hours" }],
      },
    );

    expect(rows.map((row) => [row.name, row.window.label])).toEqual([["Codex", "This week"]]);
  });

  it("marks a window close to its limit and shows nothing without a snapshot", () => {
    expect(
      homeQuotaRows(snapshot([provider("codex", "Codex", [quotaWindow("5 hours", 92)])]), shown),
    ).toMatchObject([{ usedPercent: 92, severity: "danger" }]);
    expect(homeQuotaRows(null, shown)).toEqual([]);
  });
});

describe("homeRemote", () => {
  it("says nothing while remote access is off", () => {
    expect(homeRemote({ running: false, devices: [] })).toBeUndefined();
    expect(homeRemote(undefined)).toBeUndefined();
  });

  it("counts devices and this month's relay share", () => {
    const devices = [{ id: "phone" }, { id: "tablet" }] as never;
    expect(
      homeRemote({ running: true, devices }, { usedBytes: 82, limitBytes: 100, exhausted: false }),
    ).toEqual({ devices: 2, relayPercent: 82, relayExhausted: false });
    expect(
      homeRemote({ running: true, devices }, { usedBytes: 100, limitBytes: 100, exhausted: true }),
    ).toMatchObject({ relayPercent: 100, relayExhausted: true });
    expect(homeRemote({ running: true, devices })).toEqual({
      devices: 2,
      relayPercent: undefined,
      relayExhausted: false,
    });
  });
});

describe("homeMaintenance", () => {
  const workspaces = ["broken", "clean", "unchecked"].map(
    (id) => ({ id, name: id }) as WorkspaceSummary,
  );
  const summary = (id: string, warnings: number): ContextDoctorSummary => ({
    workspace_id: id,
    error_count: 0,
    warning_count: warnings,
    info_count: 3,
    repairable_count: 0,
    checked_at: "2026-11-09T00:00:00.000Z",
  });
  const memories = [
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
    { id: "c", status: "approved" },
  ] as MemoryRecord[];
  const tool = (agent: string, installed: boolean, state: string) =>
    ({ agent, installed, state }) as AgentToolStatus;

  it("lists configuration problems, pending memories, tool updates and unchecked workspaces", () => {
    expect(
      homeMaintenance({
        workspaces,
        doctorSummaries: { broken: summary("broken", 2), clean: summary("clean", 0) },
        memories,
        tools: {
          tools: [
            tool("codex", true, "update-available"),
            tool("claude-code", false, "update-available"),
            tool("cursor", true, "current"),
          ],
        },
      }),
    ).toEqual([
      { kind: "config", count: 1 },
      { kind: "memories", count: 2 },
      { kind: "tools", agents: ["codex"] },
      { kind: "undiagnosed", count: 1 },
    ]);
  });

  it("counts nothing from results that have not been read yet", () => {
    expect(homeMaintenance({ workspaces })).toEqual([]);
  });
});
