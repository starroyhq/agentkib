// @vitest-environment node
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DshManagedRuntime,
  dshEnvironment,
  dshHome,
  findDshLauncher,
} from "../../../packages/backend/src/dsh-managed-runtime";
import {
  DSH_BRIDGE_COMPATIBILITY,
  dshBridgeLaunchable,
} from "../../../packages/dsh-bridge-plugin/compatibility.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-dsh-managed-")));
  roots.push(root);
  return root;
}

function executable(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
}

/** A child process that exits when told to, or never, as a stuck DSH would. */
function fakeChild(pid: number, { exitOn = "SIGTERM" as NodeJS.Signals | null } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    signals: string[];
    kill(signal: NodeJS.Signals): boolean;
  };
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === exitOn || signal === "SIGKILL")
      setImmediate(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

function runtime(
  root: string,
  {
    version = "0.2.2-rc.1",
    child = fakeChild(4242),
    env = {},
  }: {
    version?: string | null;
    child?: ReturnType<typeof fakeChild>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const launcher = executable(path.join(root, "bin", "dsh"));
  const spawned: { file: string; args: string[]; options: any }[] = [];
  const exits: Array<[number, string | null]> = [];
  const managed = new DshManagedRuntime({
    dataDir: path.join(root, "data"),
    agentkibHome: path.join(root, "agentkib-home"),
    pluginDirectory: path.join(root, "plugin"),
    env: { HOME: root, AGENTKIB_DSH_LAUNCHER: launcher, PATH: "/usr/bin:/bin", ...env },
    stopGraceMs: 50,
    onExit: (pid, failure) => exits.push([pid, failure]),
    execFile: ((file: string, args: string[], _options: unknown, callback: any) => {
      if (file === "/bin/ps") callback(null, "", "");
      else callback(version === null ? new Error("failed") : null, `${version ?? ""}\n`, "");
    }) as any,
    spawn: ((file: string, args: string[], options: unknown) => {
      spawned.push({ file, args, options });
      return child;
    }) as any,
  });
  return { managed, launcher, spawned, exits, child };
}

describe("background DeepSeek Harness process", () => {
  it("finds DSH Desktop's launcher, then a dsh on the PATH", () => {
    const home = temporary();
    // Only this test folder, never the system ones.
    const places = { applications: [path.join(home, "Applications")], bins: [] };
    expect(findDshLauncher({ HOME: home, PATH: "" }, places)).toBeNull();
    const onPath = executable(path.join(home, "tools", "dsh"));
    expect(findDshLauncher({ HOME: home, PATH: path.dirname(onPath) }, places)).toEqual({
      path: onPath,
      kind: "path",
    });
    const app = executable(
      path.join(
        home,
        "Applications",
        "DeepSeek Harness.app",
        "Contents",
        "Resources",
        "runtime",
        "cli",
        "bin",
        "dsh",
      ),
    );
    expect(findDshLauncher({ HOME: home, PATH: path.dirname(onPath) }, places)).toEqual({
      path: app,
      kind: "app",
    });
    // The override replaces the search; a relative one finds nothing.
    expect(findDshLauncher({ HOME: home, AGENTKIB_DSH_LAUNCHER: onPath })?.path).toBe(onPath);
    expect(findDshLauncher({ HOME: home, AGENTKIB_DSH_LAUNCHER: "dsh" })).toBeNull();
  });

  it("starts only DSH versions the plugin runs in, as engines.dsh says", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(__dirname, "../../../packages/dsh-bridge-plugin/package.json"),
        "utf8",
      ),
    );
    expect(manifest.engines.dsh).toBe(
      `>=${DSH_BRIDGE_COMPATIBILITY.minimumDshVersion} <${DSH_BRIDGE_COMPATIBILITY.dshVersionBelow}`,
    );
    expect(manifest.version).toBe(DSH_BRIDGE_COMPATIBILITY.pluginVersion);
    expect(dshBridgeLaunchable("0.2.1-rc.5")).toBe(true);
    expect(dshBridgeLaunchable("0.2.2-rc.1")).toBe(true);
    expect(dshBridgeLaunchable("0.2.1-rc.4")).toBe(false);
    // DSH compares with `includePrerelease`, so a 0.3.0 prerelease is still inside <0.3.0.
    expect(dshBridgeLaunchable("0.3.0-alpha.1")).toBe(true);
    expect(dshBridgeLaunchable("0.3.0")).toBe(false);
    expect(dshBridgeLaunchable("unknown")).toBe(false);
  });

  it("runs the web profile with Desktop's settings and the plugin mounted by path", async () => {
    const root = temporary();
    const desktop = path.join(root, "dsh-home", "profiles", "desktop", "cordis.patch.yml");
    mkdirSync(path.dirname(desktop), { recursive: true });
    writeFileSync(desktop, "[]\n");
    const { managed, launcher, spawned } = runtime(root, {
      env: {
        DSH_HOME: path.join(root, "dsh-home"),
        AGENTKIB_HOME: "/elsewhere",
        ELECTRON_RUN_AS_NODE: "1",
        USER_SETTING: "kept",
      },
    });
    expect(await managed.start()).toBe(4242);
    expect(managed.phase).toBe("starting");
    const [{ file, args, options }] = spawned;
    expect(file).toBe(launcher);
    const overlay = path.join(root, "data", "dsh-bridge", "managed-overlay.yml");
    expect(args).toEqual([
      "--profile",
      "web",
      "--patch",
      desktop,
      "--patch",
      overlay,
      "--no-open",
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ]);
    // AgentKib's and Electron's own settings stay out of what DSH hands its tools.
    expect(options.env).toMatchObject({
      USER_SETTING: "kept",
      DSH_HOME: path.join(root, "dsh-home"),
    });
    expect(Object.keys(options.env).some((key) => key.startsWith("AGENTKIB_"))).toBe(false);
    expect(Object.keys(options.env).some((key) => key.startsWith("ELECTRON_"))).toBe(false);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(statSync(overlay).mode & 0o777).toBe(0o600);
    const text = readFileSync(overlay, "utf8");
    expect(text).toContain("- id: agentkib-dsh-bridge\n  disabled: true");
    expect(text).toContain(`name: ${JSON.stringify(path.join(root, "plugin", "index.js"))}`);
    expect(text).toContain(`home: ${JSON.stringify(path.join(root, "agentkib-home"))}`);
    managed.started();
    expect(managed.status()).toMatchObject({
      phase: "running",
      pid: 4242,
      launcher: "path",
      version: "0.2.2-rc.1",
      failure: null,
    });
  });

  it("leaves the Desktop settings out when there are none", async () => {
    const root = temporary();
    const { managed, spawned } = runtime(root, { env: { DSH_HOME: path.join(root, "none") } });
    await managed.start();
    expect(spawned[0]!.args.filter((arg) => arg === "--patch")).toHaveLength(1);
  });

  it("refuses a DSH version the plugin does not run in, before starting anything", async () => {
    const root = temporary();
    const { managed, spawned } = runtime(root, { version: "0.3.0" });
    await expect(managed.start()).rejects.toThrow("dsh-version-unsupported");
    expect(spawned).toEqual([]);
    expect(managed.available()).toEqual({ available: false, reason: "dsh-version-unsupported" });
    expect(managed.status().failure?.reason).toBe("dsh-version-unsupported");
  });

  it("says so when no launcher is found", async () => {
    const root = temporary();
    const managed = new DshManagedRuntime({
      dataDir: path.join(root, "data"),
      agentkibHome: root,
      pluginDirectory: root,
      env: { HOME: root, PATH: "" },
      launcherPlaces: { applications: [], bins: [] },
    });
    expect(managed.available()).toEqual({ available: false, reason: "dsh-launcher-unavailable" });
    await expect(managed.start()).rejects.toThrow("dsh-launcher-unavailable");
  });

  it("stops DSH the way its own launcher does, and forces a stuck one", async () => {
    const root = temporary();
    const polite = runtime(root);
    await polite.managed.start();
    polite.managed.started();
    await polite.managed.stop();
    expect(polite.child.signals).toEqual(["SIGTERM"]);
    expect(polite.managed.phase).toBe("stopped");
    // AgentKib stopped it, so no failure is recorded.
    expect(polite.exits).toEqual([[4242, null]]);

    const stuck = runtime(temporary(), { child: fakeChild(4343, { exitOn: null }) });
    await stuck.managed.start();
    await stuck.managed.stop();
    expect(stuck.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stuck.managed.pid).toBeNull();
  });

  it("tells a plugin DSH turned off from other failures, without keeping the web token", async () => {
    const root = temporary();
    const { managed, child, exits } = runtime(root);
    await managed.start();
    child.stdout.write("dsh web: http://127.0.0.1:5000/?token=secret-token-value\n");
    child.stderr.write(
      'dsh: disabling profile plugin row "agentkib-dsh-bridge-managed": requires dsh <0.3.0\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 1, null);
    await vi.waitFor(() => expect(exits).toEqual([[4242, "dsh-version-unsupported"]]));
    expect(managed.diagnostics()).not.toContain("secret-token-value");

    const other = runtime(temporary(), { child: fakeChild(4444) });
    await other.managed.start();
    other.managed.started();
    other.child.emit("exit", 1, null);
    await vi.waitFor(() => expect(other.exits).toEqual([[4444, "dsh-exited"]]));
    expect(other.managed.status().failure?.reason).toBe("dsh-exited");
  });

  it("knows DSH Desktop's window from DSH started on a command line", async () => {
    const app = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
    const check = (stdout: string) =>
      new DshManagedRuntime({
        dataDir: "/tmp/none",
        agentkibHome: "/tmp/none",
        pluginDirectory: "/tmp/none",
        execFile: ((_file: string, _args: string[], _options: unknown, callback: any) =>
          callback(null, stdout, "")) as any,
      }).desktopRunning();
    expect(await check(`${app}\n/usr/bin/other\n`)).toBe(true);
    expect(
      await check(
        `${app} --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/cli.js --profile web\n`,
      ),
    ).toBe(false);
    expect(await check("/usr/bin/other\n")).toBe(false);
  });

  it("finds DSH's home as DSH does and keeps the user's own environment", () => {
    expect(dshHome({ DSH_HOME: "/data/dsh", HOME: "/home/a" })).toBe("/data/dsh");
    expect(dshHome({ DSH_HOME: "relative", HOME: "/home/a" })).toBe("/home/a/.dsh");
    expect(dshEnvironment({ PATH: "/bin", AGENTKIB_X: "1", ELECTRON_Y: "2" })).toEqual({
      PATH: "/bin",
    });
  });
});
