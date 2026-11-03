import { describe, expect, it } from "vitest";
import { mergeCatalogSessions } from "@agentkib/web-client";

type Record = {
  id: string;
  agent: string;
  workspace_id: string;
  title: string;
  indexedSessionId?: string;
  indexedSessionIds?: string[];
};
const row = (id: string, workspace = "old", agent = "codex"): Record => ({
  id,
  agent,
  workspace_id: workspace,
  title: "Same display title",
});
const partial = [{ workspaceId: "old", agent: "codex" }];

describe("catalog source preservation with global and verified alias identities", () => {
  it.each([false, true])(
    "replaces a moved session rather than retaining its former workspace (%s)",
    (unknown) => {
      const previous = row("thread");
      const moved = row("thread", "new");
      const merged = mergeCatalogSessions([previous], [moved], partial, unknown);
      expect(merged).toEqual([moved]);
      expect(merged[0]).toBe(moved);
    },
  );

  it("deduplicates the same provider's global ID within a received snapshot", () => {
    const moved = row("thread", "new");
    expect(mergeCatalogSessions([], [moved, row("thread")], partial)).toEqual([moved]);
  });

  it.each(["indexedSessionId", "indexedSessionIds"] as const)(
    "uses a verified %s to replace a native row from a partial source",
    (field) => {
      const native = row("native");
      const managed = {
        ...row("managed", "new"),
        [field]: field === "indexedSessionId" ? "native" : ["native"],
      };
      expect(mergeCatalogSessions([native], [managed], partial)).toEqual([managed]);
      expect(mergeCatalogSessions([native], [native, managed], partial)).toEqual([managed]);
    },
  );

  it("replaces an obsolete managed owner when the new owner proves their common native alias", () => {
    const previous = { ...row("former-managed"), indexedSessionIds: ["native"] };
    const current = { ...row("current-managed", "new"), indexedSessionIds: ["native"] };
    expect(mergeCatalogSessions([previous], [current], partial)).toEqual([current]);
  });

  it.each([false, true])(
    "keeps a partial managed owner and suppresses its native alias (%s)",
    (unknown) => {
      const managed = { ...row("managed"), indexedSessionIds: ["native"] };
      const native = row("native", "new");
      const previous = [managed];
      expect(mergeCatalogSessions(previous, [native], partial, unknown)).toBe(previous);
      expect(mergeCatalogSessions(previous, [native])).toEqual([native]);
    },
  );

  it("does not suppress another verified canonical record by guessing from an older alias", () => {
    const previous = { ...row("managed"), indexedSessionIds: ["native"] };
    const observed = { ...row("native", "new"), indexedSessionIds: ["another-native"] };
    expect(mergeCatalogSessions([previous], [observed], partial)).toEqual([observed, previous]);
  });

  it("does not combine providers even when their IDs and aliases match", () => {
    const claude = row("native", "old", "claude-code");
    const managed = { ...row("managed", "new"), indexedSessionIds: ["native"] };
    const incomplete = [{ workspaceId: "old", agent: "claude-code" }];
    expect(mergeCatalogSessions([claude], [managed], incomplete)).toEqual([managed, claude]);
    expect(mergeCatalogSessions([claude], [row("native", "new")], incomplete)).toHaveLength(2);
  });

  it("keeps unrelated same-title rows and stable references for unchanged records", () => {
    const old = row("old");
    const current = row("new", "new");
    expect(mergeCatalogSessions([old], [current], partial)).toEqual([current, old]);
    const previous = [old, current];
    expect(mergeCatalogSessions(previous, [{ ...old }, { ...current }])).toBe(previous);
    const reordered = mergeCatalogSessions(previous, [{ ...current }, { ...old }]);
    expect(reordered[0]).toBe(current);
    expect(reordered[1]).toBe(old);
  });
});
