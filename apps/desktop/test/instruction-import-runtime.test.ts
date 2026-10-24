import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import type { ChangeSet } from "../../../packages/backend/src/change-plan";
import { MANAGED_START, defaultManifest } from "../../../packages/backend/src/default-manifest";
import { InstructionImports } from "../../../packages/backend/src/instruction-adoption";
import {
  manifestSchema,
  manifestYaml,
  type Manifest,
} from "../../../packages/backend/src/manifest";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const original = "# Project\nUse pnpm.\n";
function fixture() {
  const f = contextFixture();
  cleanups.push(() => f.dispose());
  f.write("AGENTS.md", original);
  f.write("CLAUDE.md", original);
  return f;
}
async function runtime(f: ContextFixture) {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const data = f.outside("data");
  mkdirSync(data, { recursive: true });
  f.write(
    `${data}/preferences.json`,
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      mcp_network: { port: address.port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  const backend = new TypeScriptBackend({
    ...f.environment,
    CODEX_HOME: f.inHome(".codex"),
    CLAUDE_CONFIG_DIR: f.inHome(".claude"),
    AGENTKIB_HOME: f.inHome(".agentkib"),
    DSH_HOME: f.inHome(".dsh"),
    XDG_CONFIG_HOME: f.inHome(".config"),
    AGENTKIB_BENCHMARK_DATA_DIR: data,
    AGENTKIB_BENCHMARK_USER_DATA: f.outside("user-data"),
  });
  cleanups.push(() => backend.closeAsync());
  let id = 0;
  const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const response = await backend.handleAsync({ jsonrpc: "2.0", id: ++id, method, params });
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result as T;
  };
  await rpc("backend.initialize", { dataDir: data });
  return {
    prepare: async (project = f.project) =>
      manifestSchema.parse(await rpc(RUNTIME_METHODS.prepareManifest, { project })),
    plan: (manifest: Manifest, project = f.project, extra = {}) =>
      rpc<ChangeSet>(RUNTIME_METHODS.planChanges, {
        project,
        manifest,
        includeHome: false,
        ...extra,
      }),
    raw: rpc,
  };
}
function after(plan: ChangeSet, f: ContextFixture, name: string) {
  return plan.changes.find((change) => change.target === f.at(name))!.after;
}

describe("server-owned first-import proof", () => {
  it("moves a sole imported CLAUDE body into the new AGENTS file without duplicating it", async () => {
    const f = fixture();
    rmSync(f.at("AGENTS.md"));
    const api = await runtime(f),
      manifest = await api.prepare();
    expect(manifest.instructions.shared).toBe(original);
    manifest.instructions.shared += "Reviewed addition.\n";
    const plan = await api.plan(manifest);
    expect(after(plan, f, "AGENTS.md").startsWith(MANAGED_START)).toBe(true);
    expect(after(plan, f, "AGENTS.md").split("Use pnpm.")).toHaveLength(2);
    expect(after(plan, f, "CLAUDE.md").startsWith(MANAGED_START)).toBe(true);
    expect(after(plan, f, "CLAUDE.md")).not.toContain("Use pnpm.");
  });

  it.each(["# Replacement\nUse the new workflow.\n", ""])(
    "honors arbitrary reviewed shared edits without retaining the old native body: %j",
    async (shared) => {
      const f = fixture(),
        api = await runtime(f),
        manifest = await api.prepare();
      manifest.instructions.shared = shared;
      const plan = await api.plan(manifest);
      expect(after(plan, f, "AGENTS.md").startsWith(MANAGED_START)).toBe(true);
      expect(after(plan, f, "AGENTS.md")).not.toContain("Use pnpm.");
      expect(after(plan, f, "CLAUDE.md")).not.toContain("Use pnpm.");
      applyChanges(plan, f.outside("backups"), {
        approvedHome: [],
        protectedHome: [],
        approvedApplication: [],
        approveHome: false,
      });
      expect(readFileSync(f.at("CLAUDE.md"), "utf8").startsWith(MANAGED_START)).toBe(true);
    },
  );

  it("does not accept a fabricated draft id or proof fields supplied by the client", async () => {
    const f = fixture(),
      api = await runtime(f);
    await api.prepare();
    const manifest = defaultManifest(f.project);
    manifest.instructions.shared += "Reviewed addition.\n";
    const plan = await api.plan(manifest, f.project, {
      instructionImport: { shared_hash: "fabricated", source_hashes: {} },
    });
    expect(after(plan, f, "AGENTS.md").startsWith(original)).toBe(true);
    expect(after(plan, f, "CLAUDE.md").startsWith(original)).toBe(true);
  });

  it("binds the server-issued id to its original canonical workspace", async () => {
    const f = fixture(),
      other = fixture(),
      api = await runtime(f),
      manifest = await api.prepare();
    manifest.instructions.shared += "Reviewed addition.\n";
    const plan = await api.plan(manifest, other.project);
    expect(after(plan, other, "AGENTS.md").startsWith(original)).toBe(true);
  });

  it("preserves a source modified after import and still enforces the reviewed apply fingerprint", async () => {
    const f = fixture(),
      api = await runtime(f),
      manifest = await api.prepare();
    manifest.instructions.shared += "Reviewed addition.\n";
    const changed = `${original}\nExternal change before planning.\n`;
    f.write("AGENTS.md", changed);
    const plan = await api.plan(manifest);
    expect(after(plan, f, "AGENTS.md").startsWith(changed)).toBe(true);
    f.write("AGENTS.md", "External change after planning.\n");
    expect(() =>
      applyChanges(plan, f.outside("backups"), {
        approvedHome: [],
        protectedHome: [],
        approvedApplication: [],
        approveHome: false,
      }),
    ).toThrow();
    expect(readFileSync(f.at("AGENTS.md"), "utf8")).toBe("External change after planning.\n");
  });

  it("does not consume the old import proof once a real manifest exists", async () => {
    const f = fixture(),
      api = await runtime(f),
      manifest = await api.prepare();
    f.write(".agentkib/manifest.yaml", manifestYaml(manifest));
    manifest.instructions.shared += "Reviewed addition.\n";
    expect(after(await api.plan(manifest), f, "AGENTS.md").startsWith(original)).toBe(true);
  });

  it("does not opt cross-Agent asset planning into takeover", async () => {
    const f = fixture(),
      api = await runtime(f),
      manifest = await api.prepare();
    manifest.instructions.shared += "Reviewed addition.\n";
    const plan = await api.raw<ChangeSet>("backend.planProjectAssets", {
      project: f.project,
      manifest,
    });
    expect(after(plan, f, "AGENTS.md").startsWith(original)).toBe(true);
  });

  it("evicts old evidence at the bounded capacity and stores only hashes", () => {
    const f = fixture(),
      imports = new InstructionImports(),
      manifest = defaultManifest(f.project);
    const id = manifest.workspace.id;
    imports.record(f.project, manifest);
    const proof = imports.get(f.project, id)!;
    expect(proof.shared_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(proof.source_hashes).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(
      true,
    );
    for (let index = 0; index < 64; index++)
      imports.record(f.project, {
        ...manifest,
        workspace: { ...manifest.workspace, id: `fixture-${index}` },
      });
    expect(imports.get(f.project, id)).toBeUndefined();
    expect(imports.get(f.project, "fixture-63")).toBeDefined();
    imports.clear();
    expect(imports.get(f.project, "fixture-63")).toBeUndefined();
  });
});
