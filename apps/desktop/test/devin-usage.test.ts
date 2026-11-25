// @vitest-environment node
import childProcesses from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  devinLimitReset,
  devinUsageWindows,
  readDevinUsage,
} from "../../../packages/backend/src/agents/devin/devin-usage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// What Devin CLI 3000.12.59 printed in its terminal: the status line it shows from the start,
// then the panel `/usage` answers with (a Max plan has a weekly window only).
const STATUS_LINE =
  "\r\u001b[11A\u001b[6B\r\u001b[1C\u001b[38;2;124;124;124mMax · 34% remaining (resets in 5d 22h)\u001b[7B\r\u001b[67C";
const PANEL =
  "\r\u001b[3A\u001b[J \u001b[1mUsage\u001b[0m\r\n \u001b[38;2;124;124;124mWeekly\u001b[0m  ■■■■■■■■■■■■■\u001b[38;2;124;124;124m■■■■■■■\u001b[0m  66% used  \u001b[38;2;124;124;124m· resets Nov 22, 4:00 PM (UTC+8)\u001b[0m\r\n\r\n \u001b[38;2;124;124;124mNo usage yet in this session.\u001b[0m\r\n";
const NOW = Date.UTC(2026, 10, 16, 9, 0);
const hit = (message: string) => ({ resetsAt: null, kind: null, scope: null, message });

describe("Devin's /usage panel", () => {
  it("reads each window with when it resets, and nothing from the status line", () => {
    expect(devinUsageWindows(STATUS_LINE, NOW)).toEqual([]);
    expect(devinUsageWindows(STATUS_LINE + PANEL, NOW)).toEqual([
      { label: "Weekly", usedPercent: 66, resetsAt: Date.UTC(2026, 10, 22, 8, 0) },
    ]);
  });

  it.each([
    // Devin prints no year: the next such time, also across the new year.
    [
      "Daily  ■■■■  100% used  · resets Jan 2, 9:30 AM (UTC-5)",
      Date.UTC(2026, 11, 30, 12),
      Date.UTC(2027, 0, 2, 14, 30),
    ],
    ["Daily  ■■  100% used  · resets Nov 16, 12:05 AM (UTC)", NOW, Date.UTC(2026, 10, 16, 0, 5)],
    [
      "Weekly  ■■  40% used  · resets Nov 18, 11:15 PM (UTC+5:30)",
      NOW,
      Date.UTC(2026, 10, 18, 17, 45),
    ],
    [
      "Billing cycle  ■■  12% used  · resets Dec 1, 8:00 AM (UTC+0)",
      NOW,
      Date.UTC(2026, 11, 1, 8, 0),
    ],
    // Without an offset, the time is this computer's.
    ["Daily  ■■  100% used  · resets Nov 17, 1:00 PM", NOW, new Date(2026, 10, 17, 13).getTime()],
  ])("reads %j", (line, now, resetsAt) => {
    expect(devinUsageWindows(`${line}\n`, now)).toEqual([expect.objectContaining({ resetsAt })]);
  });

  it.each([
    "Weekly  ■■  66% used  · resets Feb 30, 4:00 PM (UTC+8)",
    "Weekly  ■■  66% used  · resets Nov 22, 13:00 PM (UTC+8)",
    "Weekly  ■■  66% used",
    "No quota data available.",
  ])("reads nothing from %j", (line) => {
    expect(devinUsageWindows(line, NOW)).toEqual([]);
  });

  const windows = [
    { label: "Daily", usedPercent: 100, resetsAt: NOW + 3_600_000 },
    { label: "Weekly", usedPercent: 81, resetsAt: NOW + 5 * 86_400_000 },
  ];
  it("takes the window Devin's message names", () => {
    expect(
      devinLimitReset(windows, hit("Your daily usage quota has been exhausted. Visit …")),
    ).toEqual({ resetsAt: NOW + 3_600_000, kind: null });
    expect(
      devinLimitReset(windows, hit("Your weekly usage quota has been exhausted. Visit …")),
    ).toEqual({ resetsAt: NOW + 5 * 86_400_000, kind: "weekly" });
    // A window the panel does not list is not guessed at.
    expect(
      devinLimitReset(windows.slice(1), hit("Your daily usage quota has been exhausted.")),
    ).toBe(null);
  });

  it("otherwise takes the used-up window that resets last, as for Codex", () => {
    expect(devinLimitReset(windows, hit("Quota exhausted"))).toEqual({
      resetsAt: NOW + 3_600_000,
      kind: null,
    });
    expect(
      devinLimitReset(
        [...windows, { label: "Weekly", usedPercent: 100, resetsAt: NOW + 2 * 86_400_000 }],
        hit("Usage limit reached"),
      ),
    ).toEqual({ resetsAt: NOW + 2 * 86_400_000, kind: "weekly" });
    expect(devinLimitReset(windows.slice(1), hit("Rate limited: Too many requests"))).toBeNull();
  });
});

/**
 * A stand-in for Devin's interactive CLI in a pseudo-terminal: it marks itself idle as Devin
 * does (OSC 7501), answers `/usage` typed and then entered, and logs the keys it got.
 */
function fakeRepl(mode: "panel" | "trust" | "silent" | "logged-out") {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-devin-usage-"));
  roots.push(root);
  const log = path.join(root, "keys.log");
  writeFileSync(
    path.join(root, "repl.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
// The terminal adds a carriage return to each line feed, also to Devin's own "\\r\\n".
const out = (text) => process.stdout.write(text);
writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid));
log("start " + process.stdin.isTTY + " " + process.stdout.columns);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const mode = ${JSON.stringify(mode)};
if (mode === "trust") out(" Do you trust the authors of this directory?\\n 1 Yes, trust\\n 2 No, exit\\n");
else if (mode !== "silent") out(${JSON.stringify(STATUS_LINE)} + "\\u001b]7501;state=idle:app=devin\\u001b\\\\");
let typed = "";
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  log("keys " + JSON.stringify(text));
  if (text !== "\\r") {
    // A burst that ends in Enter is a paste: it adds a line, it runs nothing.
    typed = text.includes("\\r") ? "" : typed + text;
    return;
  }
  if (typed === "/usage")
    setTimeout(() => out(mode === "logged-out" ? " Not logged in.\\n" : ${JSON.stringify(PANEL)}), 100);
  typed = "";
});
process.on("SIGHUP", () => process.exit(0));
`,
  );
  const executable = path.join(root, "devin");
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/repl.mjs"\n`);
  chmodSync(executable, 0o755);
  const keys = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const alive = () => {
    try {
      process.kill(Number(readFileSync(path.join(root, "pid"), "utf8")), 0);
      return true;
    } catch {
      return false;
    }
  };
  return { root, executable, keys, alive };
}

const ended = async (alive: () => boolean) => {
  for (let attempt = 0; attempt < 100 && alive(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive();
};

// macOS's BSD `script` and util-linux's are the pseudo-terminals AgentKib uses. Each test starts
// Node in one, which a busy machine may take a while to do.
describe.runIf(["darwin", "linux"].includes(process.platform))(
  "reading /usage",
  { timeout: 20_000 },
  () => {
    it("types /usage in Devin's terminal once it is idle, reads the panel and closes it", async () => {
      const devin = fakeRepl("panel");
      const windows = await readDevinUsage(devin.executable, devin.root, { ...process.env });
      expect(windows).toEqual([expect.objectContaining({ label: "Weekly", usedPercent: 66 })]);
      // Enter apart from the text, as a key press; the terminal has a size.
      expect(devin.keys()).toContain('start true 120\nkeys "/usage"\nkeys "\\r"\n');
      expect(await ended(devin.alive)).toBe(true);
    });

    it("reads the final panel when the child exits before stdout drains", async () => {
      const terminal = new childProcesses.ChildProcess();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      Object.assign(terminal, { stdin, stdout });
      const spawn = vi.spyOn(childProcesses, "spawn").mockReturnValue(terminal);
      syncBuiltinESMExports();
      try {
        stdin.on("data", (chunk) => {
          if (chunk.toString("utf8") !== "\r") return;
          terminal.emit("exit", 0, null);
          stdout.end(PANEL);
        });
        stdout.once("end", () => terminal.emit("close", 0, null));
        const read = readDevinUsage("fixture-devin", tmpdir(), {});
        stdout.write("\u001b]7501;state=idle:app=devin\u001b\\");
        await expect(read).resolves.toEqual([
          expect.objectContaining({ label: "Weekly", usedPercent: 66 }),
        ]);
      } finally {
        spawn.mockRestore();
        syncBuiltinESMExports();
      }
    });

    it("never answers a question Devin asks first, such as trusting the folder", async () => {
      const devin = fakeRepl("trust");
      expect(await readDevinUsage(devin.executable, devin.root, { ...process.env })).toBeNull();
      expect(devin.keys()).not.toContain("keys");
      expect(await ended(devin.alive)).toBe(true);
    });

    it("gives up in time when Devin never takes input", async () => {
      const devin = fakeRepl("silent");
      const started = Date.now();
      expect(
        await readDevinUsage(
          devin.executable,
          devin.root,
          { ...process.env },
          { timeoutMs: 1_500 },
        ),
      ).toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(devin.keys()).not.toContain("keys");
      expect(await ended(devin.alive)).toBe(true);
    });

    it("reads nothing when /usage has no data for this login", async () => {
      const devin = fakeRepl("logged-out");
      expect(await readDevinUsage(devin.executable, devin.root, { ...process.env })).toBeNull();
      expect(await ended(devin.alive)).toBe(true);
    });

    it("stops when AgentKib no longer waits for it", async () => {
      const devin = fakeRepl("silent");
      const abort = new AbortController();
      const read = readDevinUsage(
        devin.executable,
        devin.root,
        { ...process.env },
        {
          signal: abort.signal,
        },
      );
      for (let attempt = 0; attempt < 100 && !devin.keys(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      abort.abort();
      expect(await read).toBeNull();
      expect(await ended(devin.alive)).toBe(true);
    });
  },
);
