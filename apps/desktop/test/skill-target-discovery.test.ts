import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-skill-target-discovery-")),
  );
  homes.push(home);
  const project = path.join(home, "project");
  const root = path.join(home, "library");
  const workspaces = [{ id: "project", path: project }];
  const environment = { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root } as NodeJS.ProcessEnv;
  const text = (body: string) => `---\nname: reviewer\ndescription: Review changes\n---\n${body}\n`;
  async function nativeSkill(directory: string, body = "initial") {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), text(body));
    return directory;
  }
  const target = await nativeSkill(path.join(project, ".claude", "skills", "reviewer"));
  await fs.mkdir(path.join(project, ".git"));
  const skills = new Skills(environment, path.join(home, "data"), () => workspaces);
  const prepare = (params: Record<string, unknown>) =>
    skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = (preview: SkillSyncPreview) =>
    skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    }) as Promise<SkillSyncReport>;
  async function adopt() {
    const observation = (await skills.manager.inventory()).observations.find(
      (row) => row.path === target,
    )!;
    const result = await apply(
      await prepare({ operation: "adopt", observation_id: observation.id }),
    );
    expect(result.results[0], JSON.stringify(result)).toMatchObject({ success: true });
    return result.results[0];
  }
  return {
    home,
    project,
    root,
    workspaces,
    environment,
    text,
    nativeSkill,
    target,
    skills,
    prepare,
    apply,
    adopt,
  };
}

async function preparedCursorDeployment() {
  const f = await fixture();
  const adopted = await f.adopt();
  const cursor = (await f.skills.manager.targets()).find(
    (target) => target.agent === "cursor" && target.scope === "workspace",
  )!;
  const request = {
    operation: "deploy",
    library_id: adopted.library_id!,
    target_ids: [cursor.id],
  };
  const preview = await f.skills.manager.prepareDeployment(request);
  expect(preview.targets[0].conflicts).toEqual([]);
  return { ...f, adopted, cursor, request, preview };
}

describe("Skill target discovery within read aggregates", () => {
  it("scans each native root once for a multi-skill synchronization state", async () => {
    const f = await fixture();
    const nativeRoot = path.dirname(f.target);
    const paths = [f.target];
    for (let index = 1; index < 8; index++) {
      paths.push(await f.nativeSkill(path.join(nativeRoot, `reviewer-${index}`)));
    }
    const discover = vi.spyOn(f.skills.manager, "targets");
    const readdir = vi.spyOn(fs, "readdir");

    const state = (await f.skills.request("skills.syncState", {})) as SkillSyncState;

    expect(state.observations.filter((row) => paths.includes(row.path))).toHaveLength(8);
    for (const target of paths) {
      expect(state.observations.find((row) => row.path === target)).toMatchObject({
        can_adopt: true,
        target_id: expect.any(String),
      });
    }
    expect(discover).toHaveBeenCalledOnce();
    expect(readdir.mock.calls.filter(([directory]) => directory === nativeRoot)).toHaveLength(1);
  });

  it("keeps overlapping synchronization state discoveries independent", async () => {
    const f = await fixture();
    const discover = vi.spyOn(f.skills.manager, "targets");

    const states = (await Promise.all([
      f.skills.request("skills.syncState", {}),
      f.skills.request("skills.syncState", {}),
    ])) as SkillSyncState[];

    expect(discover).toHaveBeenCalledTimes(2);
    expect(states[0].observations).toEqual(states[1].observations);
    expect(states[0].observations.find((row) => row.path === f.target)?.can_adopt).toBe(true);
  });

  it("refreshes workspaces between synchronization state requests", async () => {
    const f = await fixture();
    const before = (await f.skills.request("skills.syncState", {})) as SkillSyncState;
    expect(before.observations.some((row) => row.path === f.target)).toBe(true);
    const replacement = path.join(f.home, "replacement");
    const next = await f.nativeSkill(path.join(replacement, ".claude", "skills", "next"));
    await fs.mkdir(path.join(replacement, ".git"));
    f.workspaces[0] = { id: "project", path: replacement };

    const after = (await f.skills.request("skills.syncState", {})) as SkillSyncState;

    expect(after.observations.find((row) => row.path === next)?.can_adopt).toBe(true);
    expect(after.observations.some((row) => row.path === f.target)).toBe(false);
  });

  it("refreshes package and receipt changes between synchronization state requests", async () => {
    const f = await fixture();
    const adopted = await f.adopt();
    const read = () => f.skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
    expect((await read()).deployments[0]).toMatchObject({
      id: adopted.deployment_id,
      sync_state: "current",
    });
    await fs.writeFile(path.join(f.target, "SKILL.md"), f.text("external native edit"));
    expect((await read()).deployments[0]).toMatchObject({ sync_state: "incoming" });
    const receiptFile = path.join(f.project, ".agentkib", "skill-deployments.json");
    const receipts = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    receipts.deployments[0].status = "inactive";
    await fs.writeFile(receiptFile, JSON.stringify(receipts));
    expect((await read()).deployments[0]).toMatchObject({ status: "inactive" });
    await fs.writeFile(receiptFile, "invalid JSON");

    const damaged = await read();

    expect(
      damaged.warnings.some((warning) => warning.includes("Skill ownership could not be verified")),
    ).toBe(true);
    expect(damaged.observations.find((row) => row.path === f.target)).toMatchObject({
      status: "unverified",
      can_adopt: false,
    });
  });

  it.each(["observation", "deployment"] as const)(
    "discovers targets once while resolving a %s with its real package and ownership",
    async (kind) => {
      const f = await fixture();
      const params =
        kind === "deployment"
          ? { deployment_id: (await f.adopt()).deployment_id! }
          : {
              observation_id: (await f.skills.manager.inventory()).observations.find(
                (row) => row.path === f.target,
              )!.id,
            };
      const discover = vi.spyOn(f.skills.manager, "targets");

      const location = await f.skills.manager.syncLocation(params);

      expect(discover).toHaveBeenCalledOnce();
      expect(location).toMatchObject({ destination: f.target, target: { writable: true } });
      expect(location.target_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(location.receipt === null).toBe(kind === "observation");
    },
  );

  it("keeps overlapping location reads independent instead of sharing a discovery cache", async () => {
    const f = await fixture();
    const second = await f.nativeSkill(path.join(f.project, ".cursor", "skills", "second"));
    const observations = (await f.skills.manager.inventory()).observations;
    const discover = vi.spyOn(f.skills.manager, "targets");

    const locations = await Promise.all(
      [f.target, second].map((target) =>
        f.skills.manager.syncLocation({
          observation_id: observations.find((row) => row.path === target)!.id,
        }),
      ),
    );

    expect(discover).toHaveBeenCalledTimes(2);
    expect(locations.map((location) => location.destination)).toEqual([f.target, second]);
  });

  it("reads changed package contents again on the next location request", async () => {
    const f = await fixture();
    const adopted = await f.adopt();
    const params = { deployment_id: adopted.deployment_id! };
    const discover = vi.spyOn(f.skills.manager, "targets");
    const before = await f.skills.manager.syncLocation(params);
    await fs.writeFile(path.join(f.target, "SKILL.md"), f.text("external native edit"));

    const after = await f.skills.manager.syncLocation(params);

    expect(discover).toHaveBeenCalledTimes(2);
    expect(after.target_hash).not.toBe(before.target_hash);
    expect(after.receipt).toEqual(before.receipt);
  });

  it.each(["availability", "location"] as const)(
    "rechecks reservations after the previous %s request finished",
    async (method) => {
      const f = await fixture();
      const adopted = await f.adopt();
      const receipt = (await f.skills.manager.listDeployments())[0];
      const request = () =>
        method === "availability"
          ? f.skills.manager.assertSyncOperationAvailable(f.target)
          : f.skills.manager.syncLocation({ deployment_id: adopted.deployment_id! });
      await f.skills.request("skills.syncState", {});
      const discover = vi.spyOn(f.skills.manager, "targets");
      await request();
      expect(discover).toHaveBeenCalledOnce();
      await fs.writeFile(
        path.join(f.project, ".agentkib", "skill-deployment-reservations.json"),
        JSON.stringify({
          schema_version: 2,
          deployments: [
            { ...receipt, operation_id: "other-operation", status: "recovery-required" },
          ],
        }),
      );

      await expect(request()).rejects.toThrow("unfinished operation requiring recovery");
      expect(discover).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );

  it("discovers deployment targets once while retaining the actual preview checks", async () => {
    const f = await fixture();
    const adopted = await f.adopt();
    const cursor = (await f.skills.manager.targets()).find(
      (target) => target.agent === "cursor" && target.scope === "workspace",
    )!;
    const discover = vi.spyOn(f.skills.manager, "targets");

    const preview = await f.skills.manager.prepareDeployment({
      operation: "deploy",
      library_id: adopted.library_id,
      target_ids: [cursor.id],
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(preview.targets[0]).toMatchObject({
      target_id: cursor.id,
      conflicts: [],
      added: ["SKILL.md"],
    });
    await expect(fs.lstat(cursor.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers deployment targets once before staging and independently again after staging", async () => {
    const f = await preparedCursorDeployment();
    const discover = vi.spyOn(f.skills.manager, "targets");

    const result = await f.skills.manager.applyDeployment({
      token: f.preview.token,
      confirmed: true,
    });

    expect(result.results[0], JSON.stringify(result)).toMatchObject({ success: true });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(f.preview.targets[0].path, "SKILL.md"), "utf8")).toBe(
      f.text("initial"),
    );
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
  });

  it.each(["ownership", "reservation"] as const)(
    "reads a new %s record during application instead of reusing the preview read",
    async (kind) => {
      const f = await preparedCursorDeployment();
      const receipt = (await f.skills.manager.listDeployments()).find(
        (row) => row.id === f.adopted.deployment_id,
      )!;
      await f.skills.request("skills.syncState", {});
      const file = path.join(
        f.project,
        ".agentkib",
        kind === "ownership" ? "skill-deployments.json" : "skill-deployment-reservations.json",
      );
      const stored =
        kind === "ownership"
          ? JSON.parse(await fs.readFile(file, "utf8"))
          : { schema_version: 2, deployments: [] };
      stored.deployments.push({
        ...receipt,
        id: "other-owner",
        operation_id: "other-operation",
        status: kind === "ownership" ? "active" : "recovery-required",
        target: f.preview.targets[0].path,
        agents: ["cursor"],
        visible_to: ["cursor"],
      });
      await fs.writeFile(file, JSON.stringify(stored));
      const discover = vi.spyOn(f.skills.manager, "targets");

      const result = await f.skills.manager.applyDeployment({
        token: f.preview.token,
        confirmed: true,
      });

      expect(result.results[0], JSON.stringify(result)).toMatchObject({
        success: false,
        error:
          kind === "ownership"
            ? "Skill destination is owned by another library"
            : "Skill location has an unfinished operation requiring recovery",
      });
      expect(discover).toHaveBeenCalledOnce();
      await expect(fs.lstat(f.preview.targets[0].path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );

  it.each(["workspace", "target-link"] as const)(
    "rejects a %s change during staging and rediscovers it on the next request",
    async (changed) => {
      const f = await preparedCursorDeployment();
      const outside = path.join(f.home, "outside");
      const replacement = path.join(f.home, "replacement");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "sentinel.txt"), "preserve external files");
      await fs.mkdir(replacement);
      await fs.mkdir(path.join(replacement, ".git"));
      const copyFile = fs.copyFile.bind(fs);
      let changedDuringStaging = false;
      vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
        await copyFile(from, to, mode);
        const destination = String(to);
        if (
          !changedDuringStaging &&
          destination.includes(
            `${path.sep}.agentkib-skill-state${path.sep}operations${path.sep}`,
          ) &&
          destination.endsWith(`${path.sep}new${path.sep}SKILL.md`)
        ) {
          changedDuringStaging = true;
          if (changed === "workspace") f.workspaces[0] = { id: "project", path: replacement };
          else
            await fs.symlink(
              outside,
              f.cursor.root,
              process.platform === "win32" ? "junction" : "dir",
            );
        }
      });
      const discover = vi.spyOn(f.skills.manager, "targets");

      const result = await f.skills.manager.applyDeployment({
        token: f.preview.token,
        confirmed: true,
      });

      expect(changedDuringStaging).toBe(true);
      expect(result.results[0], JSON.stringify(result)).toMatchObject({
        success: false,
        error: "Skill target changed while staging",
      });
      expect(discover).toHaveBeenCalledTimes(2);
      if (changed === "workspace")
        await expect(f.skills.manager.prepareDeployment(f.request)).rejects.toThrow(
          "Skill target changed; refresh and retry",
        );
      else
        expect(
          (await f.skills.manager.prepareDeployment(f.request)).targets[0].conflicts,
        ).toContain("Skill target contains a symbolic link or non-directory path component");
      expect(discover).toHaveBeenCalledTimes(3);
      expect(await fs.readdir(outside)).toEqual(["sentinel.txt"]);
      expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe(
        "preserve external files",
      );
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
      await expect(fs.lstat(path.join(replacement, ".cursor", "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["workspace", "target-link"] as const)(
    "refreshes deployment preparation after a %s change and refuses the old preview",
    async (changed) => {
      const f = await fixture();
      const adopted = await f.adopt();
      const cursor = (await f.skills.manager.targets()).find(
        (target) => target.agent === "cursor" && target.scope === "workspace",
      )!;
      const request = {
        operation: "deploy",
        library_id: adopted.library_id,
        target_ids: [cursor.id],
      };
      const discover = vi.spyOn(f.skills.manager, "targets");
      const preview = await f.skills.manager.prepareDeployment(request);
      expect(preview.targets[0].conflicts).toEqual([]);
      const outside = path.join(f.home, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "sentinel.txt"), "preserve external files");
      await fs.writeFile(path.join(outside, ".agentkib-skill.lock"), "existing lease file\n");
      if (changed === "workspace") {
        const replacement = path.join(f.home, "replacement");
        await fs.mkdir(replacement);
        await fs.mkdir(path.join(replacement, ".git"));
        f.workspaces[0] = { id: "project", path: replacement };
        await expect(f.skills.manager.prepareDeployment(request)).rejects.toThrow(
          "Skill target changed; refresh and retry",
        );
      } else {
        await fs.mkdir(path.dirname(cursor.root), { recursive: true });
        await fs.symlink(outside, cursor.root, process.platform === "win32" ? "junction" : "dir");
        const refreshed = await f.skills.manager.prepareDeployment(request);
        expect(refreshed.targets[0].conflicts).toContain(
          "Skill target contains a symbolic link or non-directory path component",
        );
      }
      expect(discover).toHaveBeenCalledTimes(2);

      const rejected = await f.skills.manager.applyDeployment({
        token: preview.token,
        confirmed: true,
      });

      expect(rejected.results[0], JSON.stringify(rejected)).toMatchObject({
        success: false,
        error: "Skill target changed after preview",
      });
      expect(await fs.readdir(outside)).toEqual([".agentkib-skill.lock", "sentinel.txt"]);
      expect(await fs.readFile(path.join(outside, ".agentkib-skill.lock"), "utf8")).toBe(
        "existing lease file\n",
      );
      expect(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe(
        "preserve external files",
      );
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );

  it.each(["inventory", "listDeployments"] as const)(
    "%s discovers native targets once without adding read-only roots to writable targets",
    async (method) => {
      const f = await fixture();
      const extra = await f.nativeSkill(path.join(f.home, ".codex", "skills", "extra"));
      const discover = vi.spyOn(f.skills.manager, "targets");

      await f.skills.manager[method]();

      expect(discover).toHaveBeenCalledOnce();
      const targets = await discover.mock.results[0].value;
      expect(targets.some((row) => row.root === path.dirname(extra))).toBe(false);
      expect((await f.skills.manager.inventory()).observations).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: extra })]),
      );
      expect(discover).toHaveBeenCalledTimes(2);
    },
  );

  it("discovers a replacement workspace on the next inventory request", async () => {
    const f = await fixture();
    expect(
      (await f.skills.manager.inventory()).observations.some((row) => row.path === f.target),
    ).toBe(true);
    const replacement = path.join(f.home, "replacement");
    const next = await f.nativeSkill(path.join(replacement, ".claude", "skills", "reviewer"));
    await fs.mkdir(path.join(replacement, ".git"));
    f.workspaces[0] = { id: "project", path: replacement };

    const inventory = await f.skills.manager.inventory();

    expect(inventory.observations.some((row) => row.path === next)).toBe(true);
    expect(inventory.observations.some((row) => row.path === f.target)).toBe(false);
  });

  it("discovers native home configuration changes on the next request", async () => {
    const f = await fixture();
    const first = await f.nativeSkill(path.join(f.home, ".claude", "skills", "first"));
    expect(
      (await f.skills.manager.inventory()).observations.find((row) => row.path === first)?.agents,
    ).toContain("claude-code");
    const configured = path.join(f.home, "configured-claude");
    const next = await f.nativeSkill(path.join(configured, "skills", "next"));
    f.environment.CLAUDE_CONFIG_DIR = configured;

    const inventory = await f.skills.manager.inventory();

    expect(inventory.observations.find((row) => row.path === next)?.agents).toContain(
      "claude-code",
    );
    expect(inventory.observations.find((row) => row.path === first)?.agents).not.toContain(
      "claude-code",
    );
  });

  it("rechecks target path safety after a directory is replaced by a symbolic link", async () => {
    const f = await fixture();
    const discover = vi.spyOn(f.skills.manager, "targets");
    await f.skills.manager.listDeployments();
    const first = (await discover.mock.results[0].value).find(
      (row) => row.scope === "workspace" && row.agent === "claude-code",
    )!;
    expect(first.writable).toBe(true);
    const original = path.join(f.project, ".claude", "original-skills");
    await fs.rename(first.root, original);
    await fs.symlink(original, first.root, process.platform === "win32" ? "junction" : "dir");

    await f.skills.manager.listDeployments();

    expect(discover).toHaveBeenCalledTimes(2);
    expect((await discover.mock.results[1].value).find((row) => row.id === first.id)).toMatchObject(
      {
        writable: false,
        reason: "Skill target contains a symbolic link or non-directory path component",
      },
    );
  });

  it("keeps receipt and package reads fresh between deployment requests", async () => {
    const f = await fixture();
    const adopted = await f.adopt();
    const discover = vi.spyOn(f.skills.manager, "targets");
    expect((await f.skills.manager.listDeployments())[0]).toMatchObject({
      id: adopted.deployment_id,
      status: "active",
    });
    await fs.writeFile(path.join(f.target, "SKILL.md"), f.text("external native edit"));
    expect((await f.skills.manager.listDeployments())[0]).toMatchObject({ status: "modified" });
    const receiptFile = path.join(f.project, ".agentkib", "skill-deployments.json");
    const receipts = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    receipts.deployments[0].status = "inactive";
    await fs.writeFile(receiptFile, JSON.stringify(receipts));

    expect((await f.skills.manager.listDeployments())[0]).toMatchObject({ status: "inactive" });
    expect(discover).toHaveBeenCalledTimes(3);
    await fs.writeFile(receiptFile, "invalid JSON");
    const inventory = await f.skills.manager.inventory();
    expect(
      inventory.warnings.some((warning) =>
        warning.includes("Skill ownership could not be verified"),
      ),
    ).toBe(true);
    expect(inventory.observations.find((row) => row.path === f.target)).toMatchObject({
      status: "unverified",
      diagnostics: expect.arrayContaining(["Deployment ownership could not be verified"]),
    });
  });

  it.each(["workspace", "target-link"] as const)(
    "rejects a stale reviewed synchronization after a read and a %s change",
    async (changed) => {
      const f = await fixture();
      const adopted = await f.adopt();
      await fs.writeFile(path.join(f.target, "SKILL.md"), f.text("unwanted native edit"));
      const preview = await f.prepare({
        operation: "push",
        deployment_id: adopted.deployment_id,
        resolution: "library",
      });
      await f.skills.manager.listDeployments();
      await f.skills.request("skills.syncState", {});
      const libraryFile = path.join(f.root, "skills", adopted.library_id!, "SKILL.md");
      const originalFile = path.join(f.target, "SKILL.md");
      let unchangedNative = originalFile;
      if (changed === "workspace") {
        const replacement = path.join(f.home, "replacement");
        await fs.mkdir(replacement);
        await fs.mkdir(path.join(replacement, ".git"));
        f.workspaces[0] = { id: "project", path: replacement };
      } else {
        const originalRoot = path.join(f.project, ".claude", "original-skills");
        await fs.rename(path.dirname(f.target), originalRoot);
        await fs.symlink(
          originalRoot,
          path.dirname(f.target),
          process.platform === "win32" ? "junction" : "dir",
        );
        unchangedNative = path.join(originalRoot, "reviewer", "SKILL.md");
      }

      const result = await f.apply(preview);

      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toBeTruthy();
      expect(await fs.readFile(libraryFile, "utf8")).toBe(f.text("initial"));
      expect(await fs.readFile(unchangedNative, "utf8")).toBe(f.text("unwanted native edit"));
    },
  );
});
