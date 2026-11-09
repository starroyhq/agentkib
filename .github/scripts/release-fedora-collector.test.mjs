import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Fedora packaging consumes the validated Linux collector before preparation", () => {
  const workflow = readFileSync(
    new URL("../workflows/release-desktop.yml", import.meta.url),
    "utf8",
  );
  const fedora = workflow.split("  fedora-x64:\n")[1].split("\n  publish:")[0];
  // The Fedora container deliberately has no Swift toolchain. Packaging must
  // wait for and reuse the accepted native Linux build, with its manifest.
  assert.match(fedora, /needs: \[[^\n]*quota-collectors[^\n]*\]/);
  const download = fedora.indexOf("uses: actions/download-artifact@");
  const prepare = fedora.indexOf("pnpm quota:prepare");
  assert.ok(download >= 0 && download < prepare);
  assert.match(fedora.slice(download, prepare), /name: quota-collector-x86_64-unknown-linux-gnu/);
  assert.match(fedora.slice(download, prepare), /path: apps\/desktop\/resources\/quota\//);
  assert.ok(fedora.indexOf("apps/desktop/build/quota") < download);
});
