import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const web = join(repo, "apps/web/src/features/conversation/features");
const desktop = join(repo, "apps/desktop/src/features/sessions/conversation/features");

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

test("desktop and Web have no remaining same-path conversation feature files", () => {
  const desktopPaths = new Set(filesIn(desktop));
  const duplicatePaths = filesIn(web)
    .filter((path) => desktopPaths.has(path))
    .sort();
  assert.deepEqual(duplicatePaths, [], "Move shared conversation features to packages/session-ui");
});
