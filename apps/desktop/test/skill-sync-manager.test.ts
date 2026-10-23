import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";
import { createSkillRequestTracker } from "./fixtures/skill-request-tracker";
import type {
  SkillSyncPreview,
  SkillSyncReport,
  SkillSyncState,
  SkillSyncPolicy,
} from "@agentkib/runtime-protocol";

const homes: string[] = [];
const requests = createSkillRequestTracker();
afterEach(async () => {
  await requests.settle();
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-sync-"));
  homes.push(home);
  const workspace = path.join(home, "project");
  const root = path.join(home, "library");
  const target = path.join(workspace, ".claude", "skills", "reviewer");
  await mkdir(target, { recursive: true });
  await mkdir(path.join(workspace, ".git"));
  const text = (value: string) =>
    `---\nname: reviewer\ndescription: Review changes\n---\n${value}\n`;
  await writeFile(path.join(target, "SKILL.md"), text("initial"));
  const skills = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
    path.join(home, "data"),
    () => [{ id: "project", path: workspace }],
  );
  const state = async () => skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const prepare = async (params: Record<string, unknown>) =>
    skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = async (preview: SkillSyncPreview) =>
    skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    }) as Promise<SkillSyncReport>;
  const adopt = async () => {
    const observation = (await state()).observations.find((row) => row.path === target)!;
    const preview = await prepare({ operation: "adopt", observation_id: observation.id });
    const result = await apply(preview);
    expect(result.results[0], JSON.stringify(result)).toMatchObject({ success: true });
    return result.results[0];
  };
  return { home, root, target, text, skills, state, prepare, apply, adopt };
}

describe("Skill synchronization manager", () => {
  it.each(["deployment", "library"] as const)(
    "previews the actual destination delta when adopting an existing library using the %s version",
    (resolution) =>
      requests.run(async () => {
        const f = await fixture();
        await writeFile(path.join(f.target, "library-only.txt"), "library resource\n");
        const adopted = await f.adopt();
        const libraryPath = path.join(f.root, "skills", adopted.library_id!);
        const second = path.join(
          path.dirname(path.dirname(path.dirname(f.target))),
          ".cursor",
          "skills",
          "reviewer",
        );
        await mkdir(second, { recursive: true });
        await writeFile(path.join(second, "SKILL.md"), f.text("native replacement"));
        await writeFile(path.join(second, "native-only.txt"), "native resource\n");
        const observation = (await f.state()).observations.find((row) => row.path === second)!;
        const preview = await f.prepare({
          operation: "adopt",
          observation_id: observation.id,
          library_id: adopted.library_id,
          resolution,
        });
        expect(preview.targets[0]).toMatchObject({
          added: [resolution === "deployment" ? "native-only.txt" : "library-only.txt"],
          modified: ["SKILL.md"],
          removed: [resolution === "deployment" ? "library-only.txt" : "native-only.txt"],
          conflicts: [],
        });
        const read = (file: string) =>
          f.skills.request("skills.readPreviewFile", { token: preview.token, path: file });
        expect(await read("SKILL.md")).toMatchObject({
          before: f.text(resolution === "deployment" ? "initial" : "native replacement"),
          after: f.text(resolution === "deployment" ? "native replacement" : "initial"),
        });
        expect(await read("library-only.txt")).toMatchObject(
          resolution === "deployment"
            ? { before: "library resource\n", after_size: null }
            : { before_size: null, after: "library resource\n" },
        );
        expect(await read("native-only.txt")).toMatchObject(
          resolution === "deployment"
            ? { before_size: null, after: "native resource\n" }
            : { before: "native resource\n", after_size: null },
        );
        expect(await readFile(path.join(libraryPath, "SKILL.md"), "utf8")).toBe(f.text("initial"));
        expect(await readFile(path.join(second, "SKILL.md"), "utf8")).toBe(
          f.text("native replacement"),
        );
        expect((await f.apply(preview)).results[0]).toMatchObject({
          success: true,
          library_id: adopted.library_id,
        });
        const expected = f.text(resolution === "deployment" ? "native replacement" : "initial");
        expect(await readFile(path.join(libraryPath, "SKILL.md"), "utf8")).toBe(expected);
        expect(await readFile(path.join(second, "SKILL.md"), "utf8")).toBe(expected);
        for (const destination of [libraryPath, second]) {
          expect(
            await readFile(
              path.join(
                destination,
                resolution === "deployment" ? "native-only.txt" : "library-only.txt",
              ),
              "utf8",
            ),
          ).toBe(resolution === "deployment" ? "native resource\n" : "library resource\n");
          await expect(
            readFile(
              path.join(
                destination,
                resolution === "deployment" ? "library-only.txt" : "native-only.txt",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
      }),
  );
  it("adopts without rewriting native files and recovers a deployment edit into its library", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const initial = await f.state();
      expect(initial.deployments[0]).toMatchObject({
        sync_state: "current",
        baseline_available: true,
      });
      expect(
        JSON.parse(await readFile(path.join(f.root, "skills.lock.json"), "utf8")).schema_version,
      ).toBe(2);
      await writeFile(path.join(f.target, "SKILL.md"), f.text("from agent"));
      expect((await f.state()).deployments[0].sync_state).toBe("incoming");
      const preview = await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id });
      const file = await f.skills.request("skills.readPreviewFile", {
        token: preview.token,
        target_id: preview.targets[0].target_id,
        path: "SKILL.md",
      });
      expect(file).toMatchObject({ after: expect.stringContaining("from agent") });
      expect((await f.apply(preview)).results[0].success).toBe(true);
      expect(
        await readFile(path.join(f.root, "skills", adopted.library_id!, "SKILL.md"), "utf8"),
      ).toContain("from agent");
      expect((await f.state()).deployments[0].sync_state).toBe("current");
    }));

  it("keeps independent baselines, blocks a conflict, and requires an explicit winner", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const targets = (await f.skills.request("skills.targets", {})) as Array<{
        id: string;
        agent: string;
        scope: string;
      }>;
      const target = targets.find((row) => row.agent === "cursor" && row.scope === "workspace")!;
      const deploy = (await f.skills.request("skills.prepareDeployment", {
        operation: "deploy",
        library_id: adopted.library_id,
        target_ids: [target.id],
      })) as { token: string };
      const second = (await f.skills.request("skills.applyDeployment", {
        token: deploy.token,
        confirmed: true,
      })) as SkillSyncReport;
      const secondId = second.results[0].deployment_id!;
      const originalBase = (await f.state()).deployments.find(
        (row) => row.id === secondId,
      )!.base_hash;
      await writeFile(path.join(f.target, "SKILL.md"), f.text("first accepted"));
      expect(
        (
          await f.apply(
            await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }),
          )
        ).results[0].success,
      ).toBe(true);
      let state = await f.state();
      expect(state.deployments.find((row) => row.id === secondId)).toMatchObject({
        base_hash: originalBase,
        sync_state: "outgoing",
        baseline_available: true,
      });
      const secondPath = state.deployments.find((row) => row.id === secondId)!.target;
      await writeFile(path.join(secondPath, "SKILL.md"), f.text("other edit"));
      const conflict = await f.prepare({ operation: "push", deployment_id: secondId });
      expect(conflict.targets[0].conflicts.length).toBeGreaterThan(0);
      await expect(f.apply(conflict)).rejects.toThrow("explicitly choose");
      expect(
        (
          await f.apply(
            await f.prepare({ operation: "push", deployment_id: secondId, resolution: "library" }),
          )
        ).results[0].success,
      ).toBe(true);
      state = await f.state();
      expect(state.deployments.find((row) => row.id === secondId)!.sync_state).toBe("current");
    }));

  it("rejects stale previews, forks one location, detaches without deleting, and explicitly restores missing files", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const stale = await f.prepare({ operation: "push", deployment_id: adopted.deployment_id });
      await writeFile(path.join(f.target, "SKILL.md"), f.text("forked"));
      const rejected = await f.apply(stale);
      expect(rejected.results[0]).toMatchObject({ success: false, status: "failed" });
      const forked = await f.apply(
        await f.prepare({ operation: "fork", deployment_id: adopted.deployment_id }),
      );
      expect(forked.results[0].success).toBe(true);
      expect(forked.results[0].library_id).not.toBe(adopted.library_id);
      expect((await f.state()).deployments[0].library_id).toBe(adopted.library_id);
      await rm(f.target, { recursive: true });
      const restored = await f.apply(
        await f.prepare({ operation: "restore", deployment_id: adopted.deployment_id }),
      );
      expect(restored.results[0].success).toBe(true);
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toContain("initial");
      expect(
        (
          await f.apply(
            await f.prepare({ operation: "detach", deployment_id: adopted.deployment_id }),
          )
        ).results[0].status,
      ).toBe("detached");
      expect(await readFile(path.join(f.target, "SKILL.md"), "utf8")).toContain("initial");
      expect((await f.state()).observations.find((row) => row.path === f.target)?.owner).toBe(
        "external",
      );
    }));

  it("persists scoped policies, rejects a stale save, and does not run before the interval", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const state = await f.state();
      const deployment = state.deployments.find((row) => row.id === adopted.deployment_id)!;
      const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      const next = {
        ...policy,
        deployments: {
          [deployment.id]: {
            mode: "follow",
            approve_home: false,
            owner_key: deployment.owner_key,
            target_key: deployment.target_key,
          },
        },
      };
      await f.skills.request("skills.saveSyncPolicy", { policy: next, revision: policy.revision });
      await expect(
        f.skills.request("skills.saveSyncPolicy", { policy: next, revision: policy.revision }),
      ).rejects.toThrow("changed");
      const run = await f.skills.request("skills.runDueSync", {});
      expect(run).toMatchObject({ trigger: "automatic" });
      expect(await f.skills.request("skills.runDueSync", {})).toBeNull();
      const stored = await f.skills.request("skills.syncRuns", {});
      expect(stored).toMatchObject({
        runs: expect.arrayContaining([expect.objectContaining({ trigger: "automatic" })]),
      });
    }));

  it("recovers after the library committed without accepting twice", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      await writeFile(path.join(f.target, "SKILL.md"), f.text("accepted before interruption"));
      const accept = f.skills.sync.hooks.accept;
      f.skills.sync.hooks.accept = async (input) => {
        await accept(input);
        throw new Error("fixture interruption after library commit");
      };
      const interrupted = await f.apply(
        await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }),
      );
      expect(interrupted.results[0]).toMatchObject({ success: false, status: "recovery-required" });
      f.skills.sync.hooks.accept = accept;
      const recovered = (await f.skills.request("skills.recoverSync", {
        operation_id: interrupted.operation_id,
        confirmed: true,
      })) as SkillSyncReport;
      expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({ success: true });
      expect((await f.state()).deployments[0].sync_state).toBe("current");
      const previous = await readFile(
        path.join(f.root, "backups", "skills", adopted.library_id!, "SKILL.md"),
        "utf8",
      );
      expect(previous).toContain("initial");
    }));

  it("binds legacy ownership explicitly and rejects management from another library", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const receiptFile = path.join(
        path.dirname(path.dirname(path.dirname(f.target))),
        ".agentkib",
        "skill-deployments.json",
      );
      const receipts = JSON.parse(await readFile(receiptFile, "utf8"));
      delete receipts.deployments[0].library_root;
      delete receipts.deployments[0].base_snapshot_hash;
      await writeFile(receiptFile, JSON.stringify(receipts));
      expect((await f.state()).deployments[0].sync_state).toBe("unverified");
      const bind = await f.prepare({
        operation: "bind",
        deployment_id: adopted.deployment_id,
        library_id: adopted.library_id,
      });
      expect((await f.apply(bind)).results[0].success).toBe(true);
      const other = new Skills(
        { HOME: f.home, AGENTKIB_HOME: path.join(f.home, "other-library") },
        path.join(f.home, "other-data"),
        () => [{ id: "project", path: path.dirname(path.dirname(path.dirname(f.target))) }],
      );
      await expect(
        other.request("skills.prepareSync", {
          operation: "pull",
          deployment_id: adopted.deployment_id,
        }),
      ).rejects.toThrow("another library");
      const state = await f.state();
      const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      await f.skills.request("skills.saveSyncPolicy", {
        policy: {
          ...policy,
          deployments: {
            stale: { mode: "manual", approve_home: false, owner_key: "old", target_key: "old" },
          },
        },
        revision: policy.revision,
      });
      expect(state.deployments[0].sync_state).toBe("current");
    }));

  it("checks automatic forward changes even while upstream checks are not due", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const targets = (await f.skills.request("skills.targets", {})) as Array<{
        id: string;
        agent: string;
        scope: string;
      }>;
      const cursor = targets.find((row) => row.agent === "cursor" && row.scope === "workspace")!;
      const deployment = (await f.skills.request("skills.prepareDeployment", {
        operation: "deploy",
        library_id: adopted.library_id,
        target_ids: [cursor.id],
      })) as { token: string };
      const deployed = (await f.skills.request("skills.applyDeployment", {
        token: deployment.token,
        confirmed: true,
      })) as SkillSyncReport;
      const row = (await f.state()).deployments.find(
        (item) => item.id === deployed.results[0].deployment_id,
      )!;
      const policy = (await f.skills.request("skills.syncPolicy", {})) as SkillSyncPolicy;
      await f.skills.request("skills.saveSyncPolicy", {
        policy: {
          ...policy,
          deployments: {
            [row.id]: {
              mode: "follow",
              approve_home: false,
              owner_key: row.owner_key,
              target_key: row.target_key,
            },
          },
        },
        revision: policy.revision,
      });
      await f.skills.request("skills.runDueSync", {});
      await writeFile(path.join(f.target, "SKILL.md"), f.text("next revision"));
      expect(
        (
          await f.apply(
            await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }),
          )
        ).results[0].success,
      ).toBe(true);
      const result = (await f.skills.request("skills.runDueSync", {})) as SkillSyncReport;
      expect(result.results).toEqual(
        expect.arrayContaining([expect.objectContaining({ success: true, deployment_id: row.id })]),
      );
      expect(await readFile(path.join(row.target, "SKILL.md"), "utf8")).toContain("next revision");
    }));

  it("matches OpenClaw legacy Agent workspaces by identity, including shared workspaces", () =>
    requests.run(async () => {
      const f = await fixture();
      await mkdir(path.join(f.home, ".openclaw"), { recursive: true });
      await writeFile(
        path.join(f.home, ".openclaw", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: { workspace: path.join(f.home, "default") },
            list: [
              {
                id: "first",
                workspace: path.dirname(path.dirname(path.dirname(f.target))),
                skills: ["reviewer"],
              },
              {
                id: "second",
                workspace: path.dirname(path.dirname(path.dirname(f.target))),
                skills: [],
              },
            ],
          },
        }),
      );
      const native = path.join(
        path.dirname(path.dirname(path.dirname(f.target))),
        "skills",
        "reviewer",
      );
      await mkdir(native, { recursive: true });
      await writeFile(path.join(native, "SKILL.md"), f.text("native"));
      const inventory = (await f.skills.request("skills.inventory", {})) as {
        observations: Array<{ path: string; status: string; diagnostics: string[] }>;
      };
      const observation = inventory.observations.find((row) => row.path === native)!;
      expect(observation.status).not.toBe("native-restricted");
      expect(observation.diagnostics).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Agent first: allowed"),
          expect.stringContaining("Agent second: excluded"),
        ]),
      );
    }));

  it.each([
    "prepared",
    "backup-moved",
    "activated",
    "before-receipt",
    "after-receipt",
    "release-reservation",
  ] as const)(
    "recovers deployment interruption at %s without losing the retained versions",
    (stage) =>
      requests.run(async () => {
        const f = await fixture();
        const adopted = await f.adopt();
        const targets = (await f.skills.request("skills.targets", {})) as Array<{
          id: string;
          agent: string;
          scope: string;
        }>;
        const cursor = targets.find((row) => row.agent === "cursor" && row.scope === "workspace")!;
        const deployment = (await f.skills.request("skills.prepareDeployment", {
          operation: "deploy",
          library_id: adopted.library_id,
          target_ids: [cursor.id],
        })) as { token: string };
        const deployed = (await f.skills.request("skills.applyDeployment", {
          token: deployment.token,
          confirmed: true,
        })) as SkillSyncReport;
        const id = deployed.results[0].deployment_id!;
        const target = (await f.state()).deployments.find((row) => row.id === id)!.target;
        await writeFile(path.join(f.target, "SKILL.md"), f.text("second"));
        await f.apply(await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }));
        await f.apply(await f.prepare({ operation: "push", deployment_id: id }));
        await writeFile(path.join(f.target, "SKILL.md"), f.text("third"));
        await f.apply(await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }));
        const preview = await f.prepare({ operation: "push", deployment_id: id });
        const rename = fs.rename.bind(fs);
        let injected = false;
        const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          const destination = String(to);
          let hit =
            !injected &&
            ((stage === "prepared" &&
              destination.endsWith("journal.json") &&
              destination.includes(".agentkib-skill-state")) ||
              (stage === "backup-moved" && destination.endsWith("previous-backup")) ||
              (stage === "activated" && destination === target) ||
              (["before-receipt", "after-receipt"].includes(stage) &&
                destination.endsWith(path.join(".agentkib", "skill-deployments.json"))));
          if (
            !injected &&
            stage === "release-reservation" &&
            destination.endsWith("skill-deployment-reservations.json")
          )
            hit = JSON.parse(await readFile(String(from), "utf8")).deployments.length === 0;
          if (hit && (stage === "before-receipt" || stage === "release-reservation")) {
            injected = true;
            throw new Error(`fixture interruption ${stage}`);
          }
          await rename(from, to);
          if (hit) {
            injected = true;
            throw new Error(`fixture interruption ${stage}`);
          }
        });
        const interrupted = await f.apply(preview);
        spy.mockRestore();
        expect(injected).toBe(true);
        expect(interrupted.results[0], JSON.stringify(interrupted)).toMatchObject({
          success: false,
          status: "recovery-required",
        });
        const recovered = (await f.skills.request("skills.recoverSync", {
          operation_id: interrupted.operation_id,
          confirmed: true,
        })) as SkillSyncReport;
        const committed = stage === "after-receipt" || stage === "release-reservation";
        expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
          success: committed,
          status: committed ? "synchronized" : "recovered",
        });
        expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain(
          committed ? "third" : "second",
        );
        const backup = path.join(
          path.dirname(path.dirname(target)),
          ".agentkib-skill-state",
          "backups",
          id,
          "SKILL.md",
        );
        expect(await readFile(backup, "utf8")).toContain(committed ? "second" : "initial");
        const repeated = (await f.skills.request("skills.recoverSync", {
          operation_id: interrupted.operation_id,
          confirmed: true,
        })) as SkillSyncReport;
        expect(repeated.results).toEqual(recovered.results);
        expect((await f.state()).library).toHaveLength(1);
      }),
  );

  it("preserves an external edit made after an interrupted native activation", () =>
    requests.run(async () => {
      const f = await fixture();
      const adopted = await f.adopt();
      const targets = (await f.skills.request("skills.targets", {})) as Array<{
        id: string;
        agent: string;
        scope: string;
      }>;
      const cursor = targets.find((row) => row.agent === "cursor" && row.scope === "workspace")!;
      const deployment = (await f.skills.request("skills.prepareDeployment", {
        operation: "deploy",
        library_id: adopted.library_id,
        target_ids: [cursor.id],
      })) as { token: string };
      const deployed = (await f.skills.request("skills.applyDeployment", {
        token: deployment.token,
        confirmed: true,
      })) as SkillSyncReport;
      const id = deployed.results[0].deployment_id!;
      const target = (await f.state()).deployments.find((row) => row.id === id)!.target;
      await writeFile(path.join(f.target, "SKILL.md"), f.text("new candidate"));
      await f.apply(await f.prepare({ operation: "pull", deployment_id: adopted.deployment_id }));
      const preview = await f.prepare({ operation: "push", deployment_id: id });
      const rename = fs.rename.bind(fs);
      let injected = false;
      const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (!injected && String(to) === target) {
          injected = true;
          throw new Error("fixture after activation");
        }
      });
      const interrupted = await f.apply(preview);
      spy.mockRestore();
      await writeFile(path.join(target, "SKILL.md"), f.text("external work"));
      const recovered = (await f.skills.request("skills.recoverSync", {
        operation_id: interrupted.operation_id,
        confirmed: true,
      })) as SkillSyncReport;
      expect(recovered.results[0]).toMatchObject({ success: false, status: "recovery-required" });
      expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("external work");
    }));
});
