import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevinCliRuntime } from "../../../packages/backend/src/agents/devin/devin-cli-runtime";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

let directory: string;
let executable: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "agentkib-devin-cli-version-"));
  executable = path.join(directory, "devin");
  writeFileSync(executable, "fixture-old");
  execFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

it("shares a pending version probe and probes again after the installed build changes", async () => {
  const environment = { PATH: directory };
  const runtime = new DevinCliRuntime();

  const first = runtime.select(executable, environment);
  const second = runtime.select(executable, environment);
  expect(runtime.modeFor(executable)).toBeUndefined();
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    executable,
    ["--version"],
    {
      env: environment,
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024,
      windowsHide: true,
    },
    expect.any(Function),
  );
  execFile.mock.calls[0]![3](null, "Devin CLI 3000.12.59\n", "");
  const old = { executable, mode: "print" };
  expect(await Promise.all([first, second])).toEqual([old, old]);
  expect(runtime.modeFor(executable)).toBe("print");
  expect(await runtime.select(executable, environment)).toEqual(old);
  expect(execFile).toHaveBeenCalledTimes(1);

  writeFileSync(executable, "fixture-new-build-at-the-same-path");
  expect(runtime.modeFor(executable)).toBeUndefined();
  const replaced = runtime.select(executable, environment);
  expect(execFile).toHaveBeenCalledTimes(2);
  execFile.mock.calls[1]![3](null, "", "3000.14.30833\n");
  expect(await replaced).toEqual({ executable, mode: "acp" });
  expect(runtime.modeFor(executable)).toBe("acp");
});

it.each(["unrecognized output", "failed command"])(
  "keeps ACP when the executable has %s and rechecks that same build after a short delay",
  async (reason) => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runtime = new DevinCliRuntime();
    const environment = { PATH: directory };
    const selection = runtime.select(executable, environment);
    const failure = reason === "failed command" ? new Error("command failed") : null;
    // A version mentioned in a warning does not identify the executable's build.
    execFile.mock.calls[0]![3](
      failure,
      failure ? "Devin CLI 3000.12.59" : "cached catalog 3000.12.59",
      "",
    );
    expect(await selection).toEqual({ executable, mode: "acp" });
    expect(await runtime.select(executable, environment)).toEqual({ executable, mode: "acp" });
    expect(execFile).toHaveBeenCalledTimes(1);

    now = 5_000;
    expect(runtime.modeFor(executable)).toBeUndefined();
    const rechecked = runtime.select(executable, environment);
    expect(execFile).toHaveBeenCalledTimes(2);
    execFile.mock.calls[1]![3](null, "v3000.13.30833 (Devin CLI)\n", "");
    expect(await rechecked).toEqual({ executable, mode: "print" });
  },
);
