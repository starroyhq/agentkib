// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type Access,
  type ConversationCatalog,
  type HistoryLocatedRecord,
  type HistorySearchHit,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import { HistorySearchPanel, historyAccessScope, historyCopy } from "@agentkib/session-ui";
import { render } from "@/features/conversation/web-reader-test-utils";

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

describe("history search Web presentation", () => {
  it.each(locales)(
    "formats message and index times in %s while retaining exact machine timestamps",
    async (locale) => {
      const f = fixture();
      render(<HistorySearchPanel {...f.props} locale={locale} />);
      const button = await resultButton();
      const times = [...button.querySelectorAll("time")];
      expect(times).toHaveLength(2);
      expect(times[0]).toHaveAttribute("datetime", timestamp);
      expect(times[0].textContent).toBe(localizedTime(timestamp, locale));
      expect(times[1]).toHaveAttribute("datetime", indexedAt);
      expect(times[1].textContent).toBe(localizedTime(indexedAt, locale));
      expect(button).not.toHaveTextContent(timestamp);
      expect(button).not.toHaveTextContent(indexedAt);
      expect(button).toHaveTextContent("Claude Code");
      expect(button).not.toHaveTextContent("claude-code");
      expect(
        screen.queryByRole("list", { name: historyCopy[locale].sources }),
      ).not.toBeInTheDocument();
    },
  );

  it("displays the Agent name while submitting the original Agent filter ID", async () => {
    const f = fixture();
    render(<HistorySearchPanel {...f.props} locale="en-US" />);
    await resultButton();
    const filter = screen.getByRole("combobox", { name: historyCopy["en-US"].allAgents });
    expect(within(filter).getByRole("option", { name: "Claude Code" })).toHaveValue("claude-code");
    fireEvent.change(filter, { target: { value: "claude-code" } });
    await waitFor(() =>
      expect(f.client.historySearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ agents: ["claude-code"] }),
        expect.any(AbortSignal),
      ),
    );
  });
});
