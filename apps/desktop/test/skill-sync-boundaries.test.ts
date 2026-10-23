import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillSyncPolicy,
  SkillSyncPreview,
  SkillSyncReport,
  SkillSyncState,
} from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";
import { createSkillRequestTracker } from "./fixtures/skill-request-tracker";
import { SkillStateStore } from "../../../packages/backend/src/skill-state";

const folders: string[] = [];
const requests = createSkillRequestTracker();
afterEach(async () => {
  await requests.settle();
  vi.restoreAllMocks();
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-sync-boundary-")));
  folders.push(home);
  const workspace = path.join(home, "project");
  const root = path.join(home, "library");
  const target = path.join(workspace, ".claude/skills/reviewer");
  const text = (value: string) =>
    `---\nname: reviewer\ndescription: Review changes\n---\n${value}\n`;
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.join(workspace, ".git"));
  await fs.writeFile(path.join(target, "SKILL.md"), text("initial"));
  const skills = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
    path.join(home, "data"),
    () => [{ id: "project", path: workspace }],
  );
  const state = () => skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const prepare = (params: Record<string, unknown>) =>
    skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = (preview: SkillSyncPreview) =>
    skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    }) as Promise<SkillSyncReport>;
  const observation = (await state()).observations.find((row) => row.path === target)!;
  const adopted = await apply(
    await prepare({ operation: "adopt", observation_id: observation.id }),
  );
  expect(adopted.results[0], JSON.stringify(adopted)).toMatchObject({ success: true });
  const firstId = adopted.results[0]!.deployment_id!;
  const libraryId = adopted.results[0]!.library_id!;
  const library = path.join(root, "skills", libraryId);
  const receiptFile = path.join(workspace, ".agentkib/skill-deployments.json");
  async function second() {
    const targets = (await skills.request("skills.targets", {})) as Array<{
      id: string;
      agent: string;
      scope: string;
    }>;
    const cursor = targets.find((row) => row.agent === "cursor" && row.scope === "workspace")!;
    const preview = (await skills.request("skills.prepareDeployment", {
      operation: "deploy",
      library_id: libraryId,
      target_ids: [cursor.id],
    })) as { token: string };
    const deployed = (await skills.request("skills.applyDeployment", {
      token: preview.token,
      confirmed: true,
    })) as SkillSyncReport;
    expect(deployed.results[0], JSON.stringify(deployed)).toMatchObject({ success: true });
    const row = (await state()).deployments.find(
      (item) => item.id === deployed.results[0]!.deployment_id,
    )!;
    return row;
  }
  async function advance() {
    await fs.writeFile(path.join(target, "SKILL.md"), text("accepted revision"));
    const result = await apply(await prepare({ operation: "pull", deployment_id: firstId }));
    expect(result.results[0], JSON.stringify(result)).toMatchObject({ success: true });
  }
  async function follow(id: string, mode: "follow" | "manual" = "follow") {
    const row = (await state()).deployments.find((item) => item.id === id)!;
    const policy = (await skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
    return skills.request("skills.saveSyncPolicy", {
      revision: policy.revision,
      policy: {
        ...policy,
        default_mode: "manual",
        libraries: {},
        deployments: {
          [id]: { mode, approve_home: false, owner_key: row.owner_key, target_key: row.target_key },
        },
      },
    });
  }
  return {
    home,
    workspace,
    root,
    target,
    text,
    skills,
    state,
    prepare,
    apply,
    firstId,
    libraryId,
    library,
    receiptFile,
    second,
    advance,
    follow,
  };
}

describe("Skill synchronization filesystem boundaries", () => {
  it("advances a converged baseline without rewriting native or library package files", () =>
    requests.run(async () => {
      const f = await fixture();
      const second = await f.second();
      await f.advance();
      await fs.writeFile(path.join(second.target, "SKILL.md"), f.text("accepted revision"));
      const before = await fs.stat(path.join(second.target, "SKILL.md"));
      const libraryBefore = await fs.stat(path.join(f.library, "SKILL.md"));
      const libraryLock = await fs.readFile(path.join(f.root, "skills.lock.json"), "utf8");
      expect((await f.state()).deployments.find((row) => row.id === second.id)?.sync_state).toBe(
        "converged",
      );
      const result = await f.apply(
        await f.prepare({ operation: "push", deployment_id: second.id }),
      );
      expect(result.results[0], JSON.stringify(result)).toMatchObject({ success: true });
      const after = await fs.stat(path.join(second.target, "SKILL.md"));
      const libraryAfter = await fs.stat(path.join(f.library, "SKILL.md"));
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect([libraryAfter.ino, libraryAfter.mtimeMs]).toEqual([
        libraryBefore.ino,
        libraryBefore.mtimeMs,
      ]);
      expect(await fs.readFile(path.join(f.root, "skills.lock.json"), "utf8")).toBe(libraryLock);
      expect((await f.state()).deployments.find((row) => row.id === second.id)?.sync_state).toBe(
        "current",
      );
    }));

  it.each([
    "target-invalid",
    "target-missing",
    "target-linked",
    "library-invalid",
    "baseline-corrupt",
    "candidate-corrupt",
  ])("does not start an automatic distribution when %s", (damage) =>
    requests.run(async () => {
      const f = await fixture();
      const second = await f.second();
      await f.follow(second.id);
      await f.advance();
      const current = (await f.state()).deployments.find((row) => row.id === second.id)!;
      const entrypoint = path.join(second.target, "SKILL.md");
      const before = await fs.readFile(entrypoint, "utf8");
      if (damage === "target-invalid") await fs.writeFile(entrypoint, "Invalid frontmatter\n");
      if (damage === "target-missing") await fs.rm(second.target, { recursive: true });
      if (damage === "target-linked") {
        await fs.rm(second.target, { recursive: true });
        await fs.symlink(
          f.target,
          second.target,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      if (damage === "library-invalid")
        await fs.writeFile(path.join(f.library, "SKILL.md"), "Invalid frontmatter\n");
      if (damage === "baseline-corrupt" || damage === "candidate-corrupt") {
        const hash = damage === "baseline-corrupt" ? current.base_hash! : current.library_hash!;
        await fs.writeFile(
          path.join(new SkillStateStore(f.root).snapshotPath(hash), "SKILL.md"),
          "Corrupt snapshot\n",
        );
      }
      const commit = vi.spyOn(f.skills.manager, "commitSync");
      await f.skills.request("skills.runDueSync", {});
      expect(commit).not.toHaveBeenCalled();
      if (damage === "target-missing") await expect(fs.lstat(second.target)).rejects.toThrow();
      else if (damage === "target-linked")
        expect((await fs.lstat(second.target)).isSymbolicLink()).toBe(true);
      else
        expect(await fs.readFile(entrypoint, "utf8")).toBe(
          damage === "target-invalid" ? "Invalid frontmatter\n" : before,
        );
    }),
  );

  it.each(["policy", "ownership"])("rejects a reviewed preview after %s changes", (change) =>
    requests.run(async () => {
      const f = await fixture();
      const second = await f.second();
      await f.advance();
      const preview = await f.prepare({ operation: "push", deployment_id: second.id });
      const before = await fs.readFile(path.join(second.target, "SKILL.md"), "utf8");
      if (change === "policy") {
        const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
        await f.skills.request("skills.saveSyncPolicy", {
          revision: policy.revision,
          policy: { ...policy, enabled: false },
        });
        await expect(f.apply(preview)).rejects.toThrow("policy changed");
      } else {
        const document = JSON.parse(await fs.readFile(f.receiptFile, "utf8"));
        document.deployments.find((row: { id: string }) => row.id === second.id).updated_at =
          "2030-01-01T00:00:00.000Z";
        await fs.writeFile(f.receiptFile, JSON.stringify(document));
        const result = await f.apply(preview);
        expect(result.results[0]).toMatchObject({
          success: false,
          error: expect.stringContaining("ownership changed"),
        });
      }
      expect(await fs.readFile(path.join(second.target, "SKILL.md"), "utf8")).toBe(before);
    }),
  );

  it("creates only one deployment for Agents sharing a physical native root", () =>
    requests.run(async () => {
      const f = await fixture();
      const targets = (await f.skills.request("skills.targets", {})) as Array<{
        id: string;
        agent: string;
        scope: string;
        root: string;
      }>;
      const selected = targets.filter(
        (row) => row.scope === "workspace" && ["codex", "antigravity"].includes(row.agent),
      );
      expect(selected).toHaveLength(2);
      expect(selected[0]!.root).toBe(selected[1]!.root);
      const preview = (await f.skills.request("skills.prepareDeployment", {
        operation: "deploy",
        library_id: f.libraryId,
        target_ids: selected.map((row) => row.id),
      })) as { token: string };
      const applied = (await f.skills.request("skills.applyDeployment", {
        token: preview.token,
        confirmed: true,
      })) as SkillSyncReport;
      expect(applied.results).toHaveLength(1);
      expect(applied.results[0]).toMatchObject({ success: true });
      const physical = path.join(selected[0]!.root, f.libraryId);
      expect((await f.state()).deployments.filter((row) => row.target === physical)).toHaveLength(
        1,
      );
    }));

  it("does not start a write when automatic authorization is revoked during preparation", () =>
    requests.run(async () => {
      const f = await fixture();
      const second = await f.second();
      await f.follow(second.id);
      await f.advance();
      const before = await fs.readFile(path.join(second.target, "SKILL.md"), "utf8");
      const prepare = f.skills.sync.prepare.bind(f.skills.sync);
      vi.spyOn(f.skills.sync, "prepare").mockImplementation(async (params) => {
        const preview = await prepare(params);
        await f.follow(second.id, "manual");
        return preview;
      });
      const commit = vi.spyOn(f.skills.manager, "commitSync");
      await f.skills.request("skills.runDueSync", {});
      expect(commit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(second.target, "SKILL.md"), "utf8")).toBe(before);
    }));
});
