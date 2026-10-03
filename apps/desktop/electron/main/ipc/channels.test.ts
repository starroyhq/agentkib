// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// IPC 通道名是 preload 与主进程之间唯一的约定，编译器检查不到拼写错误。
// 这里从源码里提取两侧的通道名并比较，防止重构时漏注册或写错名字。
const electronRoot = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(electronRoot, file), "utf8");
const channels = (source: string, pattern: RegExp) =>
  new Set([...source.matchAll(pattern)].map((match) => match[1]));

const preload = read("preload/index.ts");
const main = ["main/index.ts", "main/ipc/runtime.ts"].map(read).join("\n");

describe("IPC channel wiring", () => {
  it("registers a main-process handler for every channel the preload invokes", () => {
    const invoked = channels(preload, /ipcRenderer\.invoke\(\s*"(agentkib:[^"]+)"/g);
    const handled = channels(main, /\b(?:handle|forward|ipcMain\.handle)\(\s*"(agentkib:[^"]+)"/g);
    expect(invoked.size).toBeGreaterThan(100);
    expect([...invoked].filter((channel) => !handled.has(channel))).toEqual([]);
    expect([...handled].filter((channel) => !invoked.has(channel))).toEqual([]);
  });

  it("listens for every one-way message the preload sends", () => {
    const sent = channels(preload, /ipcRenderer\.send\(\s*"(agentkib:[^"]+)"/g);
    const listened = channels(main, /ipcMain\.on\(\s*"(agentkib:[^"]+)"/g);
    expect([...sent]).toEqual([...listened]);
  });
});
