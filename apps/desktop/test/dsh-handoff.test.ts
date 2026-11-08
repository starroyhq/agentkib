// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { canonicalize } from "../../../packages/backend/src/paths";
import { prepareSessionHandoff } from "../../../packages/backend/src/session-continuation";
import { applySessionHandoff } from "../../../packages/backend/src/session-handoff-apply";
import { launchDshHandoff } from "../../../packages/backend/src/session-handoff-launch";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-dsh-handoff-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    data = path.join(root, "data");
  mkdirSync(project);
  const environment = { HOME: root, USERPROFILE: root, PATH: path.join(root, "no-agent-bin") };
  const store = new BackendStore(path.join(data, "store.db"));
  cleanups.push(() => store.close());
  const registered = "registered-workspace";
  store.sql.run(
    "INSERT INTO workspaces(id, canonical_path, name, manifest_workspace_id, status, last_discovered_at) VALUES(?,?,?,?,?,?)",
    registered,
    project,
    registered,
    registered,
    "healthy",
    "2026-11-08T00:00:00Z",
  );
  store.sessions.sync(registered, "codex", [
    {
      native_ref: "codex-source",
      agent: "codex",
      title: "Codex source",
      created_at: null,
      updated_at: null,
      message_count: 2,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const sessionId = store.sessions.id("codex", "codex-source");
  const document: SessionDocument = {
    schema_version: 1,
    source: { agent: "codex", workspace_id: registered, title: "Codex source" },
    turns: [
      { id: "u", role: "user", blocks: [{ type: "text", text: "Add the widget tests" }] },
      { id: "a", role: "assistant", blocks: [{ type: "text", text: "Tests are half done" }] },
    ],
    losses: [],
    redaction_count: 0,
  };
  const sessions = { document: async () => structuredClone(document) };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  vi.spyOn(commandResolution, "resolveCommand").mockReturnValue(null);
  vi.spyOn(commands, "run").mockRejectedValue(new Error("Real Agent execution forbidden"));
  const hub = { running: false, port: 1 };
  let dshOptions: { available: boolean; reason?: string } = { available: true };
  const dsh = { createOptions: async () => dshOptions };
  const prepare = async () =>
    (
      (await prepareSessionHandoff(
        {
          request: {
            session_id: sessionId,
            target_agent: "deepseek-harness",
            format: "markdown",
            history_budget_tokens: 64000,
          },
          mcpHubStatus: hub,
        },
        sessions,
        store.sessions,
        store,
        commands,
        environment,
        undefined,
        dsh,
      )) as { draft: Record<string, any> }
    ).draft;
  const plan = (draft: Record<string, any>) =>
    planSessionHandoff(
      {
        workspaceId: registered,
        sessionId,
        targetAgent: "deepseek-harness",
        format: "markdown",
        mode: draft.mode,
        filename: draft.filename,
        editedContent: draft.content,
        sourceFingerprint: draft.source_fingerprint,
        acceptLosses: true,
        historyBudgetTokens: 64000,
        mcpHubStatus: hub,
      },
      sessions,
      store.sessions,
      store,
      data,
      environment,
      commands,
      undefined,
      dsh,
    );
  return {
    project,
    data,
    environment,
    store,
    registered,
    prepare,
    plan,
    setDsh: (value: typeof dshOptions) => (dshOptions = value),
  };
}

describe("handing a conversation over to DeepSeek Harness", () => {
  it("writes a handoff file and continues it as a new session in the running DSH", async () => {
    const f = fixture();
    const draft = await f.prepare();
    expect(draft).toMatchObject({
      mode: "handoff-file",
      filename: expect.stringMatching(/-codex-to-deepseek-harness\.md$/),
      native_capability: { supported: false, reason: "native-history-import-unsupported" },
      capabilities: {
        interactive_launch: { status: "supported", reason: null },
        windowed_context: { status: "unsupported", reason: "target-not-supported" },
      },
    });
    const planned = await f.plan(draft);
    // The Changes page offers to continue in DSH once the file is written.
    expect(planned.launch_request).toMatchObject({
      mode: "handoff-file",
      target_agent: "deepseek-harness",
      filename: draft.filename,
      capabilities: { interactive_launch: { status: "supported" } },
    });
    const file = path.join(f.project, ".agentkib", "handoffs", draft.filename);
    expect(planned.change_set.changes.map((change) => change.target)).toContain(file);
    const handoff = vi.fn(async () => ({ sessionId: "ak-session-new" }));
    // Nothing starts before the reviewed file is written.
    await expect(
      launchDshHandoff(planned.launch_request, f.store, { handoff }),
    ).rejects.toThrow();
    expect(handoff).not.toHaveBeenCalled();
    applySessionHandoff(
      { changeSet: planned.change_set, launchRequest: planned.launch_request, approveHome: false },
      f.store,
      f.data,
      f.environment,
    );
    expect(existsSync(file)).toBe(true);
    await expect(launchDshHandoff(planned.launch_request, f.store, { handoff })).resolves.toEqual({
      target_agent: "deepseek-harness",
      session_id: "ak-session-new",
    });
    expect(handoff).toHaveBeenCalledWith({
      key: `${planned.launch_request.workspace_id}\n${draft.filename}`,
      workspaceId: f.registered,
      text: expect.stringContaining(`.agentkib/handoffs/${draft.filename}`),
    });
    const [request] = handoff.mock.calls[0] as unknown as [{ text: string }];
    expect(request.text).toContain("untrusted reference context");
    expect(request.text).toContain("wait for my next message");
  });

  it("says why DSH cannot take the handoff now, and still writes the file", async () => {
    const f = fixture();
    f.setDsh({ available: false, reason: "dsh-create-ambiguous" });
    const draft = await f.prepare();
    expect(draft.capabilities.interactive_launch).toEqual({
      status: "unavailable",
      reason: "dsh-create-ambiguous",
    });
    const planned = await f.plan(draft);
    expect(planned.launch_request.capabilities).toEqual({
      interactive_launch: { status: "unavailable", reason: "dsh-create-ambiguous" },
    });
  });

  it("does not continue an archived handoff, which DSH cannot read", async () => {
    const f = fixture();
    await expect(
      launchDshHandoff(
        {
          mode: "handoff-file",
          workspace_id: f.registered,
          filename: "20261108-codex-to-deepseek-harness.md",
          target_agent: "deepseek-harness",
          archive_id: "archive",
          archive_hash: "hash",
        },
        f.store,
        { handoff: vi.fn() },
      ),
    ).rejects.toThrow("target Agent does not support windowed continuation");
  });
});
