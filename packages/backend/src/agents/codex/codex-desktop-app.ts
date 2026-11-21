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
  return listing
    .split("\n")
    .some((line) => MAIN_PROCESS.some((marker) => line.trimEnd().endsWith(marker)));
}

export class CodexDesktopApp {
  #commands = new Commands();
  #running?: { at: number; value: Promise<boolean> };

  constructor(readonly environment: NodeJS.ProcessEnv) {}

  static supported(): boolean {
    return process.platform === "darwin";
  }

  close(): void {
    this.#commands.close();
  }

  /** Whether the desktop app runs now; false when that cannot be told. Never starts it. */
  running(): Promise<boolean> {
    if (!CodexDesktopApp.supported()) return Promise.resolve(false);
    const cached = this.#running;
    if (cached && Date.now() - cached.at < RUNNING_TTL_MS) return cached.value;
    const value = this.#commands
      .run("/bin/ps", ["-axo", "comm="], {
        env: this.environment,
        timeout: 3_000,
        limit: 1024 * 1024,
        allowFailure: true,
      })
      .then(
        (output) =>
          output.success && !output.truncated && codexDesktopListed(output.bytes.toString("utf8")),
        () => false,
      );
    this.#running = { at: Date.now(), value };
    return value;
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
