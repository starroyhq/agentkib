import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { Commands } from "../../../packages/backend/src/commands";
import { QuotaOwner } from "../../../packages/backend/src/quota";
import { sanitizeHandoffExport } from "../../../packages/backend/src/session-handoff";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

const previousTime = "2026-09-09T14:15:32.000Z";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentkib-quota-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  const run = vi.spyOn(commands, "run");
  const sidecar = path.join(root, "collector");
  const config = path.join(root, "config.json");
  writeFileSync(sidecar, "synthetic executable, intercepted at process boundary");
  writeFileSync(config, '{"version":1,"providers":[{"id":"codex","enabled":true}]}');
  const owner = new QuotaOwner(store, commands, root, {
    AGENTKIB_QUOTA_SIDECAR: sidecar,
    CODEXBAR_CONFIG: config,
    // Keep Windows proxy discovery from invoking a separate command.
    HTTPS_PROXY: "http://127.0.0.1:1",
  });
  cleanups.push(() => owner.stop());
  store.saveQuotaSnapshot({
    backend: "codex-bar-cli",
    generated_at: previousTime,
    fetched_at: previousTime,
    stale_after_seconds: 180,
    providers: [{ id: "codex", windows: [{ remaining_percent: 13 }] }],
  });
  const before = store.quotaCollectorStatus({
    backend: "codex-bar-cli",
    platform_supported: true,
    sidecar_available: true,
    config_source: "environment",
    running: false,
  });
  let expectedCalls = 1;
  function respond(providers: unknown[]) {
    const enabled = (providers as Array<{ id: string; enabled: boolean }>).filter(
      (entry) => entry.enabled,
    );
    expectedCalls = enabled.length;
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        providers: enabled.map((entry) => ({ id: entry.id, enabled: true })),
      }),
    );
    const snapshot = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: 180,
      host: { codexBarVersion: "fixture" },
      providers,
    };
    run.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify(snapshot)),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
  }
  return { store, owner, run, before, respond, expectedCalls: () => expectedCalls };
}

function window(remaining = 57) {
  return {
    kind: "weekly",
    label: "Weekly",
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
  };
}
function provider(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    enabled: true,
    windows: [],
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("quota collection diagnostics and partial results", () => {
  it("saves current Codex and Claude quota when only their separate cost scans timed out", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        windows: [window()],
        error: { code: 1, message: "codex cost refresh timed out" },
      }),
      provider("claude", {
        windows: [window(61)],
        error: { code: 1, message: "claude cost refresh timed out" },
      }),
      provider("gemini", { error: "Not logged in" }),
    ]);
    await expect(f.owner.refresh()).resolves.toMatchObject({ status: { state: "succeeded" } });
    expect(f.owner.snapshot()).toMatchObject({
      freshness: "fresh",
      providers: [
        {
          id: "codex",
          windows: [{ remaining_percent: 57 }],
          error: "codex cost refresh timed out",
        },
        {
          id: "claude",
          windows: [{ remaining_percent: 61 }],
          error: "claude cost refresh timed out",
        },
        { id: "gemini", error: "Not logged in" },
      ],
    });
    expect(await f.owner.status()).not.toHaveProperty("error_key");
    expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
  });

  it.each(["Authentication failed (401)", "codex usage timed out", "unknown provider failure"])(
    "keeps the old cache and reports the actual failure for %s, even with returned windows",
    async (error) => {
      const f = fixture();
      f.respond([provider("codex", { windows: [window()], error })]);
      await expect(f.owner.refresh()).rejects.toThrow(`codex: ${error}`);
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      expect(await f.owner.status()).toMatchObject({
        last_success_at: (f.before as { last_success_at: string }).last_success_at,
        error_key: "errors.quotaUnavailable",
        error_detail: expect.stringContaining(`codex: ${error}`),
      });
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it.each([previousTime, undefined, "2099-01-01T00:00:00Z"])(
    "rejects cost-only results with stale or missing update time (%s)",
    async (updatedAt) => {
      const f = fixture();
      f.respond([
        provider("codex", {
          updatedAt,
          windows: [window()],
          error: "codex cost refresh timed out",
        }),
      ]);
      await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
    },
  );

  it.each(["codex", "claude"])(
    "classifies complete raw %s errors before diagnostic truncation",
    async (id) => {
      const f = fixture();
      f.respond([
        provider(id, {
          windows: [window()],
          error: `${id} cost refresh timed out${"\n".repeat(12)}Authentication failed (401)`,
        }),
      ]);
      await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
      expect(f.owner.snapshot()).toMatchObject({
        fetched_at: previousTime,
        freshness: "stale",
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "codex",
            windows: expect.arrayContaining([expect.objectContaining({ remaining_percent: 13 })]),
          }),
        ]),
      });
      expect(await f.owner.status()).toMatchObject({
        last_success_at: (f.before as { last_success_at: string }).last_success_at,
        error_key: "errors.quotaUnavailable",
      });
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it.each([
    {
      error: {
        message: `codex cost refresh timed out${"\n".repeat(12)}Usage failed`,
      },
    },
    { error: `${"\n".repeat(12)}Authentication failed (401)` },
    { accountsError: `${"\n".repeat(12)}Account lookup failed` },
    { accountsError: `codex cost refresh timed out${"\n".repeat(12)}Account lookup failed` },
    { error: "codex cost refresh timed out ", accountsError: "" },
    {
      windows: [],
      accounts: [
        {
          id: "a",
          label: "Fixture",
          active: true,
          windows: [window()],
          error: `${"\n".repeat(12)}Authentication failed (401)`,
        },
      ],
    },
  ])("does not let diagnostic formatting hide raw errors (%j)", async (errors) => {
    const f = fixture();
    f.respond([provider("codex", { windows: [window()], ...errors })]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
    expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
  });

  it("does not treat a discarded null credit balance as usable quota", async () => {
    const f = fixture();
    f.respond([provider("codex", { credits: null })]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it("does not turn a cost-only error with no quota into a success", async () => {
    const f = fixture();
    f.respond([provider("codex", { error: "codex cost refresh timed out" })]);
    await expect(f.owner.refresh()).rejects.toThrow("codex: codex cost refresh timed out");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it.each([
    ["codex", "codex cost refresh timed out; usage failed"],
    ["other", "other cost refresh timed out"],
  ])("rejects unverified cost errors for %s", async (id, error) => {
    const f = fixture();
    f.respond([provider(id, { windows: [window()], error })]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it("reports each enabled provider and account failure without overwriting last-good data", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: { message: "Usage request failed (403)" },
        accountsError: "Account enumeration failed",
      }),
      provider("claude", {
        accounts: [
          {
            id: "private-id",
            label: "private-account",
            active: true,
            windows: [],
            error: "Usage timed out",
          },
        ],
      }),
      provider("gemini"),
      provider("disabled", {
        enabled: false,
        windows: [window()],
        error: "Do not include disabled diagnostics",
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail).toContain(
      "codex: Usage request failed (403); Account enumeration failed".replace("; ", " "),
    );
    expect(status.error_detail).toContain("claude: Usage timed out");
    expect(status.error_detail).toContain("gemini: No usable quota");
    expect(status.error_detail).not.toMatch(/private-id|private-account|disabled/);
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it("redacts credentials, URL parameters and private keys before returning or persisting diagnostics", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: [
          "Request failed (403)",
          "Authorization: Bearer private-credential",
          "password = private-password",
          'Upstream response: {"password":"private-json-password"}',
          "https://user:private-password@example.test/usage?session=private-session",
          "upstream sk-abcdef1234567890abcdef",
          "upstream eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.syntheticSignature",
          "account private-account@example.test",
          "-----BEGIN RSA PRIVATE KEY-----",
          "private-key-body",
          "-----END RSA PRIVATE KEY-----",
          "-----BEGIN PRIVATE KEY-----",
          "private-key-pkcs8-body",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Request failed (403)");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail).not.toMatch(
      /private-credential|private-password|private-json-password|private-session|private-key-body|private-key-pkcs8-body|abcdef1234567890abcdef|eyJhbGci|private-account/,
    );
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
  });

  it("bounds large diagnostics while keeping a reason for every displayed provider", async () => {
    const f = fixture();
    f.respond(
      Array.from({ length: 10 }, (_, i) =>
        provider(`provider-${i}`, { error: "Unavailable ".repeat(500) }),
      ),
    );
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    const status = (await f.owner.status()) as { error_detail: string };
    for (let i = 0; i < 8; i++) expect(status.error_detail).toContain(`provider-${i}:`);
    expect(status.error_detail).toContain("2 more providers omitted");
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    '{"accessToken":"SYNTHETIC-ACCESS","refreshToken":"SYNTHETIC-REFRESH"}',
    '{"Id_Token":\n  "SYNTHETIC-ID"\n}',
    '{"refresh-token":\n  {"value":"SYNTHETIC-NESTED"}\n}',
    '{"credentials":[{"value":"SYNTHETIC-ARRAY"}]}',
    String.raw`{"\u0061ccessToken":"SYNTHETIC-ESCAPED-KEY"}`,
    String.raw`{\"accessToken\":\"SYNTHETIC-ENCODED-JSON\"}`,
    JSON.stringify({ message: 'Upstream: {"accessToken":"SYNTHETIC-EMBEDDED-JSON"}' }),
    JSON.stringify({ message: String.raw`Upstream: {"\u0061ccessToken":"SYNTHETIC-NESTED-KEY"}` }),
    "{'credential': 'SYNTHETIC-SINGLE-QUOTE'}",
    '{"refreshToken": "SYNTHETIC-INCOMPLETE',
    'Upstream: { accessToken: "SYNTHETIC-BARE" }',
    'Upstream: refreshToken: "SYNTHETIC-PREFIX"',
    'Upstream:{error:{idToken:"SYNTHETIC-NESTED-BARE"}}',
    '{code:403, message:"Unavailable", credentials:\n {value:"SYNTHETIC-BARE-OBJECT"}}',
    'Upstream: { access_token:\r\n "SYNTHETIC-SNAKE" }',
    'Upstream: { refresh-token: "SYNTHETIC-KEBAB" }',
    'Upstream: access token: "SYNTHETIC-SPACED"',
    'Upstream: access key id: "SYNTHETIC-SPACED-KEY"',
    'Collector --access-token="SYNTHETIC-FLAG"',
    "Collector rejected --refresh-token SYNTHETIC-REFRESH-VALUE",
    "Collector rejected --id-token SYNTHETIC-ID-VALUE",
    "Collector --id-token SYNTHETIC-COLON: opaque",
    'Collector --REFRESH_TOKEN\t"SYNTHETIC-TAB"',
    "Collector --idToken\n'SYNTHETIC-LINE'",
    'Collector --auth-token "SYNTHETIC-AUTH"',
    "Collector --session-token 'SYNTHETIC-SESSION'",
    "Collector --access-key-id SYNTHETIC-ACCESS",
    "Collector --private-key SYNTHETIC-PRIVATE",
    "Collector --dsn SYNTHETIC-DSN",
    '["collector","--refresh-token","SYNTHETIC-ARGV"]',
    '{_refreshToken: "SYNTHETIC-PRIVATE-FIELD"}',
    '{"passphrase":\n"SYNTHETIC-VALUE-A"}',
    '{"passphrase": {"value":"SYNTHETIC-VALUE-B"}}',
    "Upstream: passphrase:\nSYNTHETIC-VALUE-C",
    JSON.stringify({ message: 'Upstream: {accessToken:"SYNTHETIC-EMBEDDED-BARE"}' }),
    '{"access\'Token":"SYNTHETIC-PUNCTUATED-KEY"}',
  ])(
    "redacts structured credential payloads before returning and persisting failures (%s)",
    async (payload) => {
      const f = fixture();
      f.respond([provider("codex", { error: `Request failed (403)\n${payload}` })]);
      const refresh = f.owner.refresh();
      await expect(refresh).rejects.toThrow("Request failed (403)");
      await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
      expect(await f.owner.status()).toMatchObject({
        last_success_at: (f.before as { last_success_at: string }).last_success_at,
        error_detail: expect.stringContaining("Request failed (403)"),
      });
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it.each([false, true])(
    "redacts every account/provider error when collection succeeds=%s",
    async (succeeds) => {
      const f = fixture();
      f.respond([
        ...(succeeds ? [provider("codex", { windows: [window()] })] : []),
        provider("claude", {
          error: '{"accessToken":"SYNTHETIC-PROVIDER"}',
          accountsError: '{"refreshToken":"SYNTHETIC-ACCOUNTS"}',
          accounts: [
            {
              id: "a",
              label: "Fixture",
              active: true,
              windows: [],
              error: '{"idToken":"SYNTHETIC-ACCOUNT"}',
            },
          ],
        }),
      ]);
      const refresh = f.owner.refresh();
      if (succeeds) {
        await expect(refresh).resolves.toMatchObject({ status: { state: "succeeded" } });
        expect(f.owner.snapshot()).toMatchObject({
          providers: [
            { windows: [{ remaining_percent: 57 }] },
            {
              error: expect.stringContaining("redacted"),
              accounts: [{ error: expect.stringContaining("redacted") }],
            },
          ],
        });
      } else {
        await expect(refresh).rejects.toThrow("no usable quota");
        await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
      }
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
      expect(JSON.stringify(f.owner.snapshot())).not.toContain("SYNTHETIC-");
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it("redacts structured credentials from a failed collector process", async () => {
    const f = fixture();
    f.run.mockResolvedValue({
      bytes: Buffer.alloc(0),
      error: 'Request failed (403)\n{"accessToken":"SYNTHETIC-STDERR"}',
      success: false,
      truncated: false,
      exitCode: 1,
    });
    const refresh = f.owner.refresh();
    await expect(refresh).rejects.toThrow("Request failed (403)");
    await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
    expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
    expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
  });

  it("retains ordinary structured errors for diagnosis", async () => {
    const f = fixture();
    f.respond([provider("codex", { error: '{"code":403,"message":"Usage unavailable"}' })]);
    await expect(f.owner.refresh()).rejects.toThrow('"message":"Usage unavailable"');
    expect(await f.owner.status()).toMatchObject({
      error_detail: expect.stringContaining('"message":"Usage unavailable"'),
    });
  });

  it.each([
    JSON.stringify({ message: 'Upstream: {"accessToken"\n : "SYNTHETIC-VALUE"}' }),
    JSON.stringify({ message: 'Upstream: {"refreshToken"\t: "SYNTHETIC-VALUE"}' }),
    JSON.stringify({ message: 'Upstream: {"idToken"\r\n: "SYNTHETIC-VALUE"}' }),
    JSON.stringify(JSON.stringify({ message: 'Upstream: {"accessToken"\n : "SYNTHETIC-VALUE"}' })),
    String.raw`{"message":"Upstream: {\"refreshToken\"\u0020: \"SYNTHETIC-VALUE\"}"}`,
  ])("redacts nested credential fields followed by encoded whitespace (%s)", async (error) => {
    for (const mode of ["failure", "partial", "stderr"] as const) {
      const f = fixture();
      if (mode === "stderr") {
        f.run.mockResolvedValue({
          bytes: Buffer.alloc(0),
          error,
          success: false,
          truncated: false,
          exitCode: 1,
        });
      } else {
        f.respond([
          ...(mode === "partial" ? [provider("codex", { windows: [window()] })] : []),
          provider("claude", {
            error,
            accountsError: error,
            accounts: [{ id: "a", label: "Fixture", active: true, windows: [], error }],
          }),
        ]);
      }
      const refresh = f.owner.refresh();
      if (mode === "partial") {
        await expect(refresh).resolves.toMatchObject({ status: { state: "succeeded" } });
        expect(JSON.stringify(f.owner.snapshot())).toContain("Upstream:");
      } else {
        await expect(refresh).rejects.toThrow("Upstream:");
        await expect(refresh).rejects.not.toThrow("SYNTHETIC-VALUE");
        expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      }
      for (const stored of [f.owner.snapshot(), await f.owner.status()]) {
        expect(JSON.stringify(stored)).not.toContain("SYNTHETIC-VALUE");
      }
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    }
  });

  it("retains ordinary nested fields with encoded whitespace", async () => {
    const f = fixture();
    const error = JSON.stringify({ message: 'Upstream: {"message"\n: "Usage unavailable"}' });
    f.respond([provider("codex", { error })]);
    await expect(f.owner.refresh()).rejects.toThrow(error);
    expect(await f.owner.status()).toMatchObject({ error_detail: expect.stringContaining(error) });
  });

  it("bounds long encoded whitespace after a credential field", async () => {
    const f = fixture();
    const error = String.raw`Upstream: {\"accessToken\"${String.raw`\n`.repeat(100_000)}: \"SYNTHETIC-VALUE\"}`;
    f.respond([provider("codex", { error })]);
    const refresh = f.owner.refresh();
    await expect(refresh).rejects.toThrow("Upstream:");
    await expect(refresh).rejects.not.toThrow("SYNTHETIC-VALUE");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail).not.toContain("SYNTHETIC-VALUE");
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
  });

  it.each(["refresh-token", "id-token"])(
    "redacts --%s values in every error field of partial-success snapshots",
    async (option) => {
      const f = fixture();
      f.respond([
        provider("codex", { windows: [window()] }),
        provider("claude", {
          error: `Collector rejected --${option} SYNTHETIC-PROVIDER`,
          accountsError: `Collector rejected --${option} "SYNTHETIC-ACCOUNTS"`,
          accounts: [
            {
              id: "a",
              label: "Fixture",
              active: true,
              windows: [],
              error: `Collector rejected --${option}\n'SYNTHETIC-ACCOUNT'`,
            },
          ],
        }),
      ]);
      await expect(f.owner.refresh()).resolves.toMatchObject({ status: { state: "succeeded" } });
      expect(f.owner.snapshot()).toMatchObject({
        freshness: "fresh",
        providers: [
          { windows: [{ remaining_percent: 57 }] },
          {
            error: expect.stringContaining("Collector rejected"),
            accounts: [{ error: expect.stringContaining("Collector rejected") }],
          },
        ],
      });
      expect(JSON.stringify(f.owner.snapshot())).not.toContain("SYNTHETIC-");
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it.each(["refresh-token", "id-token"])(
    "redacts --%s values from failed collector stderr",
    async (option) => {
      const f = fixture();
      f.run.mockResolvedValue({
        bytes: Buffer.alloc(0),
        error: `Request failed (403): collector --${option} SYNTHETIC-STDERR`,
        success: false,
        truncated: false,
        exitCode: 1,
      });
      const refresh = f.owner.refresh();
      await expect(refresh).rejects.toThrow("Request failed (403)");
      await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it("retains ordinary CLI options and their values", async () => {
    const f = fixture();
    const error = "Collector failed (403): --timeout 25 --retry-policy never --format json";
    f.respond([provider("codex", { error })]);
    await expect(f.owner.refresh()).rejects.toThrow(error);
    expect(await f.owner.status()).toMatchObject({ error_detail: expect.stringContaining(error) });
  });

  it.each([false, true])(
    "redacts bare keys and multiline passphrases when succeeds=%s",
    async (succeeds) => {
      const f = fixture();
      f.respond([
        ...(succeeds ? [provider("codex", { windows: [window()] })] : []),
        provider("claude", {
          error: 'Upstream: {accessToken:"SYNTHETIC-PROVIDER"}',
          accountsError: '{"passphrase":\n{"value":"SYNTHETIC-ACCOUNTS"}}',
          accounts: [
            {
              id: "a",
              label: "Fixture",
              active: true,
              windows: [],
              error: 'Upstream: refreshToken:\n"SYNTHETIC-ACCOUNT"',
            },
          ],
        }),
      ]);
      const refresh = f.owner.refresh();
      if (succeeds) {
        await expect(refresh).resolves.toMatchObject({ status: { state: "succeeded" } });
        expect(f.owner.snapshot()).toMatchObject({
          providers: [
            { windows: [{ remaining_percent: 57 }] },
            {
              error: expect.stringContaining("redacted"),
              accounts: [{ error: expect.stringContaining("redacted") }],
            },
          ],
        });
      } else {
        await expect(refresh).rejects.toThrow("no usable quota");
        await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
      }
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
      expect(JSON.stringify(f.owner.snapshot())).not.toContain("SYNTHETIC-");
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    },
  );

  it.each(['Upstream: {accessToken:"SYNTHETIC-STDERR"}', '{"passphrase":\n"SYNTHETIC-STDERR"}'])(
    "redacts credential fields in failed collector stderr (%s)",
    async (payload) => {
      const f = fixture();
      f.run.mockResolvedValue({
        bytes: Buffer.alloc(0),
        error: `Request failed (403)\n${payload}`,
        success: false,
        truncated: false,
        exitCode: 1,
      });
      const refresh = f.owner.refresh();
      await expect(refresh).rejects.toThrow("Request failed (403)");
      await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
    },
  );

  it("safely bounds deeply encoded diagnostic keys", async () => {
    const f = fixture();
    const key = String.raw`\u005c` + "u005c".repeat(20_000) + "u0061ccessToken";
    f.respond([provider("codex", { error: `Request failed (403)\n{"${key}":"SYNTHETIC-DEEP"}` })]);
    const refresh = f.owner.refresh();
    await expect(refresh).rejects.toThrow("Request failed (403)");
    await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
    expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-");
  });

  it("keeps ordinary long hyphenated diagnostic text bounded", async () => {
    const f = fixture();
    f.respond([
      provider("codex", { error: `Request failed (403)\n${"retry-rejected-".repeat(15_000)}` }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Request failed (403)");
    expect(
      ((await f.owner.status()) as { error_detail: string }).error_detail.length,
    ).toBeLessThanOrEqual(1000);
  });

  it("redacts email accounts without hiding the surrounding failure", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: "Request failed (403) for user.name+quota-test@example.test; Usage unavailable",
      }),
    ]);
    const refresh = f.owner.refresh();
    await expect(refresh).rejects.toThrow(
      "Request failed (403) for [account redacted]; Usage unavailable",
    );
    expect(JSON.stringify(await f.owner.status())).not.toContain("example.test");
  });

  it.each([
    "https://example.test/usage?session=SYNTHETIC-VALUE",
    String.raw`https:\/\/example.test\/usage?session=SYNTHETIC-VALUE`,
    String.raw`HTTP:\/\/example.test\/usage?session=SYNTHETIC-VALUE`,
    String.raw`https:/\/example.test/usage?session=SYNTHETIC-VALUE`,
    JSON.stringify({ url: String.raw`https:\/\/example.test\/usage?session=SYNTHETIC-VALUE` }),
    JSON.stringify(
      JSON.stringify({ url: String.raw`https:\/\/example.test\/usage?session=SYNTHETIC-VALUE` }),
    ),
  ])("redacts plain and JSON-escaped URLs across diagnostic paths (%s)", async (url) => {
    for (const mode of ["failure", "partial", "stderr"] as const) {
      const f = fixture();
      const error = `Request failed (403): ${url}`;
      if (mode === "stderr") {
        f.run.mockResolvedValue({
          bytes: Buffer.alloc(0),
          error,
          success: false,
          truncated: false,
          exitCode: 1,
        });
      } else {
        f.respond([
          ...(mode === "partial" ? [provider("codex", { windows: [window()] })] : []),
          provider("claude", {
            error,
            accountsError: error,
            accounts: [{ id: "a", label: "Fixture", active: true, windows: [], error }],
          }),
        ]);
      }
      const refresh = f.owner.refresh();
      if (mode === "partial") {
        await expect(refresh).resolves.toMatchObject({ status: { state: "succeeded" } });
        expect(JSON.stringify(f.owner.snapshot())).toContain("[URL redacted]");
      } else {
        await expect(refresh).rejects.toThrow("Request failed (403)");
        await expect(refresh).rejects.toThrow("[URL redacted]");
        await expect(refresh).rejects.not.toThrow("SYNTHETIC-");
        expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      }
      for (const stored of [f.owner.snapshot(), await f.owner.status()]) {
        expect(JSON.stringify(stored)).not.toContain("SYNTHETIC-");
        expect(JSON.stringify(stored)).not.toContain("example.test");
      }
      expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
    }
  });

  it.each(["json", "markdown"] as const)(
    "shares passphrase protection with %s handoff exports",
    (format) => {
      const input =
        format === "json"
          ? JSON.stringify({ status: "unavailable", auth: { passphrase: "SYNTHETIC-VALUE" } })
          : "status: unavailable\npassphrase: SYNTHETIC-VALUE\n";
      const output = sanitizeHandoffExport(input, format);
      expect(output).not.toContain("SYNTHETIC-VALUE");
      expect(output).toContain("unavailable");
    },
  );

  it("bounds diagnostics containing large runs of escaped quotes", async () => {
    const f = fixture();
    f.respond([
      provider("codex", { error: `Request failed (403)\n${String.raw`\"`.repeat(100_000)}` }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Request failed (403)");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
    expect(f.run).toHaveBeenCalledTimes(f.expectedCalls());
  });

  it.each([
    'Upstream response: {"password":"SYNTHETIC-SECRET"}',
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-SECRET\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-SECRET",
  ])(
    "redacts quoted passwords and standard or incomplete private-key blocks (%s)",
    async (error) => {
      const f = fixture();
      f.respond([provider("codex", { error })]);
      await expect(f.owner.refresh()).rejects.not.toThrow("SYNTHETIC-SECRET");
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-SECRET");
    },
  );

  it("preserves successful account quota and the parent warning", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: "One account failed",
        accounts: [{ id: "a", label: "Fixture", active: true, windows: [window()] }],
      }),
    ]);
    await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({
      providers: [
        { error: "One account failed", accounts: [{ windows: [{ remaining_percent: 57 }] }] },
      ],
    });
  });

  it("preserves a healthy provider when another provider fails", async () => {
    const f = fixture();
    f.respond([
      provider("codex", { windows: [window()] }),
      provider("claude", { error: "claude usage timed out" }),
    ]);
    await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({
      providers: [
        { windows: [{ remaining_percent: 57 }] },
        { windows: [], error: "claude usage timed out" },
      ],
    });
  });

  it("does not conflate separate account failures with a verified cost timeout", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        windows: [window()],
        error: "codex cost refresh timed out",
        accountsError: "Account lookup failed",
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Account lookup failed");
  });

  it("reports an empty enabled-provider configuration explicitly", async () => {
    const f = fixture();
    f.respond([]);
    await expect(f.owner.refresh()).rejects.toThrow("No providers are enabled");
  });
});
