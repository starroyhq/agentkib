import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

if (process.platform === "darwin") {
  const target = path.resolve(import.meta.dirname, "../dist-electron/native");
  mkdirSync(target, { recursive: true });
  execFileSync(
    "xcrun",
    [
      "clang",
      "-dynamiclib",
      "-fobjc-arc",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-mmacosx-version-min=13.3",
      "-install_name",
      "@rpath/desktop-notifications.dylib",
      "-framework",
      "Foundation",
      "-framework",
      "UserNotifications",
      path.join(import.meta.dirname, "desktop-notifications.m"),
      "-o",
      path.join(target, "desktop-notifications.dylib"),
    ],
    { stdio: "inherit", timeout: 60_000 },
  );
}
