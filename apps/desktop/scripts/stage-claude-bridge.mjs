import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const source = path.resolve(desktop, "../../packages/claude-bridge-plugin");
const destination = path.join(desktop, "build/claude-bridge");
const entries = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "package.json",
  "hooks/hooks.json",
  "hooks/register.js",
  "hooks/compatibility.js",
];
const hash = createHash("sha256");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of entries) {
  const bytes = await readFile(path.join(source, entry));
  hash.update(entry).update("\0").update(bytes).update("\0");
  await mkdir(path.dirname(path.join(destination, entry)), { recursive: true });
  await writeFile(path.join(destination, entry), bytes);
}
const manifest = JSON.parse(
  await readFile(path.join(source, ".claude-plugin/plugin.json"), "utf8"),
);
await writeFile(
  path.join(destination, "artifact.json"),
  JSON.stringify(
    {
      id: manifest.name,
      version: manifest.version,
      sha256: hash.digest("hex"),
      files: entries,
    },
    null,
    2,
  ) + "\n",
);
