import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { describe, expect, it } from "vitest";
import { buildTaskSummaryCoverage } from "./task-summary-coverage";

const workspaces = new Set(["visible"]);
const codex = { workspaceId: "visible", agent: "codex", complete: true };
const antigravity = { workspaceId: "visible", agent: "antigravity", complete: true };
const session: ConversationSessionSummary = {
  id: "test-session",
  workspace_id: "visible",
  agent: "codex",
  availability: "readable",
  archived: false,
  sidechain: false,
  continuation: { status: "idle" },
  readState: {
    freshness: "current",
    status: "read",
    source: "codex-native",
    version: "read-state-version",
    latestResult: null,
    firstUnread: null,
  },
};
function catalog(sources: unknown[], managedComplete = true, indexEnabled = true) {
  return { taskSummarySourceCoverage: { indexEnabled, managedComplete, sources } };
}

describe("task summary source coverage", () => {
  it("includes successfully covered empty sources and current session observations", () => {
    expect(
      buildTaskSummaryCoverage(catalog([codex, antigravity]), workspaces, [session], true),
    ).toEqual({ complete: true, sources: [antigravity, codex] });
  });

  it("propagates specific partial-read and unavailable codes without arbitrary source details", () => {
    expect(
      buildTaskSummaryCoverage(
        catalog([
          {
            ...antigravity,
            complete: false,
            reasons: ["antigravity-acp-list", "private-diagnostic", "antigravity-acp-list"],
          },
          { ...codex, complete: false, reasons: ["source-unavailable"] },
          {
            workspaceId: "visible",
            agent: "devin",
            complete: false,
            reasons: [REMOTE_ERROR_CODES.devinSourceBusy],
          },
        ]),
        workspaces,
        [],
        true,
      ),
    ).toEqual({
      complete: false,
      sources: [
        { ...antigravity, complete: false, reasons: ["antigravity-acp-list"] },
        { ...codex, complete: false, reasons: ["source-unavailable"] },
        {
          workspaceId: "visible",
          agent: "devin",
          complete: false,
          reasons: [REMOTE_ERROR_CODES.devinSourceBusy],
        },
      ],
    });
  });

  it.each([
    {
      readState: { ...session.readState!, freshness: "stale" as const },
      reason: "read-state-stale",
    },
    {
      readState: { ...session.readState!, status: "unknown" as const },
      reason: "coverage-unknown",
    },
    { readState: undefined, reason: "coverage-unknown" },
  ])("reports incomplete observations for $reason", ({ readState, reason }) => {
    expect(
      buildTaskSummaryCoverage(catalog([codex]), workspaces, [{ ...session, readState }], true),
    ).toEqual({ complete: false, sources: [{ ...codex, complete: false, reasons: [reason] }] });
  });

  it("does not use a current result to claim complete live coverage when its runtime is offline", () => {
    const source = { ...codex, agent: "deepseek-harness" };
    const offline: ConversationSessionSummary = {
      ...session,
      agent: "deepseek-harness",
      continuation: { status: "unsupported", reason: "dsh-native-status-unknown" },
    };
    expect(buildTaskSummaryCoverage(catalog([source]), workspaces, [offline], true)).toEqual({
      complete: false,
      sources: [{ ...source, complete: false, reasons: ["coverage-unknown"] }],
    });
  });

  it.each([undefined, { status: "running", executionLocation: "external" as const }])(
    "marks current results without a local activity observation as incomplete",
    (continuation) => {
      expect(
        buildTaskSummaryCoverage(
          catalog([codex]),
          workspaces,
          [{ ...session, continuation }],
          true,
        ),
      ).toEqual({
        complete: false,
        sources: [{ ...codex, complete: false, reasons: ["coverage-unknown"] }],
      });
    },
  );

  it("keeps restricted coverage independent of other workspace sessions and registry failures", () => {
    const expected = buildTaskSummaryCoverage(catalog([codex]), workspaces, [session], false);
    expect(
      buildTaskSummaryCoverage(
        catalog([codex, { workspaceId: "hidden", agent: "devin", complete: false }], false),
        workspaces,
        [session, { ...session, workspace_id: "hidden", readState: undefined }],
        false,
      ),
    ).toEqual(expected);
    expect(expected).toEqual({
      complete: false,
      sources: [codex],
      reasons: ["coverage-unknown"],
    });
    expect(buildTaskSummaryCoverage(catalog([codex], false), workspaces, [], true)).toEqual({
      complete: false,
      sources: [codex],
      reasons: ["source-partial"],
    });
  });

  it("does not treat catalog metadata unavailable on older hosts as complete", () => {
    expect(
      buildTaskSummaryCoverage(
        { complete: true, incompleteSources: [{ workspaceId: "hidden", agent: "devin" }] },
        workspaces,
        [session],
        true,
      ),
    ).toEqual({
      complete: false,
      sources: [{ ...codex, complete: false, reasons: ["coverage-unknown"] }],
      reasons: ["coverage-unknown"],
    });
  });

  it("does not treat missing source inventory or disabled indexing as a complete read", () => {
    expect(buildTaskSummaryCoverage(catalog([]), workspaces, [], true)).toEqual({
      complete: false,
      sources: [],
      reasons: ["coverage-unknown"],
    });
    expect(buildTaskSummaryCoverage(catalog([], true, false), workspaces, [session], true)).toEqual(
      {
        complete: false,
        sources: [{ ...codex, complete: false, reasons: ["index-disabled"] }],
        reasons: ["coverage-unknown", "index-disabled"],
      },
    );
  });

  it("returns a complete empty summary when no workspace is authorized", () => {
    expect(buildTaskSummaryCoverage(catalog([codex], false), new Set(), [session], false)).toEqual({
      complete: true,
      sources: [],
    });
  });
});
