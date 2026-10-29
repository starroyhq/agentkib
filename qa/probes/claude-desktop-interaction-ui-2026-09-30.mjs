// One real UI turn. This helper prepares an isolated workspace or reads evidence;
// it never sends, approves, or answers a model request.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
const repo = resolve(import.meta.dirname, "../..");
const root = "/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30";
const settings = "/Users/user/.claude/settings.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = {
  root,
  workspace: join(root, "workspace"),
  config: join(root, "claude-config"),
  data: join(root, "runtime-data"),
  profile: join(root, "electron-profile"),
  bin: join(root, "bin"),
};
if (process.argv[2] === "prepare") {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "attempt.json"),
    JSON.stringify({ started: new Date().toISOString(), maxUserTurns: 1 }),
    { flag: "wx", mode: 0o600 },
  );
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await mkdir(join(paths.workspace, ".claude"), { mode: 0o700 });
  await writeFile(
    join(paths.workspace, ".claude/settings.local.json"),
    JSON.stringify({ permissions: { ask: ["Write", "Edit", "Bash"] } }),
    { mode: 0o600 },
  );
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  await writeFile(
    join(paths.data, "preferences.json"),
    JSON.stringify({
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      close_behavior: "quit",
    }),
    { mode: 0o600 },
  );
  const marker = randomUUID();
  const output = join(paths.workspace, "ui-approved-marker.txt");
  const prompt = `This is a synthetic desktop UI tool test. In this single turn: (1) Use Write exactly once to create ${output} containing exactly ${marker}. Do not use Bash or Edit. Wait for the tool result. (2) Use AskUserQuestion exactly once with a single-select question "Which synthetic namespace should this desktop test use?", header "Namespace", and choices "cobalt-lake" and "amber-ridge" with short descriptions. Wait for the user's tool answer, do not answer yourself. (3) Reply briefly with the exact marker and selected namespace. Do not use further tools or inspect unrelated files.`;
  await writeFile(join(root, "prompt.txt"), prompt, { mode: 0o600 });
  const wrapper = `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '/Users/user/.local/bin/claude' "$@"; fi\nif ! (set -C; : > '${root}/launch.once') 2>/dev/null; then exit 76; fi\nprintf 'launch\\n' >> '${root}/model-launches'\nexec '/Users/user/.local/bin/claude' --settings '${settings}' --safe-mode --setting-sources local --strict-mcp-config --permission-mode default --max-budget-usd 0.50 --model deepseek-v4-pro "$@"\n`;
  await writeFile(join(paths.bin, "claude"), wrapper, { mode: 0o700 });
  const runtime = join(repo, "target/debug/agentkib-runtime");
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: paths.config,
    AGENTKIB_BENCHMARK_DATA_DIR: paths.data,
    PATH: `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const child = spawn(runtime, [], {
    cwd: paths.workspace,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    const done = pending.get(value.id);
    if (!done) return;
    pending.delete(value.id);
    value.error ? done.reject(new Error(value.error.message)) : done.resolve(value.result);
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const seq = ++id;
      pending.set(seq, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: seq, method, params }) + "\n");
    });
  const version = Number(
    (
      await readFile(join(repo, "apps/desktop/electron/generated/runtime-protocol.ts"), "utf8")
    ).match(/PROTOCOL_VERSION = (\d+)/)[1],
  );
  await rpc("agentkib.handshake", {
    protocolVersion: version,
    client: { name: "desktop-ui-fixture", version: "0.12.0" },
  });
  const workspace = await rpc("workspace.add", { path: paths.workspace });
  child.stdin.end();
  await new Promise((done) => child.once("exit", done));
  await writeFile(
    join(root, "fixture.json"),
    JSON.stringify(
      {
        ...paths,
        marker,
        output,
        workspaceId: workspace.id,
        settingsBefore: sha(await readFile(settings)),
        runtimeSha256: sha(await readFile(runtime)),
        model: "deepseek-v4-pro",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ root, workspaceId: workspace.id, marker, prompt }, null, 2));
} else if (process.argv[2] === "verify") {
  const fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
  const files = (await readdir(join(paths.config, "projects"), { recursive: true })).filter(
    (file) => file.endsWith(".jsonl"),
  );
  const entries = [];
  for (const file of files)
    for (const line of (await readFile(join(paths.config, "projects", file), "utf8"))
      .split("\n")
      .filter(Boolean))
      entries.push(JSON.parse(line));
  const blocks = entries.flatMap((entry) =>
    Array.isArray(entry.message?.content) ? entry.message.content : [],
  );
  const assistants = entries
    .filter((entry) => entry.type === "assistant")
    .flatMap((entry) =>
      Array.isArray(entry.message?.content)
        ? entry.message.content.filter((block) => block.type === "text").map((block) => block.text)
        : [],
    );
  const tools = blocks.filter((block) => block.type === "tool_use");
  const results = blocks.filter((block) => block.type === "tool_result");
  const records = await readdir(join(paths.data, "claude-managed"));
  const metas = [];
  for (const file of records.filter((file) => file.endsWith(".json")))
    metas.push(JSON.parse(await readFile(join(paths.data, "claude-managed", file), "utf8")));
  const result = {
    root,
    settingsUnchanged: sha(await readFile(settings)) === fixture.settingsBefore,
    runtimeSha256: fixture.runtimeSha256,
    nativeSessionFiles: files.length,
    launchCount: (await readFile(join(root, "model-launches"), "utf8")).trim().split("\n").length,
    userTurns: entries.filter(
      (entry) =>
        entry.type === "user" &&
        (typeof entry.message?.content === "string" ||
          entry.message?.content?.some((block) => block.type === "text")),
    ).length,
    tools: tools.map((tool) => tool.name),
    allToolsHaveSuccessfulResult: tools.every((tool) =>
      results.some((result) => result.tool_use_id === tool.id && !result.is_error),
    ),
    successfulToolResults: results.filter((result) => !result.is_error).length,
    toolResults: results.map((result) => ({
      toolUseId: result.tool_use_id,
      isError: result.is_error ?? false,
      content: result.content,
    })),
    reply: assistants.join("\n"),
    fileMatches: (await readFile(fixture.output, "utf8")).trim() === fixture.marker,
    markerInReply: assistants.join("\n").includes(fixture.marker),
    answerInReply: assistants.join("\n").includes("cobalt-lake"),
    model: metas[0]?.snapshot?.model,
    usage: metas[0]?.snapshot?.tokenUsage,
    status: metas[0]?.snapshot?.status,
    sessionId: metas[0]?.id,
    nativeId: metas[0]?.nativeId,
    apiErrors: entries.filter((entry) => entry.subtype === "api_error").length,
  };
  await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.allToolsHaveSuccessfulResult ||
    !result.settingsUnchanged ||
    result.launchCount !== 1 ||
    result.userTurns !== 1 ||
    !result.fileMatches ||
    !result.markerInReply ||
    !result.answerInReply ||
    result.status !== "idle" ||
    JSON.stringify(result.tools) !== JSON.stringify(["Write", "AskUserQuestion"])
  )
    process.exitCode = 1;
} else throw new Error("Use prepare or verify; UI actions must happen in Electron.");
