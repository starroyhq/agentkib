import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { plainTerminalText } from "./conversation-tools";
import type { UsageLimitHit, UsageLimitKind } from "./usage-limit";

/**
 * When a Devin usage limit resets, as Devin itself shows it. `devin -p` names no reset time, and
 * the account's reset times reach only the interactive CLI's `/usage` (3000.12.59), which reads
 * them with the CLI's own login. So AgentKib starts the interactive `devin` once in a
 * pseudo-terminal, as the person would in a terminal, types `/usage`, reads the panel and closes
 * the terminal again.
 * AgentKib never reads Devin's login itself, and never answers a question Devin asks instead,
 * such as whether to trust the folder.
 *
 * The repository has no pseudo-terminal library, so `script(1)` provides one: macOS's BSD
 * `script` and util-linux's on Linux. Elsewhere, or when anything does not go as below, there is
 * no reset time and the session only says that the limit was met.
 */

/** How long reading `/usage` may take in all, starting Devin included (about 5 s in practice). */
export const DEVIN_USAGE_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 256 * 1024;
// The REPL marks the terminal idle once it takes input (OSC 7501, seen with 3000.12.59).
const READY = "\u001b]7501;state=idle";
// Devin asks before it runs in a folder it does not trust; AgentKib never answers it.
const TRUST_PROMPT = /trust the authors of this directory/i;
// What `/usage` says instead of its panel: no login, no data, or no answer from the service.
const USAGE_FAILED = /Not logged in\.|No quota data available\.|Timed out fetching account usage\./;
// Typed text arrives as one burst; Enter apart from it is a key press, not part of a paste.
const KEY_GAP_MS = 400;
// Windows printed together reach the terminal together; this waits for a straggling line.
const SETTLE_MS = 300;
const EXIT_GRACE_MS = 2_000;
const DAY_MS = 24 * 60 * 60_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A usage window `/usage` lists: "Weekly ■■■■ 66% used · resets Nov 22, 4:00 PM (UTC+8)". */
export interface DevinUsageWindow {
  /** Devin's own name for it, such as "Weekly" or "Daily". */
  label: string;
  usedPercent: number;
  /** ms since the epoch. */
  resetsAt: number;
}

// Devin formats the time as `%b %-d, %-I:%M %p` and adds its UTC offset in parentheses.
const RESET =
  /resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*([AP]M)(?:\s*\(\s*(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?\s*\))?/i;
const USED = /(\d{1,3}(?:\.\d+)?)%\s*used/i;

/**
 * The text a terminal shows. A terminal that adds a carriage return to each line feed shows
 * "\r\r\n" as one line end, not as a line written over.
 */
const screenText = (output: string) => plainTerminalText(output.replace(/\r+\n/g, "\n"));

/**
 * The time a reset line names. The year is not printed: it is the first one that puts the time
 * no more than two days back (a reset is ahead, or has just passed). Without an offset the time
 * is this computer's local time.
 */
function resetTime(match: RegExpExecArray, now: number): number | null {
  const [, monthName, dayText, hourText, minuteText, meridiem, sign, offsetHours, offsetMinutes] =
    match;
  const month = MONTHS.indexOf(monthName!.toLowerCase());
  const day = Number(dayText);
  const hour12 = Number(hourText);
  const minute = Number(minuteText);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem!.toUpperCase() === "PM" ? 12 : 0);
  const offset =
    sign === undefined
      ? match[0].match(/\((?:UTC|GMT)\s*\)/i)
        ? 0
        : null
      : (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0));
  const year = new Date(now).getUTCFullYear();
  for (const candidate of [year - 1, year, year + 1]) {
    let at: number;
    if (offset === null) {
      const local = new Date(candidate, month, day, hour, minute);
      if (local.getMonth() !== month || local.getDate() !== day) return null;
      at = local.getTime();
    } else {
      const utc = new Date(Date.UTC(candidate, month, day, hour, minute));
      if (utc.getUTCMonth() !== month || utc.getUTCDate() !== day) return null;
      at = utc.getTime() - offset * 60_000;
    }
    if (at >= now - 2 * DAY_MS) return at - now > 400 * DAY_MS ? null : at;
  }
  return null;
}

/** The windows in what `/usage` printed; none when it printed no panel. */
export function devinUsageWindows(output: string, now = Date.now()): DevinUsageWindow[] {
  const windows: DevinUsageWindow[] = [];
  for (const line of screenText(output).split("\n")) {
    const used = USED.exec(line);
    const reset = RESET.exec(line);
    if (!used || !reset || reset.index < used.index) continue;
    const resetsAt = resetTime(reset, now);
    // The name is what comes before the bar: letters and the spaces between them.
    const label = line
      .slice(0, used.index)
      .replace(/[^\p{L} ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (resetsAt === null || !label || label.length > 40) continue;
    windows.push({ label, usedPercent: Number(used[1]), resetsAt });
  }
  return windows;
}

/**
 * When the limit a turn met resets: the window Devin's message names ("daily", "weekly"), or else
 * the used-up window that resets last, as for Codex. Null when the panel does not tell.
 */
export function devinLimitReset(
  windows: readonly DevinUsageWindow[],
  hit: UsageLimitHit,
): { resetsAt: number; kind: UsageLimitKind | null } | null {
  const named = /\bdaily\b/i.test(hit.message)
    ? /\bdaily\b|\bday\b/i
    : /\bweekly\b/i.test(hit.message)
      ? /\bweekly\b|\bweek\b/i
      : null;
  const window = named
    ? windows.find((item) => named.test(item.label))
    : windows
        .filter((item) => item.usedPercent >= 100)
        .sort((left, right) => right.resetsAt - left.resetsAt)[0];
  if (!window) return null;
  return {
    resetsAt: window.resetsAt,
    kind: /\bweek/i.test(window.label) ? "weekly" : hit.kind,
  };
}

/** The pseudo-terminal for `executable`, or null where AgentKib has none. */
function pseudoTerminal(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): ChildProcess | null {
  if (!existsSync("/usr/bin/script")) return null;
  // The REPL lays itself out for the terminal's size; a new one has none.
  const size = "stty cols 120 rows 40 2>/dev/null";
  // `cat` hands the keys to `script` through a pipe: BSD `script` refuses the socket Node gives a
  // child. Once AgentKib closes its input, or goes away, `cat` ends the whole group: `script`
  // exits and Devin's terminal hangs up, as when a terminal window is closed.
  const keys = "(cat; kill -TERM 0 2>/dev/null) | exec /usr/bin/script";
  const options = {
    cwd,
    env: { ...environment, TERM: "xterm-256color", AGENTKIB_DEVIN_CLI: executable },
    stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"],
    // Its own process group, which `kill 0` and AgentKib end together.
    detached: true,
    windowsHide: true,
  };
  // The executable's path is passed in the environment, never written into a command line.
  if (process.platform === "darwin")
    return spawn(
      "/bin/sh",
      ["-c", `${keys} -q /dev/null /bin/sh -c '${size}; exec "$AGENTKIB_DEVIN_CLI"'`],
      options,
    );
  if (process.platform === "linux")
    // util-linux runs the command with $SHELL; /bin/sh reads it as written here.
    return spawn(
      "/bin/sh",
      ["-c", `${keys} -q -e -c '${size}; exec "$AGENTKIB_DEVIN_CLI"' /dev/null`],
      { ...options, env: { ...options.env, SHELL: "/bin/sh" } },
    );
  return null;
}

/**
 * Runs Devin's `/usage` once and returns the windows its panel lists; null when that could not
 * be done in `timeoutMs`, Devin asked something first, the panel says it has no data, or
 * `signal` aborted it.
 */
export function readDevinUsage(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  { timeoutMs = DEVIN_USAGE_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DevinUsageWindow[] | null> {
  if (signal?.aborted) return Promise.resolve(null);
  let child: ChildProcess | null;
  try {
    child = pseudoTerminal(executable, cwd, environment);
  } catch {
    return Promise.resolve(null);
  }
  if (!child) return Promise.resolve(null);
  const terminal = child;
  return new Promise((resolve) => {
    // What Devin shows before `/usage` is typed (only its start is read), and what follows Enter.
    let screen = "";
    let answer: string | null = null;
    let typed = false;
    let settling = false;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      timers.push(timer);
    };
    // The whole group, `script` included, which can outlive the shell that started it.
    const kill = (name: NodeJS.Signals) => {
      try {
        if (terminal.pid) process.kill(-terminal.pid, name);
      } catch {
        // Already gone.
      }
    };
    const panel = (): DevinUsageWindow[] | null => {
      if (answer === null || USAGE_FAILED.test(screenText(answer))) return null;
      const windows = devinUsageWindows(answer);
      return windows.length ? windows : null;
    };
    const finish = (windows: DevinUsageWindow[] | null, now = false) => {
      if (finished) return;
      finished = true;
      for (const timer of timers.splice(0)) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(windows);
      try {
        terminal.stdin?.end();
      } catch {
        // Already closed.
      }
      if (now) kill("SIGKILL");
      else later(EXIT_GRACE_MS, () => kill("SIGKILL"));
    };
    const abort = () => finish(null, true);
    signal?.addEventListener("abort", abort, { once: true });
    terminal.stdin?.on("error", () => undefined);
    terminal.once("error", () => finish(null, true));
    terminal.once("exit", () => finish(panel()));
    terminal.stdout?.on("data", (chunk: Buffer) => {
      if (finished) return;
      const text = chunk.toString("utf8");
      if (!typed) {
        screen = (screen + text).slice(-OUTPUT_LIMIT);
        if (TRUST_PROMPT.test(screenText(screen))) return finish(null, true);
        if (!screen.includes(READY)) return;
        typed = true;
        terminal.stdin?.write("/usage");
        later(KEY_GAP_MS, () => {
          // What the REPL showed meanwhile is its list of commands, not the panel.
          answer = "";
          terminal.stdin?.write("\r");
        });
        return;
      }
      if (answer === null) return;
      answer += text;
      if (answer.length > OUTPUT_LIMIT || USAGE_FAILED.test(screenText(answer)))
        return finish(panel());
      if (settling || !panel()) return;
      settling = true;
      later(SETTLE_MS, () => finish(panel()));
    });
    // The panel may have come just now; otherwise there is nothing to read.
    later(timeoutMs, () => finish(panel(), true));
  });
}
