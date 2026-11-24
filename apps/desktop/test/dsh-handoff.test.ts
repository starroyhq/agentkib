// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import {
  DshHistoryImport,
  type DshHistoryImportBridge,
} from "../../../packages/backend/src/agents/dsh/history-import";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { canonicalize } from "../../../packages/backend/src/paths";
import { prepareSessionHandoff } from "../../../packages/backend/src/session-continuation";
import { applySessionHandoff } from "../../../packages/backend/src/session-handoff-apply";
import { launchDshHandoff } from "../../../packages/backend/src/session-handoff-launch";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import { listNativeImports } from "../../../packages/backend/src/session-native-imports";
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
  const dsh: { createOptions: () => Promise<typeof dshOptions> } & Partial<DshHistoryImportBridge> =
    { createOptions: async () => dshOptions };
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
        targetFingerprint: draft.target_fingerprint,
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
    document,
    sessions,
    prepare,
    plan,
    setDsh: (value: typeof dshOptions) => (dshOptions = value),
    setImport: (bridge: DshHistoryImportBridge) => Object.assign(dsh, bridge),
  };
}

describe("handing a conversation over to DeepSeek Harness", () => {
  function nativeImport(f: ReturnType<typeof fixture>) {
    const historyImportContext = vi.fn(async () => ({
      runtimeId: "2be5173c-9122-44a8-b129-9cc7ff063c5c",
      workspaceId: "dsh-workspace",
    }));
    const importHistory = vi.fn<DshHistoryImportBridge["importHistory"]>(async (value) => {
      value.beforeDispatch?.();
      return { sessionId: "ak-imported-dsh-session" };
    });
    const bridge = { historyImportContext, importHistory };
    f.setImport(bridge);
    const owner = new DshHistoryImport(f.data, f.store, f.sessions, bridge, f.environment);
    return { owner, bridge };
  }

  it("reviews and imports all durable history, including images larger than the context window", async () => {
    const f = fixture();
    const { owner, bridge } = nativeImport(f);
    const image = Buffer.alloc(256 * 1024, 12).toString("base64");
    f.document.turns[0]!.blocks.push({
      type: "attachment",
      kind: "image",
      media_type: "image/png",
      inline_base64: image,
    });
    f.document.turns[1]!.blocks.push({
      type: "tool-call",
      call_id: "check",
      name: "read_file",
      input: "{}",
    });
    f.document.turns.push({
      id: "result",
      role: "tool",
      blocks: [
        { type: "tool-result", call_id: "check", output: "existing tests", is_error: false },
      ],
    });
    const draft = await f.prepare();
    expect(draft).toMatchObject({
      mode: "native-session",
      window_strategy: "full",
      native_capability: { supported: true },
      losses: [{ code: "target-tool-summary", count: 2 }],
    });
    expect(draft.archive_id).toBeUndefined();
    const planned = await f.plan(draft);
    expect(planned.change_set).toMatchObject({
      requires_home_approval: true,
      changes: [{ scope: "application-data" }],
    });
    expect(planned.launch_request).toMatchObject({
      mode: "native-import",
      target_agent: "deepseek-harness",
    });
    await expect(owner.launch(planned.launch_request)).rejects.toThrow();
    await expect(
      owner.continue({
        changeSet: planned.change_set,
        launchRequest: planned.launch_request,
        approveHome: false,
      }),
    ).rejects.toThrow();
    expect(bridge.importHistory).not.toHaveBeenCalled();
    const result = { target_agent: "deepseek-harness", session_id: "ak-imported-dsh-session" };
    await expect(
      owner.continue({
        changeSet: planned.change_set,
        launchRequest: planned.launch_request,
        approveHome: true,
      }),
    ).resolves.toEqual(result);
    const [submitted] = bridge.importHistory.mock.calls[0]!;
    expect(submitted).toMatchObject({
      cwd: f.project,
      workspaceId: f.registered,
      nativeId: planned.launch_request.operation_id,
      verifyOnly: false,
      context: { workspaceId: "dsh-workspace" },
    });
    expect(submitted.document.turns).toEqual(f.document.turns);
    expect(existsSync(path.join(f.project, ".agentkib", "handoffs", draft.filename))).toBe(false);
    await expect(owner.launch(planned.launch_request)).resolves.toEqual(result);
    expect(bridge.importHistory).toHaveBeenCalledTimes(1);
    expect(listNativeImports(f.data, f.store, f.registered)).toMatchObject([
      { status: "launched", target_session_id: planned.launch_request.operation_id },
    ]);
  });

  it("checks the native result without trying a second write after a lost import reply", async () => {
    const f = fixture();
    const { owner, bridge } = nativeImport(f);
    bridge.importHistory.mockImplementationOnce(async (input) => {
      input.beforeDispatch?.();
      throw new Error("fixture lost the response");
    });
    const planned = await f.plan(await f.prepare());
    await expect(
      owner.continue({
        changeSet: planned.change_set,
        launchRequest: planned.launch_request,
        approveHome: true,
      }),
    ).rejects.toThrow("DSH import outcome needs reconciliation");
    expect(listNativeImports(f.data, f.store, f.registered)).toMatchObject([
      { status: "outcome-unknown" },
    ]);
    await expect(owner.launch(planned.launch_request)).resolves.toMatchObject({
      target_agent: "deepseek-harness",
    });
    expect(bridge.importHistory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        verifyOnly: true,
        nativeId: planned.launch_request.operation_id,
        beforeDispatch: undefined,
      }),
    );
  });

  it("leaves the native store untouched when the source changes after preview", async () => {
    const f = fixture();
    const { owner, bridge } = nativeImport(f);
    const planned = await f.plan(await f.prepare());
    f.document.turns[0]!.blocks.push({ type: "text", text: "Later message" });
    await expect(
      owner.continue({
        changeSet: planned.change_set,
        launchRequest: planned.launch_request,
        approveHome: true,
      }),
    ).rejects.toThrow("Source changed after DSH import preview");
    expect(bridge.importHistory).not.toHaveBeenCalled();
  });

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
    await expect(launchDshHandoff(planned.launch_request, f.store, { handoff })).rejects.toThrow();
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
