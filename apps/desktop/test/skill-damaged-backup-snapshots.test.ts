import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";
import { createSkillRequestTracker } from "./fixtures/skill-request-tracker";

const homes: string[] = [];
const requests = createSkillRequestTracker();
const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const text = (value: string) => `---\nname: reviewer\ndescription: Review changes\n---\n${value}\n`;
type Preview = { token: string };

beforeEach(() => requests.waitForCleanup());
afterEach(() =>
  requests.cleanup(async () => {
    await requests.settle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  }),
);

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-damaged-backup-")));
  homes.push(home);
  const root = path.join(home, "library");
  const project = path.join(home, "project");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  const create = () =>
    new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "data"),
      () => [{ id: "project", path: project }],
    );
  const skills = create();
  const target = path.join(root, "skills/reviewer");
  const backup = path.join(root, "backups/skills/reviewer");
  const lockPath = path.join(root, "skills.lock.json");
  const apply = (preview: Preview) =>
    skills.request("skills.applyOperation", { token: preview.token, confirmed: true });
  return { home, root, project, create, skills, target, backup, lockPath, apply };
}

function github() {
  const refs = new Map([
    ["heads/main", A],
    ["heads/next", B],
    ["tags/third", C],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (url.hostname === "raw.githubusercontent.com")
        return new Response(text(parts[2] === A ? "initial" : parts[2] === B ? "second" : "third"));
      if (url.hostname !== "api.github.com") throw new Error("Unexpected external request");
      if (!parts[3]) return Response.json({ default_branch: "main" });
      if (parts[3] === "commits") {
        const reference = parts.slice(4).join("/");
        const sha = refs.get(reference) ?? [A, B, C].find((commit) => commit.startsWith(reference));
        if (!sha) return new Response("Missing ref", { status: 404 });
        return Response.json({ sha, commit: { tree: { sha: `tree-${sha}` } } });
      }
      if (parts[3] === "git" && parts[4] === "trees") {
        const sha = parts[5]!.replace(/^tree-/, "");
        return Response.json({
          tree: [
            { path: "skills/reviewer", type: "tree", mode: "040000", sha: "package" },
            {
              path: "skills/reviewer/SKILL.md",
              type: "blob",
              mode: "100644",
              sha: "blob",
              size: Buffer.byteLength(text(sha === A ? "initial" : sha === B ? "second" : "third")),
            },
          ],
        });
      }
      throw new Error(`Unexpected fixture request ${url.pathname}`);
    }),
  );
  return refs;
}

async function remoteFixture() {
  const refs = github();
  const f = await fixture();
  await f.apply(
    (await f.skills.prepareInstall({
      kind: "github",
      repository: "example/skills",
      ref: "main",
      ref_type: "branch",
      path: "skills/reviewer",
    })) as Preview,
  );
  const version = (value: string, type = "branch") =>
    f.skills.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type, value },
    }) as Promise<Preview>;
  await f.apply(await version("next"));
  return { ...f, refs, version };
}

async function recoveredFixture() {
  const f = await remoteFixture();
  await fs.writeFile(path.join(f.target, "retained.txt"), "damaged version\n");
  await fs.rm(path.join(f.target, "SKILL.md"));
  await f.skills.rollback({ name: "reviewer", confirmed: true });
  expect(await fs.readdir(f.backup)).toEqual(["retained.txt"]);
  const lockBytes = await fs.readFile(f.lockPath, "utf8");
  return { ...f, lockBytes };
}

async function nextPreview(f: Awaited<ReturnType<typeof recoveredFixture>>, operation: string) {
  if (operation === "update") {
    f.refs.set("heads/main", C);
    return (await f.skills.prepareUpdate("reviewer")) as Preview;
  }
  return f.version("third", "tag");
}

async function legacyLock(f: Awaited<ReturnType<typeof fixture>>) {
  const lock = JSON.parse(await fs.readFile(f.lockPath, "utf8"));
  lock.schema_version = 1;
  for (const entry of [...Object.values(lock.skills), ...Object.values(lock.previous)] as Array<
    Record<string, unknown>
  >) {
    delete entry.snapshot_hash;
    delete entry.hash_algorithm;
    delete entry.library_instance_id;
  }
  await fs.writeFile(f.lockPath, JSON.stringify(lock));
  await fs.rm(path.join(f.root, ".skill-state/snapshots"), { recursive: true, force: true });
  return lock;
}

describe("Skill historical snapshots with missing entry points", () => {
  it("pulls a third native version after rollback retained a missing-entry backup", () =>
    requests.run(async () => {
      const f = await fixture();
      const native = path.join(f.project, ".claude/skills/reviewer");
      await fs.mkdir(native, { recursive: true });
      await fs.writeFile(path.join(native, "SKILL.md"), text("initial"));
      const state = (await f.skills.request("skills.syncState", {})) as SkillSyncState;
      const observation = state.observations.find((row) => row.path === native)!;
      const prepare = (params: Record<string, unknown>) =>
        f.skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
      const apply = (preview: SkillSyncPreview) =>
        f.skills.request("skills.applySync", {
          token: preview.token,
          confirmed: true,
        }) as Promise<SkillSyncReport>;
      const adopted = await apply(
        await prepare({ operation: "adopt", observation_id: observation.id }),
      );
      expect(adopted.results[0], JSON.stringify(adopted)).toMatchObject({ success: true });
      const id = adopted.results[0]!.deployment_id!;
      await fs.writeFile(path.join(native, "SKILL.md"), text("second"));
      expect(
        (await apply(await prepare({ operation: "pull", deployment_id: id }))).results[0],
      ).toMatchObject({ success: true });
      await fs.writeFile(path.join(f.target, "retained.txt"), "damaged version\n");
      await fs.rm(path.join(f.target, "SKILL.md"));
      await f.skills.rollback({ name: "reviewer", confirmed: true });
      await fs.writeFile(path.join(native, "SKILL.md"), text("third"));
      const preview = await prepare({
        operation: "pull",
        deployment_id: id,
        resolution: "deployment",
      });
      expect(preview.targets[0]!.conflicts).toEqual([]);
      const report = await apply(preview);
      expect(report.results[0], JSON.stringify(report)).toMatchObject({
        success: true,
        status: "synchronized",
      });
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
      expect(await fs.readdir(f.backup)).toEqual(["SKILL.md"]);
      expect(await fs.readFile(path.join(native, "SKILL.md"), "utf8")).toBe(text("third"));
      expect(
        ((await f.create().request("skills.syncState", {})) as SkillSyncState).deployments.find(
          (row) => row.id === id,
        ),
      ).toMatchObject({ sync_state: "current" });
    }));

  it.each(["update", "version-change"])(
    "continues %s with a missing-entry obsolete backup",
    (operation) =>
      requests.run(async () => {
        const f = await recoveredFixture();
        await f.apply(await nextPreview(f, operation));
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
        expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
        expect(await fs.readdir(f.backup)).toEqual(["SKILL.md"]);
        const lock = JSON.parse(await fs.readFile(f.lockPath, "utf8"));
        expect(lock.previous.reviewer).toEqual(JSON.parse(f.lockBytes).skills.reviewer);
        await f.skills.state.verifySnapshot(lock.previous.reviewer.content_sha256);
        await f.skills.state.verifySnapshot(lock.skills.reviewer.content_sha256);
      }),
  );

  it.each(["metadata-commit", "install-candidate", "move-current"])(
    "compensates %s and retries without losing the damaged backup",
    (phase) =>
      requests.run(async () => {
        const f = await recoveredFixture();
        const preview = await nextPreview(f, "version-change");
        const rename = fs.rename.bind(fs);
        let interrupted = false;
        const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          const matches =
            phase === "metadata-commit"
              ? to === f.lockPath
              : phase === "install-candidate"
                ? to === f.target && String(from).endsWith(`${path.sep}incoming`)
                : from === f.target && to === f.backup;
          if (!interrupted && matches) {
            interrupted = true;
            throw Object.assign(new Error(`Fixture ${phase} EIO`), { code: "EIO" });
          }
          return rename(from, to);
        });
        await expect(f.apply(preview)).rejects.toThrow(`Fixture ${phase} EIO`);
        expect(interrupted).toBe(true);
        expect(await fs.readFile(f.lockPath, "utf8")).toBe(f.lockBytes);
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("initial"));
        expect(await fs.readdir(f.backup)).toEqual(["retained.txt"]);
        expect(await fs.readFile(path.join(f.backup, "retained.txt"), "utf8")).toBe(
          "damaged version\n",
        );
        failure.mockRestore();
        await f.apply(await nextPreview(f, "version-change"));
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
        expect(await fs.readdir(f.backup)).toEqual(["SKILL.md"]);
      }),
  );

  it.each([false, true])(
    "uninstalls safely with a missing-entry backup and damaged current=%s",
    (damageCurrent) =>
      requests.run(async () => {
        const f = await recoveredFixture();
        if (damageCurrent) {
          await fs.writeFile(path.join(f.target, "current.txt"), "retained current\n");
          await fs.rm(path.join(f.target, "SKILL.md"));
        }
        const removed = await f.skills.uninstall({ name: "reviewer", confirmed: true });
        expect((await f.skills.removed()).find((row) => row.id === removed.id)).toMatchObject({
          name: "reviewer",
          path: removed.path,
        });
        const trash = path.dirname(removed.path);
        expect(await fs.readdir(path.join(trash, "backup"))).toEqual(["retained.txt"]);
        expect(await fs.readFile(path.join(trash, "backup/retained.txt"), "utf8")).toBe(
          "damaged version\n",
        );
        expect(await fs.readdir(removed.path)).toEqual([
          damageCurrent ? "current.txt" : "SKILL.md",
        ]);
        if (damageCurrent) {
          await expect(f.skills.restore({ id: removed.id, confirmed: true })).rejects.toThrow(
            /SKILL.md entry point/,
          );
          expect(await fs.readFile(path.join(removed.path, "current.txt"), "utf8")).toBe(
            "retained current\n",
          );
          expect(await fs.readdir(path.join(trash, "backup"))).toEqual(["retained.txt"]);
        } else {
          await f.skills.restore({ id: removed.id, confirmed: true });
          expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("initial"));
          expect(await fs.readdir(f.backup)).toEqual(["retained.txt"]);
          await f.apply(await nextPreview(f, "version-change"));
          expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
        }
      }),
  );

  it.each(["update", "rollback", "uninstall"])(
    "preserves legal snapshots for schema-1 %s",
    (operation) =>
      requests.run(async () => {
        const f = await remoteFixture();
        const lock = await legacyLock(f);
        if (operation === "update") {
          f.refs.set("heads/next", C);
          await f.apply((await f.skills.prepareUpdate("reviewer")) as Preview);
        } else await f.skills.request(`skills.${operation}`, { name: "reviewer", confirmed: true });
        await f.skills.state.verifySnapshot(lock.skills.reviewer.content_sha256);
        await f.skills.state.verifySnapshot(lock.previous.reviewer.content_sha256);
      }),
  );

  it.each(["move-current", "move-backup", "metadata-commit"])(
    "compensates uninstall %s while preserving missing-entry trash evidence",
    (phase) =>
      requests.run(async () => {
        const f = await recoveredFixture();
        const rename = fs.rename.bind(fs);
        let interrupted = false;
        const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
          const matches =
            phase === "metadata-commit"
              ? to === f.lockPath
              : from === (phase === "move-current" ? f.target : f.backup);
          if (!interrupted && matches) {
            interrupted = true;
            throw Object.assign(new Error(`Fixture uninstall ${phase} EIO`), { code: "EIO" });
          }
          return rename(from, to);
        });
        await expect(f.skills.uninstall({ name: "reviewer", confirmed: true })).rejects.toThrow(
          `Fixture uninstall ${phase} EIO`,
        );
        expect(interrupted).toBe(true);
        failure.mockRestore();
        expect(await fs.readFile(f.lockPath, "utf8")).toBe(f.lockBytes);
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("initial"));
        expect(await fs.readdir(f.backup)).toEqual(["retained.txt"]);
        expect(await fs.readFile(path.join(f.backup, "retained.txt"), "utf8")).toBe(
          "damaged version\n",
        );
        expect(await f.skills.removed()).toEqual([]);
        const removed = await f.skills.uninstall({ name: "reviewer", confirmed: true });
        expect(await fs.readFile(path.join(removed.path, "SKILL.md"), "utf8")).toBe(
          text("initial"),
        );
        expect(
          await fs.readFile(path.join(path.dirname(removed.path), "backup/retained.txt"), "utf8"),
        ).toBe("damaged version\n");
        await f.skills.restore({ id: removed.id, confirmed: true });
        expect(await fs.readdir(f.backup)).toEqual(["retained.txt"]);
      }),
  );

  it("rejects an already corrupt immutable snapshot of a valid outgoing version", () =>
    requests.run(async () => {
      const f = await remoteFixture();
      const before = await fs.readFile(f.lockPath, "utf8");
      const hash = JSON.parse(before).skills.reviewer.content_sha256;
      const snapshot = f.skills.state.snapshotPath(hash);
      await fs.writeFile(path.join(snapshot, "SKILL.md"), text("external snapshot change"));
      await expect(f.apply(await f.version("third", "tag"))).rejects.toThrow(
        "Skill snapshot is corrupt",
      );
      expect(await fs.readFile(f.lockPath, "utf8")).toBe(before);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("second"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
      expect(await fs.readFile(path.join(snapshot, "SKILL.md"), "utf8")).toBe(
        text("external snapshot change"),
      );
    }));

  it("reuses verified accepted history without reading obsolete backup contents", () =>
    requests.run(async () => {
      const f = await remoteFixture();
      const preview = await f.version("third", "tag");
      const readFile = fs.readFile.bind(fs);
      let reads = 0;
      const failure = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(`${f.backup}${path.sep}`)) {
          reads++;
          throw Object.assign(new Error("Fixture obsolete resource EIO"), { code: "EIO" });
        }
        return readFile(...args);
      });
      await f.apply(preview);
      failure.mockRestore();
      expect(reads).toBe(0);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("second"));
    }));

  it("preserves unsnapshotted legacy history when reading its contents fails", () =>
    requests.run(async () => {
      const f = await remoteFixture();
      await legacyLock(f);
      const before = await fs.readFile(f.lockPath, "utf8");
      const preview = await f.version("third", "tag");
      const readFile = fs.readFile.bind(fs);
      const failure = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === path.join(f.backup, "SKILL.md"))
          throw Object.assign(new Error("Fixture legacy history EIO"), { code: "EIO" });
        return readFile(...args);
      });
      await expect(f.apply(preview)).rejects.toThrow("Fixture legacy history EIO");
      failure.mockRestore();
      expect(await fs.readFile(f.lockPath, "utf8")).toBe(before);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("second"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
    }));

  it.skipIf(process.platform === "win32")(
    "physically retains a non-portable damaged resource through rollback, trash and restore",
    () =>
      requests.run(async () => {
        const f = await remoteFixture();
        const resource = "bad\\resource.txt";
        await fs.writeFile(path.join(f.target, resource), "opaque damaged resource\n");
        await f.skills.rollback({ name: "reviewer", confirmed: true });
        expect(await fs.readFile(path.join(f.backup, resource), "utf8")).toBe(
          "opaque damaged resource\n",
        );
        const removed = await f.skills.uninstall({ name: "reviewer", confirmed: true });
        expect(
          await fs.readFile(path.join(path.dirname(removed.path), "backup", resource), "utf8"),
        ).toBe("opaque damaged resource\n");
        await f.skills.restore({ id: removed.id, confirmed: true });
        expect(await fs.readFile(path.join(f.backup, resource), "utf8")).toBe(
          "opaque damaged resource\n",
        );
        await f.apply(await f.version("third", "tag"));
        expect(await fs.readdir(f.backup)).toEqual(["SKILL.md"]);
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("third"));
      }),
  );

  it("rejects resources that change while inspecting optional uninstall history", () =>
    requests.run(async () => {
      const f = await remoteFixture();
      const before = await fs.readFile(f.lockPath, "utf8");
      const readFile = fs.readFile.bind(fs);
      const failure = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === path.join(f.target, "SKILL.md")) return Buffer.from("changed");
        return readFile(...args);
      });
      await expect(f.skills.uninstall({ name: "reviewer", confirmed: true })).rejects.toThrow(
        "Skill resource changed while reading",
      );
      failure.mockRestore();
      expect(await fs.readFile(f.lockPath, "utf8")).toBe(before);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("second"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
    }));

  it("propagates entry inspection I/O failures without committing an uninstall", () =>
    requests.run(async () => {
      const f = await remoteFixture();
      const before = await fs.readFile(f.lockPath, "utf8");
      const lstat = fs.lstat.bind(fs);
      const failure = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (args[0] === path.join(f.target, "SKILL.md"))
          throw Object.assign(new Error("Fixture entry inspection EIO"), { code: "EIO" });
        return lstat(...args);
      });
      await expect(f.skills.uninstall({ name: "reviewer", confirmed: true })).rejects.toThrow(
        "Fixture entry inspection EIO",
      );
      failure.mockRestore();
      expect(await fs.readFile(f.lockPath, "utf8")).toBe(before);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(text("second"));
      expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe(text("initial"));
    }));
});
