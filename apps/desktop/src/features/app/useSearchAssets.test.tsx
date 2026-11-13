// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { CatalogAsset } from "@/core/types";
import { SEARCH_ASSET_LIMIT, useSearchAssets } from "./useSearchAssets";

vi.mock("@/core/api", () => ({ api: { catalogAssets: vi.fn() } }));

function asset(id: string, overrides: Partial<CatalogAsset> = {}): CatalogAsset {
  return {
    id,
    scope: "workspace",
    workspace_id: "workspace-one",
    agent: "codex",
    kind: "skill",
    name: "skill-" + id,
    path: "/workspace/skills/skill-" + id,
    summary: "Summary " + id,
    size: 120,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useSearchAssets", () => {
  it("translates a stored error without restarting the catalog query", async () => {
    await initializeI18n("en-US");
    vi.mocked(api.catalogAssets).mockRejectedValue({ key: "errors.generic" });
    const { result } = renderHook(() => useSearchAssets("skill", true));
    await tick();
    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(result.current.error).toBe(tr("errors.generic"));
      }
      expect(api.catalogAssets).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(api.catalogAssets).mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not query empty or whitespace input or a closed dialog", async () => {
    const { result, rerender } = renderHook(({ query, open }) => useSearchAssets(query, open), {
      initialProps: { query: "", open: true },
    });
    await tick(1000);
    rerender({ query: "  ", open: true });
    await tick(1000);
    rerender({ query: "skill", open: false });
    await tick(1000);
    expect(api.catalogAssets).not.toHaveBeenCalled();
    expect(result.current.assets).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("debounces changes and sends the trimmed latest query using the backend limit", async () => {
    vi.mocked(api.catalogAssets).mockResolvedValue([asset("latest")]);
    const { result, rerender } = renderHook(({ query }) => useSearchAssets(query, true), {
      initialProps: { query: "review" },
    });
    await tick(200);
    rerender({ query: "  reviewer  " });
    await tick(249);
    expect(api.catalogAssets).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    await tick(1);
    expect(api.catalogAssets).toHaveBeenCalledExactlyOnceWith(
      "reviewer",
      undefined,
      undefined,
      500,
    );
    expect(result.current.assets[0].name).toBe("skill-latest");
    expect(result.current.loading).toBe(false);
  });

  it("does not allow an older query to overwrite the current results", async () => {
    const old = deferred<CatalogAsset[]>();
    const latest = deferred<CatalogAsset[]>();
    vi.mocked(api.catalogAssets)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(({ query }) => useSearchAssets(query, true), {
      initialProps: { query: "old" },
    });
    await tick();
    rerender({ query: "latest" });
    expect(result.current.assets).toEqual([]);
    await tick();
    await act(async () => latest.resolve([asset("latest")]));
    await act(async () => old.resolve([asset("old")]));
    expect(result.current.assets.map(({ name }) => name)).toEqual(["skill-latest"]);
    expect(result.current.error).toBe("");
  });

  it("ignores an obsolete error and cancels a pending debounce when closed", async () => {
    const old = deferred<CatalogAsset[]>();
    vi.mocked(api.catalogAssets).mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ query, open }) => useSearchAssets(query, open), {
      initialProps: { query: "old", open: true },
    });
    await tick();
    rerender({ query: "new", open: true });
    rerender({ query: "new", open: false });
    await act(async () => old.reject(new Error("obsolete request failed")));
    await tick();
    expect(api.catalogAssets).toHaveBeenCalledTimes(1);
    expect(result.current.assets).toEqual([]);
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(false);
  });

  it("ignores in-flight results after closing and does a new read when reopened", async () => {
    const old = deferred<CatalogAsset[]>();
    vi.mocked(api.catalogAssets)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([asset("fresh")]);
    const { result, rerender } = renderHook(({ open }) => useSearchAssets("skill", open), {
      initialProps: { open: true },
    });
    await tick();
    rerender({ open: false });
    await act(async () => old.resolve([asset("old")]));
    expect(result.current.assets).toEqual([]);
    rerender({ open: true });
    await tick();
    expect(result.current.assets.map(({ name }) => name)).toEqual(["skill-fresh"]);
    expect(api.catalogAssets).toHaveBeenCalledTimes(2);
  });

  it("groups a logical Skill package while retaining every Agent and distinct workspaces", async () => {
    const records = [
      asset("codex", { name: "reviewer", path: "/shared/skills/reviewer" }),
      asset("claude", { name: "reviewer", path: "/shared/skills/reviewer", agent: "claude-code" }),
      asset("other-workspace", {
        name: "reviewer",
        path: "/shared/skills/reviewer",
        workspace_id: "workspace-two",
      }),
    ];
    vi.mocked(api.catalogAssets).mockResolvedValue(records);
    const { result } = renderHook(() => useSearchAssets("reviewer", true));
    await tick();
    expect(result.current.assets).toHaveLength(2);
    expect(result.current.assets[0].name).toBe("reviewer");
    expect(result.current.assets[0].path).toBe("/shared/skills/reviewer");
    expect(result.current.assets[0].agents).toEqual(["codex", "claude-code"]);
    expect(result.current.assets[0].records).toHaveLength(2);
  });

  it("flags the 500 raw record cap even when logical grouping reduces the result count", async () => {
    // The backend clamps requests to 500 and cannot return a sentinel record.
    // Hitting the cap therefore means the results are possibly incomplete.
    vi.mocked(api.catalogAssets).mockResolvedValue(
      Array.from({ length: SEARCH_ASSET_LIMIT }, (_, i) =>
        asset(String(i), { path: "/shared/skills/reviewer", name: "reviewer" }),
      ),
    );
    const { result } = renderHook(() => useSearchAssets("reviewer", true));
    await tick();
    expect(result.current.limited).toBe(true);
    expect(result.current.assets).toHaveLength(1);
  });

  it("does not mark below-limit results as truncated", async () => {
    vi.mocked(api.catalogAssets).mockResolvedValue(
      Array.from({ length: SEARCH_ASSET_LIMIT - 1 }, (_, i) => asset(String(i))),
    );
    const { result } = renderHook(() => useSearchAssets("skill", true));
    await tick();
    expect(result.current.assets).toHaveLength(499);
    expect(result.current.limited).toBe(false);
  });

  it("surfaces a read error independently and retries the current query", async () => {
    vi.mocked(api.catalogAssets)
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce([asset("recovered")]);
    const { result } = renderHook(() => useSearchAssets("reviewer", true));
    await tick();
    expect(result.current.error).toContain("catalog unavailable");
    expect(result.current.loading).toBe(false);
    act(() => result.current.retry());
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(true);
    await tick();
    expect(result.current.error).toBe("");
    expect(result.current.assets[0].name).toBe("skill-recovered");
    expect(api.catalogAssets).toHaveBeenCalledTimes(2);
  });
});
