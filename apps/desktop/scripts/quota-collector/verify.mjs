// Real collector acceptance uses only synthetic local histories and private caches.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { binaryPath, hostTarget, preparedManifest, prepareSources, run } from "./build.mjs";

const target = process.env.AGENTKIB_QUOTA_TARGET ?? hostTarget();
const manifest = await preparedManifest(target);
assert(manifest, `Missing verified patched collector for ${target}; prepare it first`);
const executable = binaryPath(target);
const directory = await mkdtemp(path.join(tmpdir(), "agentkib-native-cost-"));
try {
  const codex = path.join(directory, "codex");
  const claude = path.join(directory, "claude");
  const cache = path.join(directory, "cache");
  for (const folder of [
    codex,
    claude,
    cache,
    path.join(directory, "appdata"),
    path.join(directory, "localappdata"),
  ])
    await mkdir(folder, { recursive: true });
  const configuration = path.join(directory, "config.json");
  await writeFile(
    configuration,
    JSON.stringify(
      process.platform === "win32"
        ? { enabled_providers: ["codex", "claude"], open_codex_usage_logs_enabled: true }
        : {
            version: 1,
            providers: [
              { id: "codex", enabled: true },
              { id: "claude", enabled: true },
            ],
          },
    ),
  );
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"),
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"),
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
    CODEXBAR_CONFIG: configuration,
    AGENTKIB_COST_CACHE: cache,
    // No credentials are inherited. Pricing lookups fail immediately; built-in prices remain usable.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    TZ: "UTC",
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
  };
  if (process.platform !== "win32") {
    const resources = spawnSync(executable, [], {
      cwd: directory,
      env: { ...env, CODEXBAR_RESOURCE_SMOKE: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(resources.status, 0, resources.stderr);
    assert.match(resources.stdout, /CODEXBAR_RESOURCE_SMOKE_OK/);
  }
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const codexEvents = [
    {
      type: "session_meta",
      timestamp: now,
      payload: { id: "synthetic-cost", session_id: "synthetic-cost", cwd: "/synthetic/no-project" },
    },
    { type: "turn_context", timestamp: now, payload: { model: "gpt-5.4" } },
    {
      type: "event_msg",
      timestamp: now,
      payload: {
        type: "token_count",
        info: {
          model: "gpt-5.4",
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
          },
        },
      },
    },
  ];
  const nativeCodex = path.join(codex, "sessions", ...today.split("-"));
  await mkdir(nativeCodex, { recursive: true });
  await writeFile(
    path.join(nativeCodex, "rollout-synthetic.jsonl"),
    `${codexEvents.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const claudeEvent = {
    type: "assistant",
    timestamp: now,
    uuid: "synthetic-response",
    requestId: "synthetic-request",
    message: {
      id: "synthetic-message",
      model: "claude-sonnet-4-5-20250929",
      role: "assistant",
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    },
  };
  await mkdir(path.join(claude, "projects/synthetic"), { recursive: true });
  await writeFile(
    path.join(claude, "projects/synthetic/synthetic.jsonl"),
    `${JSON.stringify(claudeEvent)}\n`,
  );
  // An extra imported/swap profile must not contribute to the strict scope.
  const imported = path.join(directory, ".claude-swap-backup/sessions/1-other/projects/other");
  await mkdir(imported, { recursive: true });
  await writeFile(
    path.join(imported, "ignored.jsonl"),
    `${JSON.stringify({ ...claudeEvent, uuid: "ignored", requestId: "ignored", message: { ...claudeEvent.message, id: "ignored", usage: { input_tokens: 999999, output_tokens: 999999 } } })}\n`,
  );

  for (const provider of ["codex", "claude"]) {
    const args = [
      "cost",
      "--provider",
      provider,
      "--format",
      "json",
      "--days",
      "30",
      "--provider-native-only",
      "--agentkib-native-only",
    ];
    if (process.platform !== "win32") args.push("--json-only");
    const output = spawnSync(executable, args, {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(output.error, undefined, output.error?.message);
    const rows = JSON.parse(output.stdout);
    const row = rows.find((value) => value.provider === provider);
    assert.equal(row?.agentkibNativeOnly, true, output.stderr || "Missing native scope proof");
    assert.equal(rows.length, 1, "No additional tool source may be appended");
    const tokens = process.platform === "win32" ? row.totals?.totalTokens : row.last30DaysTokens;
    assert.equal(
      tokens,
      provider === "codex" ? 110 : 135,
      "Native totals must exclude imported histories and avoid cache-token double counting",
    );
    const daily = process.platform === "win32" ? row.spendContract?.daily : row.daily;
    assert(
      daily?.some((entry) => (entry.day ?? entry.date) === today && entry.totalTokens === tokens),
    );
    const outputPath = process.env.AGENTKIB_QUOTA_FIXTURE_OUTPUT;
    if (outputPath) {
      await mkdir(outputPath, { recursive: true });
      await writeFile(
        path.join(outputPath, `${process.platform}-${provider}.json`),
        `${JSON.stringify(row, null, 2)}\n`,
      );
    }
    process.stdout.write(`Verified real native ${provider} cost JSON and isolated source scope.\n`);
  }
  if (process.argv.includes("--source-tests")) {
    const { source } = await prepareSources(target);
    if (process.platform === "win32") {
      run("cargo", ["test", "--locked", "--package", "codexbar", "--lib", "agentkib_tests"], {
        cwd: source,
      });
      run(
        "cargo",
        ["test", "--locked", "--package", "codexbar", "--lib", "cli::serve::dashboard::snapshot"],
        { cwd: source },
      );
    } else {
      assert.equal(
        process.platform,
        "darwin",
        "Swift source patch tests must run on macOS; Linux validates the native CLI separately",
      );
      run(
        "swift",
        [
          "test",
          "--disable-automatic-resolution",
          "-j",
          "2",
          "--filter",
          "AgentKibDashboardTests|DashboardSnapshotBuilderTests|DashboardManagedCodexSnapshotTests|DashboardAntigravityWindowTests",
        ],
        { cwd: source },
      );
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
