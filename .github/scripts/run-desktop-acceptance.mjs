import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { on } from "node:events";
import { watch } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { acceptanceAccountId, seedAcceptanceAccount } from "./desktop-acceptance-account.mjs";
import {
  connectLegacyClaude,
  notifyLegacyClaudeTurn,
} from "./desktop-acceptance-claude-legacy.mjs";
import { withDesktopAcceptance } from "./desktop-acceptance-launch.mjs";

const requireDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const windowUrl = "app://bundle/index.html";
const namedCase = {
  local: { scope: "local", legacy: false },
  account: { scope: "account:" + acceptanceAccountId, legacy: false },
  legacy: { scope: "account:" + acceptanceAccountId, legacy: true },
  "legacy-storm": { scope: "account:" + acceptanceAccountId, legacy: true },
};

async function until(description, signal, read, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const result = await read();
    if (result) return result;
    await delay(75, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + description);
}

function fixtureTranscript(directory, workspace, title) {
  const nativeId = randomUUID();
  const file = path.join(directory, nativeId + ".jsonl");
  let parentUuid = null;
  return {
    nativeId,
    file,
    title,
    async append(turns) {
      const lines = [];
      let latest;
      for (const { at, prompt, reply } of turns) {
        const record = (type, delta, fields) => {
          const uuid = randomUUID();
          lines.push({
            type,
            uuid,
            parentUuid,
            sessionId: nativeId,
            cwd: workspace,
            timestamp: new Date(at + delta).toISOString(),
            isSidechain: false,
            ...fields,
          });
          parentUuid = uuid;
          return uuid;
        };
        record("user", 0, {
          userType: "external",
          message: { role: "user", content: prompt },
        });
        const itemId = record("assistant", 50, {
          requestId: "req_" + randomUUID(),
          message: {
            id: "msg_" + randomUUID(),
            role: "assistant",
            model: "claude-haiku-5-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: reply }],
          },
        });
        record("system", 100, { subtype: "turn_duration", durationMs: 100, isMeta: false });
        latest = { itemId, text: reply };
      }
      await appendFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
        mode: 0o600,
      });
      return latest;
    },
  };
}

async function prepareAT01({ home, data, profile, scratch, sandbox, signal }, { scope }) {
  const workspace = path.join(scratch, "project");
  const claude = path.join(home, ".claude");
  const directory = path.join(claude, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await mkdir(directory, { recursive: true });
  const target = fixtureTranscript(directory, workspace, "AT01 unread conversation");
  const other = fixtureTranscript(directory, workspace, "AT01 other conversation");
  const start = Date.now() - 60_000;
  await target.append(
    Array.from({ length: 5 }, (_, index) => ({
      at: start + index * 1_000,
      prompt: index === 0 ? target.title : "AT01 previous prompt " + index,
      reply: "AT01 previous reply " + index,
    })),
  );
  await other.append([{ at: start, prompt: other.title, reply: "AT01 other reply" }]);
  await writeFile(
    path.join(claude, "history.jsonl"),
    [target, other]
      .map(({ nativeId, title }) =>
        JSON.stringify({
          sessionId: nativeId,
          project: workspace,
          display: title,
          timestamp: start,
        }),
      )
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  if (scope !== "local")
    await seedAcceptanceAccount({
      electron: requireDesktop("electron"),
      profile,
      home,
      scratch,
      sandbox,
      signal,
    });
  return {
    workspace,
    target,
    other,
    ledger: path.join(data, "codex-managed", "executions.sqlite"),
    key: createHash("sha256")
      .update(JSON.stringify(["claude-code", claude, target.nativeId]))
      .digest("hex"),
  };
}

function ledgerSnapshot({ ledger, key }) {
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    const latest = db
      .prepare(
        `SELECT result.sequence, result.baseline, result.result_id, result.result
           FROM conversation_read_sources AS source JOIN conversation_read_results AS result
           ON source.key=result.key AND source.latest_id=result.result_id
           WHERE source.key=?`,
      )
      .get(key);
    const cursors = db
      .prepare(
        `SELECT cursor.reader_scope, cursor.read_sequence, cursor.manual_unread,
                result.result_id, json_extract(result.result, '$.itemId') AS item_id
           FROM conversation_read_cursors AS cursor LEFT JOIN conversation_read_results AS result
           ON cursor.key=result.key AND cursor.read_sequence=result.sequence
           WHERE cursor.key=? ORDER BY cursor.reader_scope`,
      )
      .all(key);
    assert(latest, "The runtime did not write a source in the isolated ledger");
    return { latest, cursors };
  } finally {
    db.close();
  }
}

async function conversation(page, route) {
  const reply = await page.evaluate(
    (request) => window.desktopConversation.request(request),
    route,
  );
  assert.equal(reply.status, 200, route + " returned " + (reply.body?.error ?? reply.status));
  return reply.body;
}

const stateFor = async (page, id) =>
  (await conversation(page, "/read-state?sessionId=" + encodeURIComponent(id))).readState;

function directoryRow(page, id) {
  const anchor = JSON.stringify("session:" + id);
  return page.locator("[data-directory-anchor=" + anchor + "]");
}

const entryButton = (row) => row.locator("[data-session-entry]");
const unreadDot = (row) => row.locator('.session-directory-trailing [data-unread="true"]');

async function setupWindow(browser, fixture, scope, signal) {
  const page = await until("the bundled AgentKib window", signal, () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith(windowUrl)),
  );
  page.setDefaultTimeout(10_000);
  await page.bringToFront();
  await page.waitForFunction(() => window.agentkibDesktop && window.desktopConversation);
  const account = await until("the expected desktop account state", signal, async () => {
    const status = await page.evaluate(() =>
      window.agentkibDesktop.account.request({ operation: "status" }),
    );
    return scope === "local"
      ? status.phase === "signed-out" && status
      : status.phase === "signed-in" && status;
  });
  assert.equal(account.account?.id, scope === "local" ? undefined : acceptanceAccountId);
  // Fixture registration uses the production preload. Opening and reading the
  // conversation use only user input in the bundled renderer below.
  await page.evaluate(async (workspace) => {
    const project = await window.agentkibDesktop.workspace.add(workspace);
    await window.agentkibDesktop.workspace.refreshSessions(project.id, true);
    await window.agentkibDesktop.home.refreshDiscovery(true);
  }, fixture.workspace);
  const ids = await until("the two fixture sessions in the catalog", signal, async () => {
    const { sessions } = await conversation(page, "/catalog");
    const target = sessions.find((session) => session.title === fixture.target.title)?.id;
    const other = sessions.find((session) => session.title === fixture.other.title)?.id;
    return target && other && { target, other };
  });
  await until("the Claude history baseline", signal, async () => {
    const state = await stateFor(page, ids.target);
    return state.freshness === "current" && state.status === "read";
  });
  try {
    await page
      .locator(".activity-bar-item")
      .and(page.getByRole("button", { name: /^(Sessions|会话|對話|会話)$/ }))
      .click();
    await entryButton(directoryRow(page, ids.other)).click();
  } catch (error) {
    const snapshot = await page
      .locator("body")
      .ariaSnapshot({ timeout: 2_000 })
      .catch(() => "");
    throw new Error(
      "The fixture session is unavailable in the window.\n" + snapshot.slice(0, 2_000),
      {
        cause: error,
      },
    );
  }
  return { page, ids };
}

async function bottomGeometry(reader, itemId) {
  return reader.evaluate((viewport, id) => {
    const result = [...viewport.querySelectorAll("[data-event-id]")].find(
      (event) => event.dataset.eventId === id,
    );
    if (!result) return null;
    const clip = viewport.getBoundingClientRect();
    const box = result.getBoundingClientRect();
    const left = Math.max(clip.left, box.left);
    const right = Math.min(clip.right, box.right);
    const top = Math.max(clip.top, box.top);
    const bottom = Math.min(clip.bottom, box.bottom);
    const hit =
      left < right && top < bottom
        ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
        : null;
    return {
      atBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2,
      center: { x: clip.left + clip.width / 2, y: clip.top + clip.height / 2 },
      resultHit: hit !== null && (hit === result || result.contains(hit)),
      foreground: document.visibilityState === "visible" && document.hasFocus(),
    };
  }, itemId);
}

async function readWithWindow({ page, ids, fixture, result, scope, signal }) {
  const row = directoryRow(page, ids.target);
  const dot = unreadDot(row);
  const before = await until("a fresh unread result with its native reply", signal, async () => {
    const value = await stateFor(page, ids.target);
    return value.freshness === "current" &&
      value.status === "unread" &&
      value.latestResult?.itemId === result.itemId &&
      (!result.bridgeResultId ||
        (value.latestResult.id === result.bridgeResultId &&
          value.canAcknowledge === true &&
          value.version))
      ? value
      : null;
  });
  await dot.waitFor({ state: "visible" });
  const beforeLedger = ledgerSnapshot(fixture);
  assert.equal(beforeLedger.latest.baseline, 0);
  assert.equal(beforeLedger.latest.result_id, before.latestResult.id);
  if (result.bridgeResultId) {
    assert.equal(JSON.parse(beforeLedger.latest.result).itemId, null);
  }
  const prior = beforeLedger.cursors.find((cursor) => cursor.reader_scope === scope);
  assert((prior?.read_sequence ?? 0) < beforeLedger.latest.sequence);

  await entryButton(row).click();
  const reader = page.locator("section.reader-scroll");
  const reply = reader.locator("[data-event-id=" + JSON.stringify(result.itemId) + "]");
  await reply.waitFor({ state: "attached" });
  const geometry = await bottomGeometry(reader, result.itemId);
  assert(geometry, "The final reply must be in the genuine scrolling transcript");
  await page.mouse.move(geometry.center.x, geometry.center.y);
  // Some sessions open at the latest reply. Move off the bottom first so the
  // downward gesture always exercises the real scroll container and hit testing.
  await page.mouse.wheel(0, -30_000);
  await until("the transcript scrolling away from the bottom", signal, async () => {
    const position = await bottomGeometry(reader, result.itemId);
    return position && !position.atBottom && !position.resultHit;
  });
  await page.mouse.wheel(0, 30_000);
  await until("the focused window hitting the final reply at the bottom", signal, async () => {
    const position = await bottomGeometry(reader, result.itemId);
    return position?.atBottom && position.resultHit && position.foreground;
  });
  await reply.getByText(result.text, { exact: true }).waitFor({ state: "visible" });

  try {
    await dot.waitFor({ state: "hidden" });
  } catch (error) {
    const { latest, cursors } = ledgerSnapshot(fixture);
    throw new Error(
      `Reached the final reply, but the dot remained (latest sequence ${latest.sequence}, ${scope} cursor ${cursors.find((cursor) => cursor.reader_scope === scope)?.read_sequence ?? "absent"}).`,
      { cause: error },
    );
  }
  const after = await stateFor(page, ids.target);
  assert.equal(after.status, "read");
  assert.equal(after.freshness, "current");
  // The unread proof projects the native anchor. After acknowledgement, details
  // return the original ledger result and the cursor still covers that same reply.
  assert.equal(after.latestResult?.id, before.latestResult.id);
  const persisted = ledgerSnapshot(fixture);
  assert.equal(persisted.latest.result_id, after.latestResult.id);
  if (result.bridgeResultId) {
    assert.deepEqual(
      persisted.latest,
      beforeLedger.latest,
      "The original bridge record must stay intact",
    );
  } else {
    assert(persisted.latest.sequence >= beforeLedger.latest.sequence);
  }
  assert.deepEqual(
    persisted.cursors.map(({ reader_scope }) => reader_scope),
    [scope],
  );
  const [cursor] = persisted.cursors;
  assert(cursor.read_sequence >= persisted.latest.sequence);
  assert.equal(cursor.manual_unread, 0);
  assert(
    cursor.result_id === after.latestResult.id || cursor.item_id === result.itemId,
    "The real cursor must cover the correct persisted reply",
  );

  await entryButton(directoryRow(page, ids.other)).click();
  if (result.bridgeResultId) await page.reload();
  await entryButton(row).click();
  await reply.waitFor({ state: "attached" });
  assert.equal(await dot.isVisible(), false);
  assert.deepEqual(ledgerSnapshot(fixture).cursors, persisted.cursors);
  return persisted.cursors[0].read_sequence;
}

const longPrompt = Array.from(
  { length: 24 },
  (_, line) => "AT01 scroll fixture paragraph " + line + ". " + "Synthetic text. ".repeat(7),
).join("\n\n");

async function readStateTrace(directory) {
  const logs = await Promise.all(
    ["", ".1", ".2", ".3"].map((suffix) =>
      readFile(path.join(directory, "runtime-trace.ndjson" + suffix), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      }),
    ),
  );
  const rows = logs.flatMap((log) =>
    log.split("\n").flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return row.kind === "request" ? [row] : [];
      } catch {
        // A concurrent append can leave the last line incomplete in this snapshot.
        return [];
      }
    }),
  );
  return {
    reads: rows.filter((row) => row.method === "session.request" && row.operation === "read-state")
      .length,
    confirmations: rows.filter(
      (row) => row.method === "session.request" && row.operation === "read-state-update",
    ).length,
    rateLimited: rows.filter(
      (row) =>
        row.method === "host.request" &&
        row.operation === "readState" &&
        row.reason === "rate_limited",
    ).length,
  };
}

async function withReadStateTrace(data, signal, exercise) {
  const directory = path.join(data, "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await readStateTrace(directory);
  const watcher = watch(directory);
  try {
    const changes = on(watcher, "change", { signal, close: ["close"] });
    const confirmed = async () => {
      for await (const [, name] of changes) {
        if (
          (name === null || /^runtime-trace\.ndjson(?:\.[123])?$/.test(name)) &&
          (await readStateTrace(directory)).confirmations > before.confirmations
        )
          return;
      }
      throw new Error("The trace closed before the read confirmation");
    };
    return await exercise({
      confirmed: confirmed(),
      async counts() {
        const after = await readStateTrace(directory);
        return {
          reads: after.reads - before.reads,
          confirmations: after.confirmations - before.confirmations,
          rateLimited: after.rateLimited - before.rateLimited,
        };
      },
    });
  } finally {
    watcher.close();
  }
}

async function scrollStormViewport(page, reader, toBottom) {
  await reader.hover();
  const move = await reader.evaluateHandle((viewport, toBottom) => {
    const bottom = () => viewport.scrollHeight - viewport.clientHeight;
    const atBottom = () => bottom() - viewport.scrollTop <= 2;
    if (bottom() <= 2) throw new Error("The storm fixture must have a scrollable transcript");
    const { promise, resolve } = Promise.withResolvers();
    const observe = () => {
      if (atBottom() === toBottom) resolve();
    };
    viewport.addEventListener("scroll", observe);
    observe();
    return {
      async reached() {
        // Keep the real wheel input while removing compositor timing from the target position.
        if (atBottom() !== toBottom) {
          viewport.scrollTo({
            top: toBottom ? bottom() : Math.max(0, bottom() - 150),
            behavior: "instant",
          });
        }
        await promise;
        return {
          atBottom: atBottom(),
          foreground: document.visibilityState === "visible" && document.hasFocus(),
        };
      },
      close: () => viewport.removeEventListener("scroll", observe),
    };
  }, toBottom);
  try {
    await page.mouse.wheel(0, toBottom ? 2_000 : -150);
    assert.deepEqual(await move.evaluate((observer) => observer.reached()), {
      atBottom: toBottom,
      foreground: true,
    });
  } finally {
    await move.evaluate((observer) => observer.close()).finally(() => move.dispose());
  }
}

function observeStormRound(page, sessionId, itemId) {
  return page.evaluateHandle(
    ({ anchor, itemId }) => {
      const reply = Promise.withResolvers();
      const dotCleared = Promise.withResolvers();
      let confirmed = false;
      const update = () => {
        const viewport = document.querySelector("section.reader-scroll");
        const replySelector = '[data-event-id="' + CSS.escape(itemId) + '"]';
        if (!viewport?.querySelector(replySelector)) return;
        reply.resolve();
        const row = document.querySelector('[data-directory-anchor="' + CSS.escape(anchor) + '"]');
        if (
          confirmed &&
          row &&
          !row.querySelector('.session-directory-trailing [data-unread="true"]')
        ) {
          dotCleared.resolve();
          observer.disconnect();
        }
      };
      const observer = new MutationObserver(update);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-event-id", "data-directory-anchor", "data-unread"],
      });
      update();
      return {
        reply: reply.promise,
        afterConfirmation() {
          confirmed = true;
          update();
          return dotCleared.promise;
        },
        close: () => observer.disconnect(),
      };
    },
    { anchor: "session:" + sessionId, itemId },
  );
}

async function readLegacyStorm({ page, ids, fixture, scope, signal, home, data }) {
  const completeTurn = await connectLegacyClaude({
    home,
    data,
    transcriptPath: fixture.target.file,
    workspace: fixture.workspace,
    nativeId: fixture.target.nativeId,
    signal,
  });
  const reader = page.locator("section.reader-scroll");
  const bursts = 8;
  const maxReadsPerRound = 10;
  const scroll = async () => {
    for (let repetition = 0; repetition < bursts; repetition++) {
      await scrollStormViewport(page, reader, false);
      await scrollStormViewport(page, reader, true);
    }
  };
  const rounds = [];
  for (let index = 1; index <= 3; index++) {
    const before = ledgerSnapshot(fixture).cursors.find((cursor) => cursor.reader_scope === scope);
    const itemId = randomUUID();
    const observed = await observeStormRound(page, ids.target, itemId);
    try {
      const round = await withReadStateTrace(data, signal, async ({ confirmed, counts }) => {
        const exercise = async () => {
          const result = await completeTurn({
            itemId,
            text: `AT01 legacy reply while scrolling ${index}`,
            whileRunning: scroll,
          });
          await observed.evaluate((observer) => observer.reply);
          await scroll();
          return result;
        };
        const [result] = await Promise.all([exercise(), confirmed]);
        await observed.evaluate((observer) => observer.afterConfirmation());
        const geometry = await bottomGeometry(reader, itemId);
        assert(
          geometry?.atBottom && geometry.resultHit && geometry.foreground,
          "The new reply must be hit-testable at the bottom of the focused viewport",
        );
        const persisted = ledgerSnapshot(fixture);
        assert.deepEqual(
          persisted.cursors.map(({ reader_scope }) => reader_scope),
          [scope],
        );
        const [cursor] = persisted.cursors;
        assert(
          cursor.read_sequence > before.read_sequence &&
            cursor.read_sequence >= persisted.latest.sequence &&
            (cursor.result_id === result.bridgeResultId || cursor.item_id === result.itemId),
          `Round ${index}: reader cursor ${before.read_sequence} → ${cursor.read_sequence}, expected coverage of the new result at ${persisted.latest.sequence}`,
        );
        const trace = await counts();
        assert.equal(trace.confirmations, 1, "Auto-confirm a terminal result once");
        assert.equal(trace.rateLimited, 0, "Scrolling must not trigger rate limiting");
        assert(
          trace.reads > 0 && trace.reads <= maxReadsPerRound,
          `Unexpected read-state request count for ${bursts * 4} wheel gestures: ${trace.reads}`,
        );
        return { sequence: cursor.read_sequence, scrollGestures: bursts * 4, ...trace };
      });
      rounds.push(round);
    } finally {
      await observed.evaluate((observer) => observer.close()).finally(() => observed.dispose());
    }
  }
  return rounds;
}

async function at01({ executable, mode }) {
  const testCase = namedCase[mode];
  return withDesktopAcceptance({
    executable,
    prepare: (context) => prepareAT01(context, testCase),
    async exercise({ cdpUrl, prepared: fixture, signal, home, data }) {
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
      try {
        const { page, ids } = await setupWindow(browser, fixture, testCase.scope, signal);
        const args = { page, ids, fixture, scope: testCase.scope, signal };
        const readOrdinary = async () => {
          const at = Date.now() - 500;
          const result = await fixture.target.append([
            { at, prompt: "AT01 first new prompt", reply: "AT01 first new reply" },
            { at: at + 200, prompt: longPrompt, reply: "AT01 latest ordinary reply" },
          ]);
          return readWithWindow({ ...args, result });
        };
        if (mode === "legacy-storm") {
          // The runtime flushes its trace asynchronously. Observe the setup ACK first
          // so none of the three rounds can mistake it for its own confirmation.
          await withReadStateTrace(data, signal, ({ confirmed }) =>
            Promise.all([readOrdinary(), confirmed]),
          );
          const rounds = await readLegacyStorm({ ...args, home, data });
          return { scope: testCase.scope, readSequence: rounds.at(-1).sequence, rounds };
        }
        let readSequence = await readOrdinary();
        if (testCase.legacy) {
          await entryButton(directoryRow(page, ids.other)).click();
          await fixture.target.append([
            { at: Date.now() - 400, prompt: longPrompt, reply: "AT01 pre-bridge reply" },
          ]);
          const legacy = await notifyLegacyClaudeTurn({
            home,
            data,
            transcriptPath: fixture.target.file,
            workspace: fixture.workspace,
            nativeId: fixture.target.nativeId,
            signal,
          });
          const next = await readWithWindow({ ...args, result: legacy });
          assert(
            next > readSequence,
            "The legacy bridge reply must advance the real reader cursor",
          );
          readSequence = next;
        }
        return { scope: testCase.scope, readSequence };
      } finally {
        await browser.close();
      }
    },
  });
}

const [executable, only] = process.argv.slice(2);
if (!executable || (only !== undefined && !Object.hasOwn(namedCase, only))) {
  console.error(
    "Usage: node .github/scripts/run-desktop-acceptance.mjs <app executable> [local|account|legacy|legacy-storm]",
  );
  process.exitCode = 2;
} else {
  for (const mode of only ? [only] : Object.keys(namedCase)) {
    const started = performance.now();
    try {
      const result = await at01({ executable, mode });
      console.log(
        JSON.stringify({
          test: "AT01",
          mode,
          ...result,
          outcome: "passed",
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
    } catch (error) {
      console.error(`AT01 ${mode}: ${error.stack ?? error}`);
      process.exitCode = 1;
    }
  }
}
