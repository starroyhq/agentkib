import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTranscriptPageCache } from "../../../packages/conversation-state/src/transcript-page-cache.ts";

// Separate V8 processes, identical synthetic histories, no production data or model calls.
// Native TypeScript stripping is provided by the repository's supported Node versions.
const sessions = 10;
const eventsPerSession = 1_500;
const bytesPerEvent = 8_192;
const mode = process.argv[2];

if (mode === "count-only" || mode === "bounded") {
  assert.equal(typeof global.gc, "function", "The worker must run with --expose-gc");
  const cache = mode === "bounded" ? createTranscriptPageCache() : new Map();
  global.gc();
  const before = process.memoryUsage();
  const started = performance.now();
  let active;
  for (let session = 0; session < sessions; session += 1) {
    active = {
      events: Array.from({ length: eventsPerSession }, (_, index) => {
        // Materialize separate strings, rather than repeated ropes or shared string slices.
        const body = Buffer.alloc(bytesPerEvent, 97 + (index % 26));
        body.write(`synthetic session ${session} tool ${index}\n`);
        return {
          id: `session-${session}-event-${index}`,
          kind: "tool-summary",
          tool: { output: body.toString("utf8") },
          attachment_count: 0,
          truncated: false,
        };
      }),
      next_cursor: `session-${session}-earlier`,
      warnings: [],
    };
    cache.set(`session-${session}`, active);
    if (mode === "count-only" && cache.size > 10) cache.delete(cache.keys().next().value);
  }
  const elapsedMs = performance.now() - started;
  global.gc();
  const after = process.memoryUsage();
  assert.equal(cache.get("session-9"), active);
  assert.equal(active.events.length, eventsPerSession);
  assert.equal(active.next_cursor, "session-9-earlier");
  assert.equal(active.events[0].tool.output.length, bytesPerEvent);
  process.stdout.write(
    JSON.stringify({
      mode,
      retainedSessions: cache.size,
      estimatedCacheBytes: cache.estimatedBytes ?? null,
      heapGrowthBytes: after.heapUsed - before.heapUsed,
      rssGrowthBytes: after.rss - before.rss,
      elapsedMs: Math.round(elapsedMs),
      activeEvents: active.events.length,
    }),
  );
} else {
  const results = ["count-only", "bounded"].map((cacheMode) =>
    JSON.parse(
      execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), cacheMode], {
        encoding: "utf8",
        timeout: 60_000,
      }),
    ),
  );
  console.info(
    JSON.stringify(
      {
        scenario: { sessions, eventsPerSession, bytesPerEvent, activeSessionKept: true },
        results,
        heapReductionPercent: Math.round(
          (1 - results[1].heapGrowthBytes / results[0].heapGrowthBytes) * 100,
        ),
        note: "Synthetic retained heap after GC; RSS and timings are diagnostic, not acceptance thresholds.",
      },
      null,
      2,
    ),
  );
  assert.ok(results[1].retainedSessions < results[0].retainedSessions);
  assert.ok(results[1].heapGrowthBytes < results[0].heapGrowthBytes / 2);
}
