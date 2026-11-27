// @vitest-environment node
import { REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import { expect, it, vi } from "vitest";
import { readDesktopQuitWork } from "./quit-work-preview";
import { RuntimeRequestError } from "./runtime-host";

const active = {
  id: "local-active",
  workspace_id: "workspace",
  agent: "codex",
  title: "In progress",
  availability: "readable",
  continuation: { status: "running", executionLocation: "agentkib" },
};

it("preserves the catalog warning without a continuation ticket when preparation fails", async () => {
  const prepare = vi.fn().mockRejectedValue(new Error("private unsafe error"));
  const catalog = vi.fn().mockResolvedValue([active]);
  expect(await readDesktopQuitWork({ prepare, catalog })).toEqual({
    work: [{ title: "In progress", agent: "codex" }],
    reason: codes.quitWorkPlanUnavailable,
  });
  prepare.mockRejectedValue(new RuntimeRequestError({ code: -32601, message: "Method not found" }));
  expect(await readDesktopQuitWork({ prepare, catalog })).toEqual({
    work: [{ title: "In progress", agent: "codex" }],
  });
});

it("neither prepares nor shows a warning when another desktop owns the runtime", async () => {
  const prepare = vi.fn();
  const catalog = vi.fn();
  expect(await readDesktopQuitWork({ prepare, catalog, peers: async () => 1 })).toEqual({
    work: [],
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
});

it("reports a read timeout with no stale ticket", async () => {
  const prepared = new Promise<never>(() => undefined);
  const prepare = vi.fn(() => prepared);
  const catalog = vi.fn();
  expect(await readDesktopQuitWork({ prepare, catalog }, 1)).toEqual({
    reason: codes.deadlineExceeded,
    work: [],
  });
  expect(catalog).not.toHaveBeenCalled();
});
