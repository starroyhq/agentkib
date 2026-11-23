import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { versionAtLeast } from "../../native-version";

export type DevinCliSelection = { executable: string; mode: "acp" | "print" };

const ACP_LOGIN_MINIMUM = "3000.14.0";
const UNKNOWN_RETRY_MS = 5_000;
const VERSION_LINE =
  /^(?:devin(?:[ -]cli)?\s+(?:version\s+)?)?v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?(?:\s+\(devin(?: cli)?\))?$/i;

function executableIdentity(executable: string): string | undefined {
  try {
    const file = realpathSync.native(executable);
    const info = statSync(file, { bigint: true });
    if (info.isFile())
      return `${file}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    // A missing file cannot share the version result of an earlier build.
  }
}

function versionMode(output: string): DevinCliSelection["mode"] | undefined {
  for (const line of output.split(/\r?\n/)) {
    const version = VERSION_LINE.exec(line.trim())?.[1];
    if (version && versionAtLeast(version, "0.0.0"))
      return versionAtLeast(version, ACP_LOGIN_MINIMUM) ? "acp" : "print";
  }
}

function probe(executable: string, environment: NodeJS.ProcessEnv) {
  return new Promise<DevinCliSelection["mode"] | undefined>((resolve) =>
    execFile(
      executable,
      ["--version"],
      {
        env: environment,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve(error ? undefined : (versionMode(stdout) ?? versionMode(stderr))),
    ),
  );
}

type VersionCache = {
  identity: string;
  retryAt: number;
  mode?: DevinCliSelection["mode"];
  result: Promise<DevinCliSelection["mode"]>;
};

/** Selects a transport before any session command or prompt is sent. */
export class DevinCliRuntime {
  #cached?: VersionCache;

  modeFor(executable: string): DevinCliSelection["mode"] | undefined {
    const current = this.#cached;
    if (
      current &&
      Date.now() < current.retryAt &&
      current.identity === executableIdentity(executable)
    )
      return current.mode;
  }

  async select(executable: string, environment: NodeJS.ProcessEnv): Promise<DevinCliSelection> {
    const identity = executableIdentity(executable);
    if (!identity) {
      this.#cached = undefined;
      return { executable, mode: "acp" };
    }
    const current = this.#cached;
    if (current?.identity === identity && Date.now() < current.retryAt)
      return { executable, mode: await current.result };

    const entry: VersionCache = {
      identity,
      retryAt: Infinity,
      result: probe(executable, environment)
        .catch(() => undefined)
        .then((mode) => {
          // Keep the current ACP behavior for builds whose version we cannot identify.
          if (!mode) entry.retryAt = Date.now() + UNKNOWN_RETRY_MS;
          entry.mode = mode ?? "acp";
          return entry.mode;
        }),
    };
    this.#cached = entry;
    return { executable, mode: await entry.result };
  }
}
