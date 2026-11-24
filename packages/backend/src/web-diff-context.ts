import {
  privateFilePathPart,
  type WorkspaceDiffContext,
  type WorkspaceDiffContextLine,
} from "@agentkib/runtime-protocol";
import type { Git } from "./git";

const PATCH_BYTES = 512 * 1024;
const BLOB_BYTES = 256 * 1024;
const CONTEXT_BYTES = 64 * 1024;
const CONTEXT_FILES = 8;
const CONTEXT_LINES = 256;
const SPAN_EDGE_LINES = 24;

type ChangedPath = { path: string; old_path?: string | null };
type UnchangedSpan = { oldStart: number; newStart: number; count: number };

function eligiblePath(value: string): boolean {
  return (
    value.length <= 1024 &&
    !value.includes("\\") &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !value.split("/").some((part) => !part || privateFilePathPart(part))
  );
}

function patchPath(line: string | undefined, prefix: string): string | undefined {
  return line?.startsWith(prefix) ? line.slice(prefix.length).replace(/\t$/, "") : undefined;
}

/** Prove that the old blob and the original patch have the same unchanged gaps. */
function unchangedSpans(patch: string[], oldLines: string[]): UnchangedSpan[] | null {
  const spans: UnchangedSpan[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of patch) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (hunk) {
      if (oldRemaining || newRemaining) return null;
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      // A zero-length side points between lines. Its position is already zero-based.
      const oldStart = Number(hunk[1]) - (oldRemaining ? 1 : 0);
      const newStart = Number(hunk[3]) - (newRemaining ? 1 : 0);
      if (
        oldStart < oldLine ||
        newStart < newLine ||
        !Number.isSafeInteger(newStart + newRemaining) ||
        oldStart + oldRemaining > oldLines.length ||
        oldStart - oldLine !== newStart - newLine
      )
        return null;
      spans.push({ oldStart: oldLine, newStart: newLine, count: oldStart - oldLine });
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    const marker = line[0];
    if (marker !== " " && marker !== "-" && marker !== "+") return null;
    if (marker !== "+") {
      if (!oldRemaining || oldLines[oldLine] !== line.slice(1)) return null;
      oldLine++;
      oldRemaining--;
    }
    if (marker !== "-") {
      if (!newRemaining) return null;
      newLine++;
      newRemaining--;
    }
  }
  if (oldRemaining || newRemaining) return null;
  spans.push({ oldStart: oldLine, newStart: newLine, count: oldLines.length - oldLine });
  return spans;
}

/** Supplemental lines are read from Git's old blob, whose unchanged spans map to both sides. */
export async function supplementalDiffContext(
  git: Git,
  workspace: string,
  patch: string,
  files: ChangedPath[],
): Promise<WorkspaceDiffContext | undefined> {
  if (Buffer.byteLength(patch) > PATCH_BYTES || !patch.endsWith("\n")) return;
  const approved = new Set(
    files
      .filter(({ path, old_path }) => eligiblePath(path) && eligiblePath(old_path ?? path))
      .map(({ path, old_path }) => `${old_path ?? path}\0${path}`),
  );
  const lines: WorkspaceDiffContextLine[] = [];
  let bytes = 0;
  let readFiles = 0;
  let truncated = false;
  for (const section of patch.slice(0, -1).split(/(?=^diff --git )/m)) {
    const rows = section.split("\n");
    if (rows.at(-1) === "") rows.pop();
    const firstHunk = rows.findIndex((row) => row.startsWith("@@ "));
    if (!rows[0]?.startsWith("diff --git ") || firstHunk < 4) continue;
    const headers = rows.slice(1, firstHunk);
    const oldPath = patchPath(headers.at(-2), "--- a/");
    const newPath = patchPath(headers.at(-1), "+++ b/");
    if (!oldPath || !newPath || !approved.delete(`${oldPath}\0${newPath}`)) continue;
    const index = headers.find((row) => row.startsWith("index "));
    // A regular file on both sides, with an old blob named by Git itself.
    const before = /^index ([0-9a-f]{4,64})\.\.[0-9a-f]{4,64} 100(?:644|755)$/.exec(
      index ?? "",
    )?.[1];
    if (!before || /^0+$/.test(before)) continue;
    if (readFiles >= CONTEXT_FILES) {
      truncated = true;
      break;
    }
    readFiles++;
    const blob = await git.diffContextBlob(workspace, before, BLOB_BYTES);
    if (blob === null) continue;
    const oldLines = blob === "" ? [] : blob.replace(/\n$/, "").split("\n");
    const spans = unchangedSpans(rows.slice(firstHunk), oldLines);
    if (!spans) continue;
    for (const { oldStart, newStart, count } of spans) {
      for (let offset = 0; offset < count; offset++) {
        if (offset === SPAN_EDGE_LINES && count > 2 * SPAN_EDGE_LINES) {
          offset = count - SPAN_EDGE_LINES;
          truncated = true;
        }
        if (lines.length >= CONTEXT_LINES) return { lines, truncated: true };
        const row: WorkspaceDiffContextLine = {
          path: newPath,
          oldLine: oldStart + offset + 1,
          newLine: newStart + offset + 1,
          text: oldLines[oldStart + offset]!,
          source: "host",
        };
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > CONTEXT_BYTES) {
          truncated = true;
          continue;
        }
        lines.push(row);
        bytes += size;
      }
    }
  }
  return lines.length ? { lines, ...(truncated ? { truncated: true } : {}) } : undefined;
}
