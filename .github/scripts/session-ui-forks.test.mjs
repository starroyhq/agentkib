import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const web = join(repo, "apps/web/src/features/conversation/features");
const desktop = join(repo, "apps/desktop/src/features/sessions/conversation/features");

// At e77efe196, 36 pairs are byte-identical and the other 53 differ by 5,821 lines.
// Only the paths below may differ. Migrated paths leave the comparison when no pair remains.
const divergenceBudget = {
  "sessions/claude-session-banner.test.ts": 20,
  "sessions/claude-session-banner.ts": 8,
  "sessions/codex-session-controls.tsx": 909,
  "sessions/codex-tools.tsx": 148,
  "sessions/composer-layout-copy.ts": 6,
  "sessions/context-usage.tsx": 35,
  "sessions/devin-turn-notice.tsx": 52,
  "sessions/dsh-queue.tsx": 12,
  "sessions/managed-control-copy.ts": 2,
  "sessions/managed-copy.ts": 2,
  "sessions/managed-error-copy.ts": 2,
  "sessions/managed-turn-notice.tsx": 4,
  "sessions/operation-layout.tsx": 73,
  "sessions/permission-mode-notice.tsx": 22,
  "sessions/project-agent-panel.test.tsx": 229,
  "sessions/project-agent-panel.tsx": 272,
  "sessions/session-agent-copy.ts": 7,
  "sessions/session-composer-commands.test.tsx": 753,
  "sessions/session-composer-offline.test.tsx": 41,
  "sessions/session-composer.test.tsx": 210,
  "sessions/session-composer.tsx": 261,
  "sessions/session-context.tsx": 18,
  "sessions/session-display-state.ts": 2,
  "sessions/session-operations.tsx": 40,
  "sessions/session-panels.tsx": 1,
  "sessions/session-receipt-recovery.tsx": 173,
  "sessions/use-session-controller.ts": 689,
  "sessions/use-session-live.ts": 98,
};

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

function differenceLines(before, after) {
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "diff",
      "--no-index",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--",
      before,
      after,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  const counts = /^(\d+)\t(\d+)\t/.exec(result.stdout);
  assert.ok(counts, `Cannot count added and removed lines for ${relative(web, before)}`);
  return Number(counts[1]) + Number(counts[2]);
}

test("desktop and Web conversation forks stay within the existing divergence", () => {
  const desktopPaths = new Set(filesIn(desktop));
  const differences = [];
  for (const path of filesIn(web).sort()) {
    if (!desktopPaths.has(path)) continue;
    const webFile = join(web, path);
    const desktopFile = join(desktop, path);
    if (readFileSync(webFile).equals(readFileSync(desktopFile))) continue;
    const limit = Object.hasOwn(divergenceBudget, path) ? divergenceBudget[path] : 0;
    if (limit === 0) {
      differences.push(`${path}: must be byte-identical`);
      continue;
    }
    const lines = differenceLines(webFile, desktopFile);
    if (lines > limit)
      differences.push(`${path}: ${lines} added or removed lines exceeds ${limit}`);
  }
  assert.deepEqual(differences, []);
});
