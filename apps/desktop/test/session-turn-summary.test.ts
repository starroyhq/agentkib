import { expect, it } from "vitest";
import {
  cleanTurnSummary,
  TurnSummaryProjection,
} from "../../../packages/backend/src/session-turn-summary";

const turn_id = "turn-current";
const check = (id: string, command: string, tool_status: string, exit_code?: number) => ({
  id,
  kind: "tool-summary",
  turn_id,
  tool_status,
  tool: {
    kind: "execute",
    content: [{ type: "terminal", command, exit_code, output: "PRIVATE CHECK OUTPUT" }],
  },
});
const edit = (id: string, path: string, tool_status: string) => ({
  id,
  kind: "tool-summary",
  turn_id,
  tool_status,
  tool_name: "apply_patch",
  tool: {
    kind: "edit",
    content: [
      {
        type: "diff",
        path,
        change: "update",
        added: 2,
        removed: 1,
        preview: "@@ -1 +1,2 @@\n-a\n+b\n+c",
      },
    ],
  },
});

it("keeps attributable check runs, deduplicating replayed items and dropping raw arguments", () => {
  const summary = new TurnSummaryProjection(turn_id);
  summary.add(check("running", "pnpm test", "running"));
  summary.add(check("declined", "pnpm test", "declined"));
  summary.add(check("help", "pnpm exec vitest --help", "completed", 0));
  summary.add(check("dry-run", "pnpm test --dry-run", "completed", 0));
  summary.add(check("uncertain", "pnpm test private/src.ts", "unknown"));
  summary.add(check("compound", "pnpm test || echo recovered", "completed", 0));
  summary.add(check("compound", "go run tools -- test", "completed", 0));
  const retried = check(
    "first",
    "timeout -k 2s 16s pnpm --filter pkg exec vitest run file",
    "failed",
    2,
  );
  summary.add(retried);
  summary.add(retried);
  summary.add({ ...retried, id: "stale", turn_id: "older" });
  summary.add({
    ...retried,
    id: "second",
    tool: { ...retried.tool, content: [{ ...retried.tool.content[0]!, exit_code: 0 }] },
  });
  expect(summary.summary()).toEqual({
    checks: [
      { name: "pnpm test", status: "unknown" },
      { name: "pnpm exec vitest", status: "failed", exit_code: 2 },
      { name: "pnpm exec vitest", status: "passed", exit_code: 0 },
    ],
  });
});

it("sums successful edits at workspace-relative paths and preserves known partial evidence", () => {
  const summary = new TurnSummaryProjection(turn_id);
  const first = edit("first", "src/a.ts", "completed");
  summary.add(first);
  summary.add(first);
  summary.add(edit("second", "./src/a.ts", "completed"));
  summary.add(edit("failed", "src/failed.ts", "failed"));
  summary.add(edit("absolute", "/outside/a.ts", "completed"));
  summary.add(edit("traversal", "src/../../outside/a.ts", "completed"));
  summary.add(edit("private", "src/.env.production", "completed"));
  const overwrite = edit("write", "src/maybe-overwritten.ts", "completed");
  overwrite.tool_name = "Write";
  overwrite.tool.content[0]!.change = "add";
  summary.add(overwrite);
  expect(summary.summary()).toEqual({
    files: [{ path: "src/a.ts", added: 4, removed: 2 }, { path: "src/maybe-overwritten.ts" }],
    partial: true,
  });
});

it("keeps the same safe summary when persisted with another Provider's turn metadata", () => {
  const summary = new TurnSummaryProjection(turn_id);
  summary.add(edit("first", "src/a.ts", "completed"));
  summary.add(check("second", "pnpm exec vitest --run", "failed", 1));
  const saved = summary.summary();
  expect(cleanTurnSummary(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  expect(
    cleanTurnSummary({
      files: [{ path: "~/outside" }, { path: "C:\\outside" }, { path: "src/secrets/auth.txt" }],
      checks: [{ name: "pnpm test arg=secret", status: "passed" }],
    }),
  ).toBeUndefined();
});
