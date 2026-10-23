import childProcesses from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeClaude, type FakeClaudePlan } from "./claude-fake-cli";

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
  };
  writeFileSync(
    f.executable,
    `#!/bin/sh
# Deliberately only shell builtins: no child interpreter competes with the 300 ms deadline.
printf '%s\\n' "$$" > "$STARTUP_READY"
while IFS= read -r frame; do
  printf '%s\\n' "$frame" >> "$FAKE_LOG"
  IFS= read -r mode < "$STARTUP_MODE"
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
`,
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
  return {
    failures,
    spawn(...args: Parameters<typeof childProcesses.spawn>) {
      const options = Array.isArray(args[1]) ? args[2] : (args[1] ?? args[2]);
      const environment = options && "env" in options ? options.env : undefined;
      const ready = environment?.STARTUP_READY;
      const root = ready ? path.dirname(ready) : "";
      if (
        !ready ||
        !path.isAbsolute(ready) ||
        path.basename(root).indexOf("agentkib-claude-startup-") !== 0 ||
        ready !== path.join(root, "startup-ready") ||
        environment?.STARTUP_MODE !== path.join(root, "startup-mode") ||
        environment.STARTUP_EVIDENCE !== path.join(root, "startup-evidence") ||
        args[0] !== path.join(root, "bin", "claude")
      )
        return actualSpawn(...args);
      try {
        rmSync(ready, { force: true });
      } catch {
        failures.push("startup fixture readiness could not be reset");
        return actualSpawn(...args);
      }
      const child = actualSpawn(...args);
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
