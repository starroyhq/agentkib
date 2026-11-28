import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const SANDBOX = "(version 1)(allow default)(deny file-write*)(deny network*)";
const captureModule = new URL("./session-shape-store.mjs", import.meta.url).href;
const readOnlyProgram = `
  const { captureSessionShape } = await import(process.argv[1]);
  const [root, sessionId, transcript] = process.argv.slice(2);
  const result = captureSessionShape({ root, sessionId, transcript });
  process.stdout.write(JSON.stringify(result));
`;

function fail(code, message) {
  console.error(message);
  process.exitCode = code;
}

function ensureDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(directory).isDirectory()) throw new Error("invalid-output-directory");
}

function isWithin(file, directory) {
  const relative = path.relative(directory, file);
  return (
    !relative ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function locations(args) {
  const checkout = realpathSync(process.cwd());
  const dotGit = lstatSync(path.join(checkout, ".git"));
  if (!dotGit.isDirectory() && !dotGit.isFile()) throw new Error("invalid-checkout");
  const designs = path.join(checkout, "designs");
  const output = path.join(designs, "shapes");
  const root = realpathSync(args["data-dir"]);
  const transcript = path.resolve(args.transcript);
  const transcriptDir = realpathSync(path.dirname(transcript));
  if (isWithin(output, root) || isWithin(output, transcriptDir)) {
    throw new Error("output-in-input");
  }
  return { designs, output, root, transcript };
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        "data-dir": { type: "string" },
        "session-id": { type: "string" },
        transcript: { type: "string" },
      },
    }).values;
  } catch {}
  if (
    !args?.["data-dir"] ||
    !/^[A-Za-z0-9-]{1,128}$/.test(args?.["session-id"] ?? "") ||
    !args.transcript?.endsWith(".jsonl")
  ) {
    return fail(
      2,
      "Usage: node capture-session-shape.mjs --data-dir DIR --session-id ID --transcript FILE.jsonl",
    );
  }
  if (process.platform !== "darwin") {
    return fail(2, "Shape capture requires the macOS read-only sandbox.");
  }
  let paths;
  try {
    paths = locations(args);
  } catch {
    return fail(2, "Run shape capture from a repository checkout with separate input directories.");
  }
  // Even a read-only SQLite connection can touch WAL sidecars. Only the parent writes,
  // and it receives a bounded projection instead of source rows or captured stderr.
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      SANDBOX,
      process.execPath,
      "--max-old-space-size=160",
      "--input-type=module",
      "--eval",
      readOnlyProgram,
      "--",
      captureModule,
      paths.root,
      args["session-id"],
      paths.transcript,
    ],
    {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error || result.status !== 0) {
    return fail(1, "Shape capture could not complete inside the read-only sandbox.");
  }
  try {
    const report = JSON.parse(result.stdout);
    const { designs, output } = paths;
    ensureDirectory(designs);
    ensureDirectory(output);
    const filename = `session-shape-${randomUUID()}.json`;
    writeFileSync(path.join(output, filename), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`designs/shapes/${filename}`);
  } catch {
    return fail(1, "Shape report could not be written to designs/shapes.");
  }
}

main();
