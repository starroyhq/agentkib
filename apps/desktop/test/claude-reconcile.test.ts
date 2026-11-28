// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runClaudeReconcile } from "../../../packages/backend/src/agents/claude/claude-reconcile";
import { admitControlReceipt } from "../../../packages/backend/src/sessions/control-receipts";

it("claims the reconcile request before releasing either session's fence", async () => {
  const data = mkdtempSync(join(tmpdir(), "claude-reconcile-"));
  try {
    const requestId = randomUUID();
    const first = admitControlReceipt(data, requestId, "first session");
    const second = admitControlReceipt(data, requestId, "second session");
    expect(first.previous).toBeNull();
    expect(second.previous).toBeNull();
    const scope = {
      requestId,
      deviceId: "desktop-local",
      workspaceId: "workspace",
      runtimeBootId: "boot",
    };
    const entered = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<boolean>();
    const firstRecovery = vi.fn(() => {
      entered.resolve();
      return settled.promise;
    });
    const secondRecovery = vi.fn(async () => true);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ status: "outcome-unknown" })
      .mockResolvedValue({ status: "idle" });
    const original = runClaudeReconcile(
      first,
      { ...scope, sessionId: "first" },
      read,
      firstRecovery,
    );
    await entered.promise;
    try {
      await expect(
        runClaudeReconcile(
          second,
          { ...scope, sessionId: "second" },
          async () => ({ status: "outcome-unknown" }),
          secondRecovery,
        ),
      ).rejects.toThrow("request-id-reused-with-different-input");
      expect(secondRecovery).not.toHaveBeenCalled();
    } finally {
      settled.resolve(true);
      await expect(original).resolves.toMatchObject({ sessionId: "first", reconciled: true });
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
