// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";

/** The Host side of a connected DeepSeek Harness: which session operations reach the runtime. */
describe("DeepSeek Harness host control boundary", () => {
  let directory: string;
  let service: WebAccessService;
  let features: Record<string, { available: boolean; reason?: string }>;
  const runtime = vi.fn<(value: unknown) => Promise<unknown>>();
  const models = [
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", efforts: ["low", "high"] },
    { id: "mock%2Flocal/m-1", name: "Mock One", efforts: [] },
  ];

  beforeEach(async () => {
    runtime.mockReset();
    features = {
      rename: { available: true },
      archive: { available: true },
      unarchive: { available: false, reason: "operation-unavailable" },
      fork: { available: true },
      settings: { available: true },
      delete: { available: true },
    };
    directory = await mkdtemp(join(tmpdir(), "agentkib-dsh-host-"));
    await mkdir(join(directory, "workspace"));
    runtime.mockImplementation(async (value) => {
      const params = value as Record<string, unknown>;
      switch (params.operation) {
        case "catalog":
          return {
            sessions: [{ id: "dsh-session", workspace_id: "workspace", agent: "deepseek-harness" }],
            workspaces: [],
          };
        case "live":
          return {
            executionMode: "dsh-follower",
            workspaceId: "workspace",
            runtimeBootId: "runtime-one",
            revision: 4,
            status: "idle",
            sendEnabled: true,
          };
        case "capabilities":
          return { executionMode: "dsh-follower", features };
        case "settings-state":
          return {
            available: true,
            executionMode: "dsh-follower",
            revision: 4,
            current: { model: "deepseek/deepseek-chat", effort: "low" },
            selected: { model: "deepseek/deepseek-chat", effort: "low" },
            defaults: { model: "deepseek/deepseek-chat", effort: null },
            models,
            writable: { model: { available: true }, effort: { available: true } },
          };
        case "usage":
          return { available: false, state: "unavailable", reason: "usage-unavailable" };
        case "dsh-options":
          return { available: true };
        case "dsh-create":
          return {
            accepted: true,
            completed: true,
            requestId: params.requestId,
            controlOutcome: "accepted",
            sessionId: "dsh-new",
          };
        default:
          return {
            accepted: true,
            completed: false,
            requestId: params.requestId,
            controlOutcome: "accepted",
            runtimeBootId: "runtime-one",
          };
      }
    });
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      desktopOrigin: "app://bundle",
      runtimeRequest: runtime,
      workspaceRequest: async () => [
        { id: "workspace", name: "Synthetic workspace", path: join(directory, "workspace") },
      ],
      verifiedDshFollower: true,
    });
    await service.initialize();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  async function action(operation: string, fields: Record<string, unknown> = {}) {
    const desktop = await service.localRequest("/access");
    return service.localRequest("/managed/action", {
      operation,
      agent: "deepseek-harness",
      bootId: (desktop.body as { bootId: string }).bootId,
      sessionId: "dsh-session",
      requestId: randomUUID(),
      expectedRevision: 4,
      ...fields,
    });
  }
  const forwarded = (operation: string) =>
    runtime.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => value.operation === operation);

  it("forwards rename, archive and fork, and nothing DSH does not take", async () => {
    expect(await action("rename", { name: "Renamed" })).toMatchObject({ status: 200 });
    expect(forwarded("rename")).toEqual([
      expect.objectContaining({ sessionId: "dsh-session", name: "Renamed" }),
    ]);
    expect(await action("archive")).toMatchObject({ status: 200 });
    expect(forwarded("archive")).toHaveLength(1);
    expect(await action("fork")).toMatchObject({ status: 200 });
    expect(forwarded("fork")).toHaveLength(1);
    // The capability decides; an unavailable one never reaches the runtime.
    expect(await action("unarchive")).toMatchObject({
      status: 409,
      body: { controlOutcome: "not-dispatched" },
    });
    expect(forwarded("unarchive")).toEqual([]);
    // Delete is not a DSH operation even when a capability claims it.
    expect(await action("delete")).toMatchObject({
      status: 409,
      body: { controlOutcome: "not-dispatched" },
    });
    expect(forwarded("delete")).toEqual([]);
  });

  it("reads DSH's models and forwards a model or effort from the list only", async () => {
    const settings = await service.localRequest("/managed/settings?sessionId=dsh-session");
    expect(settings).toMatchObject({
      status: 200,
      body: {
        available: true,
        executionMode: "dsh-follower",
        current: { modelId: "deepseek/deepseek-chat", effort: "low" },
        options: {
          models: [
            expect.objectContaining({ id: "deepseek/deepseek-chat", efforts: ["low", "high"] }),
            expect.objectContaining({ id: "mock%2Flocal/m-1", efforts: [] }),
          ],
        },
      },
    });
    expect(await action("settings", { model: "mock%2Flocal/m-1" })).toMatchObject({
      status: 200,
    });
    expect(await action("settings", { effort: "high" })).toMatchObject({ status: 200 });
    expect(forwarded("settings")).toEqual([
      expect.objectContaining({ model: "mock%2Flocal/m-1" }),
      expect.objectContaining({ effort: "high" }),
    ]);
    expect(await action("settings", { model: "nobody/none" })).toMatchObject({
      status: 400,
      body: { error: "unsupported_model" },
    });
    expect(await action("settings", { effort: "extreme" })).toMatchObject({
      status: 400,
      body: { error: "unsupported_effort" },
    });
    for (const fields of [{ effort: null }, { serviceTierId: null }])
      expect(await action("settings", fields)).toMatchObject({ status: 400 });
    expect(forwarded("settings")).toHaveLength(2);
    // With a default model reported, restoring defaults reaches the runtime as a reset.
    expect(await action("settings", { restoreDefaults: true })).toMatchObject({ status: 200 });
    expect(forwarded("settings").at(-1)).toMatchObject({ resetDefaults: true });
  });

  it("starts new DSH sessions in an authorized workspace and takes nothing else here", async () => {
    expect(await service.localRequest("/managed/options?agent=deepseek-harness")).toMatchObject({
      status: 200,
      body: { available: true, workspaces: [{ id: "workspace", name: "Synthetic workspace" }] },
    });
    const desktop = await service.localRequest("/access");
    const bootId = (desktop.body as { bootId: string }).bootId;
    expect(
      await service.localRequest("/managed/create", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        workspaceId: "workspace",
      }),
    ).toMatchObject({ status: 200, body: { accepted: true, sessionId: "dsh-new" } });
    expect(forwarded("dsh-create")).toEqual([
      expect.objectContaining({ workspaceId: "workspace" }),
    ]);
    // Adopting or releasing is not how a DSH session is taken over.
    expect(
      await service.localRequest("/managed/adopt", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        sessionId: "dsh-session",
      }),
    ).toMatchObject({ status: 404 });
  });
});
