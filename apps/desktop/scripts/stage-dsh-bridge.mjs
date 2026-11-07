import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// The DeepSeek Harness plugin ships as a directory the user installs with `dsh plugin add`.
const desktop = path.resolve(import.meta.dirname, "..");
const source = path.resolve(desktop, "../../packages/dsh-bridge-plugin");
const destination = path.join(desktop, "build/dsh-bridge");
const entries = [
  "package.json",
  "cordis.patch.yml",
  "index.js",
  "bridge.js",
  "client.js",
  "projection.js",
  "compatibility.js",
  "commands.js",
  "LICENSE",
  "NOTICE",
];
const hash = createHash("sha256");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of entries) {
  const bytes = await readFile(
    entry === "LICENSE" || entry === "NOTICE"
      ? path.resolve(desktop, "../..", entry)
      : path.join(source, entry),
  );
  hash.update(entry).update("\0").update(bytes).update("\0");
  await writeFile(path.join(destination, entry), bytes);
}
const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
await writeFile(
  path.join(destination, "artifact.json"),
  JSON.stringify(
    { id: manifest.name, version: manifest.version, sha256: hash.digest("hex"), files: entries },
    null,
    2,
  ) + "\n",
);
