// Extends the existing real Electron QA session with precise owned process-tree cleanup.
// No production handlers, requests, response objects or UI state are replaced.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { createE2Ui } = require("./v15-e2-ui.cjs");
const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash("sha256").update(value).digest("hex");

function createE2FinalizeUi(chromium, root, output) {
  assert.match(root, /^\/private\/tmp\/agentkib-v15-e2-finalize-[a-z0-9-]+$/);
  const session = createE2Ui(chromium, root, output);
  const identities = new Map();
  async function command(pid) {
    try {
      const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "command="]);
      return stdout.trim();
    } catch (error) {
      if (error.code === 1) return null;
      throw error;
    }
  }
  async function remember() {
    const rootPid = session.state.child?.pid;
    if (!rootPid) return;
    // Read only numeric identities globally. Command strings are read only for descendants
    // of the exact process launched by this session; never inspect unrelated app commands.
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows)
        if (owned.has(ppid) && !owned.has(pid)) {
          owned.add(pid);
          changed = true;
        }
    }
    for (const pid of owned) {
      if (identities.has(pid)) continue;
      const current = await command(pid);
      if (current) identities.set(pid, digest(current));
    }
  }
  async function remaining() {
    const owned = [];
    for (const [pid, identity] of identities) {
      const current = await command(pid);
      if (current && digest(current) === identity) owned.push(pid);
    }
    return owned;
  }
  return {
    state: session.state,
    async launch() {
      const page = await session.launch();
      await remember();
      return page;
    },
    async capture(name) {
      await remember();
      const text = [
        await session.state.page.locator("body").innerText(),
        await session.state.page
          .locator('input:visible:not([type="password"]), textarea:visible')
          .evaluateAll((nodes) => nodes.map((node) => node.value).join("\n")),
      ].join("\n");
      // Throw only a generic reason: assertion diagnostics would echo the matched input.
      if (/\/Users\/|\/private\/tmp\/agentkib-/.test(text))
        throw new Error("Replace local paths with synthetic display values before capture");
      if (
        /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/.test(
          text,
        )
      )
        throw new Error("Do not capture private network addresses");
      return session.capture(name);
    },
    async diagnosis(name) {
      await remember();
      return session.diagnosis(name);
    },
    async close() {
      await remember();
      const original = await session.close();
      const leftover = await remaining();
      for (const pid of leftover) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      for (let index = 0; index < 30 && (await remaining()).length; index++) await wait(100);
      const stillOwned = await remaining();
      assert.deepEqual(stillOwned, [], "Owned Electron/backend descendants remain");
      return {
        ...original,
        checked_at: new Date().toISOString(),
        recorded_process_count: identities.size,
        additionally_terminated_descendants: leftover.length,
        remaining_owned_pids: stillOwned,
        tmux_sessions_created: 0,
      };
    },
  };
}
module.exports = { createE2FinalizeUi };
