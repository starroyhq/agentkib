import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = "release-windows-store";

export function readWindowsStoreIdentity(environment) {
  const identity = {
    identityName: environment.WINDOWS_STORE_IDENTITY_NAME,
    publisher: environment.WINDOWS_STORE_PUBLISHER,
    publisherDisplayName: environment.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME,
  };
  if (Object.values(identity).every((value) => !value)) return undefined;
  if (
    Object.values(identity).some(
      (value) => !value || value !== value.trim() || /[\r\n]/.test(value),
    )
  ) {
    throw new Error(
      "Set all three Windows Store identity variables to the exact Partner Center values.",
    );
  }
  if (!/^[a-z0-9.-]{3,50}$/i.test(identity.identityName) || !identity.publisher.startsWith("CN=")) {
    throw new Error("Windows Store identity name or publisher is invalid.");
  }
  return identity;
}

export function windowsStoreIdentityRequired(environment) {
  return (
    environment.SHOULD_PUBLISH === "true" &&
    /^[1-9]\d*\.\d+\.\d+$/.test(environment.APP_VERSION ?? "")
  );
}

async function packageWindowsStore(environment) {
  const identity = readWindowsStoreIdentity(environment);
  if (!identity) {
    if (windowsStoreIdentityRequired(environment)) {
      throw new Error(
        "Windows Store identity is required for stable releases starting with 1.0.0.",
      );
    }
    console.log(
      "::notice::Windows Store package skipped. Set the three Partner Center variables to build it.",
    );
    return;
  }

  const { Arch, build, Platform } = await import("electron-builder");
  const artifacts = await build({
    projectDir,
    targets: Platform.WINDOWS.createTarget(["appx"], Arch.x64),
    publish: "never",
    config: {
      directories: { output: outputDirectory, buildResources: "resources/windows-store" },
      // The modern MakeAppx SDK recognizes the Win32 activation attributes.
      toolsets: { winCodeSign: "1.1.0" },
      win: { signExecutable: false },
      appx: identity,
    },
  });
  const packages = artifacts.filter((file) => file.endsWith(".msix"));
  if (packages.length !== 1) throw new Error("Expected exactly one Windows Store MSIX artifact.");
  const [file] = packages;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  await writeFile(`${file}.sha256`, `${hash.digest("hex")}  ${path.basename(file)}\n`);
  if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, "built=true\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await packageWindowsStore(process.env);
}
