import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

if (process.platform !== "win32") {
  throw new Error("MCP process cleanup verification requires Windows");
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    fileURLToPath(new URL("./verify-windows-mcp-cleanup.cjs", import.meta.url)),
    process.execPath,
    ...process.argv.slice(2),
  ],
  { env: environment, stdio: "inherit", windowsHide: true },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
