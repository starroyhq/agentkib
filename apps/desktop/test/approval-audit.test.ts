import { constants } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionApprovalAuditStore,
  type SessionApprovalAuditInput,
} from "../../../packages/backend/src/sessions/approval-audit";

const directories: string[] = [];
const time = Date.parse("2026-11-24T09:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(maxEntries?: number) {
  const root = await mkdtemp(join(tmpdir(), "agentkib-approval-audit-"));
  directories.push(root);
  let now = time;
  return {
    root,
    file: join(root, "approval-audit.json"),
    store: new SessionApprovalAuditStore(root, { maxEntries, now: () => now }),
    advance: () => ++now,
  };
}

function input(overrides: Partial<SessionApprovalAuditInput> = {}): SessionApprovalAuditInput {
  return {
    requestId: "receipt-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    workspacePath: "/fake/workspace-one",
    agent: "codex",
    kind: "approval",
    risk: { level: "low", reason: "test" },
    decision: { kind: "allow", scope: "once" },
    source: { kind: "phone", deviceId: "phone-1" },
    ...overrides,
  };
}

describe("the local approval audit store", () => {
  it("persists canonical decisions, device identity and outcomes across a restart", async () => {
    const { root, store, file } = await fixture();
    const request = input({
      decision: { kind: "deny", scope: "persistent" },
      source: { kind: "web", deviceId: "browser-1" },
    });
    const { id: first } = await store.begin(request);
    const { id: second } = await store.begin(
      input({
        requestId: "receipt-2",
        kind: "question",
        decision: { kind: "answer", scope: "once" },
        risk: { level: "low", reason: "question" },
      }),
    );
    const { id: third } = await store.begin(input({ requestId: "receipt-3" }));
    const { id: fourth } = await store.begin(input({ requestId: "receipt-4" }));
    await store.finish(first, "denied");
    await store.finish(second, "executed");
    await store.finish(third, "expired");

    const reopened = new SessionApprovalAuditStore(root);
    const { entries } = await reopened.list();
    expect(entries).toHaveLength(4);
    expect(entries.find(({ id }) => id === first)).toEqual({
      id: first,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      agent: "codex",
      kind: "approval",
      risk: { level: "low", reason: "test" },
      summary: "Requested to run tests.",
      decision: { kind: "deny", scope: "persistent" },
      source: { kind: "web", deviceId: "browser-1" },
      time: "2026-11-24T09:00:00.000Z",
      result: "denied",
    });
    expect(entries.find(({ id }) => id === second)).toMatchObject({
      risk: { level: "low", reason: "question" },
      summary: "Asked the user a question.",
      result: "executed",
    });
    expect(entries.find(({ id }) => id === third)?.result).toBe("expired");
    expect(entries.find(({ id }) => id === fourth)?.result).toBe("unknown");
    if (process.platform !== "win32")
      expect((await stat(file)).mode & (constants.S_IRWXG | constants.S_IRWXO)).toBe(0);
  });

  it("records a retry once and reconciles only an unknown receipt with the same identity", async () => {
    const { store } = await fixture();
    const decision = input({ decision: { kind: "deny", scope: "once" } });
    const [first, replay] = await Promise.all([
      store.begin(decision),
      store.begin(decision, "expired"),
    ]);
    expect(first.created).toBe(true);
    expect(replay).toEqual({ id: first.id, created: false });
    await store.finishReceipt({ ...decision, deviceId: "another-phone", result: "accepted" });
    expect((await store.list()).entries.map(({ result }) => result)).toEqual(["unknown"]);

    await store.finishReceipt({ ...decision, deviceId: "phone-1", result: "accepted" });
    await store.finish(first.id, "expired");
    await store.finish(first.id, "unknown");
    expect((await store.list()).entries.map(({ result }) => result)).toEqual(["denied"]);
  });

  it("retains the classified risk for a questionnaire that grants permission", async () => {
    const { store } = await fixture();
    await store.begin(
      input({
        agent: "deepseek-harness",
        kind: "question",
        risk: { level: "high", reason: "unknown-operation" },
        decision: { kind: "answer", scope: "once" },
      }),
    );
    expect((await store.list()).entries[0]).toMatchObject({
      kind: "question",
      risk: { level: "high", reason: "unknown-operation" },
    });
  });

  it("filters before paginating, with no fallback from an unauthorized explicit workspace", async () => {
    const { store, advance } = await fixture();
    const { id: older } = await store.begin(
      input({ requestId: "older", sessionId: "allowed-older" }),
    );
    advance();
    const { id: newest } = await store.begin(
      input({ requestId: "newest", sessionId: "allowed-newest", workspaceId: undefined }),
    );
    advance();
    await store.begin(
      input({ requestId: "blocked", sessionId: "blocked", workspaceId: "workspace-2" }),
    );
    await store.begin(
      input({
        requestId: "unknown",
        sessionId: "unknown",
        workspaceId: undefined,
        workspacePath: undefined,
      }),
    );
    const workspaceScopes = [{ id: "workspace-1", path: "/fake/workspace-one" }];
    const first = await store.list({ limit: 1, workspaceScopes });
    expect(first.entries.map(({ id }) => id)).toEqual([newest]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{1,160}$/);
    const next = await store.list({ limit: 1, before: first.nextCursor, workspaceScopes });
    expect(next).toMatchObject({ entries: [{ id: older, sessionId: "allowed-older" }] });
    expect(next.nextCursor).toBeUndefined();
    expect((await store.list({ workspaceScopes: [] })).entries).toEqual([]);
    expect((await store.list()).entries).toHaveLength(4);
    await expect(store.list({ before: "looks-valid" })).rejects.toThrow(
      /^invalid_approval_audit_cursor$/,
    );
  });

  it("caps retained records and uses a stable cursor for decisions in the same millisecond", async () => {
    const { store, file } = await fixture(3);
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.begin(input({ requestId: `decision-${i}` }))),
    );
    const first = await store.list({ limit: 2 });
    const next = await store.list({ before: first.nextCursor });
    expect(first.entries).toHaveLength(2);
    expect(next.entries).toHaveLength(1);
    expect(new Set([...first.entries, ...next.entries].map(({ id }) => id))).toEqual(
      new Set(ids.slice(-3).map(({ id }) => id)),
    );
    expect(JSON.parse(await readFile(file, "utf8")).entries).toHaveLength(3);
  });

  it("keeps raw explanations, filenames, credentials, parameters, answers and file contents off disk", async () => {
    const { store, file } = await fixture();
    const raw = "private-filename-credential-needle";
    const request = {
      ...input({
        requestId: raw,
        source: { kind: "phone", deviceId: "phone-1", deviceName: raw },
        workspacePath: `/private/project/${raw}`,
      }),
      summary: raw,
      cwd: raw,
      command: ["tool", raw],
      parameters: { arg: raw },
      answer: raw,
      output: raw,
      fileContent: raw,
      risk: { level: "low" as const, reason: raw, contents: raw },
    };
    await store.begin(request);
    expect(await readFile(file, "utf8")).not.toContain(raw);
    const page = await store.list();
    expect(JSON.stringify(page)).not.toContain(raw);
    expect(page.entries[0]).toMatchObject({
      risk: { level: "high", reason: "unknown-operation" },
      summary: "Requested approval for an unclassified operation.",
      source: { kind: "phone", deviceId: "phone-1" },
    });
    expect(page.entries[0]).not.toHaveProperty("workspacePathDigest");
  });

  it("fails closed on invalid local evidence without exposing it or destroying it", async () => {
    const { store, file } = await fixture();
    const contents = "invalid JSON: keep this private";
    await writeFile(file, contents);
    await expect(store.list()).rejects.toThrow(/^approval-audit-unavailable$/);
    await expect(store.begin(input())).rejects.toThrow(/^approval-audit-unavailable$/);
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it.skipIf(process.platform === "win32")("refuses an audit file symlink", async () => {
    const { root, store, file } = await fixture();
    const other = join(root, "not-the-audit-log");
    const contents = JSON.stringify({ version: 1, entries: [] });
    await writeFile(other, contents);
    await chmod(other, 0o600);
    await symlink(other, file);
    await expect(store.begin(input())).rejects.toThrow(/^approval-audit-unavailable$/);
    await expect(store.list()).rejects.toThrow(/^approval-audit-unavailable$/);
    expect(await readFile(other, "utf8")).toBe(contents);
  });
});
