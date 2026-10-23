import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const documentationFiles = new Set([
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
]);
const scopedDocumentation = /^(?:docs|qa)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const rawHeader =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z][0-9]*)$/;
const leafJobs = ["checks", "desktop", "safety", "web"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function classifyRawDiff(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return "full";
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    if (!text.endsWith("\0") || /[\x01-\x1f\x7f]/.test(text)) return "full";
    const fields = text.slice(0, -1).split("\0");
    if (fields.length % 2 !== 0) return "full";
    const seen = new Set();
    for (let index = 0; index < fields.length; index += 2) {
      const header = rawHeader.exec(fields[index]);
      const file = fields[index + 1];
      if (!header || seen.has(file)) return "full";
      seen.add(file);
      const [, oldMode, newMode, oldBlob, newBlob, status] = header;
      if (oldBlob.length !== newBlob.length || newMode !== "100644" || /^0+$/.test(newBlob)) {
        return "full";
      }
      if (status === "A") {
        if (oldMode !== "000000" || !/^0+$/.test(oldBlob)) return "full";
      } else if (status === "M") {
        if (oldMode !== "100644" || /^0+$/.test(oldBlob)) return "full";
      } else {
        return "full";
      }
      if (!documentationFiles.has(file) && !scopedDocumentation.test(file)) return "full";
    }
    return "docs";
  } catch {
    return "full";
  }
}

export function determineChangeMode({ eventName, event, readDiff } = {}) {
  if (eventName !== "pull_request") return "full";
  try {
    if (!isRecord(event) || !isRecord(event.pull_request)) return "full";
    const { base, head } = event.pull_request;
    if (!isRecord(base) || !isRecord(head)) return "full";
    if (typeof base.sha !== "string" || !objectId.test(base.sha)) return "full";
    if (typeof head.sha !== "string" || !objectId.test(head.sha)) return "full";
    if (typeof readDiff !== "function") return "full";
    return classifyRawDiff(readDiff(base.sha, head.sha));
  } catch {
    return "full";
  }
}

export function evaluateGate(needs) {
  if (!isRecord(needs)) return false;
  for (const job of ["changes", ...leafJobs]) {
    if (!Object.hasOwn(needs, job) || !isRecord(needs[job])) return false;
  }
  const changes = needs.changes;
  if (changes.result !== "success" || !isRecord(changes.outputs)) return false;
  const mode = changes.outputs.mode;
  if (mode !== "full" && mode !== "docs") return false;
  const expected = mode === "full" ? "success" : "skipped";
  return leafJobs.every((job) => needs[job].result === expected);
}

function changesCommand() {
  let event;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      // Event and Git failures retain the full validation path without logging their contents.
    }
  }
  const mode = determineChangeMode({
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    readDiff: (base, head) =>
      execFileSync(
        "git",
        [
          "diff",
          "--raw",
          "--no-abbrev",
          "-z",
          "--find-renames",
          "--find-copies",
          "--find-copies-harder",
          `${base}...${head}`,
          "--",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
  });
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error();
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`, "utf8");
  } catch {
    process.stderr.write("Unable to write CI quality output.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    mode === "docs" ? "Documentation-only pull request.\n" : "Full validation required.\n",
  );
}

function gateCommand() {
  let needs;
  try {
    needs = JSON.parse(process.env.CI_QUALITY_NEEDS ?? "");
  } catch {
    // Invalid or absent job state must never satisfy the stable quality check.
  }
  if (!evaluateGate(needs)) {
    process.stderr.write("CI quality gate rejected incomplete or unsuccessful checks.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write("Usage: node ci-quality.mjs changes|gate\n");
    process.exitCode = 1;
  } else if (process.argv[2] === "changes") {
    changesCommand();
  } else if (process.argv[2] === "gate") {
    gateCommand();
  } else {
    process.stderr.write("Usage: node ci-quality.mjs changes|gate\n");
    process.exitCode = 1;
  }
}
