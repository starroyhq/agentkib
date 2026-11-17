// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionProviderCapabilities } from "@agentkib/runtime-protocol";
import { WebAccessService } from "./service";

const model = {
  id: "opus",
  efforts: ["high"],
  serviceTierIds: ["fast"],
  maxContextTokens: 1_000_000,
  variants: [
    { id: "opus-high", effort: "high", maxContextTokens: 1_000_000 },
    { id: "opus-high-fast", effort: "high", serviceTierId: "fast", maxContextTokens: 1_000_000 },
  ],
};
const serviceTiers = [{ id: "fast", name: "Fast" }];
const writable = { available: true };
let directory: string;
let service: WebAccessService;
let bootId: string;

const runtime = vi.fn(async (input: unknown) => {
  const params = input as Record<string, unknown>;
  const live = {
    sessionId: "devin-session",
    executionMode: "devin-print",
    workspaceId: "workspace",
    runtimeBootId: "runtime",
    revision: 4,
    status: "idle",
    sendEnabled: true,
  };
  switch (params.operation) {
    case "catalog":
      return {
        sessions: [{ id: live.sessionId, agent: "devin", workspace_id: live.workspaceId }],
      };
    case "live":
      return live;
    case "capabilities":
      return { ...live, features: { settings: writable, "settings-state": writable } };
    case "settings-state":
      return {
        ...live,
        provider: sessionProviderCapabilities("devin"),
        available: true,
        current: {
          model: model.id,
          effort: "high",
          serviceTier: "fast",
          maxContextTokens: 1_000_000,
        },
        models: [model],
        serviceTiers,
        writable: { model: writable, effort: writable, serviceTier: writable },
        historicalUsage: {
          available: true,
          state: "stale",
          historical: true,
          reason: "devin-last-model-request",
          usedTokens: 40_000,
          contextWindow: 1_000_000,
        },
      };
    case "provider-options":
      return {
        available: true,
        provider: sessionProviderCapabilities(params.agent),
        models: params.agent === "devin" ? [model] : [],
        ...(params.agent === "devin" ? { serviceTiers } : {}),
      };
    case "usage":
      return { available: false, reason: "usage-not-reported" };
    default:
      return {
        accepted: true,
        completed: true,
        sessionId: live.sessionId,
        requestId: params.requestId,
      };
  }
});

beforeEach(async () => {
  runtime.mockClear();
  directory = await mkdtemp(join(tmpdir(), "agentkib-devin-host-"));
  const path = join(directory, "workspace");
  await mkdir(path);
  service = new WebAccessService({
    dataDir: directory,
    staticDir: directory,
    desktopOrigin: "app://bundle",
    runtimeRequest: runtime,
    sessionProviderRequest: runtime,
    workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path }],
    verifiedAntigravityManaged: true,
    verifiedDevinManaged: true,
  });
  await service.initialize();
  bootId = ((await service.localRequest("/access")).body as { bootId: string }).bootId;
});

afterEach(async () => {
  await service.shutdown();
  await rm(directory, { recursive: true, force: true });
});

it("keeps model variants and window limits in the settings and new-session responses", async () => {
  const models = [model];
  expect(
    await service.localRequest("/managed/settings?sessionId=devin-session&agent=devin"),
  ).toMatchObject({
    status: 200,
    body: {
      current: {
        modelId: "opus",
        effort: "high",
        serviceTierId: "fast",
        maxContextTokens: 1_000_000,
      },
      options: { models, serviceTiers },
      provider: sessionProviderCapabilities("devin"),
      usage: {
        historical: true,
        state: "stale",
        reason: "devin-last-model-request",
        usedTokens: 40_000,
        contextWindow: 1_000_000,
      },
    },
  });
  expect(runtime).not.toHaveBeenCalledWith({ operation: "usage", sessionId: "devin-session" });
  expect(
    await service.localRequest("/managed/options?agent=devin&workspaceId=workspace"),
  ).toMatchObject({
    status: 200,
    body: { models, serviceTiers, provider: sessionProviderCapabilities("devin") },
  });
  expect(runtime).toHaveBeenCalledWith({
    operation: "provider-options",
    agent: "devin",
    workspaceId: "workspace",
  });
});

it("forwards Devin's preferred effort and tier on create and allows turning Fast off on resume", async () => {
  expect(
    await service.localRequest("/managed/create", {
      agent: "devin",
      bootId,
      requestId: randomUUID(),
      workspaceId: "workspace",
      prompt: "sample",
      model: "opus",
      effort: "high",
      serviceTierId: "fast",
    }),
  ).toMatchObject({ status: 200 });
  expect(runtime).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "provider-create",
      agent: "devin",
      model: "opus",
      effort: "high",
      serviceTier: "fast",
    }),
  );
  expect(
    await service.localRequest("/managed/action", {
      operation: "settings",
      agent: "devin",
      bootId,
      requestId: randomUUID(),
      sessionId: "devin-session",
      expectedRevision: 4,
      serviceTierId: null,
    }),
  ).toMatchObject({ status: 200 });
  expect(runtime).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "settings", expectedRevision: 4, serviceTier: null }),
  );
});

it("uses the same registered create path for Codex without dispatching invalid creation requests", async () => {
  const request = { bootId, workspaceId: "workspace" };
  expect(await service.localRequest("/managed/options?agent=codex")).toMatchObject({
    status: 200,
    body: { provider: sessionProviderCapabilities("codex") },
  });
  expect(
    await service.localRequest("/managed/create", {
      ...request,
      agent: "devin",
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 400, body: { error: "missing_prompt" } });
  expect(
    await service.localRequest("/managed/create", {
      ...request,
      workspaceId: "unknown",
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 403, body: { error: "workspace_not_authorized" } });
  expect(
    await service.localRequest("/managed/create", {
      ...request,
      requestId: randomUUID(),
    }),
  ).toMatchObject({ status: 200, body: { accepted: true } });
  const dispatched = runtime.mock.calls
    .map(([params]) => params as Record<string, unknown>)
    .filter(({ operation }) => operation === "provider-create");
  expect(dispatched).toEqual([
    expect.objectContaining({
      agent: "codex",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
    }),
  ]);
  expect(dispatched[0]).not.toHaveProperty("prompt");
});
