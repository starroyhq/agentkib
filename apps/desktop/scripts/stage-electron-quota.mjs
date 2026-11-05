import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  binaryPath,
  desktopDirectory,
  hostTarget,
  preparedManifest,
  resourceDirectory,
} from "./quota-collector/build.mjs";

const target = process.env.AGENTKIB_QUOTA_TARGET ?? hostTarget();
const windows = target.endsWith("windows-msvc");
const destinationDirectory = path.join(desktopDirectory, "build/quota");
const destination = path.join(
  destinationDirectory,
  windows ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
);
if (target === "aarch64-pc-windows-msvc") {
  await rm(destination, { force: true });
  process.stdout.write("AgentKib quota collector: Windows ARM64 is unsupported.\n");
} else {
  const manifest = await preparedManifest(target);
  if (!manifest)
    throw new Error(
      `No verified patched collector for ${target}; run quota:prepare on the target platform first`,
    );
  await mkdir(destinationDirectory, { recursive: true });
  if (!windows) await chmod(binaryPath(target), 0o755);
  await copyFile(binaryPath(target), destination);
  if (!windows) {
    const bundle = path.join(
      resourceDirectory,
      target.includes("linux") ? "resources/linux" : "resources",
      "CodexBar_CodexBarCore.bundle",
    );
    await rm(path.join(destinationDirectory, "CodexBar_CodexBarCore.bundle"), {
      recursive: true,
      force: true,
    });
    await cp(bundle, path.join(destinationDirectory, "CodexBar_CodexBarCore.bundle"), {
      recursive: true,
    });
  }
  await writeFile(
    path.join(destinationDirectory, "VERSION"),
    `${manifest.version}+agentkib.${manifest.patchRevision}\n`,
  );
  await writeFile(
    path.join(destinationDirectory, "collector-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (!windows) await chmod(destination, 0o755);
  process.stdout.write(`AgentKib quota collector: staged verified ${target}.\n`);
}
