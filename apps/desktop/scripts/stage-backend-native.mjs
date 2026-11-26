import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
// Koffi 3 exports its entry points, but no longer exports package.json.
const source = path.dirname(await realpath(require.resolve("koffi")));
const target = path.join(root, "dist-electron/native/koffi");
await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (file) => {
    const relative = path.relative(source, file).split(path.sep).join("/");
    const first = relative.split("/")[0];
    if (["doc", "vendor", "node_modules", "cnoke.cjs"].includes(first)) return false;
    // The public entry points delegate to these JS loaders inside src/koffi.
    if (first === "src")
      return (
        ["src", "src/koffi", "src/koffi/src"].includes(relative) || /\.(cjs|js)$/.test(relative)
      );
    return true;
  },
});

// Koffi's loader also searches its own build/koffi directory for the platform
// binary. This layout is retained when electron-builder filters node_modules.
const binaryName = `@koromix/koffi-${process.platform}-${process.arch}`;
const koffiRequire = createRequire(path.join(source, "package.json"));
const binarySource = path.dirname(await realpath(koffiRequire.resolve(binaryName)));
const binaryTarget = path.join(target, "build/koffi");
await cp(binarySource, binaryTarget, { recursive: true });
