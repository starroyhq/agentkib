import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";
import { createSkillRequestTracker } from "./fixtures/skill-request-tracker";

const folders: string[] = [];
const requests = createSkillRequestTracker();
beforeEach(() => requests.waitForCleanup());
afterEach(() =>
  requests.cleanup(async () => {
    await requests.settle();
    vi.restoreAllMocks();
    await Promise.all(
      folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
    );
  }),
);

async function fixture(personal = false) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-sync-recovery-")));
  folders.push(home);
  const workspace = path.join(home, "project");
  const root = path.join(home, "library");
  const target = path.join(personal ? home : workspace, ".claude/skills/reviewer");
  const text = (body: string) => `---\nname: reviewer\ndescription: Review changes\n---\n${body}\n`;
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  await fs.writeFile(path.join(target, "SKILL.md"), text("initial"));
  const create = () =>
    new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "data"),
      () => [{ id: "project", path: workspace }],
    );
  const skills = create();
  const state = () => skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const prepare = (params: Record<string, unknown>) =>
    skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = (preview: SkillSyncPreview, approveHome = personal) =>
    skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
      approve_home: approveHome,
    }) as Promise<SkillSyncReport>;
  const observation = (await state()).observations.find((row) => row.path === target)!;
  const adopted = await apply(
    await prepare({ operation: "adopt", observation_id: observation.id }),
  );
  expect(adopted.results[0], JSON.stringify(adopted)).toMatchObject({ success: true });
  const id = adopted.results[0]!.deployment_id!;
  const libraryId = adopted.results[0]!.library_id!;
  const library = path.join(root, "skills", libraryId);
  return {
    home,
    workspace,
    root,
    target,
    text,
    create,
    skills,
    state,
    prepare,
    apply,
    id,
    libraryId,
    library,
  };
}

describe("Skill synchronization recovery regressions", () => {
  it("returns a stable recovered receipt after rolling back a library precommit interruption", () =>
    requests.run(async () => {
      const f = await fixture();
      const edited = f.text("retained native edit");
      await fs.writeFile(path.join(f.target, "SKILL.md"), edited);
      const preview = await f.prepare({ operation: "pull", deployment_id: f.id });
      const rename = fs.rename.bind(fs);
      const backup = path.join(f.root, "backups/skills", f.libraryId);
      let interrupted = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(from) === f.library && !interrupted) {
          await rename(from, to);
          interrupted = true;
          throw new Error("fixture interruption after library move");
        }
        if (interrupted && String(from) === backup && String(to) === f.library)
          throw new Error("fixture recovery unavailable before restart");
        await rename(from, to);
      });
      const failed = await f.apply(preview);
      spy.mockRestore();
      expect(interrupted).toBe(true);
      expect(failed.results[0]).toMatchObject({ success: false, status: "recovery-required" });
      const restarted = f.create();
      const accept = vi.spyOn(restarted.sync.hooks, "accept");
      const recover = () =>
        restarted.request("skills.recoverSync", {
          operation_id: failed.operation_id,
          confirmed: true,
        }) as Promise<SkillSyncReport>;
      const recovered = await recover();
      expect(recovered.results[0]).toMatchObject({
        success: false,
        status: "recovered",
        error: expect.stringContaining("new synchronization preview"),
      });
      expect(accept).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.library, "SKILL.md"), "utf8")).toBe(f.text("initial"));
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(edited);
      expect(await recover()).toEqual(recovered);
      const transaction = JSON.parse(
        await fs.readFile(
          path.join(f.root, ".skill-state/library-transactions", `${failed.operation_id}.json`),
          "utf8",
        ),
      );
      expect(transaction.state).toBe("recovered");
      const newPreview = (await restarted.request("skills.prepareSync", {
        operation: "pull",
        deployment_id: f.id,
      })) as SkillSyncPreview;
      const newResult = (await restarted.request("skills.applySync", {
        token: newPreview.token,
        confirmed: true,
      })) as SkillSyncReport;
      expect(newResult.results[0]).toMatchObject({ success: true });
      expect(newResult.operation_id).not.toBe(failed.operation_id);
      expect(await fs.readFile(path.join(f.library, "SKILL.md"), "utf8")).toBe(edited);
    }));

  it("continues a committed library transaction after restart without accepting it twice", () =>
    requests.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.target, "SKILL.md"), f.text("accepted edit"));
      const accept = f.skills.sync.hooks.accept;
      f.skills.sync.hooks.accept = async (input) => {
        await accept(input);
        throw new Error("fixture interruption after commit");
      };
      const failed = await f.apply(await f.prepare({ operation: "pull", deployment_id: f.id }));
      expect(failed.results[0]).toMatchObject({ status: "recovery-required" });
      const restarted = f.create();
      const repeatedAccept = vi.spyOn(restarted.sync.hooks, "accept");
      const recovery = { operation_id: failed.operation_id, confirmed: true };
      const recovered = (await restarted.request(
        "skills.recoverSync",
        recovery,
      )) as SkillSyncReport;
      expect(recovered.results[0]).toMatchObject({ success: true, status: "synchronized" });
      expect(repeatedAccept).not.toHaveBeenCalled();
      expect(await restarted.request("skills.recoverSync", recovery)).toEqual(recovered);
      expect(
        ((await restarted.request("skills.syncState", {})) as SkillSyncState).deployments[0],
      ).toMatchObject({ sync_state: "current" });
    }));

  it.each(["invalid-frontmatter", "missing-entrypoint"])(
    "detaches %s while retaining every native byte",
    (damage) =>
      requests.run(async () => {
        const f = await fixture();
        await fs.writeFile(path.join(f.target, "notes.txt"), "retained ordinary resource\n");
        if (damage === "missing-entrypoint") await fs.rm(path.join(f.target, "SKILL.md"));
        else await fs.writeFile(path.join(f.target, "SKILL.md"), "user edited non-YAML document\n");
        const entries = await fs.readdir(f.target);
        const before = await Promise.all(
          entries.map((file) => fs.readFile(path.join(f.target, file))),
        );
        const libraryBefore = await fs.readFile(path.join(f.library, "SKILL.md"));
        const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
        expect(preview.targets[0].conflicts).toEqual([]);
        expect(preview.targets[0]).toMatchObject({ added: [], modified: [], removed: [] });
        expect(preview.targets[0].base_library).toBeUndefined();
        expect(preview.targets[0].base_target).toBeUndefined();
        const result = await f.apply(preview);
        expect(result.results[0], JSON.stringify(result)).toMatchObject({
          success: true,
          status: "detached",
        });
        expect(await fs.readdir(f.target)).toEqual(entries);
        expect(
          await Promise.all(entries.map((file) => fs.readFile(path.join(f.target, file)))),
        ).toEqual(before);
        expect(await fs.readFile(path.join(f.library, "SKILL.md"))).toEqual(libraryBefore);
        expect((await f.state()).deployments[0]).toMatchObject({ lifecycle_status: "inactive" });
        expect(
          await f.skills.request("skills.recoverSync", {
            operation_id: result.operation_id,
            confirmed: true,
          }),
        ).toEqual(result);
      }),
  );

  it.each(["body", "directory", "receipt", "linked-directory", "linked-resource"])(
    "rejects detach preview drift in %s",
    (change) =>
      requests.run(async () => {
        const f = await fixture();
        await fs.writeFile(path.join(f.target, "SKILL.md"), "invalid but retained body\n");
        const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
        if (change === "body")
          await fs.writeFile(path.join(f.target, "SKILL.md"), "external new body\n");
        if (change === "directory") {
          await fs.rename(f.target, `${f.target}-old`);
          await fs.mkdir(f.target);
          await fs.writeFile(path.join(f.target, "SKILL.md"), "invalid but retained body\n");
        }
        if (change === "receipt") {
          const file = path.join(f.workspace, ".agentkib/skill-deployments.json");
          const receipts = JSON.parse(await fs.readFile(file, "utf8"));
          receipts.deployments[0].updated_at = "2030-01-01T00:00:00.000Z";
          await fs.writeFile(file, JSON.stringify(receipts));
        }
        if (change === "linked-directory") {
          await fs.rename(f.target, `${f.target}-old`);
          await fs.symlink(
            `${f.target}-old`,
            f.target,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        if (change === "linked-resource")
          await fs.symlink(
            f.library,
            path.join(f.target, "linked"),
            process.platform === "win32" ? "junction" : "dir",
          );
        const result = await f.apply(preview);
        expect(result.results[0]).toMatchObject({ success: false });
        const receipts = JSON.parse(
          await fs.readFile(path.join(f.workspace, ".agentkib/skill-deployments.json"), "utf8"),
        );
        expect(receipts.deployments[0].status).toBe("active");
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
          change === "body" ? "external new body\n" : "invalid but retained body\n",
        );
      }),
  );

  it.each([
    ["invalid-frontmatter", false],
    ["invalid-frontmatter", true],
    ["missing-entrypoint", false],
    ["missing-entrypoint", true],
  ] as const)(
    "recovers interrupted metadata-only detach with %s and committed receipt=%s",
    (damage, committed) =>
      requests.run(async () => {
        const f = await fixture();
        if (damage === "missing-entrypoint") await fs.rm(path.join(f.target, "SKILL.md"));
        else await fs.writeFile(path.join(f.target, "SKILL.md"), "invalid retained body\n");
        const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
        const rename = fs.rename.bind(fs);
        let interrupted = false;
        const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          const hit =
            !interrupted && String(to).endsWith(path.join(".agentkib", "skill-deployments.json"));
          if (hit && !committed) {
            interrupted = true;
            throw new Error("fixture detach interruption before receipt");
          }
          await rename(from, to);
          if (hit) {
            interrupted = true;
            throw new Error("fixture detach receipt written before acknowledgment");
          }
        });
        const failed = await f.apply(preview);
        spy.mockRestore();
        expect(interrupted).toBe(true);
        expect(failed.results[0]).toMatchObject({ status: "recovery-required" });
        const restarted = f.create();
        const recovery = { operation_id: failed.operation_id, confirmed: true };
        const recovered = (await restarted.request(
          "skills.recoverSync",
          recovery,
        )) as SkillSyncReport;
        expect(recovered.results[0]).toMatchObject({
          success: committed,
          status: committed ? "detached" : "recovered",
        });
        expect(await restarted.request("skills.recoverSync", recovery)).toEqual(recovered);
        if (damage === "missing-entrypoint")
          await expect(fs.lstat(path.join(f.target, "SKILL.md"))).rejects.toThrow();
        else
          expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(
            "invalid retained body\n",
          );
      }),
  );

  it("still requires personal Agent Home approval to detach invalid content", () =>
    requests.run(async () => {
      const f = await fixture(true);
      await fs.writeFile(path.join(f.target, "SKILL.md"), "invalid personal body\n");
      const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
      expect(preview.requires_home_approval).toBe(true);
      await expect(f.apply(preview, false)).rejects.toThrow("Agent Home approval");
      const result = await f.apply(preview, true);
      expect(result.results[0]).toMatchObject({ success: true, status: "detached" });
    }));

  it("keeps full package validation for synchronization operations that propagate contents", () =>
    requests.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.target, "SKILL.md"), "invalid retained body\n");
      for (const operation of ["pull", "push", "fork", "bind"])
        await expect(f.prepare({ operation, deployment_id: f.id })).rejects.toThrow(
          "YAML frontmatter",
        );
      const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
      expect((await f.apply(preview)).results[0]).toMatchObject({
        success: true,
        status: "detached",
      });
    }));
});
