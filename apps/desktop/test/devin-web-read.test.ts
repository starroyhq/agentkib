// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeSessionGroups, workStoppedByQuit, type HomeSession } from "@agentkib/session-catalog";
import { DevinManagedRunner } from "../../../packages/backend/src/agents/devin/devin-managed-runner";
import type { DevinSessionProvider } from "../../../packages/backend/src/agents/devin/session-provider";
import { ACP_INLINE_ATTACHMENT_LIMIT } from "../../../packages/backend/src/acp-prompt-attachments";
import { Commands } from "../../../packages/backend/src/commands";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { readManagedUsageLimit } from "../../../packages/backend/src/managed-ledger";
import {
  OrchestrationService,
  type WorkerRestartRequest,
} from "../../../packages/backend/src/orchestration-service";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { ConversationEvent } from "../../../packages/backend/src/session-events";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";
import { AUTO_CONTINUE_TEXT } from "../../../packages/backend/src/usage-limit";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Event = { sessionId: string; type: string; payload: Record<string, unknown> };

// What Devin's service answers when a quota runs out, as `devin -p` prints it (3000.12.59).
const DAILY_QUOTA =
  "Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";
const WEEKLY_QUOTA =
  "Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.";

/** A whole minute, as `/usage` prints times; `ms` from now at the least. */
const minuteAfter = (ms: number) => Math.ceil((Date.now() + ms) / 60_000) * 60_000;
/** `/usage`'s line for a window, the time in UTC as Devin prints it (`%b %-d, %-I:%M %p`). */
function usageLine(label: string, used: number, resetsAt: number) {
  const at = new Date(resetsAt);
  const month = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hour = at.getUTCHours() % 12 || 12;
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  const meridiem = at.getUTCHours() < 12 ? "AM" : "PM";
  return ` ${label}  ■■■■■■■■  ${used}% used  · resets ${month} ${at.getUTCDate()}, ${hour}:${minute} ${meridiem} (UTC+0)\n`;
}

/**
 * A Devin session in a registered workspace, run by a stand-in `devin` on PATH: its ACP turn
 * waits, answers or fails as the files beside it say and logs its prompt, the session it loads
 * and the model and permission mode set on it (as AgentKib names the mode); its interactive REPL
 * answers `/usage` with the panel in `usage-panel`, or says it has no data.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-devin-web-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    bin = path.join(root, "bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  const executable = path.join(bin, "devin");
  writeFileSync(
    executable,
    `#!/bin/sh
dir="$(dirname "$0")"
if [ "$1" = "auth" ]; then echo "Logged in as tester"; exit 0; fi
if [ "$1" = "models" ]; then cat "$dir/models.json"; exit; fi
if [ "$1" = "acp" ]; then exec "${process.execPath}" "$dir/acp.cjs"; fi
if [ $# -eq 0 ]; then echo start >> "$dir/usage.log"; exec "${process.execPath}" "$dir/repl.mjs"; fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--prompt-file" ]; then cat "$2" >> "$dir/prompts.log"; echo >> "$dir/prompts.log"; shift; fi
  if [ "$1" = "--model" ]; then echo "$2" >> "$dir/models.log"; shift; fi
  if [ "$1" = "--permission-mode" ]; then echo "$2" >> "$dir/permissions.log"; shift; fi
  if [ "$1" = "-r" ]; then echo "$2" >> "$dir/resume.log"; shift; fi
  shift
done
while [ -f "$dir/hold-turn" ]; do sleep 0.05; done
[ -f "$dir/turn-sleep" ] && sleep "$(cat "$dir/turn-sleep")"
[ -f "$dir/turn-stderr" ] && cat "$dir/turn-stderr" >&2
exit "$(cat "$dir/turn-code" 2>/dev/null || echo 0)"
`,
  );
  chmodSync(executable, 0o755);
  writeFileSync(
    path.join(bin, "acp.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const dir = ${JSON.stringify(bin)};
const file = (name) => path.join(dir, name);
const read = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : null);
const append = (name, line) => fs.appendFileSync(file(name), line + "\\n");
// Devin keeps a session's options between processes.
const saved = () => JSON.parse(read("acp-sessions.json") ?? "{}");
const names = { ask: "auto", bypass: "dangerous" };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let pending = null;
const options = (id) => {
  const declared = JSON.parse(read("declared-options") ?? "null");
  const value = { mode: "accept-edits", model: "swe-2-high", ...(declared ? { thought_level: "high" } : {}), ...saved()[id] };
  return Object.entries(value).map(([key, currentValue]) => ({ id: key, type: "select", currentValue, options: (declared?.[key] ?? []).map(value => ({ value, name: value })) }));
};
function finish(result) {
  if (!pending) return;
  const id = pending; pending = null;
  send({ jsonrpc: "2.0", id, ...result });
}
async function turn() {
  while (fs.existsSync(file("hold-turn"))) await new Promise((resolve) => setTimeout(resolve, 50));
  const wait = Number(read("turn-sleep") ?? 0);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  const stderr = read("turn-stderr") ?? "", code = Number(read("turn-code") ?? 0);
  if (stderr || code) finish({ error: { code: -32603, message: stderr || "failed" } });
  else finish({ result: { stopReason: "end_turn" } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === undefined) return;
  if (method === "initialize") {
    append("initialize.log", "initialize");
    const promptCapabilities = JSON.parse(read("prompt-capabilities") ?? "null");
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, ...(promptCapabilities && { promptCapabilities }) },
    } });
  }
  if (method === "session/new") return send({ jsonrpc: "2.0", id, result: { sessionId: read("new-session-id") ?? "new-otter", configOptions: options("") } });
  if (method === "session/load") { append("resume.log", params.sessionId); return send({ jsonrpc: "2.0", id, result: { configOptions: options(params.sessionId) } }); }
  if (method === "session/set_config_option") {
    const choices = options(params.sessionId).find(option => option.id === params.configId)?.options;
    if (choices?.length && !choices.some(choice => choice.value === params.value))
      return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
    const all = saved(); all[params.sessionId] = { ...all[params.sessionId], [params.configId]: params.value };
    fs.writeFileSync(file("acp-sessions.json"), JSON.stringify(all));
    if (params.configId === "model") append("models.log", params.value);
    if (params.configId === "thought_level") append("efforts.log", params.value);
    if (params.configId === "mode") append("permissions.log", names[params.value] ?? params.value);
    return send({ jsonrpc: "2.0", id, result: { configOptions: options(params.sessionId) } });
  }
  if (method === "session/cancel") return finish({ result: { stopReason: "cancelled" } });
  if (method === "session/prompt") {
    append("prompt-blocks.log", JSON.stringify(params.prompt));
    append("prompts.log", (params.prompt ?? []).map((block) => block.text ?? "").join(""));
    pending = id;
    return void turn();
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
`,
  );
  writeFileSync(
    path.join(bin, "repl.mjs"),
    `import { existsSync, readFileSync } from "node:fs";
const panel = ${JSON.stringify(path.join(bin, "usage-panel"))};
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\\u001b]7501;state=idle:app=devin\\u001b\\\\");
let typed = "";
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  if (text !== "\\r") return void (typed += text);
  if (typed === "/usage")
    process.stdout.write(existsSync(panel) ? readFileSync(panel, "utf8") : " No quota data available.\\n");
  typed = "";
});
process.on("SIGHUP", () => process.exit(0));
`,
  );
  const turn = ({ sleep = 0, stderr = "", code = 0, hold = false } = {}) => {
    writeFileSync(path.join(bin, "turn-sleep"), String(sleep));
    writeFileSync(path.join(bin, "turn-stderr"), stderr);
    writeFileSync(path.join(bin, "turn-code"), String(code));
    if (hold) writeFileSync(path.join(bin, "hold-turn"), "");
    else rmSync(path.join(bin, "hold-turn"), { force: true });
  };
  const usage = (...lines: string[]) =>
    writeFileSync(path.join(bin, "usage-panel"), ` Usage\n${lines.join("")}\n`);
  const models = (families: unknown[]) =>
    writeFileSync(path.join(bin, "models.json"), JSON.stringify({ families }));
  const log = (name: string) =>
    existsSync(path.join(bin, name)) ? readFileSync(path.join(bin, name), "utf8") : "";
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-16T00:00:00Z",
  );
  const native: NativeSession = {
    native_ref: "brisk-otter",
    agent: "devin",
    title: "Fix the build",
    origin: "interactive",
    created_at: "2026-11-16T00:00:00.000Z",
    updated_at: "2026-11-16T00:00:00.000Z",
    message_count: null,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
  };
  store.sessions.sync("workspace", "devin", [native]);
  const id = store.sessions.id("devin", native.native_ref);
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    DEVIN_SESSIONS_DIR: path.join(root, "devin"),
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, { profiles: () => [] });
  cleanups.push(() => readers.close());
  vi.spyOn(readers, "resolve").mockResolvedValue({
    summary: store.sessions.get(id)!,
    native,
    workspace,
  });
  // What Devin stored for the session: the prompt, and the answer that ended its turn.
  const history: ConversationEvent[] = [
    { id: "devin-m1", kind: "user-message", turn_id: "devin-m1", content: "Hello" },
    {
      id: "devin-m2",
      kind: "agent-message",
      turn_id: "devin-m1",
      message_phase: "final_answer",
      content: "Done.",
    },
  ].map((event) => ({
    timestamp: null,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
    ...(event as Partial<ConversationEvent>),
  })) as ConversationEvent[];
  vi.spyOn(readers, "eventsForNative").mockResolvedValue({
    events: history,
    next_cursor: null,
    warnings: [],
  });
  const events: Event[] = [];
  const open = () => {
    const web = new WebReadRequests(
      store,
      readers,
      root,
      () => 0n,
      environment,
      (sessionId, type, payload) => events.push({ sessionId, type, payload }),
    );
    cleanups.push(() => web.closeAsync());
    return web;
  };
  const f = {
    root,
    id,
    workspace,
    environment,
    store,
    readers,
    history,
    events,
    turn,
    usage,
    models,
    log,
    promptCapabilities: (value: Record<string, boolean> | null) =>
      writeFileSync(path.join(bin, "prompt-capabilities"), JSON.stringify(value)),
    attachment: (name: string, mime: string, bytes: Buffer) => {
      const dir = path.join(root, "attachments");
      const id = randomUUID();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, id), bytes);
      return {
        type: "acpAttachment",
        id,
        name,
        mime,
        size: bytes.length,
        version: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    web: open(),
    /** AgentKib quits and starts again on the same data. */
    async restart() {
      await f.web.closeAsync();
      f.web = open();
    },
    live: () =>
      f.web.request({ operation: "live", sessionId: id, experimentalEnabled: true }) as Promise<
        Record<string, unknown> & { usageLimit?: Record<string, unknown> | null }
      >,
    async row() {
      return (
        (await f.web.request({ operation: "catalog" })) as {
          sessions: Array<HomeSession & { continuation?: Record<string, unknown> }>;
        }
      ).sessions.find((session) => session.id === id)!;
    },
    async control(operation: string, extra: Record<string, unknown> = {}) {
      const state = await f.live();
      return f.web.managedControl({
        operation,
        sessionId: id,
        requestId: randomUUID(),
        deviceId: "phone",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        ...extra,
      }) as Promise<Record<string, unknown>>;
    },
    send: (text: string) => f.control("send", { text }),
    async features() {
      return (
        (await f.web.managedQuery({
          operation: "capabilities",
          sessionId: id,
          experimentalEnabled: true,
        })) as { features: Record<string, { available: boolean; reason?: string }> }
      ).features;
    },
    async ended() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await f.live();
        if (state.sendEnabled === true) return state;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("the turn did not end");
    },
  };
  return f;
}

describe.runIf(process.platform !== "win32")("Devin sessions run by AgentKib", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+c9esAAAAASUVORK5CYII=",
    "base64",
  );

  it("uses the negotiated prompt capability before enabling ACP attachments", async () => {
    const f = fixture();
    f.promptCapabilities({ image: true, embeddedContext: true });
    const probes = await Promise.all([f.features(), f.features()]);
    for (const features of probes) {
      expect(features.attachments).toMatchObject({
        available: true,
        attachmentKinds: { image: true, files: true },
      });
    }
    expect(f.log("initialize.log")).toBe("initialize\n");
    expect(f.log("resume.log")).toBe("");

    const input = [
      f.attachment("screenshot.png", "image/png", png),
      f.attachment("notes.txt", "text/plain", Buffer.from("Offline attachment")),
    ];
    f.turn({ hold: true });
    expect(await f.control("send", { input })).toMatchObject({ accepted: true });
    await expect.poll(() => f.log("prompt-blocks.log").trim()).not.toBe("");
    const blocks = JSON.parse(f.log("prompt-blocks.log"));
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mimeType: "image/png",
          data: png.toString("base64"),
        }),
        expect.objectContaining({ type: "text", text: expect.stringContaining("[notes.txt](") }),
      ]),
    );
    expect((await f.features()).attachments).toMatchObject({ available: false });
    f.turn();
    await f.ended();
  });

  it("sends an image as a Markdown file link when Devin accepts files only", async () => {
    const f = fixture();
    f.promptCapabilities({ image: false, resourceLink: true });
    expect((await f.features()).attachments).toMatchObject({
      available: true,
      attachmentKinds: { image: false, files: true },
    });

    const input = [f.attachment("screenshot.png", "image/png", png)];
    expect(await f.control("send", { input })).toMatchObject({ accepted: true });
    await f.ended();

    const blocks = JSON.parse(f.log("prompt-blocks.log"));
    expect(blocks).not.toContainEqual(expect.objectContaining({ type: "image" }));
    expect(blocks).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("[screenshot.png](") }),
    );
  });

  it("links a picture above the native inline budget when the negotiated file link is available", async () => {
    const f = fixture();
    f.promptCapabilities({ image: true });
    const large = Buffer.alloc(ACP_INLINE_ATTACHMENT_LIMIT + 1);
    png.copy(large);
    const input = [f.attachment("screenshot.png", "image/png", large)];

    expect(await f.control("send", { input })).toMatchObject({ accepted: true });
    await f.ended();
    const blocks = JSON.parse(f.log("prompt-blocks.log"));
    expect(blocks).toMatchObject([
      { type: "resource_link", name: "screenshot.png", mimeType: "image/png" },
      { type: "text", text: expect.stringContaining("[screenshot.png](") },
    ]);
  });

  it("refuses an over-budget native picture before Devin loads or prompts the session", async () => {
    const f = fixture();
    f.promptCapabilities({ image: true, resourceLink: false });
    const large = Buffer.alloc(ACP_INLINE_ATTACHMENT_LIMIT + 1);
    png.copy(large);
    const input = [f.attachment("screenshot.png", "image/png", large)];

    expect(await f.control("send", { input })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "attachments_too_large",
    });
    expect(f.log("resume.log")).toBe("");
    expect(f.log("prompt-blocks.log")).toBe("");
  });

  it("leaves attachments unavailable when ACP omits prompt capabilities", async () => {
    const f = fixture();
    expect((await f.features()).attachments).toMatchObject({ available: false });

    const input = [f.attachment("screenshot.png", "image/png", png)];
    expect(await f.control("send", { input })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(f.log("resume.log")).toBe("");
    expect(f.log("prompt-blocks.log")).toBe("");
  });

  it("rechecks attachment support in the actual turn before loading or sending", async () => {
    const f = fixture();
    f.promptCapabilities({ image: true, embeddedContext: true });
    expect((await f.features()).attachments).toMatchObject({ available: true });

    f.promptCapabilities(null);
    const input = [f.attachment("screenshot.png", "image/png", png)];
    expect(await f.control("send", { input })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(f.log("initialize.log")).toBe("initialize\ninitialize\n");
    expect(f.log("resume.log")).toBe("");
    expect(f.log("prompt-blocks.log")).toBe("");
    expect((await f.features()).attachments).toMatchObject({ available: false });
  });

  it("offers a thought level declared by ACP even without a matching CLI variant", async () => {
    const f = fixture();
    f.models([{ slug: "swe-2", variants: [{ model_uid: "swe-2-high" }] }]);
    vi.spyOn(f.readers, "devinSessionModel").mockReturnValue("swe-2-high");
    writeFileSync(
      path.join(f.root, "bin", "declared-options"),
      JSON.stringify({
        model: ["swe-2-high"],
        thought_level: ["high", "max"],
      }),
    );
    expect(await f.send("Read native options")).toMatchObject({ accepted: true });
    await f.ended();
    expect(
      await f.web.sessionProviderSettingsState({ operation: "settings-state", sessionId: f.id }),
    ).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "swe-2", efforts: ["high", "max"] }),
      ]),
    });
    expect(await f.control("settings", { effort: "max" })).toMatchObject({ accepted: true });
    expect(await f.send("Use native maximum")).toMatchObject({ accepted: true });
    await f.ended();
    expect(f.log("models.log")).toBe("");
    expect(f.log("efforts.log")).toBe("max\n");
  });

  it.each(["new settings", "legacy file"])(
    "uses the separate ACP thought level from %s",
    async (source) => {
      const f = fixture();
      f.models([
        { slug: "swe-2", variants: [{ model_uid: "swe-2-high" }, { model_uid: "swe-2-max" }] },
      ]);
      vi.spyOn(f.readers, "devinSessionModel").mockReturnValue("swe-2-high");
      writeFileSync(
        path.join(f.root, "bin", "declared-options"),
        JSON.stringify({
          model: ["swe-2-high"],
          thought_level: ["high", "max"],
        }),
      );
      const settingsFile = path.join(f.root, "devin-session-settings.json");
      if (source === "legacy file") {
        writeFileSync(settingsFile, JSON.stringify({ "brisk-otter": { model: "swe-2-max" } }));
      } else {
        expect(await f.control("settings", { effort: "max" })).toMatchObject({ accepted: true });
        expect(JSON.parse(readFileSync(settingsFile, "utf8"))["brisk-otter"]).toMatchObject({
          model: "swe-2",
          effort: "max",
        });
      }
      await f.restart();
      expect(
        await f.web.sessionProviderSettingsState({ operation: "settings-state", sessionId: f.id }),
      ).toMatchObject({
        selected: { model: "swe-2", effort: "max" },
      });
      expect(await f.send("Use maximum effort")).toMatchObject({ accepted: true });
      await f.ended();
      expect(f.log("models.log")).toBe("");
      expect(f.log("efforts.log")).toBe("max\n");
      expect(f.log("prompts.log")).toBe("Use maximum effort\n");
    },
  );

  it("browses its verified workspace without launching Devin or enabling native resource references", async () => {
    const f = fixture();
    const run = vi.spyOn(Commands.prototype, "run");
    expect(await f.features()).toMatchObject({
      resources: { available: true },
      files: { available: true },
      context: { available: false },
    });
    expect(await f.web.request({ operation: "resources", sessionId: f.id })).toMatchObject({
      available: true,
      executionMode: "devin-print",
      contextReferences: { supportedTypes: [] },
    });
    expect(run).not.toHaveBeenCalled();
    await expect(
      f.control("send", {
        text: "synthetic blocked ref",
        resourceRefs: [{ kind: "file", relativePath: "readme.md" }],
      }),
    ).rejects.toThrow("attachments-unsupported");
    expect(run).not.toHaveBeenCalled();
  });

  const family = "claude-opus-5.5";
  const variant = (suffix: string, tokens = 1_000_000) => ({
    model_uid: `claude-opus-5-5-${suffix}`,
    label: `Claude Opus 5.5 ${suffix}`,
    max_context_tokens: tokens,
  });

  it("uses the advertised Devin variant on the next turn and keeps unsupported choices out", async () => {
    const f = fixture();
    f.models([
      {
        slug: family,
        family_label: "Claude Opus 5.5",
        variants: [variant("low"), variant("high"), variant("high-fast")],
      },
      {
        slug: "claude-opus-4.6",
        family_label: "Claude Opus 4.6",
        variants: [
          { model_uid: "claude-opus-4-6", max_context_tokens: 200_000 },
          {
            model_uid: "claude-opus-4-6-thinking-1m",
            label: "Claude Opus 4.6 Thinking 1M",
            max_context_tokens: 1_000_000,
          },
        ],
      },
    ]);
    vi.spyOn(f.readers, "devinSessionModel").mockReturnValue(variant("high").model_uid);
    const context = vi.spyOn(f.readers, "devinLastContextInput").mockReturnValue({
      usedTokens: 45_600,
      updatedAt: "2026-11-16T00:00:00Z",
    });
    await expect(f.web.sessionProviderOptions("devin", { workspaceId: "" })).rejects.toThrow();
    const options = await f.web.sessionProviderOptions("devin", { workspaceId: "workspace" });
    expect(options).toMatchObject({
      provider: {
        create: { mode: "with-first-message", attachments: false },
        models: { selection: "variants" },
        contextUsage: "last-request",
      },
      serviceTiers: [{ id: "fast", name: "Fast" }],
      models: expect.arrayContaining([
        {
          id: family,
          name: "Claude Opus 5.5",
          efforts: ["low", "high"],
          serviceTierIds: ["fast"],
          maxContextTokens: 1_000_000,
          variants: expect.any(Array),
        },
        expect.objectContaining({ id: "claude-opus-4-6-thinking-1m", maxContextTokens: 1_000_000 }),
      ]),
    });
    expect(
      (options.models as { id: string }[]).find((model) => model.id === "claude-opus-4.6"),
    ).not.toHaveProperty("maxContextTokens");
    const state = () =>
      f.web.sessionProviderSettingsState({ operation: "settings-state", sessionId: f.id });
    expect(await state()).toMatchObject({
      provider: options.provider,
      current: { model: family, effort: "high", maxContextTokens: 1_000_000 },
      historicalUsage: {
        available: true,
        state: "stale",
        historical: true,
        reason: "devin-last-model-request",
        usedTokens: 45_600,
        contextWindow: 1_000_000,
      },
      writable: { effort: { available: true }, serviceTier: { available: true } },
    });
    expect(context).toHaveBeenCalledWith("brisk-otter", f.workspace, variant("high").model_uid);
    const usage = () => f.web.request({ operation: "usage", sessionId: f.id });
    expect(await usage()).toEqual({
      available: true,
      state: "stale",
      historical: true,
      reason: "devin-last-model-request",
      usedTokens: 45_600,
      contextWindow: 1_000_000,
      updatedAt: "2026-11-16T00:00:00Z",
    });
    context.mockReturnValueOnce({ usedTokens: 1_000_001, updatedAt: "2026-11-16T00:00:00Z" });
    expect(await usage()).toEqual({ available: false, state: "unavailable" });
    await expect(
      f.web.sessionProviderSettingsState({
        operation: "settings-state",
        sessionId: f.id,
        agent: "codex",
      }),
    ).rejects.toThrow();
    expect(await f.control("settings", { model: family })).toMatchObject({ accepted: true });
    expect(await state()).toMatchObject({ current: { model: family, effort: "high" } });
    expect(await f.control("settings", { serviceTier: "fast" })).toMatchObject({ accepted: true });
    const fast = await state();
    expect(fast).toMatchObject({
      current: {
        model: family,
        effort: "high",
        serviceTier: "fast",
        variantId: variant("high-fast").model_uid,
      },
    });
    expect(fast).not.toHaveProperty("historicalUsage");
    expect(await usage()).toEqual({ available: false, state: "unavailable" });
    expect(await f.control("settings", { effort: "low" })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "unsupported-effort",
    });
    await f.restart();
    expect(await state()).toMatchObject({ current: { effort: "high", serviceTier: "fast" } });
    expect(f.log("prompts.log")).toBe("");
    expect(f.log("resume.log")).toBe("");
    f.turn();
    expect(await f.send("Hello")).toMatchObject({ accepted: true });
    await f.ended();
    expect(f.log("models.log")).toBe(`${variant("high-fast").model_uid}\n`);
    expect(f.log("resume.log")).toBe("brisk-otter\n");
    expect(await f.control("settings", { serviceTier: null })).toMatchObject({ accepted: true });
    const normal = await state();
    expect(normal).toMatchObject({
      current: { model: family, effort: "high", variantId: variant("high").model_uid },
    });
    expect(normal.current).not.toHaveProperty("serviceTier");
    expect(normal).not.toHaveProperty("usage");
    expect(await f.control("settings", { resetDefaults: true })).toMatchObject({ accepted: true });
    await f.send("Hello");
    await f.ended();
    expect(f.log("models.log")).toBe(`${variant("high-fast").model_uid}\n`);
  });

  it("saves model, effort, and permissions during a turn for the next process only", async () => {
    const f = fixture();
    f.models([{ slug: family, variants: [variant("low"), variant("high")] }]);
    const state = () =>
      f.web.sessionProviderSettingsState({ operation: "settings-state", sessionId: f.id });

    await f.control("settings", { model: family, effort: "high", permissionMode: "auto" });
    f.turn({ hold: true });
    expect(await f.send("First turn")).toMatchObject({ accepted: true });
    const running = await f.live();
    expect(running).toMatchObject({ status: "running", sendEnabled: false });
    expect(await f.features()).toMatchObject({
      send: { available: false },
      settings: { available: true },
    });
    expect(await state()).toMatchObject({
      writable: {
        model: { available: true },
        effort: { available: true },
        permissionMode: { available: true },
      },
    });

    const update = {
      requestId: randomUUID(),
      expectedRevision: running.revision,
      model: family,
      effort: "low",
      permissionMode: "accept-edits",
    };
    const receipt = await f.control("settings", update);
    expect(receipt).toMatchObject({ accepted: true, completed: true, appliesTo: "next-turn" });
    expect(await f.control("settings", update)).toEqual(receipt);
    await expect(f.control("settings", { ...update, requestId: randomUUID() })).rejects.toThrow(
      "stale-or-disabled-control",
    );
    expect(await f.live()).toMatchObject({ status: "running", turnId: running.turnId });
    expect(await state()).toMatchObject({
      current: { model: family, effort: "high", permissionMode: "auto" },
      selected: { model: family, effort: "low", permissionMode: "accept-edits" },
    });

    f.turn();
    await f.ended();
    expect(f.log("models.log")).toBe(`${variant("high").model_uid}\n`);
    expect(f.log("permissions.log")).toBe("auto\n");
    expect(await f.send("Second turn")).toMatchObject({ accepted: true });
    await f.ended();
    expect(f.log("models.log")).toBe(`${variant("high").model_uid}\n${variant("low").model_uid}\n`);
    expect(f.log("permissions.log")).toBe("auto\naccept-edits\n");
  });

  it("starts Devin with the concrete model selected by effort and tier", async () => {
    const f = fixture();
    f.models([
      { slug: family, variants: [variant("high"), variant("high-fast"), variant("max-fast")] },
    ]);
    const { native } = await f.readers.resolve(f.id);
    const created = { ...native, native_ref: "new-otter", created_at: new Date().toISOString() };
    vi.spyOn(f.readers, "list").mockImplementation(async () => ({
      sessions: f.log("prompts.log") ? [native, created] : [native],
      incomplete: false,
    }));
    f.turn();
    const request = {
      operation: "devin-create",
      requestId: randomUUID(),
      deviceId: "phone",
      workspaceId: "workspace",
      prompt: "Hello",
      model: family,
      effort: "high",
      serviceTier: "fast",
    };
    await expect(f.web.devinCreate({ ...request, operation: "create" })).rejects.toThrow();
    expect(await f.web.devinCreate({ ...request, effort: "low" })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "unsupported-effort",
    });
    expect(
      await f.web.devinCreate({ ...request, requestId: randomUUID(), effort: undefined }),
    ).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "unsupported-service-tier",
    });
    expect(f.log("prompts.log")).toBe("");
    const { operation, ...fields } = request;
    const create = { ...fields, requestId: randomUUID() };
    const createdResult = await f.web.sessionProviderCreate("devin", create);
    expect(createdResult).toMatchObject({
      accepted: true,
      sessionId: f.store.sessions.id("devin", created.native_ref),
    });
    expect(await f.web.devinCreate({ ...create, operation })).toEqual(createdResult);
    await expect(
      f.web.sessionProviderCreate("devin", { ...create, prompt: "Changed" }),
    ).rejects.toThrow("request-id-reused-with-different-input");
    expect(f.log("models.log")).toBe(`${variant("high-fast").model_uid}\n`);
  });

  it("names the session's workspace in its live state and in what it publishes", async () => {
    const f = fixture();
    expect(await f.live()).toMatchObject({
      executionMode: "devin-print",
      status: "idle",
      workspaceId: "workspace",
    });
    f.turn();
    expect(await f.send("Hello")).toMatchObject({ accepted: true });
    await f.ended();
    const states = f.events.filter((event) => event.type === "state");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.sessionId).toBe(f.id);
      // Clients merge a state event into the live state: its fields are at the top.
      expect(state.payload).toMatchObject({
        executionMode: "devin-print",
        workspaceId: "workspace",
      });
      expect(state.payload).not.toHaveProperty("live");
    }
    expect(states.map((state) => state.payload.status)).toContain("running");
    expect(states.at(-1)!.payload).toMatchObject({ status: "idle", sendEnabled: true });
  });

  it("lists a running turn in the catalog, so the home and the quit confirmation count it", async () => {
    const f = fixture();
    // Before AgentKib holds a runner the row says nothing about a turn.
    expect((await f.row()).continuation).toBeUndefined();
    f.turn({ sleep: 2 });
    await f.send("Long task");
    const running = await f.row();
    expect(running.continuation).toMatchObject({
      status: "running",
      executionLocation: "agentkib",
    });
    expect(workStoppedByQuit([running]).map((session) => session.id)).toEqual([f.id]);
    await f.ended();
    const idle = await f.row();
    expect(idle.continuation).toMatchObject({ status: "idle", reason: null });
    expect(workStoppedByQuit([idle])).toEqual([]);
  });

  it("explains a usage limit whose reset Devin's /usage does not tell, with no continue", async () => {
    const f = fixture();
    f.turn({ stderr: `Error: ${WEEKLY_QUOTA}\n`, code: 1 });
    await f.send("Hello");
    expect(await f.ended()).toMatchObject({
      status: "idle",
      reason: null,
      usageLimit: {
        agent: "devin",
        kind: "weekly",
        resetsAt: null,
        continueAt: null,
        manual: "reset-unknown",
      },
    });
    // `/usage` was asked once, in a terminal of its own, and said it has no data.
    await vi.waitFor(() => expect(f.log("usage.log")).toBe("start\n"));
    const features = await f.features();
    expect(features["usage-limit-continue"]?.available).toBe(false);
    expect(features["usage-limit-cancel"]?.available).toBe(false);
  });
});

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "a Devin turn that meets the usage limit",
  { timeout: 30_000 },
  () => {
    it("says when the limit resets, from Devin's /usage, and continues on its own after it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
      vi.spyOn(Math, "random").mockReturnValue(0);
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Daily", 100, resetsAt), usageLine("Weekly", 64, resetsAt + 86_400_000));
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      // The notice says so at once, and when it resets once /usage has answered.
      expect((await f.ended()).usageLimit).toMatchObject({ manual: "reset-unknown" });
      await vi.waitFor(
        async () =>
          expect((await f.live()).usageLimit).toEqual({
            agent: "devin",
            resetsAt,
            kind: null,
            scope: null,
            message: DAILY_QUOTA,
            continueAt: resetsAt + 30_000,
            manual: null,
            autoContinues: 0,
          }),
        { timeout: 15_000 },
      );
      expect(f.log("usage.log")).toBe("start\n");
      expect((await f.features())["usage-limit-cancel"]).toEqual({ available: true });
      f.turn();
      await vi.advanceTimersByTimeAsync(resetsAt + 30_000 - Date.now() + 1_000);
      await vi.waitFor(() => expect(f.log("prompts.log")).toContain(AUTO_CONTINUE_TEXT.devin), {
        timeout: 10_000,
      });
      // The continue went through: the limit is over, also for a later run of AgentKib.
      await vi.waitFor(async () => expect((await f.live()).usageLimit ?? null).toBeNull(), {
        timeout: 10_000,
      });
      expect((await f.ended()).usageLimit ?? null).toBeNull();
      expect(readManagedUsageLimit(f.root, f.id)).toBeNull();
    });

    it("gives way to the person's message, and can be turned off and on again", async () => {
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Weekly", 100, resetsAt));
      f.turn({ stderr: `Error: ${WEEKLY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await vi.waitFor(
        async () =>
          expect((await f.live()).usageLimit).toMatchObject({
            kind: "weekly",
            resetsAt,
            manual: null,
          }),
        { timeout: 15_000 },
      );
      expect(await f.control("usage-limit-cancel")).toMatchObject({
        accepted: true,
        completed: true,
      });
      expect((await f.live()).usageLimit).toMatchObject({ continueAt: null, manual: "cancelled" });
      const features = await f.features();
      expect(features["usage-limit-cancel"]?.available).toBe(false);
      expect(features["usage-limit-continue"]).toEqual({ available: true });
      expect(await f.control("usage-limit-continue")).toMatchObject({ accepted: true });
      expect((await f.live()).usageLimit).toMatchObject({ manual: null, autoContinues: 0 });
      expect(typeof (await f.live()).usageLimit?.continueAt).toBe("number");
      // A message the person sends takes over; nothing is kept for a later run either.
      f.turn({ sleep: 1 });
      await f.send("Carry on");
      expect((await f.live()).usageLimit ?? null).toBeNull();
      expect(readManagedUsageLimit(f.root, f.id)).toBeNull();
      await f.ended();
      expect(f.log("prompts.log")).not.toContain(AUTO_CONTINUE_TEXT.devin);
    });

    it("keeps the notice through a restart, for the person to continue", async () => {
      const f = fixture();
      const resetsAt = minuteAfter(60 * 60_000);
      f.usage(usageLine("Daily", 100, resetsAt));
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await vi.waitFor(
        async () => expect((await f.live()).usageLimit).toMatchObject({ manual: null }),
        { timeout: 15_000 },
      );
      await f.restart();
      // AgentKib's continue ended with the run that armed it; the notice stays.
      expect((await f.live()).usageLimit).toMatchObject({
        agent: "devin",
        resetsAt,
        message: DAILY_QUOTA,
        continueAt: null,
        manual: "restarted",
      });
      const features = await f.features();
      expect(features["usage-limit-cancel"]?.available).toBe(false);
      expect(features["usage-limit-continue"]).toEqual({ available: true });
      // The next turn ends it.
      f.turn();
      await f.send("Carry on");
      await f.ended();
      await f.restart();
      expect((await f.live()).usageLimit ?? null).toBeNull();
    });

    it("keeps a notice without a reset time through a restart as it was", async () => {
      const f = fixture();
      f.turn({ stderr: `Error: ${DAILY_QUOTA}\n`, code: 1 });
      await f.send("Hello");
      await f.ended();
      await vi.waitFor(() => expect(f.log("usage.log")).toBe("start\n"));
      await f.restart();
      expect((await f.live()).usageLimit).toMatchObject({
        message: DAILY_QUOTA,
        continueAt: null,
        manual: "reset-unknown",
      });
    });
  },
);

describe.runIf(process.platform !== "win32")("a Devin turn's result", () => {
  it("is recorded as each turn AgentKib ran ends: answered, failed or stopped", async () => {
    const f = fixture();
    const results: Array<{ target: Record<string, unknown>; result: Record<string, unknown> }> = [];
    f.web.observeResults((target, result) => results.push({ target, result }));
    f.turn();
    await f.send("Hello");
    await f.ended();
    f.turn({ stderr: "Error: something broke\n", code: 2 });
    await f.send("Again");
    await f.ended();
    f.turn({ sleep: 30 });
    await f.send("Long task");
    const running = await f.live();
    await f.control("stop", { turnId: running.turnId });
    await f.ended();
    expect(results.map(({ result }) => result.outcome)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const { target, result } of results) {
      expect(target).toEqual({
        provider: "devin",
        home: path.join(f.root, "devin", "cli"),
        nativeId: "brisk-otter",
        workspace: f.workspace,
      });
      // The answer in the session's history is what reading it means.
      expect(result).toMatchObject({ turnId: "devin-m1", itemId: "devin-m2" });
      expect(result.id).toMatch(/^turn:/);
    }
  });

  it("is unread on the home until read, which the phone's alerts follow", async () => {
    const f = fixture();
    const reads = new ConversationReadStates(
      f.store,
      f.readers,
      f.root,
      f.environment,
      () => null,
      () => undefined,
      () => false,
    );
    cleanups.push(() => reads.close());
    f.web.observeResults((target, result) => reads.recordTerminal(target, result));
    // A session none of whose turns AgentKib ran has nothing to read.
    expect(await reads.get(f.id, "desktop")).toMatchObject({
      source: "agentkib",
      status: "read",
      freshness: "current",
    });
    f.turn({ sleep: 1 });
    await f.send("Hello");
    expect(homeSessionGroups([await f.row()]).running).toHaveLength(1);
    await f.ended();
    const unread = await reads.get(f.id, "desktop");
    expect(unread).toMatchObject({
      source: "agentkib",
      status: "unread",
      freshness: "current",
      firstUnread: { type: "result", turnId: "devin-m1" },
      latestResult: { outcome: "completed", turnId: "devin-m1", itemId: "devin-m2" },
    });
    const [row] = reads.project([await f.row()], "desktop");
    expect(homeSessionGroups([row!]).review).toEqual([{ session: row, result: "completed" }]);
    const read = await reads.update(f.id, "desktop", unread.version!, unread.latestResult!.id);
    expect(read).toMatchObject({ status: "read", freshness: "current" });
    expect(homeSessionGroups(reads.project([await f.row()], "desktop")).review).toEqual([]);
    // Each reader keeps its own place: the phone's has not read it yet.
    expect(await reads.get(f.id, "local")).toMatchObject({ status: "unread" });
  });
});

describe.runIf(process.platform !== "win32")("restart of a managed Devin Worker", () => {
  async function restart(f: ReturnType<typeof fixture>) {
    const provider = f.web.devinSessionProvider() as DevinSessionProvider;
    const live = await f.live();
    const request: WorkerRestartRequest = {
      sessionId: f.id,
      workspaceId: "workspace",
      deviceId: "phone",
      requestId: randomUUID(),
      runtimeBootId: String(live.runtimeBootId),
      expectedRevision: Number(live.revision),
      turnId: typeof live.turnId === "string" ? live.turnId : null,
      experimentalEnabled: true,
    };
    const admit = vi.fn();
    const { requestId, deviceId } = request;
    return {
      admit,
      send: () => provider.restartWorker(request, admit),
      receipt: () => readControlReceipt(f.root, { requestId, deviceId }),
    };
  }

  it("recycles only its running process and keeps the native session and its host queue", async () => {
    const f = fixture();
    const cliData = path.join(f.environment.DEVIN_SESSIONS_DIR, "cli");
    mkdirSync(cliData, { recursive: true });
    const native = new DatabaseSync(path.join(cliData, "sessions.db"));
    try {
      native.exec(`
        CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, title TEXT,
          created_at INTEGER, last_activity_at INTEGER, hidden INTEGER, main_chain_id INTEGER);
        CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER,
          chat_message TEXT, metadata TEXT, created_at INTEGER);
      `);
      native
        .prepare("INSERT INTO sessions VALUES ('brisk-otter', ?, 'Fixture', 1, 2, 0, 2)")
        .run(f.workspace);
      const insert = native.prepare(
        "INSERT INTO message_nodes VALUES ('brisk-otter', ?, ?, ?, NULL, ?)",
      );
      insert.run(
        1,
        null,
        JSON.stringify({ role: "user", content: "Hello", metadata: { is_user_input: true } }),
        1,
      );
      insert.run(2, 1, JSON.stringify({ role: "assistant", content: "Done." }), 2);
    } finally {
      native.close();
    }
    f.turn({ hold: true });
    expect(await f.send("Running work")).toMatchObject({ accepted: true });
    await expect.poll(() => f.log("resume.log")).toBe("brisk-otter\n");
    const queue = () => f.web.managedQueueList({ operation: "queue-list", sessionId: f.id });
    const history = () => f.web.request({ operation: "events", sessionId: f.id, limit: 20 });
    expect(await f.control("queue-add", { text: "Waiting work" })).toMatchObject({
      accepted: true,
    });
    expect(await f.control("queue-pause")).toMatchObject({ accepted: true });
    const pending = await queue();
    expect(pending).toMatchObject({
      paused: true,
      data: [{ status: "pending", text: "Waiting work" }],
    });
    const previous = await history();
    expect(previous).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "user-message", content: "Hello" }),
        expect.objectContaining({ kind: "agent-message", content: "Done." }),
      ]),
    });

    const { admit, send, receipt } = await restart(f);
    const result = await send();
    expect(result).toEqual({ accepted: true, controlOutcome: "accepted" });
    expect(receipt()).toMatchObject({ status: "accepted" });
    expect(await send()).toEqual(result);
    expect(admit).toHaveBeenCalledTimes(1);
    await f.ended();
    expect(await queue()).toEqual(pending);
    expect(await history()).toEqual(previous);

    f.turn();
    expect(await f.send("Continue the same conversation")).toMatchObject({
      sessionId: f.id,
      accepted: true,
    });
    await f.ended();
    expect(f.log("resume.log").trim().split("\n")).toEqual(["brisk-otter", "brisk-otter"]);
  }, 15_000);

  it("refuses a session when AgentKib owns no process for it", async () => {
    const f = fixture();
    const { admit, send } = await restart(f);
    expect(await send()).toEqual({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-user-only",
    });
    expect(admit).not.toHaveBeenCalled();
    expect(f.log("resume.log")).toBe("");
  });

  it("replays an unknown stop receipt without sending another signal", async () => {
    const f = fixture();
    f.turn({ hold: true });
    expect(await f.send("Running work")).toMatchObject({ accepted: true });
    const nativeStop = DevinManagedRunner.prototype.stop;
    const stop = vi.spyOn(DevinManagedRunner.prototype, "stop").mockImplementation(async function (
      this: DevinManagedRunner,
      ...args
    ) {
      await nativeStop.call(this, ...args);
      throw new Error("stop-acknowledgement-lost");
    });
    const { admit, send, receipt } = await restart(f);
    expect(await send()).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(receipt()).toMatchObject({ status: "unknown" });
    expect(await send()).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await f.ended();
  }, 15_000);
});

describe.runIf(process.platform !== "win32")("an assigned Devin Worker", () => {
  function project(f: ReturnType<typeof fixture>) {
    const lead = "fixture-lead";
    const reports: string[] = [];
    const orchestration = new OrchestrationService(
      f.root,
      "fixture-boot",
      {
        control: (value) => f.web.managedControl(value),
        live: () => f.live(),
        events: async (_sessionId, limit) => f.history.slice(-limit),
        endedTurns: (id) => f.web.devinEndedTurns(id),
        session: (id) =>
          id === f.id ? { agent: "devin", workspaceId: "workspace", title: null } : null,
        managed: async () => true,
        workspaces: () => [{ id: "workspace", name: "Fixture" }],
      },
      (id) => id === lead,
      (_id, _device, text) => {
        reports.push(text);
        return false;
      },
    );
    cleanups.push(() => orchestration.close());
    return {
      orchestration,
      reports,
      assign: () =>
        orchestration.assignWorkers({
          sessionId: lead,
          deviceId: "desktop-local",
          workspaceId: "workspace",
          workers: [f.id],
        }),
      call: async (name: string, input: Record<string, unknown>) =>
        JSON.parse((await orchestration.call(lead, name, input)).text),
    };
  }

  function recordAnswer(f: ReturnType<typeof fixture>, prompt: string, reply: string) {
    const turnId = `worker-${f.history.length}`;
    const timestamp = new Date().toISOString();
    f.history.push(
      { ...f.history[0]!, id: turnId, turn_id: turnId, content: prompt, timestamp },
      { ...f.history[1]!, id: `${turnId}-answer`, turn_id: turnId, content: reply, timestamp },
    );
    return turnId;
  }

  it("sends tasks, reports the observed reply and stops without quoting a prior turn", async () => {
    const f = fixture();
    const { orchestration, reports, assign, call } = project(f);
    const observed: Array<{ turnId: string; historyTurnId: string | undefined }> = [];
    const waiting = vi.fn();
    f.web.observeLanes({
      turnEnded: (id, turnId, outcome, durationMs, historyTurnId, replyText) => {
        observed.push({ turnId, historyTurnId });
        void orchestration.laneTurnEnded(id, turnId, outcome, durationMs, historyTurnId, replyText);
      },
      waiting,
    });
    await assign();
    expect(
      await f.control("settings", { model: "saved-model", permissionMode: "auto" }),
    ).toMatchObject({ accepted: true });
    f.turn({ hold: true });
    expect(
      await call("worker_send", { worker: "worker-1", text: "Run the fixture" }),
    ).toMatchObject({
      accepted: true,
      operation: "send",
    });
    const first = await f.live();
    expect(first).toMatchObject({ status: "running", approvals: [], questions: [] });
    expect(
      await call("worker_send", { worker: "worker-1", text: "Do not insert", mode: "steer" }),
    ).toEqual({ accepted: false, reason: "steer-unsupported" });
    const historyTurnId = recordAnswer(f, "Run the fixture", "Fixture complete");
    f.turn();
    await f.ended();
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toMatch(/Worker "worker-1" \(Devin\) · turn ended: completed after /);
    expect(reports[0]).toContain("Fixture complete");
    expect(observed).toEqual([{ turnId: first.turnId, historyTurnId }]);
    const worker = await call("worker_read", { worker: "worker-1" });
    expect(worker).toMatchObject({
      status: "idle",
      replies: expect.arrayContaining([expect.objectContaining({ text: "Fixture complete" })]),
    });
    expect(worker).not.toHaveProperty("waiting");
    expect(f.log("prompts.log")).toContain("Run the fixture");
    expect(f.log("models.log")).toBe("saved-model\n");
    expect(f.log("permissions.log")).toBe("auto\n");

    f.turn({ hold: true });
    expect(await call("worker_send", { worker: "worker-1", text: "Stop this turn" })).toMatchObject(
      {
        accepted: true,
      },
    );
    const second = await f.live();
    expect(await call("worker_stop", { worker: "worker-1" })).toMatchObject({ accepted: true });
    await f.ended();
    await expect.poll(() => reports.length).toBe(2);
    expect(reports[1]).toContain("turn ended: cancelled");
    expect(reports[1]).not.toContain("Fixture complete");
    expect(observed[1]).toEqual({ turnId: second.turnId, historyTurnId: undefined });
    // Nothing waits for an answer; Devin asks no free-form questions over ACP.
    expect(await f.features()).toMatchObject({
      approve: { available: false },
      answer: { available: false, reason: "unsupported-operation" },
    });
    expect(waiting).not.toHaveBeenCalled();
  }, 15_000);

  it("recovers only stored post-assignment terminal results, once after restart", async () => {
    const f = fixture();
    const readStates = new ConversationReadStates(
      f.store,
      f.readers,
      f.root,
      f.environment,
      () => null,
      () => undefined,
      () => false,
    );
    cleanups.push(() => readStates.close());
    f.web.observeResults((target, result, options) =>
      readStates.recordTerminal(target, result, options),
    );
    f.turn();
    await f.send("Before assignment");
    await f.ended();
    const { orchestration, reports, assign, call } = project(f);
    await assign();

    // Only read state hears this result. Worker report delivery was unavailable.
    f.turn({ hold: true });
    expect(
      await call("worker_send", { worker: "worker-1", text: "Recover this task" }),
    ).toMatchObject({ accepted: true });
    const live = await f.live();
    const historyTurnId = recordAnswer(f, "Recover this task", "Recovered fixture reply");
    f.turn();
    await f.ended();
    readStates.recordTerminal(
      {
        provider: "devin",
        home: path.join(f.root, "devin", "cli"),
        nativeId: "brisk-otter",
        workspace: f.workspace,
      },
      {
        id: "turn:legacy-completion",
        turnId: null,
        itemId: null,
        outcome: "completed",
        completedAt: new Date().toISOString(),
      },
    );
    await f.restart();
    recordAnswer(f, "Sent in a native client", "No stored terminal evidence");
    const turns = await f.web.devinEndedTurns(f.id);
    expect(turns).toHaveLength(2);
    expect(turns.at(-1)).toMatchObject({
      turnId: live.turnId,
      outcome: "completed",
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      historyTurnId,
      replyText: "Recovered fixture reply",
    });
    const later = Date.now() + 60_000;
    await orchestration.catchUp(later);
    await orchestration.catchUp(later);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Recovered fixture reply");
    expect(reports[0]).not.toContain("No stored terminal evidence");
  }, 15_000);
});
