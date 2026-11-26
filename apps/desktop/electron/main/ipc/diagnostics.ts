import { BrowserWindow, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { readRuntimeDiagnostics } from "../runtime-diagnostics-report";
import type { IpcRegistrar } from "./registrar";

export function registerDiagnosticsIpc(handle: IpcRegistrar["handle"], dataDir: string): void {
  let exporting = false;
  handle("agentkib:diagnostics:export", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      throw new Error("diagnostics-export-unavailable");
    if (exporting) return;
    exporting = true;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: "agentkib-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!canceled && filePath) {
        const report = await readRuntimeDiagnostics(dataDir);
        await writeFile(filePath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      }
    } catch {
      // IPC errors must not send the selected path or filesystem errors to the renderer.
      throw new Error("diagnostics-export-failed");
    } finally {
      exporting = false;
    }
  });
}
