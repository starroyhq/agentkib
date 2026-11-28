import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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

type WriterIdentity = { device: bigint; inode: bigint };
export type CodexDesktopWriter = { version?: string };

// Darwin reports flock on the open file description as FHASLOCK. lsof's lower-case
// lock-status column can be blank even when the descriptor owns an exclusive flock.
const DARWIN_FHASLOCK = 0x4000n;

function writerPid(output: string, uid: number, identity: WriterIdentity): number | undefined {
  let pid: number | undefined;
  let user: number | undefined;
  const holders = new Set<number>();
  for (const line of output.split("\0\n")) {
    const fields = line.split("\0");
    if (fields[0]?.startsWith("p")) {
      pid = Number(fields[0].slice(1));
      user = Number(fields.find((field) => field.startsWith("u"))?.slice(1));
    } else if (fields[0]?.startsWith("f")) {
      const flags = fields
        .find((field) => field.startsWith("G"))
        ?.slice(1)
        .split(";")[0];
      const device = fields.find((field) => field.startsWith("D"))?.slice(1);
      const inode = fields.find((field) => field.startsWith("i"))?.slice(1);
      if (
        flags &&
        /^0x[\da-f]+$/i.test(flags) &&
        (BigInt(flags) & DARWIN_FHASLOCK) !== 0n &&
        device &&
        /^0x[\da-f]+$/i.test(device) &&
        BigInt(device) === identity.device &&
        inode &&
        /^\d+$/.test(inode) &&
        BigInt(inode) === identity.inode &&
        pid &&
        Number.isSafeInteger(pid) &&
        pid > 1
      ) {
        if (user !== uid) return undefined;
        holders.add(pid);
      }
    }
  }
  return holders.size === 1 ? holders.values().next().value : undefined;
}

function desktopAncestor(listing: string, writer: number, uid: number): string | undefined {
  const processes = new Map<number, { parent: number; executable: string }>();
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\/.*)$/.exec(line.trimEnd());
    if (row && Number(row[3]) === uid)
      processes.set(Number(row[1]), { parent: Number(row[2]), executable: row[4]! });
  }
  const executables: string[] = [];
  for (let pid = writer; executables.length < 16;) {
    const current = processes.get(pid);
    if (!current) return;
    const { executable, parent } = current;
    if (MAIN_PROCESS.some((marker) => executable.endsWith(marker))) {
      const contents = dirname(dirname(executable)) + "/";
      // An external shell/CLI somewhere below an App is not that App's bundled writer.
      return executables.every((child) => child.startsWith(contents)) ? executable : undefined;
    }
    executables.push(executable);
    pid = parent;
  }
}

function fileIdentity(lock: string): WriterIdentity | undefined {
  const stat = lstatSync(lock, { bigint: true });
  return stat.isFile() ? { device: stat.dev, inode: stat.ino } : undefined;
}

export class CodexDesktopApp {
  #commands = new Commands();
  #running?: { at: number; processes: Promise<string[]> };

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

  /** Observe the actual holder of this thread's lock inside the verified Codex home. */
  async writerOwner(lock: string): Promise<CodexDesktopWriter | undefined> {
    if (!CodexDesktopApp.supported() || !isAbsolute(lock) || !process.getuid) return undefined;
    const uid = process.getuid();
    try {
      const identity = fileIdentity(lock);
      if (!identity) return undefined;
      const holder = () =>
        this.#read("/usr/sbin/lsof", [
          "-nP",
          "-a",
          "-u",
          String(uid),
          "-F0pufGiD",
          "--",
          lock,
        ]).then((listing) =>
          listing === undefined ? undefined : writerPid(listing, uid, identity),
        );
      const pid = await holder();
      if (!pid) return undefined;
      const processes = await this.#read(
        "/bin/ps",
        ["-ww", "-U", String(uid), "-o", "pid=,ppid=,uid=,comm="],
        1024 * 1024,
      );
      const executable = processes === undefined ? undefined : desktopAncestor(processes, pid, uid);
      if (!executable) return undefined;
      const plist = join(dirname(dirname(executable)), "Info.plist");
      const bundle = await this.#read("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleIdentifier",
        plist,
      ]);
      if (
        bundle?.trim() !== "com.openai.codex" &&
        !(bundle?.trim() === "com.openai.chat" && executable.endsWith(MAIN_PROCESS[0]!))
      )
        return undefined;
      const version = (
        await this.#read("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          plist,
        ]).catch(() => undefined)
      )?.trim();
      const currentHolder = await holder();
      const currentFile = fileIdentity(lock);
      if (
        currentHolder !== pid ||
        currentFile?.device !== identity.device ||
        currentFile.inode !== identity.inode
      )
        return undefined;
      return version && /^\d{1,9}(\.\d{1,9}){2}$/.test(version) ? { version } : {};
    } catch {
      return undefined;
    }
  }

  async #read(program: string, args: string[], limit = 16_384): Promise<string | undefined> {
    const result = await this.#commands.run(program, args, {
      env: this.environment,
      timeout: 2_000,
      limit,
      allowFailure: true,
    });
    return result.success && !result.truncated ? result.bytes.toString("utf8") : undefined;
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
