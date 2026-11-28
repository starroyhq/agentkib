import { dirname, join } from "node:path";
import { Commands } from "../../commands";

/**
 * The Codex desktop app on macOS, shipped inside ChatGPT.app or as a standalone Codex.app. Its
 * main process owns the app-server that holds a thread's writer lock, and it registers the
 * `codex://` URL scheme: opening `codex://threads/<id>` makes the running app show the thread,
 * resume it and answer IPC owner discovery for it (ChatGPT.app 26.1007 answered within 0.1 s).
 *
 * After a page stops showing a thread, the app keeps it loaded, and its writer lock held, for
 * hours with no window answering for it; that is when AgentKib asks the app to show it again.
 */
const MAIN_PROCESS = ["/ChatGPT.app/Contents/MacOS/ChatGPT", "/Codex.app/Contents/MacOS/Codex"];
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNNING_TTL_MS = 3_000;

/** `codex://threads/<id>` for a Codex thread UUID. */
export function codexThreadLink(threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error("not a Codex thread id");
  return `codex://threads/${threadId.toLowerCase()}`;
}

/** Whether a `ps -axo comm=` listing names the desktop app's main process. */
export function codexDesktopListed(listing: string): boolean {
  return codexDesktopProcesses(listing).length > 0;
}

function codexDesktopProcesses(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => MAIN_PROCESS.some((marker) => line.endsWith(marker)));
}

export class CodexDesktopApp {
  #commands = new Commands();
  #running?: { at: number; processes: Promise<string[]>; version?: Promise<string | undefined> };

  constructor(readonly environment: NodeJS.ProcessEnv) {}

  static supported(): boolean {
    return process.platform === "darwin";
  }

  close(): void {
    this.#commands.close();
  }

  /** Whether the desktop app runs now; false when that cannot be told. Never starts it. */
  running(): Promise<boolean> {
    return CodexDesktopApp.supported()
      ? this.#observeRunning().processes.then((processes) => processes.length > 0)
      : Promise.resolve(false);
  }

  /** Diagnostic metadata only. The IPC peer must still identify itself on connection. */
  version(): Promise<string | undefined> {
    if (!CodexDesktopApp.supported()) return Promise.resolve(undefined);
    const observed = this.#observeRunning();
    return (observed.version ??= observed.processes
      .then(async ([executable, other]) => {
        if (!executable?.startsWith("/") || other) return undefined;
        const output = await this.#commands.run(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :CFBundleIdentifier",
            "-c",
            "Print :CFBundleShortVersionString",
            join(dirname(dirname(executable)), "Info.plist"),
          ],
          { env: this.environment, timeout: 2_000, limit: 1024, allowFailure: true },
        );
        if (!output.success || output.truncated) return undefined;
        const [bundle, version] = output.bytes.toString("utf8").trim().split("\n");
        if (bundle === "com.openai.codex" && version && /^\d{1,9}(\.\d{1,9}){2}$/.test(version))
          return version;
      })
      .catch(() => undefined));
  }

  #observeRunning() {
    const cached = this.#running;
    if (cached && Date.now() - cached.at < RUNNING_TTL_MS) return cached;
    const processes = this.#commands
      .run("/bin/ps", ["-axo", "comm="], {
        env: this.environment,
        timeout: 3_000,
        limit: 1024 * 1024,
        allowFailure: true,
      })
      .then(
        (output) =>
          output.success && !output.truncated
            ? codexDesktopProcesses(output.bytes.toString("utf8"))
            : [],
        () => [],
      );
    return (this.#running = { at: Date.now(), processes });
  }

  /**
   * Asks the running app to show the thread, in the background without taking focus. Opening
   * the link would also launch an app that is not running, so callers check `running()` first.
   */
  async openThread(threadId: string): Promise<boolean> {
    if (!CodexDesktopApp.supported()) return false;
    const link = codexThreadLink(threadId);
    try {
      const output = await this.#commands.run("/usr/bin/open", ["-g", link], {
        env: this.environment,
        timeout: 5_000,
        limit: 16 * 1024,
        allowFailure: true,
      });
      return output.success;
    } catch {
      return false;
    }
  }
}
