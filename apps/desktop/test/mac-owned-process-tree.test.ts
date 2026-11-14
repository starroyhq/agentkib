// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { MacOwnedProcessTree } from "../../../packages/backend/src/mac-owned-process-tree";

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/** The root's direct children as `ps` shows them: PID and state ("Z" for one not yet reaped). */
function childrenOf(pid: number): Array<{ pid: number; state: string }> {
  const { stdout } = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat="], { encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, parent]) => Number(parent) === pid)
    .map(([child, , state]) => ({ pid: Number(child), state: state ?? "" }));
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shell(script: string): ChildProcess {
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  started.push(child);
  return child;
}

describe.skipIf(process.platform !== "darwin")("owned process tree on macOS", () => {
  it("ends a root whose child has exited without being reaped", async () => {
    // The shell starts a short-lived child and becomes `sleep`, which never waits for it: the
    // child ends up exited but not reaped. Claude Code is in this state for a moment after each
    // `git` it runs at startup.
    const root = shell("/bin/sleep 0.2 & exec /bin/sleep 30");
    const tree = MacOwnedProcessTree.attach(root);
    await until(() => childrenOf(root.pid!).some((child) => child.state.startsWith("Z")));
    await tree.terminate(root);
    expect(root.signalCode).toBe("SIGKILL");
  });

  it("ends the children still running, next to one that has exited", async () => {
    const root = shell("/bin/sleep 0.2 & /bin/sleep 31 & exec /bin/sleep 30");
    const tree = MacOwnedProcessTree.attach(root);
    await until(() => {
      const children = childrenOf(root.pid!);
      return (
        children.some((child) => child.state.startsWith("Z")) &&
        children.some((child) => !child.state.startsWith("Z"))
      );
    });
    const live = childrenOf(root.pid!).filter((child) => !child.state.startsWith("Z"));
    expect(live).toHaveLength(1);
    await tree.terminate(root);
    expect(root.signalCode).toBe("SIGKILL");
    await until(() => !running(live[0]!.pid));
  });
});
