import { expect, it } from "vitest";
import { ManagedCodexState } from "../../../packages/backend/src/agents/codex/managed-codex-state";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const record = {
  id: "managed",
  workspace_id: "workspace",
  workspace: "/fixture",
  native_id: nativeId,
};
const tokens = (used: number) => ({
  last: { totalTokens: used },
  total: { totalTokens: 9000 },
  modelContextWindow: 100,
});
const notify = (state: ManagedCodexState, method: string, params: Record<string, unknown>) =>
  state.apply({ method, params: { threadId: nativeId, ...params } });
const usage = (state: ManagedCodexState) =>
  state.snapshot("boot", true).usage as {
    reportGeneration: number;
    reportId: number;
  };

it("starts a rebuilt observer in a new report namespace without changing its control revision", () => {
  const original = new ManagedCodexState(record);
  notify(original, "turn/started", { turn: { id: "first", status: "inProgress" } });
  notify(original, "thread/tokenUsage/updated", { turnId: "first", tokenUsage: tokens(60) });
  notify(original, "thread/tokenUsage/updated", { turnId: "first", tokenUsage: tokens(80) });
  const oldUsage = usage(original);
  original.fail("codex-disconnected");
  expect(usage(original)).toMatchObject({
    reportGeneration: oldUsage.reportGeneration,
    reportId: oldUsage.reportId,
    state: "stale",
  });
  const rebuilt = new ManagedCodexState(
    { ...record, token_usage: tokens(80), snapshot: original.snapshot("boot", false) },
    original.revision,
  );
  expect(rebuilt.revision).toBe(original.revision);
  expect(usage(rebuilt).reportGeneration).toBeGreaterThan(oldUsage.reportGeneration);
  expect(usage(rebuilt).reportId).toBe(0);
  const generation = usage(rebuilt).reportGeneration;
  notify(rebuilt, "turn/started", { turn: { id: "second", status: "inProgress" } });
  notify(rebuilt, "thread/tokenUsage/updated", { turnId: "second", tokenUsage: tokens(5) });
  expect(rebuilt.snapshot("boot", true).usage).toMatchObject({
    state: "ready",
    percent: 5,
    reportGeneration: generation,
    reportId: 1,
  });
});
