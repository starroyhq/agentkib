// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localRuntimeTracePaths } from "@agentkib/backend/local-runtime-trace";
import { registerDiagnosticsIpc } from "./diagnostics";
import { createIpcRegistrar } from "./registrar";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

let directory: string;
const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
const trusted = vi.fn();
const runtime = vi.fn(() => {
  throw new Error("Runtime connection is unavailable");
});

function handler() {
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === "agentkib:diagnostics:export");
  if (!call) throw new Error("Missing export IPC handler");
  return call[1];
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agentkib-export-diagnostics-"));
  vi.resetAllMocks();
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
    isDestroyed: () => false,
  } as BrowserWindow);
  registerDiagnosticsIpc(
    createIpcRegistrar({ assertTrustedRenderer: trusted, runtime }).handle,
    directory,
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("local diagnostic export IPC", () => {
  it("saves the sanitized report without requesting the runtime or trusting a renderer file path", async () => {
    const [trace] = localRuntimeTracePaths(directory);
    const selected = path.join(directory, "report.json");
    await mkdir(path.dirname(trace!));
    await writeFile(
      trace!,
      '{"v":1,"at":12345,"kind":"stall","durationMs":2500,"active":[],"extra":"private data"}\n',
    );
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: selected });
    await handler()(event, path.join(directory, "untrusted.json"));
    const saved = await readFile(selected, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      version: 1,
      recentStalls: [{ v: 1, at: 12345, kind: "stall", durationMs: 2500, active: [] }],
      trace: { filesRead: 1, counts: { stall: 1 } },
    });
    expect(saved).not.toContain("private data");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("limits the action to a trusted top level renderer and only opens one concurrent dialog", async () => {
    const exportReport = handler();
    trusted.mockImplementationOnce(() => {
      throw new Error("untrusted sender");
    });
    await expect(async () => exportReport(event)).rejects.toThrow("untrusted sender");
    await expect(exportReport({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow(
      "diagnostics-export-unavailable",
    );
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    let cancel!: () => void;
    vi.mocked(dialog.showSaveDialog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          cancel = () => resolve({ canceled: true, filePath: "" });
        }),
    );
    const received = exportReport(event);
    await exportReport(event);
    expect(dialog.showSaveDialog).toHaveBeenCalledOnce();
    cancel();
    await received;
    expect(runtime).not.toHaveBeenCalled();
  });
});
