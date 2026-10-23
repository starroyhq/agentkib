// Persistent REPL helper for the owned offline Electron sandbox, never production IPC replacement.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const exec = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createE2Ui(chromium, root, output) {
  assert.match(root, /^\/private\/tmp\/agentkib-v15-e2-[a-z0-9-]+$/);
  const state = { root, output, errors: [] };
  const ownedPids = async () => {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,command="]);
    return stdout
      .split("\n")
      .filter((line) => line.includes("Electron.app/Contents/") && line.includes(`${root}/`))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]));
  };
  const sanitize = (value) =>
    JSON.parse(
      JSON.stringify(value).replaceAll(`${root}/home`, "~").replaceAll(root, "<owned-sandbox>"),
    );
  const checkPrivacy = (value) =>
    assert.doesNotMatch(value, /\/Users\/|\/private\/tmp\/|192\.168\.|10\.0\.\d+\./);
  return {
    state,
    async launch() {
      assert.deepEqual(await ownedPids(), [], "Close the previous owned app before launching");
      const config = JSON.parse(await fs.readFile(path.join(root, "fixture-private.json"), "utf8"));
      const launch = JSON.parse(await fs.readFile(path.join(root, "launch-private.json"), "utf8"));
      assert.equal(config.owner, "agentkib-v15-e2-sandbox");
      assert.equal(config.root, root);
      assert.equal(launch.cwd, path.join(root, "home"));
      let diagnostics = "";
      state.child = spawn(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      state.child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-6000);
      });
      await fs.writeFile(
        path.join(root, "ui-owned-pid.json"),
        JSON.stringify({ pid: state.child.pid }),
        { mode: 0o600 },
      );
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        assert.equal(state.child.exitCode, null, `Owned Electron exited: ${diagnostics}`);
        try {
          const response = await fetch(`${launch.cdp}/json/version`);
          if (response.ok) break;
        } catch {}
        await wait(80);
      }
      state.browser = await chromium.connectOverCDP(launch.cdp);
      state.context = state.browser.contexts()[0];
      while (Date.now() < deadline) {
        assert.equal(state.child.exitCode, null, `Owned Electron exited: ${diagnostics}`);
        state.page = state.context.pages().find((page) => page.url().startsWith("app:"));
        if (state.page) break;
        await wait(80);
      }
      assert.ok(state.page, "Owned Electron did not open its application page");
      state.page.setDefaultTimeout(5000);
      state.page.on("pageerror", (error) => state.errors.push(error.message));
      await state.page.getByText("northstar-api", { exact: true }).first().waitFor();
      state.workspaceId = config.workspaces.find(
        (workspace) => workspace.name === "northstar-api",
      ).id;
      return state.page;
    },
    async capture(name) {
      assert.match(name, /^[A-Za-z0-9-]+$/);
      checkPrivacy(await state.page.locator("body").innerText());
      await fs.mkdir(output, { recursive: true });
      await state.page.screenshot({ path: path.join(output, `${name}.png`), scale: "css" });
      return state.page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
      }));
    },
    async diagnosis(name) {
      const report = await state.page.evaluate(
        (id) => window.agentkibDesktop.workspace.doctorReport(id),
        state.workspaceId,
      );
      const evidence = sanitize({
        summary: report.summary,
        issues: report.issues
          .filter((issue) => issue.severity !== "info")
          .map(({ code, severity, agent, evidence }) => ({ code, severity, agent, evidence })),
      });
      checkPrivacy(JSON.stringify(evidence));
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify(evidence, null, 2));
      return evidence;
    },
    async close() {
      if (state.browser?.isConnected()) {
        await state.page.evaluate(() => window.agentkibDesktop.shell.quit()).catch(() => undefined);
        for (let attempt = 0; attempt < 30 && (await ownedPids()).length > 0; attempt += 1)
          await wait(100);
      }
      const remaining = await ownedPids();
      for (const pid of remaining) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      for (let attempt = 0; attempt < 20 && (await ownedPids()).length > 0; attempt += 1)
        await wait(100);
      assert.deepEqual(await ownedPids(), [], "Owned Electron processes remain");
      return { closed: true, forcedOwnedProcessCount: remaining.length };
    },
  };
}

module.exports = { createE2Ui };
