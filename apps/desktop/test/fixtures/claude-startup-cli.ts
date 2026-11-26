import childProcesses from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeClaude, type FakeClaudePlan } from "./claude-fake-cli";
import { StartupFixtureProcessGroups } from "./claude-startup-process-groups";

const STARTUP_LIFETIME_MS = 60_000;
const startupWatchdog = `
const [cli, owner] = process.argv.slice(2).map(Number);
const override = Number(process.env.STARTUP_LIFETIME_MS);
const lifetime = Number.isSafeInteger(override) && override > 0 && override <= ${STARTUP_LIFETIME_MS}
  ? override : ${STARTUP_LIFETIME_MS};
function stop() {
  // If the shell has already exited, do not signal its possibly reused PID.
  if (process.ppid === cli) {
    try {
      process.kill(cli, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  process.exit(0);
}
function checkOwner() {
  if (process.ppid !== cli) process.exit(0);
  try {
    process.kill(owner, 0);
  } catch (error) {
    if (error.code === "ESRCH") stop();
  }
}
checkOwner();
setInterval(checkOwner, 250);
setTimeout(stop, lifetime);
`;

/** Store the watchdog behind redirected stdio so it cannot mask simulated output EOF. */
function startupClaudeScript(body: string): string {
  return `#!/bin/sh
# The protocol uses shell builtins so starting the watchdog never delays readiness.
[ "$PPID" -gt 1 ] || exit 0
"$STARTUP_NODE" - "$$" "$PPID" <<'AGENTKIB_WATCHDOG' >/dev/null 2>&1 &
${startupWatchdog}
AGENTKIB_WATCHDOG
watchdog=$!
trap 'kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null' EXIT
trap 'exit 143' TERM
${body}`;
}

/** The startup deadline tests need protocol faults, rather than a cold Node interpreter. */
export function createStartupClaude() {
  const f = createFakeClaude("agentkib-claude-startup-");
  const modeFile = path.join(f.root, "startup-mode");
  const evidenceFile = path.join(f.root, "startup-evidence");
  const readyFile = path.join(f.root, "startup-ready");
  const environment = {
    ...f.environment,
    STARTUP_MODE: modeFile,
    STARTUP_EVIDENCE: evidenceFile,
    STARTUP_READY: readyFile,
    STARTUP_NODE: process.execPath,
  };
  writeFileSync(
    f.executable,
    startupClaudeScript(`printf '%s\\n' "$$" > "$STARTUP_READY" || exit 90
while IFS= read -r frame; do
  printf '%s\\n' "$frame" >> "$FAKE_LOG" || exit 90
  IFS= read -r mode < "$STARTUP_MODE" || exit 90
  case "$frame" in
    *'"type":"control_request"'*)
      case "$frame" in *'"subtype":"initialize"'*) ;; *) exit 92 ;; esac
      request_id=\${frame#*'"request_id":"'}
      request_id=\${request_id%%\\"*}
      case "$request_id" in
        ????????-????-????-????-????????????) ;;
        *) exit 91 ;;
      esac
      case "$mode" in
        silent) continue ;;
        bad-frame)
          printf '%s\\n' bad-frame >> "$STARTUP_EVIDENCE"
          printf '%s\\n' 'invalid frame'
          continue ;;
        close-initialize)
          printf '%s\\n' close-initialize >> "$STARTUP_EVIDENCE"
          exec 1>&-
          continue ;;
        exit-initialize) exit 0 ;;
      esac
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"models":[],"commands":[]}}}\\n' "$request_id"
      ;;
    *'"type":"user"'*)
      if [ "$mode" = close-user ]; then
        printf '%s\\n' close-user >> "$STARTUP_EVIDENCE"
        exec 1>&-
        continue
      fi
      user_id=\${frame#*'"uuid":"'}
      user_id=\${user_id%%\\"*}
      printf '{"type":"assistant","parent_tool_use_id":null,"message":{"id":"%s","model":"fixture-model","usage":{"input_tokens":7},"content":[]}}\\n' "$user_id"
      printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":19,"output_tokens":11},"modelUsage":{"fixture-model":{"contextWindow":100}},"terminal_reason":"completed"}'
      ;;
  esac
done
`),
    { mode: 0o700 },
  );
  return {
    ...f,
    environment,
    setPlan(plan: FakeClaudePlan) {
      const before = plan.beforeInitialize ?? [];
      const user = plan.onUser ?? [];
      const first = before[0] as Record<string, unknown> | undefined;
      const onUser = user[0] as Record<string, unknown> | undefined;
      const mode =
        before.length === 1 && plan.silentInitialize && !user.length
          ? first?.__raw === "invalid frame"
            ? "bad-frame"
            : first?.__closeOutput === true
              ? "close-initialize"
              : first?.__exit === true
                ? "exit-initialize"
                : undefined
          : !before.length && !user.length
            ? plan.silentInitialize
              ? "silent"
              : "normal"
            : !before.length && user.length === 1 && onUser?.__closeOutput === true && plan.noResult
              ? "close-user"
              : undefined;
      if (
        !mode ||
        (plan.noResult === true && mode !== "close-user") ||
        (first !== undefined && Object.keys(first).length !== 1) ||
        (onUser !== undefined && Object.keys(onUser).length !== 1) ||
        plan.afterInitialize?.length ||
        Object.keys(plan).some(
          (key) =>
            ![
              "beforeInitialize",
              "onUser",
              "silentInitialize",
              "noResult",
              "afterInitialize",
            ].includes(key),
        )
      )
        throw new Error("unsupported startup fixture plan");
      f.setPlan(plan);
      writeFileSync(modeFile, `${mode}\n`);
      rmSync(readyFile, { force: true });
    },
    evidence: () =>
      existsSync(evidenceFile) ? readFileSync(evidenceFile, "utf8").trim().split("\n") : [],
  };
}

/**
 * Only the synthetic shell's preparation precedes the runner's unchanged protocol deadline.
 * Always return the real child: the runner must retain ownership and perform its own cleanup,
 * even when fixture readiness fails. The caller must assert failures after cleaning its runners.
 */
export function createStartupClaudeSpawn(
  actualSpawn: (
    ...args: Parameters<typeof childProcesses.spawn>
  ) => ReturnType<typeof childProcesses.spawn> = childProcesses.spawn,
  clock = {
    now: () => performance.now(),
    wait: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    },
  },
) {
  const failures: string[] = [];
  const processGroups = new StartupFixtureProcessGroups();
  return {
    failures,
    processGroups,
    spawn(...args: Parameters<typeof childProcesses.spawn>) {
      const options = Array.isArray(args[1]) ? args[2] : (args[1] ?? args[2]);
      const environment = options && "env" in options ? options.env : undefined;
      const mode = environment?.STARTUP_MODE;
      const ready = environment?.STARTUP_READY;
      const root = mode ? path.dirname(mode) : "";
      if (
        !path.isAbsolute(root) ||
        !path.basename(root).startsWith("agentkib-claude-startup-") ||
        mode !== path.join(root, "startup-mode") ||
        environment?.STARTUP_EVIDENCE !== path.join(root, "startup-evidence") ||
        args[0] !== path.join(root, "bin", "claude")
      )
        return actualSpawn(...args);
      const spawnFixture = () => {
        const child = actualSpawn(...args);
        if (
          options &&
          "detached" in options &&
          options.detached &&
          child instanceof childProcesses.ChildProcess &&
          child.pid &&
          process.platform !== "win32"
        ) {
          const pid = child.pid;
          processGroups.track(pid);
          child.once("exit", () => processGroups.forgetIfExited(pid));
        }
        return child;
      };
      // The separate-group test has its own readiness handoff.
      if (ready !== path.join(root, "startup-ready")) return spawnFixture();
      try {
        rmSync(ready, { force: true });
      } catch {
        failures.push("startup fixture readiness could not be reset");
        return spawnFixture();
      }
      const child = spawnFixture();
      if (!child.pid) {
        failures.push("startup fixture has no process identity");
        return child;
      }
      const deadline = clock.now() + 2000;
      for (;;) {
        try {
          if (readFileSync(ready, "utf8").trim() === String(child.pid)) return child;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            failures.push("startup fixture readiness could not be read");
            return child;
          }
        }
        if (clock.now() >= deadline) {
          failures.push("startup fixture readiness timed out");
          return child;
        }
        clock.wait();
      }
    },
  };
}
