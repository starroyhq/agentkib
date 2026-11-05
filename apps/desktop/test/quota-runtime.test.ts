import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS as M } from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { QuotaOwner } from "../../../packages/backend/src/quota";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-cost-rpc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  mkdirSync(data);
  writeFileSync(
    path.join(data, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      quota_auto_refresh_enabled: false,
    }),
  );
  vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
  vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
  const backend = new TypeScriptBackend({
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    APPDATA: path.join(root, "appdata"),
    PATH: path.join(root, "empty-bin"),
  });
  cleanups.push(() => backend.closeAsync());
  const request = (method: string, params: Record<string, unknown> = {}) =>
    backend.handleAsync({ jsonrpc: "2.0", id: 1, method, params });
  const initialized = await request(BACKEND_INITIALIZE, { dataDir: data });
  expect(initialized.error).toBeUndefined();
  return { backend, request };
}

describe("local estimate runtime contract", () => {
  it("routes aggregate reads, independent refreshes and observations", async () => {
    const { request } = await fixture();
    const status = {
      provider: "codex" as const,
      scope_key: "opaque-scope",
      state: "queued" as const,
    };
    const snapshot = vi.spyOn(QuotaOwner.prototype, "costSnapshot").mockResolvedValue(undefined);
    const readStatus = vi.spyOn(QuotaOwner.prototype, "costStatus").mockResolvedValue(status);
    const refresh = vi.spyOn(QuotaOwner.prototype, "refreshCost").mockResolvedValue(status);
    const observe = vi.spyOn(QuotaOwner.prototype, "observeCosts").mockResolvedValue();
    const quota = vi.spyOn(QuotaOwner.prototype, "refresh").mockResolvedValue({ accepted: true });
    expect((await request(M.localCostSnapshot, { provider: "codex" })).error).toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith("codex");
    expect((await request(M.localCostStatus, { provider: "codex" })).result).toEqual(status);
    expect(readStatus).toHaveBeenCalledWith("codex");
    expect((await request(M.refreshLocalCost, { provider: "codex", force: true })).result).toEqual(
      status,
    );
    expect(refresh).toHaveBeenCalledWith("codex", true);
    await request(M.observeLocalCosts, { provider: "claude" });
    expect(observe).toHaveBeenLastCalledWith("claude", false);
    await request(M.observeLocalCosts, { provider: null });
    expect(observe).toHaveBeenLastCalledWith(null, false);
    await request(M.refreshQuota, { provider: "claude" });
    expect(quota).toHaveBeenLastCalledWith("claude");
    await request(M.refreshQuota);
    expect(quota).toHaveBeenLastCalledWith(undefined);
  });

  it("rejects invalid providers and flags before starting any collector", async () => {
    const { request } = await fixture();
    const refresh = vi.spyOn(QuotaOwner.prototype, "refreshCost");
    for (const provider of ["cursor", "../codex", null, {}, undefined]) {
      const response = await request(M.refreshLocalCost, { provider });
      expect(response.error?.code).toBe(-32602);
    }
    expect(
      (await request(M.refreshLocalCost, { provider: "codex", force: "true" })).error?.code,
    ).toBe(-32602);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses the persisted automatic preference and cancels work on shutdown", async () => {
    const { request, backend } = await fixture();
    const automatic = vi.spyOn(QuotaOwner.prototype, "setCostAutoRefresh");
    const observe = vi.spyOn(QuotaOwner.prototype, "observeCosts").mockResolvedValue();
    await request(M.setQuotaAutoRefresh, { value: true });
    expect(automatic).toHaveBeenLastCalledWith(true);
    await request(M.observeLocalCosts, { provider: "codex" });
    expect(observe).toHaveBeenLastCalledWith("codex", true);
    await request(M.setQuotaAutoRefresh, { value: false });
    expect(automatic).toHaveBeenLastCalledWith(false);
    const stop = vi.spyOn(QuotaOwner.prototype, "stop");
    await backend.closeAsync();
    expect(stop).toHaveBeenCalled();
  });
});
