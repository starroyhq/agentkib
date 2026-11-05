import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { Commands } from "../../../packages/backend/src/commands";
import { QuotaOwner } from "../../../packages/backend/src/quota";
import { parseLocalCosts } from "../../../packages/backend/src/local-cost-parser";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const time = "2026-11-05T06:00:00.000Z";
const scope = { scope_key: "synthetic-scope", timezone: "UTC", now: new Date(time) };
// Schema from v0.83.0 CLICostCommand.makeCostPayload + CLICostPayloads CodingKeys:
// daily.totalCost / modelBreakdowns.cost; cacheReadTokens is already in totalTokens.
function swift(provider = "codex", extra: Record<string, unknown> = {}) {
  return {
    provider,
    source: "local",
    agentkibNativeOnly: true,
    updatedAt: time,
    currencyCode: "USD",
    historyDays: 30,
    reportingPeriod: "rolling:30",
    historyCoverageIsEstablished: true,
    sessionTokens: 120,
    sessionCostUSD: 0.12,
    last30DaysTokens: 220,
    last30DaysCostUSD: 0.22,
    coverage: { priced: 2, unpriced: 0, unmetered: 0, estimated: 0 },
    daily: [
      {
        date: "2026-11-04",
        totalTokens: 100,
        totalCost: 0.1,
        cacheReadTokens: 50,
        modelBreakdowns: [{ modelName: "gpt-5", cost: 0.1, totalTokens: 100 }],
      },
      {
        date: "2026-11-05",
        totalTokens: 120,
        totalCost: 0.12,
        cacheReadTokens: 60,
        modelBreakdowns: [{ modelName: "gpt-5", cost: 0.12, totalTokens: 120 }],
      },
    ],
    projects: [{ path: "/PRIVATE/SYNTHETIC", sources: [{ path: "/PRIVATE/SOURCE" }] }],
    ...extra,
  };
}
// v0.70.0 cli/cost.rs + spend_contract.rs: legacy cost.total_usd can be a placeholder;
// spendContract uses camelCase, and totals.totalTokens is provider-native accounting.
function windows(extra: Record<string, unknown> = {}) {
  return {
    provider: "codex",
    supported: true,
    agentkibNativeOnly: true,
    updatedAt: time,
    reportingPeriod: "rolling:30",
    cost: { total_usd: 0, currency: "USD" },
    totals: {
      inputTokens: 200,
      outputTokens: 20,
      cachedTokens: 100,
      totalTokens: 220,
      totalCost: 0.22,
    },
    modelPricingCompleteness: "complete",
    spendContract: {
      providerId: "codex",
      historyDays: 30,
      reportingPeriod: "rolling:30",
      knownCostUsd: 0.22,
      knownZero: false,
      historyCoverageEstablished: true,
      priceCoverage: { priced: 2, unpriced: 0, unmetered: 0, estimated: 0 },
      models: [
        {
          model: "gpt-5",
          costUsd: 0.22,
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 100,
          totalTokens: 220,
          customPricing: false,
        },
      ],
      daily: [
        { day: "2026-11-04", costUsd: 0.1, totalTokens: 100 },
        { day: "2026-11-05", costUsd: 0.12, totalTokens: 120 },
      ],
      imports: [],
      projects: [{ path: "/PRIVATE/WIN" }],
    },
    ...extra,
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("platform local-cost aggregates", () => {
  it.each([
    ["codex", 110],
    ["claude", 135],
  ] as const)("parses the real isolated v0.83.0 %s CLI output", (provider, tokens) => {
    const fixture = readFileSync(
      path.join(import.meta.dirname, "fixtures", "quota-cost", `darwin-${provider}-v083.json`),
    );
    const result = parseLocalCosts(fixture, "codex-bar-cli", provider, {
      ...scope,
      now: new Date("2026-11-05T08:00:00Z"),
    });
    expect(result.last_30_days.tokens).toBe(tokens);
    expect(result.today.tokens).toBe(tokens);
    expect(result.models[0].tokens).toBe(tokens);
    expect(result.last_30_days.partial).toBe(false);
    expect(JSON.stringify(result)).not.toContain("/synthetic/");
    expect(JSON.stringify(result)).not.toContain("999999");
  });
  it.each(["codex-bar-cli", "win-codex-bar"] as const)(
    "normalizes %s without passing private projects or double counting cache tokens",
    (backend) => {
      const result = parseLocalCosts(
        bytes([backend === "codex-bar-cli" ? swift() : windows()]),
        backend,
        "codex",
        scope,
      );
      expect(result).toMatchObject({
        provider: "codex",
        source: "native-local",
        currency: "USD",
        timezone: "UTC",
        range_start: "2026-10-07",
        range_end: "2026-11-05",
        today: { tokens: 120, cost_usd: 0.12 },
        last_30_days: { tokens: 220, cost_usd: 0.22, partial: false },
        models: [{ model: "gpt-5", tokens: 220, cost_usd: 0.22 }],
        history_complete: true,
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(result.daily).toHaveLength(2); // missing dates remain absent, not invented zeroes
    },
  );
  it("keeps explicit zero separate from absent pricing", () => {
    const zero = parseLocalCosts(
      bytes([
        swift("codex", {
          sessionTokens: 0,
          sessionCostUSD: 0,
          last30DaysTokens: 0,
          last30DaysCostUSD: 0,
          daily: [
            {
              date: "2026-11-05",
              totalTokens: 0,
              totalCost: 0,
              modelBreakdowns: [{ modelName: "free-model", cost: 0, totalTokens: 0 }],
            },
          ],
        }),
      ]),
      "codex-bar-cli",
      "codex",
      scope,
    );
    expect(zero.today).toMatchObject({ tokens: 0, cost_usd: 0, partial: false });
    const unknown = parseLocalCosts(
      bytes([
        swift("codex", {
          last30DaysCostUSD: null,
          sessionCostUSD: null,
          daily: [
            {
              date: "2026-11-05",
              totalTokens: 40,
              totalCost: null,
              modelBreakdowns: [{ modelName: "new-model", cost: null, totalTokens: 40 }],
            },
          ],
        }),
      ]),
      "codex-bar-cli",
      "codex",
      scope,
    );
    expect(unknown.today.cost_usd).toBeNull();
    expect(unknown.last_30_days.cost_usd).toBeNull();
    expect(unknown.unpriced_models).toEqual(["new-model"]);
  });
  it("preserves known subtotal, unknown models, incomplete history and structured partial errors", () => {
    const result = parseLocalCosts(
      bytes([
        swift("codex", {
          error: { message: "unavailable /PRIVATE" },
          historyCoverageIsEstablished: false,
          last30DaysCostUSD: null,
          daily: [
            {
              date: "2026-11-05",
              totalTokens: 40,
              totalCost: 0.08,
              modelBreakdowns: [
                { modelName: "gpt-5", cost: 0.08, totalTokens: 20 },
                { modelName: "future-model", cost: null, totalTokens: 20 },
              ],
            },
          ],
        }),
      ]),
      "codex-bar-cli",
      "codex",
      scope,
    );
    expect(result).toMatchObject({
      history_complete: false,
      last_30_days: { cost_usd: 0.08, partial: true },
      today: { partial: true },
      unpriced_models: ["future-model"],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("uses the requested provider and rejects mirrored Windows sources", () => {
    const result = parseLocalCosts(
      bytes([swift(), swift("opencodex", { last30DaysCostUSD: 900 })]),
      "codex-bar-cli",
      "codex",
      scope,
    );
    expect(result.last_30_days.cost_usd).toBe(0.22);
    const win = windows();
    (win.spendContract as { imports: unknown[] }).imports = [{ path: "/PRIVATE/IMPORTED" }];
    expect(() => parseLocalCosts(bytes([win]), "win-codex-bar", "codex", scope)).toThrow(
      "non-native",
    );
  });
  it("never treats legacy Windows 0/100 placeholders as known cost", () => {
    const win = windows({ totals: null });
    const contract = win.spendContract as Record<string, unknown>;
    contract.knownCostUsd = null;
    contract.daily = [];
    contract.models = [];
    contract.historyCoverageEstablished = false;
    const result = parseLocalCosts(bytes([win]), "win-codex-bar", "codex", scope);
    expect(result.last_30_days).toMatchObject({ cost_usd: null, tokens: null, partial: true });
  });
  it("uses the collector's local natural day instead of UTC", () => {
    const result = parseLocalCosts(
      bytes([swift("codex", { daily: [] })]),
      "codex-bar-cli",
      "codex",
      { ...scope, timezone: "America/Los_Angeles", now: new Date("2026-11-05T01:00:00Z") },
    );
    expect(result.range_end).toBe("2026-11-04");
    expect(result.range_start).toBe("2026-10-06");
  });
  it.each([
    { daily: [{ date: "2026-11-31", totalCost: 1 }] },
    { daily: [{ date: "2026-11-05", totalCost: -1 }] },
    { daily: [{ date: "2026-11-05", totalCost: 1, totalTokens: 1.5 }] },
    { currencyCode: "EUR" },
    { reportingPeriod: "month-to-date" },
    { source: "web" },
  ])("rejects malformed/non-native aggregates %j", (extra) => {
    expect(() =>
      parseLocalCosts(bytes([swift("codex", extra)]), "codex-bar-cli", "codex", scope),
    ).toThrow();
  });
});

function output(value: unknown, success = true) {
  return { bytes: bytes(value), error: "", success, truncated: false, exitCode: success ? 0 : 1 };
}
function fixture(providers = ["codex", "claude"]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentkib-local-costs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(root, "agentkib.db"));
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };
  cleanups.push(closeStore);
  const commands = new Commands();
  const run = vi.spyOn(commands, "run");
  const collector = path.join(root, "collector");
  writeFileSync(collector, "intercepted synthetic process");
  const config = path.join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ version: 1, providers: providers.map((id) => ({ id, enabled: true })) }),
  );
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    TZ: "UTC",
    AGENTKIB_QUOTA_SIDECAR: collector,
    CODEXBAR_CONFIG: config,
    HTTPS_PROXY: "http://127.0.0.1:1",
  };
  const notify = vi.fn();
  const owner = new QuotaOwner(store, commands, root, env, notify);
  cleanups.push(() => {
    owner.stop();
    commands.close();
  });
  return { root, store, closeStore, commands, run, config, env, notify, owner };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const dashboard = (id: string, remaining = 50, known = true) => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  staleAfterSeconds: 180,
  host: { codexBarVersion: "fixture" },
  providers: [
    {
      id,
      name: id,
      enabled: true,
      updatedAt: new Date().toISOString(),
      accounts: [{ id: "stable-account", label: "Account", active: true, windows: [] }],
      windows: [
        {
          kind: "weekly",
          label: "Custom window",
          remainingPercent: remaining,
          usedPercent: 100 - remaining,
          usageKnown: known,
        },
      ],
    },
  ],
});

describe("independent quota/cost queues and persistence", () => {
  it("matches upstream default-enabled metadata when provider.enabled is omitted", async () => {
    const f = fixture();
    writeFileSync(
      f.config,
      JSON.stringify({
        version: 1,
        providers: [{ id: "codex" }, { id: "claude" }, { id: "cursor", enabled: false }],
      }),
    );
    expect(await f.owner.status()).toMatchObject({ providers: { codex: { state: "idle" } } });
    expect(
      Object.keys(((await f.owner.status()) as { providers: Record<string, unknown> }).providers),
    ).toEqual(["codex"]);
    f.run.mockResolvedValue(output(dashboard("codex")));
    await f.owner.refresh();
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("persists preparation failures while keeping the last successful quota cache", async () => {
    const f = fixture(["codex"]);
    f.run.mockResolvedValue(output(dashboard("codex")));
    await f.owner.refresh();
    const before = f.owner.snapshot();
    writeFileSync(f.config, '{"SYNTHETIC-SECRET invalid-json');
    await expect(f.owner.refresh()).rejects.toThrow("invalid quota collector configuration");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(await f.owner.status()).toMatchObject({
      error_key: "errors.quotaUnavailable",
      error_detail: "invalid quota collector configuration",
    });
    expect(f.owner.snapshot()).toMatchObject({
      providers: (before as { providers: unknown[] }).providers,
      freshness: "stale",
    });
    expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-SECRET");
  });

  it("invalidates today's value across local midnight even within the five-minute cache period", async () => {
    const f = fixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T23:59:50Z"));
    f.run.mockResolvedValueOnce(output([swift()]));
    await f.owner.observeCosts("codex", false);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    vi.setSystemTime(new Date("2026-11-06T00:00:05Z"));
    expect(await f.owner.costSnapshot("codex")).toMatchObject({
      range_end: "2026-11-05",
      today: { date: "2026-11-06", tokens: null, cost_usd: null },
    });
    f.run.mockResolvedValueOnce(
      output([
        swift("codex", {
          sessionCostUSD: 0.4,
          sessionTokens: 400,
          last30DaysCostUSD: 0.4,
          last30DaysTokens: 400,
          daily: [{ date: "2026-11-06", totalCost: 0.4, totalTokens: 400 }],
        }),
      ]),
    );
    await f.owner.observeCosts("codex", false);
    await vi.waitFor(async () =>
      expect((await f.owner.costSnapshot("codex"))?.range_end).toBe("2026-11-06"),
    );
    expect(f.run).toHaveBeenCalledTimes(2);
  });
  it("never launches more than two quota collectors", async () => {
    const f = fixture(["codex", "claude", "cursor"]);
    const pending = new Map<string, ReturnType<typeof deferred<ReturnType<typeof output>>>>();
    f.run.mockImplementation(async (_program, args) => {
      const id = args[args.indexOf("--provider") + 1];
      const value = deferred<ReturnType<typeof output>>();
      pending.set(id, value);
      return value.promise;
    });
    const refresh = f.owner.refresh();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    expect(pending.has("cursor")).toBe(false);
    pending.get("claude")!.resolve(output(dashboard("claude")));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(3));
    pending.get("cursor")!.resolve(output(dashboard("cursor")));
    pending.get("codex")!.resolve(output(dashboard("codex")));
    await refresh;
  });
  it("publishes the fast provider immediately, caps quota concurrency at two and never waits for a slow cost scan", async () => {
    const f = fixture(["codex", "claude", "cursor"]);
    const slowQuota = deferred<ReturnType<typeof output>>();
    const slowCost = deferred<ReturnType<typeof output>>();
    f.run.mockImplementation(async (_program, args) =>
      args[0] === "cost"
        ? slowCost.promise
        : args[args.indexOf("--provider") + 1] === "codex"
          ? slowQuota.promise
          : output(dashboard(args[args.indexOf("--provider") + 1])),
    );
    await f.owner.refreshCost("codex", true);
    const all = f.owner.refresh();
    await vi.waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith(
        "quota.updated",
        expect.objectContaining({
          providers: expect.arrayContaining([expect.objectContaining({ id: "claude" })]),
        }),
      ),
    );
    expect((await f.owner.costStatus("codex")).state).toBe("running");
    await vi.waitFor(() =>
      expect(f.run.mock.calls.filter(([, args]) => args[0] === "dashboard")).toHaveLength(3),
    );
    slowQuota.resolve(output(dashboard("codex", 75)));
    await all;
    const args = f.run.mock.calls
      .filter(([, args]) => args[0] === "dashboard")
      .map(([, args]) => args);
    expect(
      args.every((entry) => entry.includes("--no-local-costs") && entry.includes("--provider")),
    ).toBe(true);
    expect(f.owner.snapshot()).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          accounts: [expect.objectContaining({ id: "stable-account" })],
        }),
      ]),
    });
    slowCost.resolve(output([swift()]));
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
  });
  it("deduplicates the same provider and retains valid zero/unknown windows", async () => {
    const f = fixture(["codex"]);
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValue(pending.promise);
    const first = f.owner.refresh("codex");
    const second = f.owner.refresh("codex");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    pending.resolve(output(dashboard("codex", 0)));
    await Promise.all([first, second]);
    expect(f.owner.snapshot()).toMatchObject({
      providers: [{ windows: [{ remaining_percent: 0, usage_known: true }] }],
    });
    f.run.mockResolvedValue(output(dashboard("codex", 100, false)));
    await f.owner.refresh("codex");
    expect(f.owner.snapshot()).toMatchObject({
      providers: [
        { windows: [{ remaining_percent: null, used_percent: null, usage_known: false }] },
      ],
    });
  });

  it("does not let an old quota process overwrite a newer configuration", async () => {
    const f = fixture(["codex"]);
    const old = deferred<ReturnType<typeof output>>();
    const current = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = f.owner.refresh("codex");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    f.env.CODEX_HOME = path.join(f.root, "new-native-root");
    const second = f.owner.refresh("codex");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    current.resolve(output(dashboard("codex", 85)));
    await second;
    old.resolve(output(dashboard("codex", 5)));
    await expect(first).rejects.toThrow("cancelled");
    expect(f.owner.snapshot()).toMatchObject({
      providers: [{ windows: [{ remaining_percent: 85 }] }],
    });
    expect(await f.owner.status()).toMatchObject({ providers: { codex: { state: "succeeded" } } });
  });
  it("keeps costs single-flight, prioritizes observation without preempting a scanner, and preserves data on timeout", async () => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValueOnce(pending.promise).mockResolvedValue(output([swift("claude")]));
    await f.owner.refreshCost("codex", true);
    await f.owner.refreshCost("codex", true);
    await f.owner.observeCosts("claude", true);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][2]).toMatchObject({
      timeout: 300_000,
      limit: 16 * 1024 * 1024,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    });
    pending.resolve(output([swift()]));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("claude")).state).toBe("succeeded"),
    );
    const previous = await f.owner.costSnapshot("codex");
    f.run.mockRejectedValueOnce(new Error("synthetic timed out"));
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () => expect((await f.owner.costStatus("codex")).state).toBe("failed"));
    expect(await f.owner.costSnapshot("codex")).toEqual(previous);
  });
  it("accepts structured nonzero-exit results and rejects truncated JSON without replacing its cache", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce(output([swift()], false));
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    const before = await f.owner.costSnapshot("codex");
    expect(before?.last_30_days.partial).toBe(true);
    f.run.mockResolvedValueOnce({
      ...output([swift("codex", { last30DaysCostUSD: 900 })]),
      truncated: true,
    });
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () => expect((await f.owner.costStatus("codex")).state).toBe("failed"));
    expect(await f.owner.costSnapshot("codex")).toEqual(before);
  });
  it("cancels on leaving with auto disabled and rejects a late completion", async () => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValue(pending.promise);
    await f.owner.observeCosts("codex", false);
    await f.owner.observeCosts(null, false);
    expect(f.run.mock.calls[0][2]?.signal?.aborted).toBe(true);
    pending.resolve(output([swift()]));
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("cancelled"),
    );
    expect(await f.owner.costSnapshot("codex")).toBeUndefined();
  });

  it("can restart a cancelled scan immediately when returning to the page", async () => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValueOnce(pending.promise).mockResolvedValue(output([swift()]));
    await f.owner.observeCosts("codex", false);
    await f.owner.observeCosts(null, false);
    await f.owner.observeCosts("codex", false);
    expect((await f.owner.costStatus("codex")).state).toBe("queued");
    pending.resolve(output([swift()]));
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
  });

  it("does not write or notify after stopping while quota/cost RPCs are settling", async () => {
    const f = fixture(["codex"]);
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValue(pending.promise);
    const refresh = f.owner.refresh();
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    f.owner.stop();
    f.closeStore();
    f.notify.mockClear();
    pending.resolve(output(dashboard("codex")));
    await expect(refresh).rejects.toThrow("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("retains cached provider scheduling after restart with auto refresh enabled", async () => {
    const f = fixture();
    f.run.mockResolvedValue(output([swift()]));
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    f.owner.stop();
    const next = new QuotaOwner(f.store, f.commands, f.root, f.env);
    cleanups.push(() => next.stop());
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    next.setCostAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    // Await file I/O before disposing the reopened owner/store.
    await vi.waitFor(async () => expect((await next.costStatus("codex")).state).toBe("succeeded"));
  });

  it("admits the observed provider first when both providers become due on one timer tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    const f = fixture();
    f.run.mockImplementation(async (_program, args) => output([swift(args[2])]));
    // Discover Codex first, so insertion order deliberately differs from page priority.
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    await f.owner.refreshCost("claude", true);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("claude")).state).toBe("succeeded"),
    );
    await f.owner.observeCosts("claude", true);
    f.run.mockClear();
    const pending = deferred<ReturnType<typeof output>>();
    f.run.mockReturnValueOnce(pending.promise);
    // Jump over both freshness limits without firing intermediate ticks.
    vi.setSystemTime(new Date(Date.parse(time) + 16 * 60_000));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    expect(f.run.mock.calls[0][1]).toContain("claude");
    expect((await f.owner.costStatus("codex")).state).toBe("queued");
    pending.resolve(output([swift("claude")]));
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    expect(f.run.mock.calls[1][1]).toContain("codex");
  });

  it("really terminates an isolated producer that exceeds the 16 MiB stdout budget", async () => {
    const f = fixture();
    f.run.mockRestore();
    const script = path.join(f.root, "overflow.cjs");
    writeFileSync(
      script,
      "process.stdout.write(Buffer.alloc(16*1024*1024+1,120));setInterval(()=>{},1000);\n",
    );
    await expect(
      f.commands.run(process.execPath, [script], {
        env: { ...process.env, HOME: f.root },
        limit: 16 * 1024 * 1024,
        strictOutput: true,
        timeout: 10_000,
        allowFailure: true,
        terminateDescendantsOnExit: true,
      }),
    ).rejects.toThrow("output exceeds");
  });
  it.each(["config", "timezone", "root"] as const)(
    "isolates %s changes and never saves a late response in the new scope",
    async (change) => {
      const f = fixture();
      const pending = deferred<ReturnType<typeof output>>();
      f.run.mockReturnValue(pending.promise);
      await f.owner.refreshCost("codex", true);
      const before = await f.owner.costStatus("codex");
      if (change === "config")
        writeFileSync(
          f.config,
          JSON.stringify({
            version: 1,
            providers: [{ id: "codex", enabled: true }],
            cost: { revision: 2 },
          }),
        );
      if (change === "timezone") f.env.TZ = "Asia/Shanghai";
      if (change === "root") f.env.CODEX_HOME = path.join(f.root, "other-codex");
      const after = await f.owner.costStatus("codex");
      expect(after.scope_key).not.toBe(before.scope_key);
      pending.resolve(output([swift()]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await f.owner.costSnapshot("codex")).toBeUndefined();
    },
  );
  it("reuses the successful SQLite aggregate after restart and leaves old quota cache readable", async () => {
    const f = fixture();
    f.run.mockResolvedValue(output([swift()]));
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () =>
      expect((await f.owner.costStatus("codex")).state).toBe("succeeded"),
    );
    const before = await f.owner.costSnapshot("codex");
    f.owner.stop();
    const next = new QuotaOwner(f.store, f.commands, f.root, f.env);
    cleanups.push(() => next.stop());
    expect(await next.costSnapshot("codex")).toEqual(before);
    expect(f.store.sql.one("SELECT value FROM schema_meta WHERE key='schema_version'")?.value).toBe(
      "15",
    );
  });
  it("records unsupported independent flags without falling back to mixed dashboard collection", async () => {
    const f = fixture(["codex"]);
    f.run.mockResolvedValue({
      bytes: Buffer.alloc(0),
      error: "unexpected argument --no-local-costs",
      success: false,
      truncated: false,
      exitCode: 2,
    });
    await expect(f.owner.refresh()).rejects.toThrow("update collector");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][1]).toContain("--no-local-costs");
    expect(await f.owner.status()).toMatchObject({
      error_key: "errors.quotaCollectorUpdateRequired",
    });
  });

  it("reports an update requirement for an external CLI without independent native costs", async () => {
    const f = fixture();
    f.run.mockResolvedValue(output([swift("codex", { agentkibNativeOnly: undefined })]));
    await f.owner.refreshCost("codex", true);
    await vi.waitFor(async () => expect((await f.owner.costStatus("codex")).state).toBe("failed"));
    expect(await f.owner.costStatus("codex")).toMatchObject({
      error_key: "errors.quotaCollectorUpdateRequired",
    });
    expect(await f.owner.costSnapshot("codex")).toBeUndefined();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
});
