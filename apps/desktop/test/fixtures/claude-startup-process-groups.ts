import { setTimeout as delay } from "node:timers/promises";

function signalGroup(pid: number, signal: 0 | "SIGKILL") {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") return false;
    // Darwin can report EPERM during the interval between exit and reap.
    if (code === "EPERM") return true;
    throw error;
  }
}

/** Only groups created by a detached spawn or by the fixture's job-control shell. */
export class StartupFixtureProcessGroups {
  readonly #groups = new Set<number>();

  track(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture process group");
    this.#groups.add(pid);
  }

  isRunning(pid: number) {
    return signalGroup(pid, 0);
  }

  forgetIfExited(pid: number) {
    if (!this.isRunning(pid)) this.#groups.delete(pid);
  }

  async cleanup() {
    const errors: unknown[] = [];
    for (const pid of this.#groups) {
      try {
        if (!signalGroup(pid, "SIGKILL")) this.#groups.delete(pid);
      } catch (error) {
        errors.push(error);
      }
    }
    const deadline = performance.now() + 2_000;
    while (this.#groups.size && !errors.length) {
      for (const pid of this.#groups) this.forgetIfExited(pid);
      if (!this.#groups.size || performance.now() >= deadline) break;
      await delay(20);
    }
    if (this.#groups.size)
      throw new AggregateError(
        errors,
        `Startup fixture groups still present: ${[...this.#groups]}`,
      );
  }
}
