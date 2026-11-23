import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import { windowsProcessTree, type NativeProcessTree } from "../../native-process";

const OUTPUT_LIMIT = 64 * 1024;
const STOP_TERM_MS = 1_500;
const STOP_KILL_MS = 5_000;
const PIPE_DRAIN_MS = 500;

interface DevinPrintOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  errors: string;
}

export interface DevinPrintTurn {
  readonly pid: number | undefined;
  readonly outcome: Promise<DevinPrintOutcome>;
  stop(): void;
  close(): void;
}

function removePrompt(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
}

/** Launch the legacy CLI with the same arguments as v0.32.0. The prompt stays off argv. */
export async function startDevinPrintTurn({
  executable,
  cwd,
  environment,
  nativeId,
  text,
  model,
  permissionMode,
  beforeDispatch,
}: {
  executable: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  nativeId: string | null;
  text: string;
  model?: string;
  permissionMode?: string;
  beforeDispatch(): void;
}): Promise<DevinPrintTurn> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-devin-"));
  const promptFile = path.join(directory, "prompt.md");
  const args = [
    "-p",
    "--prompt-file",
    promptFile,
    ...(nativeId ? ["-r", nativeId] : []),
    ...(model ? ["--model", model] : []),
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
  ];
  let child: ChildProcess;
  try {
    await writeFile(promptFile, text, { mode: 0o600 });
    beforeDispatch();
    child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    await removePrompt(directory);
    throw error;
  }
  return supervisePrintTurn(child, directory);
}

function supervisePrintTurn(child: ChildProcess, directory: string): DevinPrintTurn {
  const windows = process.platform === "win32";
  let tree: NativeProcessTree | undefined;
  if (windows && child.pid) {
    try {
      tree = windowsProcessTree(child.pid);
    } catch {
      // Some Windows hosts disallow assigning a child to a new Job Object.
    }
  }
  let output = "";
  let errors = "";
  child.stdout?.setEncoding("utf8").on("data", (text: string) => {
    output = (output + text).slice(-OUTPUT_LIMIT);
  });
  child.stderr?.setEncoding("utf8").on("data", (text: string) => {
    output = (output + text).slice(-OUTPUT_LIMIT);
    errors = (errors + text).slice(-OUTPUT_LIMIT);
  });

  let exited = false;
  let finished = false;
  let stopping = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (windows) child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // The group may have exited before the signal arrived.
    }
  };
  const outcome = new Promise<DevinPrintOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      tree?.close();
      child.stdout?.destroy();
      child.stderr?.destroy();
      void removePrompt(directory).then(() => resolve({ code, signal, output, errors }));
    };
    child.once("exit", (code, exitSignal) => {
      exited = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (windows) tree?.close();
      else signal("SIGKILL");
      // Drain buffered output, with a bound if an escaped descendant still holds a pipe.
      drainTimer = setTimeout(() => finish(code, exitSignal), PIPE_DRAIN_MS);
    });
    child.once("close", finish);
    child.on("error", () => {
      if (!child.pid) finish(-1, null);
    });
  });
  return {
    pid: child.pid,
    outcome,
    stop() {
      if (exited || finished || stopping) return;
      stopping = true;
      if (windows) signal("SIGTERM");
      else {
        signal("SIGINT");
        // The older CLI has been observed ignoring SIGINT in print mode.
        termTimer = setTimeout(() => signal("SIGTERM"), STOP_TERM_MS).unref();
      }
      killTimer = setTimeout(() => signal("SIGKILL"), STOP_KILL_MS).unref();
    },
    close() {
      if (exited || finished) return;
      stopping = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), STOP_KILL_MS).unref();
    },
  };
}
