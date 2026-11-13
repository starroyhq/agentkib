// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type Access,
  type ConversationCatalog,
  type HistoryLocatedRecord,
  type HistorySearchHit,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import { HistorySearchPanel, historyAccessScope } from "./history-search";
import { historyCopy } from "./history-copy";

const timestamp = "2026-10-16T16:30:00+08:00";
const indexedAt = "2026-10-16T17:45:00+08:00";
const locales = ["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const;
const coverage = {
  total: 1,
  ready: 1,
  building: 0,
  partial: 0,
  stale: 0,
  unavailable: 0,
  limitations: [],
};
const status: HistorySearchStatus = {
  enabled: true,
  generation: "index",
  bytes: 0,
  limitBytes: 10000,
  budgetExceeded: false,
  coverage,
  sources: [{ agent: "claude-code", body: "supported", tools: "supported", coverage }],
};
function fixture(overrides: Partial<HistorySearchHit> = {}) {
  const grant: Access = {
    protocolVersion: 2,
    status: "approved",
    csrfToken: "test",
    bootId: "boot",
    experimentalEnabled: true,
    historySearch: true,
    historySearchScope: "scope",
    device: { id: "device", name: "Test", send: true, approve: true },
  };
  const source: HistoryLocatedRecord = {
    location: {
      sessionId: "source",
      recordId: "record",
      chunkId: "chunk",
      sourceRevision: "revision",
    },
    workspaceId: "workspace",
    agent: "claude-code",
    title: "Source history",
    timestamp,
    kind: "assistant",
    toolName: null,
    content: "prefix needle suffix",
    contentHash: "hash",
    before: null,
    after: null,
  };
  const hit: HistorySearchHit = {
    ...source,
    snippet: source.content,
    matchRanges: [[7, 13]],
    stale: false,
    indexedAt,
    ...overrides,
  };
  const catalog: ConversationCatalog = {
    indexEnabled: true,
    workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
    sessions: [
      {
        id: "source",
        workspace_id: "workspace",
        agent: "claude-code",
        availability: "readable",
        origin: "interactive",
        archived: false,
        sidechain: false,
      },
    ],
  };
  const client = new WebClient(vi.fn());
  vi.spyOn(client, "access").mockResolvedValue(grant);
  vi.spyOn(client, "catalog").mockResolvedValue(catalog);
  vi.spyOn(client, "historyStatus").mockResolvedValue(status);
  vi.spyOn(client, "historySearch").mockResolvedValue({
    hits: [hit],
    status,
    nextCursor: null,
    limited: false,
  });
  vi.spyOn(client, "historyLocate").mockResolvedValue(source);
  vi.spyOn(client, "historyReferences").mockImplementation(async (references) => ({
    references: references.map((reference) => ({ ...source, reference })),
    text: source.content,
  }));
  const props = {
    client,
    scope: historyAccessScope(grant),
    initialQuery: "needle",
    onOpenSession: vi.fn(),
    onReference: vi.fn(),
  };
  return { client, catalog, source, hit, props };
}
function localizedTime(value: string, locale: (typeof locales)[number]) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
async function resultButton() {
  return await screen.findByRole("button", { name: /Source history/ });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("localized history result metadata", () => {
  it.each(locales)(
    "formats message and index times in %s while retaining exact machine timestamps",
    async (locale) => {
      const f = fixture();
      render(<HistorySearchPanel {...f.props} locale={locale} />);
      const button = await resultButton();
      const times = [...button.querySelectorAll("time")];
      expect(times).toHaveLength(2);
      expect(times[0]).toHaveAttribute("datetime", timestamp);
      expect(times[0]).toHaveTextContent(localizedTime(timestamp, locale));
      expect(times[1]).toHaveAttribute("datetime", indexedAt);
      expect(times[1]).toHaveTextContent(localizedTime(indexedAt, locale));
      expect(button).not.toHaveTextContent(timestamp);
      expect(button).not.toHaveTextContent(indexedAt);
      expect(button).toHaveTextContent("Claude Code");
      expect(button).not.toHaveTextContent("claude-code");
      expect(screen.getByRole("list", { name: historyCopy[locale].sources })).toHaveTextContent(
        "Claude Code",
      );
    },
  );

  it("uses existing display names and safe fallback names for multiple agents without changing their identity", async () => {
    const f = fixture();
    const entries = [
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["deepseek-harness", "DeepSeek Harness"],
      ["custom-agent", "custom-agent"],
      ["", "Agent"],
    ];
    vi.mocked(f.client.historySearch).mockResolvedValue({
      hits: entries.map(([agent], index) => ({
        ...f.hit,
        agent,
        title: null,
        location: { ...f.hit.location, recordId: `record-${index}` },
        snippet: `needle ${index}`,
      })),
      status,
      nextCursor: null,
      limited: false,
    });
    render(<HistorySearchPanel {...f.props} locale="en-US" />);
    await screen.findByRole("button", { name: /DeepSeek Harness/ });
    for (const [, name] of entries)
      expect(screen.getByText(name, { selector: "strong" })).toBeVisible();
    expect(vi.mocked(f.client.historySearch).mock.results).toHaveLength(1);
  });

  it.each([null, "", "not-a-date", "   "])(
    "renders an explicit fallback for missing or invalid time %j",
    async (value) => {
      const f = fixture({ timestamp: value, indexedAt: "invalid-index-time" });
      render(<HistorySearchPanel {...f.props} locale="zh-CN" />);
      const button = await resultButton();
      expect(within(button).getAllByText(historyCopy["zh-CN"].unknownTime)).toHaveLength(2);
      expect(button.querySelector("time")).toBeNull();
      expect(button).not.toHaveTextContent("Invalid Date");
      expect(button).not.toHaveTextContent("invalid-index-time");
    },
  );

  it("updates retained results after a locale change without modifying the original timestamp", async () => {
    const f = fixture();
    const view = render(<HistorySearchPanel {...f.props} locale="en-US" />);
    expect((await resultButton()).querySelector("time")).toHaveTextContent(
      localizedTime(timestamp, "en-US"),
    );
    view.rerender(<HistorySearchPanel {...f.props} locale="ja-JP" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Source history/ }).querySelector("time"),
      ).toHaveTextContent(localizedTime(timestamp, "ja-JP")),
    );
    expect(
      screen.getByRole("button", { name: /Source history/ }).querySelector("time"),
    ).toHaveAttribute("datetime", timestamp);
    expect(f.hit.timestamp).toBe(timestamp);
  });

  it("preserves highlighted result opening, exact excerpt references and source-session navigation", async () => {
    const f = fixture();
    render(<HistorySearchPanel {...f.props} locale="zh-Hant" />);
    const button = await resultButton();
    expect(button.querySelector("mark")).toHaveTextContent("needle");
    fireEvent.click(button);
    const source = await screen.findByRole("region", { name: historyCopy["zh-Hant"].source });
    expect(f.client.historyLocate).toHaveBeenCalledExactlyOnceWith(
      f.source.location,
      expect.any(AbortSignal),
    );
    const excerpt = within(source).getByRole("textbox", { name: historyCopy["zh-Hant"].excerpt });
    fireEvent.select(excerpt, { target: { selectionStart: 7, selectionEnd: 13 } });
    fireEvent.click(within(source).getByRole("button", { name: historyCopy["zh-Hant"].quote }));
    await screen.findByText(historyCopy["zh-Hant"].added);
    expect(f.client.historyReferences).toHaveBeenCalledExactlyOnceWith(
      [{ ...f.source.location, contentHash: "hash", start: 7, end: 13 }],
      expect.any(AbortSignal),
    );
    expect(f.props.onReference).toHaveBeenCalledOnce();
    fireEvent.click(
      within(source).getByRole("button", { name: historyCopy["zh-Hant"].openSession }),
    );
    await waitFor(() =>
      expect(f.props.onOpenSession).toHaveBeenCalledExactlyOnceWith(f.catalog.sessions[0]),
    );
    expect(f.catalog.sessions[0].agent).toBe("claude-code");
  });

  it("displays the Agent name while submitting the original Agent filter ID", async () => {
    const f = fixture();
    render(<HistorySearchPanel {...f.props} locale="en-US" />);
    await resultButton();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: historyCopy["en-US"].allAgents }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    expect(
      screen.getByRole("combobox", { name: historyCopy["en-US"].allAgents }),
    ).toHaveTextContent("Claude Code");
    await waitFor(() =>
      expect(f.client.historySearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ agents: ["claude-code"] }),
        expect.any(AbortSignal),
      ),
    );
  });
});
