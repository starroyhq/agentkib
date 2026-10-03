import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { compareUtf8 } from "./workspaces";

const MAX_TREE_ENTRIES = 20_000;
const MAX_CANDIDATES = 200;
const MAX_SKILL_FILES = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PACKAGE_ENTRIES = 4_096;
const PREVIEW_TTL_MS = 15 * 60_000;
const CURATED = "https://github.com/openai/skills/tree/main/skills/.curated";

function portableSkillPath(value: string): string {
  const parts = value.split("/");
  for (const part of parts) {
    const stem = part.split(".", 1)[0]?.trimEnd().toUpperCase();
    if (
      !part ||
      /[<>:"|?*]/.test(part) ||
      [...part].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[. ]$/.test(part) ||
      [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
      ].includes(stem ?? "")
    )
      throw new Error(`Skill package contains a non-portable path: ${value}`);
  }
  return parts.map((part) => part.normalize("NFC").toLowerCase()).join("/");
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index]!);
      }
    }),
  );
  return output;
}

type Source = {
  kind: "openai-curated" | "github";
  repository: string;
  ref: string;
  path: string;
  resolved_commit: string;
  tree_sha: string;
};
type Candidate = {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  source: Source;
};
type FileEntry = { path: string; size: number; executable: boolean };
type LockEntry = {
  source: Source | null;
  content_sha256: string;
  installed_at: string;
  updated_at: string;
};
type LockFile = {
  schema_version: number;
  skills: Record<string, LockEntry>;
  previous: Record<string, LockEntry>;
};
type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type Prepared = {
  preview: Record<string, unknown>;
  name: string;
  packagePath: string;
  tempPath: string;
  lock: LockEntry;
  expectedHash: string | null;
};
type SkillMetadata = {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
};

function skillRoot(environment: NodeJS.ProcessEnv) {
  const custom = environment.AGENTKIB_HOME;
  if (custom) {
    if (!path.isAbsolute(custom)) throw new Error("AGENTKIB_HOME must be an absolute path");
    return custom;
  }
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return path.join(
    home,
    environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
  );
}

export class Skills {
  readonly root: string;
  readonly cache: string;
  #previews = new Map<string, Prepared>();
  #busy = false;

  constructor(environment: NodeJS.ProcessEnv, dataDir: string) {
    this.root = skillRoot(environment);
    this.cache = path.join(dataDir, "skill-cache");
  }

  async request(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "skills.listCatalog":
        return this.catalog(params.force === true);
      case "skills.discover":
        return this.discover(this.#string(params.url, "url"));
      case "skills.listInstalled":
        return this.installed();
      case "skills.prepareInstall":
        return this.prepareInstall(params.source as Source);
      case "skills.applyOperation":
        return this.#lifecycle(() => this.apply(params));
      case "skills.checkUpdates":
        return this.checkUpdates();
      case "skills.prepareUpdate":
        return this.prepareUpdate(this.#string(params.name, "name"));
      case "skills.rollback":
        return this.#lifecycle(() => this.rollback(params));
      case "skills.uninstall":
        return this.#lifecycle(() => this.uninstall(params));
      case "skills.listRemoved":
        return this.removed();
      case "skills.restore":
        return this.#lifecycle(() => this.restore(params));
      case "skills.readFile":
        return this.readFile(params);
      default:
        throw new Error(`Unknown Skill method: ${method}`);
    }
  }

  async catalog(force: boolean) {
    const file = path.join(this.cache, "curated-skills.json");
    if (!force) {
      const cached = (await this.#readJson(file).catch(() => null)) as {
        cached_at?: string;
        entries?: Array<{ candidate: Candidate; installed?: boolean }>;
        stale?: boolean;
      } | null;
      if (cached?.cached_at && Date.now() - Date.parse(cached.cached_at) < 6 * 60 * 60_000)
        return this.#annotate(cached);
    }
    try {
      const entries = await this.discover(CURATED);
      const snapshot = {
        entries: entries.map((candidate) => ({ candidate, installed: false })),
        cached_at: new Date().toISOString(),
        stale: false,
      };
      await this.#writeJson(file, snapshot);
      return this.#annotate(snapshot);
    } catch (error) {
      const cached = (await this.#readJson(file).catch(() => null)) as {
        cached_at?: string;
        entries?: Array<{ candidate: Candidate; installed?: boolean }>;
        stale?: boolean;
      } | null;
      if (!cached) throw error;
      return this.#annotate({ ...cached, stale: true });
    }
  }

  async #lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("Skill lifecycle is busy");
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  async discover(input: string): Promise<Candidate[]> {
    const parsed = await this.#parseUrl(input);
    const selected = await this.#resolve(parsed);
    const candidates = selected.entries.filter((entry) => {
      if (entry.type !== "blob" || path.posix.basename(entry.path) !== "SKILL.md") return false;
      const directory = path.posix.dirname(entry.path);
      const relative = selected.selectorPath
        ? directory.slice(selected.selectorPath.length).replace(/^\//, "")
        : directory;
      return relative.split("/").filter(Boolean).length <= 8;
    });
    if (candidates.length > MAX_CANDIDATES)
      throw new Error("GitHub repository contains more than 200 Skill candidates");
    if (candidates.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > 8 * 1024 * 1024)
      throw new Error("Skill metadata exceeds the 8 MiB limit");
    const results = await mapConcurrent(candidates, 8, async (entry) => {
      const directory =
        path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path);
      try {
        const content = await this.#raw(
          selected.owner,
          selected.repository,
          selected.commit,
          entry.path,
          MAX_ENTRY_BYTES,
        );
        const metadata = this.#frontmatter(content.toString("utf8"));
        const tree = selected.entries.find(
          (value) => value.type === "tree" && value.path === directory,
        );
        const treeSha = tree?.sha ?? (directory === "" ? selected.rootTree : undefined);
        if (!treeSha) throw new Error(`Could not resolve tree for Skill directory ${directory}`);
        return {
          ...metadata,
          source: {
            kind:
              selected.owner.toLowerCase() === "openai" &&
              selected.repository.toLowerCase() === "skills" &&
              directory.startsWith("skills/.curated/")
                ? "openai-curated"
                : "github",
            repository: `${selected.owner}/${selected.repository}`,
            ref: selected.reference,
            path: directory,
            resolved_commit: selected.commit,
            tree_sha: treeSha,
          },
        } as Candidate;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    });
    const output = results.filter((entry): entry is Candidate => !(entry instanceof Error));
    if (!output.length && results[0] instanceof Error) throw results[0];
    return output.sort((a, b) => a.name.localeCompare(b.name));
  }

  async installed() {
    const lock = await this.#lock();
    const root = path.join(this.root, "skills");
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      );
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const folder = path.join(root, name);
      if (await this.#isLink(folder)) continue;
      const record = lock.skills[name];
      let metadata: SkillMetadata | null = null;
      try {
        metadata = this.#frontmatter(await fs.readFile(path.join(folder, "SKILL.md"), "utf8"));
      } catch {
        if (!record) continue;
      }
      let packageHash: string | null = null;
      let size = 0;
      let modifiedAt: string | null = null;
      try {
        const info = await this.#packageHash(folder);
        packageHash = info.hash;
        size = info.size;
        modifiedAt = info.modifiedAt;
      } catch {
        if (!record) continue;
      }
      result.push({
        name,
        display_name: metadata?.name ?? name,
        description: metadata?.description ?? "",
        path: folder,
        size,
        modified_at: modifiedAt,
        status: !record
          ? "unmanaged"
          : packageHash === record.content_sha256
            ? "current"
            : "modified",
        source: record?.source ?? null,
        installed_at: record?.installed_at ?? null,
        updated_at: record?.updated_at ?? null,
        can_rollback: Boolean(
          lock.previous[name] &&
          (await fs.stat(path.join(this.root, "backups/skills", name)).then(
            (value) => value.isDirectory(),
            () => false,
          )),
        ),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async checkUpdates() {
    const installed = await this.installed();
    const cache = new Map<string, Promise<string>>();
    return Promise.all(
      installed.map(async (skill) => {
        if (!skill.source) return skill;
        try {
          const key = `${skill.source.repository.toLowerCase()}#${skill.source.ref}`;
          let commit = cache.get(key);
          if (!commit) {
            commit = this.#commit(
              skill.source.repository.split("/")[0]!,
              skill.source.repository.split("/")[1]!,
              skill.source.ref,
            );
            cache.set(key, commit);
          }
          const selected = await this.#resolve({
            owner: skill.source.repository.split("/")[0]!,
            repository: skill.source.repository.split("/")[1]!,
            selectorPath: skill.source.path,
            reference: await commit,
          });
          const tree = selected.entries.find(
            (entry) => entry.type === "tree" && entry.path === skill.source!.path,
          );
          return {
            ...skill,
            status:
              tree?.sha && tree.sha !== skill.source.tree_sha ? "update-available" : skill.status,
          };
        } catch {
          return skill;
        }
      }),
    );
  }

  async prepareInstall(source: Source) {
    return this.#prepare(source, "install");
  }
  async prepareUpdate(name: string) {
    this.#validateId(name);
    const lock = await this.#lock();
    const source = lock.skills[name]?.source;
    if (!source) throw new Error("Unmanaged Skills cannot be updated");
    return this.#prepare(source, "update", name);
  }

  async apply(params: Record<string, unknown>) {
    if (params.confirmed !== true)
      throw new Error("Skill installation requires explicit confirmation");
    const token = this.#string(params.token, "token");
    const prepared = this.#previews.get(token);
    this.#previews.delete(token);
    if (!prepared || Date.parse(String(prepared.preview.expires_at)) <= Date.now())
      throw new Error("Skill preview expired or does not exist");
    if (prepared.preview.local_modified === true && params.allowModified !== true)
      throw new Error(
        "The installed Skill was modified locally; replacement requires confirmation",
      );
    try {
      const target = path.join(this.root, "skills", prepared.name);
      const actual = await fs.stat(target).then(
        (value) =>
          value.isDirectory() ? this.#packageHash(target).then((item) => item.hash) : null,
        () => null,
      );
      if (actual !== prepared.expectedHash)
        throw new Error("Installed Skill changed after preview; prepare the operation again");
      const lock = await this.#lock();
      const old = lock.skills[prepared.name];
      const backup = path.join(this.root, "backups/skills", prepared.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.mkdir(path.dirname(backup), { recursive: true });
      const stagedBackup = `${backup}.staging-${randomUUID()}`;
      let hasBackup = false;
      let targetMoved = false;
      let packageInstalled = false;
      try {
        if (
          old &&
          (await fs.stat(target).then(
            () => true,
            () => false,
          ))
        ) {
          if (
            await fs.stat(backup).then(
              () => true,
              () => false,
            )
          ) {
            await fs.rename(backup, stagedBackup);
            hasBackup = true;
          }
          await fs.rename(target, backup);
          targetMoved = true;
        }
        await fs.rename(prepared.packagePath, target);
        packageInstalled = true;
        lock.skills[prepared.name] = prepared.lock;
        if (old) lock.previous[prepared.name] = old;
        await this.#writeLock(lock);
      } catch (error) {
        if (packageInstalled) await fs.rm(target, { recursive: true, force: true });
        if (targetMoved && old) await fs.rename(backup, target);
        if (
          hasBackup &&
          (await fs.stat(stagedBackup).then(
            () => true,
            () => false,
          ))
        )
          await fs.rename(stagedBackup, backup);
        throw error;
      }
      if (hasBackup) await fs.rm(stagedBackup, { recursive: true, force: true });
      return (await this.installed()).find((item) => item.name === prepared.name);
    } finally {
      await fs.rm(prepared.tempPath, { recursive: true, force: true });
    }
  }

  async rollback(params: Record<string, unknown>) {
    if (params.confirmed !== true) throw new Error("Skill rollback requires explicit confirmation");
    const name = this.#string(params.name, "name");
    this.#validateId(name);
    const target = path.join(this.root, "skills", name);
    const backup = path.join(this.root, "backups/skills", name);
    if (
      !(await fs.stat(target).then(
        (s) => s.isDirectory(),
        () => false,
      )) ||
      !(await fs.stat(backup).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new Error("No rollback version is available");
    const lock = await this.#lock();
    const current = lock.skills[name];
    const previous = lock.previous[name];
    if (!current || !previous) throw new Error("Rollback metadata is missing");
    const staging = `${target}.rollback-${randomUUID()}`;
    await fs.rename(target, staging);
    try {
      await fs.rename(backup, target);
      try {
        await fs.rename(staging, backup);
      } catch (error) {
        await fs.rename(target, backup);
        await fs.rename(staging, target);
        throw error;
      }
      lock.skills[name] = previous;
      lock.previous[name] = current;
      try {
        await this.#writeLock(lock);
      } catch (error) {
        await fs.rename(target, staging);
        await fs.rename(backup, target);
        await fs.rename(staging, backup);
        throw error;
      }
    } catch (error) {
      if (
        (await fs.stat(staging).then(
          () => true,
          () => false,
        )) &&
        !(await fs.stat(target).then(
          () => true,
          () => false,
        ))
      )
        await fs.rename(staging, target);
      throw error;
    }
    return (await this.installed()).find((item) => item.name === name);
  }

  async uninstall(params: Record<string, unknown>) {
    if (params.confirmed !== true)
      throw new Error("Skill uninstall requires explicit confirmation");
    const name = this.#string(params.name, "name");
    this.#validateId(name);
    const target = path.join(this.root, "skills", name);
    const id = `skill-${randomUUID()}`;
    const root = path.join(this.root, "trash/skills", id);
    const lock = await this.#lock();
    const record = {
      id,
      name,
      display_name: await this.#displayName(target, name),
      removed_at: new Date().toISOString(),
      lock: lock.skills[name] ?? null,
      previous: lock.previous[name] ?? null,
    };
    await fs.mkdir(root, { recursive: true });
    await this.#writeJson(path.join(root, "record.json"), record);
    await fs.rename(target, path.join(root, "package"));
    const backup = path.join(this.root, "backups/skills", name);
    if (
      await fs.stat(backup).then(
        () => true,
        () => false,
      )
    )
      await fs.rename(backup, path.join(root, "backup"));
    delete lock.skills[name];
    delete lock.previous[name];
    await this.#writeLock(lock);
    return {
      id,
      name,
      display_name: record.display_name,
      removed_at: record.removed_at,
      path: path.join(root, "package"),
    };
  }

  async removed() {
    const directory = path.join(this.root, "trash/skills");
    const names = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      );
    const output: Array<Record<string, unknown> & { removed_at: string }> = [];
    for (const item of names) {
      if (!item.isDirectory() || (await this.#isLink(path.join(directory, item.name)))) continue;
      try {
        const record = (await this.#readJson(
          path.join(directory, item.name, "record.json"),
        )) as Record<string, unknown>;
        const pkg = path.join(directory, item.name, "package");
        if (
          !(await fs.stat(pkg).then(
            (s) => s.isDirectory(),
            () => false,
          )) ||
          (await this.#isLink(pkg))
        )
          continue;
        if (typeof record.removed_at !== "string") continue;
        output.push({ ...record, removed_at: record.removed_at, path: pkg });
      } catch {
        /* Invalid trash records are not restorable. */
      }
    }
    return output.sort(
      (a, b) => Date.parse(String(b.removed_at)) - Date.parse(String(a.removed_at)),
    );
  }

  async restore(params: Record<string, unknown>) {
    if (params.confirmed !== true) throw new Error("Skill restore requires explicit confirmation");
    const id = this.#string(params.id, "id");
    if (!/^skill-[a-zA-Z0-9-]{1,150}$/.test(id)) throw new Error("Removed Skill id is invalid");
    const root = path.join(this.root, "trash/skills", id);
    const record = (await this.#readJson(path.join(root, "record.json"))) as Record<
      string,
      unknown
    >;
    const name = this.#string(record.name, "name");
    this.#validateId(name);
    const target = path.join(this.root, "skills", name);
    if (
      await fs.stat(target).then(
        () => true,
        () => false,
      )
    )
      throw new Error("A Skill with this name already exists");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(root, "package"), target);
    const backup = path.join(this.root, "backups/skills", name);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    if (
      await fs.stat(path.join(root, "backup")).then(
        () => true,
        () => false,
      )
    )
      await fs.rename(path.join(root, "backup"), backup);
    const lock = await this.#lock();
    if (record.lock) lock.skills[name] = record.lock as LockEntry;
    if (record.previous) lock.previous[name] = record.previous as LockEntry;
    await this.#writeLock(lock);
    await fs.rm(root, { recursive: true, force: true });
    return (await this.installed()).find((item) => item.name === name);
  }

  async readFile(params: Record<string, unknown>) {
    const name = this.#string(params.name, "name");
    const relative = this.#string(params.path, "path");
    this.#validateId(name);
    const parts = relative.replaceAll("\\", "/").split("/");
    if (
      !relative ||
      path.isAbsolute(relative) ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Skill resource path is invalid");
    const root = await fs.realpath(path.join(this.root, "skills", name));
    const file = await fs.realpath(path.join(root, relative));
    const components = relative.replaceAll("\\", "/").split("/");
    const supported =
      components[0] === "SKILL.md" || ["references", "scripts", "assets"].includes(components[0]!);
    const forbidden = components.some(
      (part) =>
        part.startsWith(".") ||
        ["node_modules", "target", "dist", "build", "__pycache__"].includes(part),
    );
    const lower = relative.toLowerCase();
    const basename = path.basename(relative).toLowerCase();
    const privateFile =
      ["credential", "telemetry", "session"].some((marker) => lower.includes(marker)) ||
      lower.endsWith(".env") ||
      lower.endsWith("state.db") ||
      ["token", "secret"].some((marker) => basename.includes(marker)) ||
      basename.endsWith(".pem") ||
      basename.endsWith(".key");
    if (
      !this.#inside(file, root) ||
      !supported ||
      forbidden ||
      privateFile ||
      (await this.#isLink(path.join(root, relative)))
    )
      throw new Error("Skill resource is private, unsafe, or outside the package");
    const metadata = await fs.stat(file);
    if (!metadata.isFile() || metadata.size > MAX_PREVIEW_BYTES)
      throw new Error("Skill resource exceeds the preview limit");
    return { path: relative.replaceAll("\\", "/"), content: await fs.readFile(file, "utf8") };
  }

  async #prepare(source: Source, operation: "install" | "update", existingName?: string) {
    if (
      !source ||
      typeof source.repository !== "string" ||
      typeof source.ref !== "string" ||
      typeof source.path !== "string"
    )
      throw new Error("Invalid Skill source");
    const [owner, repository] = source.repository.split("/");
    if (!owner || !repository)
      throw new Error("Skill repository must include an owner and repository");
    this.#validateRepoPath(source.path);
    const selected = await this.#resolve({
      owner,
      repository,
      selectorPath: source.path,
      reference: source.ref,
    });
    const prefix = source.path ? `${source.path.replace(/\/$/, "")}/` : "";
    const files = selected.entries.filter(
      (entry) => entry.type === "blob" && (prefix ? entry.path.startsWith(prefix) : true),
    );
    if (!files.some((entry) => entry.path === `${prefix}SKILL.md`))
      throw new Error("Selected Skill path no longer contains SKILL.md");
    if (files.length > MAX_SKILL_FILES) throw new Error("Skill package exceeds the 512 file limit");
    const portablePaths = new Set(
      files.map((entry) => portableSkillPath(entry.path.slice(prefix.length))),
    );
    if (portablePaths.size !== files.length)
      throw new Error("Skill package contains paths that collide on case-insensitive filesystems");
    let total = 0;
    for (const entry of files) {
      if (entry.mode !== "100644" && entry.mode !== "100755")
        throw new Error(`Skill package contains an unsupported file: ${entry.path}`);
      const relative = entry.path.slice(prefix.length);
      this.#validateRelative(relative);
      const components = relative.split("/");
      for (let index = 0; index < components.length - 1; index++) {
        if (portablePaths.has(portableSkillPath(components.slice(0, index + 1).join("/"))))
          throw new Error(`Skill package has a file-directory collision: ${relative}`);
      }
      const size = entry.size ?? 0;
      if (size > MAX_FILE_BYTES)
        throw new Error(`Skill file exceeds the 8 MiB limit: ${entry.path}`);
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new Error("Skill package exceeds the 32 MiB limit");
    }
    const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-skill-"));
    const packagePath = path.join(tempPath, "package");
    await fs.mkdir(packagePath);
    try {
      const downloaded = await mapConcurrent(files, 8, async (entry) => {
        const relative = entry.path.slice(prefix.length);
        this.#validateRelative(relative);
        const target = path.join(packagePath, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const bytes = await this.#raw(
          owner,
          repository,
          selected.commit,
          entry.path,
          MAX_FILE_BYTES,
        );
        if (bytes.length !== (entry.size ?? 0))
          throw new Error(`GitHub file size changed during download: ${entry.path}`);
        await fs.writeFile(target, bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
        return {
          path: relative.replaceAll("\\", "/"),
          size: bytes.length,
          executable: entry.mode === "100755",
        } satisfies FileEntry;
      });
      const metadata = this.#frontmatter(
        await fs.readFile(path.join(packagePath, "SKILL.md"), "utf8"),
      );
      if (existingName && metadata.name !== existingName)
        throw new Error("Skill update changed the package name");
      this.#validateSkillName(metadata.name);
      const lock = await this.#lock();
      const name = existingName ?? metadata.name;
      if (
        operation === "install" &&
        (await this.installed()).some((skill) => skill.display_name === metadata.name)
      )
        throw new Error("A Skill with this name already exists");
      const target = path.join(this.root, "skills", name);
      const previousHash = await fs.stat(target).then(
        (value) =>
          value.isDirectory() ? this.#packageHash(target).then((result) => result.hash) : null,
        () => null,
      );
      if (operation === "install" && previousHash)
        throw new Error("A Skill with this name already exists");
      if (operation === "update" && !previousHash)
        throw new Error("Installed Skill does not exist");
      const currentLock = lock.skills[name];
      if (operation === "update" && !currentLock)
        throw new Error("Unmanaged Skills cannot be updated");
      if (
        operation === "update" &&
        (!currentLock?.source || !this.#sameSource(currentLock.source, source))
      )
        throw new Error("Skill update source changed");
      const [added, modified, removed] = await this.#fileDelta(target, packagePath);
      const packageResult = await this.#packageHash(packagePath);
      const resolvedSource: Source = {
        kind:
          owner.toLowerCase() === "openai" &&
          repository.toLowerCase() === "skills" &&
          source.path.startsWith("skills/.curated/")
            ? "openai-curated"
            : "github",
        repository: `${owner}/${repository}`,
        ref: selected.reference,
        path: source.path,
        resolved_commit: selected.commit,
        tree_sha:
          selected.entries.find((entry) => entry.type === "tree" && entry.path === source.path)
            ?.sha ?? selected.rootTree,
      };
      const now = new Date().toISOString();
      const token = randomUUID();
      const preview = {
        token,
        operation,
        skill: { ...metadata, source: resolvedSource },
        files: downloaded.sort((a, b) => a.path.localeCompare(b.path)),
        added,
        modified,
        removed,
        total_size: packageResult.size,
        local_modified: Boolean(currentLock && previousHash !== currentLock.content_sha256),
        expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      };
      const entry: LockEntry = {
        source: resolvedSource,
        content_sha256: packageResult.hash,
        installed_at: currentLock?.installed_at ?? now,
        updated_at: now,
      };
      this.#previews.set(token, {
        preview,
        name,
        packagePath,
        tempPath,
        lock: entry,
        expectedHash: previousHash,
      });
      while (this.#previews.size > 4) {
        const oldest = this.#previews.keys().next().value as string | undefined;
        if (!oldest) break;
        const stale = this.#previews.get(oldest);
        this.#previews.delete(oldest);
        if (stale) await fs.rm(stale.tempPath, { recursive: true, force: true });
      }
      return preview;
    } catch (error) {
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  async #parseUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error("Enter a valid GitHub URL");
    }
    if (
      url.protocol !== "https:" ||
      !["github.com", "www.github.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Only public github.com HTTPS URLs are supported");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (parts.length < 2) throw new Error("GitHub URL must include an owner and repository");
    const owner = parts[0]!;
    const repository = parts[1]!.replace(/\.git$/, "");
    this.#validateRepoSegment(owner);
    this.#validateRepoSegment(repository);
    let selectorPath = "";
    let reference: string | undefined;
    if (parts.length > 2) {
      if (!["tree", "blob"].includes(parts[2]!) || parts.length < 4)
        throw new Error("GitHub URL must point to a repository, tree, or SKILL.md blob");
      const selector = parts[2]!;
      const remainder = parts.slice(3);
      if (selector === "blob" && remainder.at(-1) !== "SKILL.md")
        throw new Error("GitHub blob URL must point to SKILL.md");
      let resolved = false;
      for (
        let split = 1;
        split <= Math.min(8, remainder.length - (selector === "blob" ? 1 : 0));
        split++
      ) {
        const candidateRef = remainder.slice(0, split).join("/");
        try {
          await this.#commit(owner, repository, candidateRef);
          reference = candidateRef;
          selectorPath = remainder
            .slice(split)
            .join("/")
            .replace(/\/?SKILL\.md$/, "");
          resolved = true;
          break;
        } catch {
          /* A tree URL can contain a slash in its ref. */
        }
      }
      if (!resolved) throw new Error("Could not resolve the GitHub URL reference");
      this.#validateRepoPath(selectorPath);
    }
    return { owner, repository, selectorPath, reference };
  }

  async #resolve(input: {
    owner: string;
    repository: string;
    selectorPath: string;
    reference?: string;
  }) {
    const repo = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
    )) as { default_branch?: string };
    const reference = input.reference ?? repo.default_branch;
    if (!reference) throw new Error("Could not determine the GitHub default branch");
    const commit = await this.#commit(input.owner, input.repository, reference);
    const commitResponse = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(commit)}`,
    )) as { commit?: { tree?: { sha?: string } } };
    const rootTree = commitResponse.commit?.tree?.sha;
    if (!rootTree) throw new Error("GitHub commit has no root tree");
    const response = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/trees/${rootTree}?recursive=1`,
    )) as { tree?: TreeEntry[]; truncated?: boolean };
    if (
      response.truncated ||
      !Array.isArray(response.tree) ||
      response.tree.length > MAX_TREE_ENTRIES
    )
      throw new Error("GitHub repository tree exceeds the inspection limit");
    if (
      input.selectorPath &&
      !response.tree.some((entry) => entry.type === "tree" && entry.path === input.selectorPath)
    )
      throw new Error("Selected GitHub directory does not exist");
    const entries = response.tree.filter(
      (entry) =>
        !input.selectorPath ||
        entry.path === input.selectorPath ||
        entry.path.startsWith(`${input.selectorPath}/`),
    );
    return {
      owner: input.owner,
      repository: input.repository,
      reference,
      commit,
      rootTree,
      selectorPath: input.selectorPath,
      entries,
    };
  }

  async #commit(owner: string, repository: string, reference: string) {
    const response = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(reference)}`,
    )) as { sha?: string };
    if (!response.sha) throw new Error("GitHub reference did not resolve to a commit");
    return response.sha;
  }

  async #raw(owner: string, repository: string, commit: string, file: string, maxBytes: number) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(commit)}/${file.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "agentkib-skill-hub" },
    });
    if (!response.ok) throw new Error(`GitHub download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("GitHub file exceeds the download limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error("GitHub file exceeds the download limit");
    return data;
  }

  async #json(url: string) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentkib-skill-hub" },
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > 32 * 1024 * 1024)
      throw new Error("GitHub response exceeds the 32 MiB limit");
    return JSON.parse(data.toString("utf8")) as unknown;
  }

  #frontmatter(content: string): SkillMetadata {
    if (Buffer.byteLength(content) > MAX_ENTRY_BYTES)
      throw new Error("SKILL.md exceeds the 1 MiB limit");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
    const value = parseYaml(match[1]!);
    if (!value || typeof value !== "object") throw new Error("Skill frontmatter must be a mapping");
    const name = value.name;
    const description = value.description;
    if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 64)
      throw new Error("Skill name is invalid");
    if (
      typeof description !== "string" ||
      !description.trim() ||
      Buffer.byteLength(description) > 1024
    )
      throw new Error("Skill description is invalid");
    return {
      name: name.trim(),
      description: description.trim(),
      license: typeof value.license === "string" ? value.license : null,
      compatibility: typeof value.compatibility === "string" ? value.compatibility : null,
    };
  }

  async #packageHash(root: string) {
    const entries: Array<{
      absolute: string;
      relative: string;
      info: Awaited<ReturnType<typeof fs.stat>>;
    }> = [];
    let count = 0;
    let size = 0;
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        count++;
        if (count > MAX_PACKAGE_ENTRIES)
          throw new Error("Skill package contains more than 4096 entries");
        const absolute = path.join(directory, entry.name);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error("Skill package contains an unsupported file");
        if (stat.isDirectory()) await walk(absolute);
        else if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES)
            throw new Error("Skill package contains a file larger than 8 MiB");
          if (entries.length >= MAX_SKILL_FILES)
            throw new Error("Skill package contains more than 512 files");
          size += stat.size;
          if (size > MAX_TOTAL_BYTES) throw new Error("Skill package is larger than 32 MiB");
          entries.push({
            absolute,
            relative: path.relative(root, absolute).replaceAll("\\", "/"),
            info: stat,
          });
        } else throw new Error("Skill package contains an unsupported file");
      }
    };
    await walk(root);
    entries.sort((a, b) => compareUtf8(a.relative, b.relative));
    const hash = createHash("sha256");
    let modifiedAt: string | null = null;
    for (const entry of entries) {
      const relative = Buffer.from(entry.relative);
      const sizeBytes = Buffer.alloc(8);
      sizeBytes.writeBigUInt64LE(BigInt(entry.info.size));
      const lengthBytes = Buffer.alloc(8);
      lengthBytes.writeBigUInt64LE(BigInt(relative.byteLength));
      hash.update(lengthBytes);
      hash.update(relative);
      hash.update(Buffer.from([Number(entry.info.mode) & 0o111 ? 1 : 0]));
      hash.update(sizeBytes);
      hash.update(await fs.readFile(entry.absolute));
      const mtime = entry.info.mtime.toISOString();
      if (!modifiedAt || mtime > modifiedAt) modifiedAt = mtime;
    }
    return { hash: hash.digest("hex"), size, modifiedAt };
  }

  async #fileDelta(existing: string, incoming: string) {
    const collect = async (root: string) => {
      const files = new Map<string, string>();
      if (
        !(await fs.stat(root).then(
          (value) => value.isDirectory(),
          () => false,
        ))
      )
        return files;
      const walk = async (directory: string) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Skill package contains an unsupported file");
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile())
            files.set(
              path.relative(root, file).replaceAll("\\", "/"),
              createHash("sha256")
                .update(await fs.readFile(file))
                .digest("hex"),
            );
        }
      };
      await walk(root);
      return files;
    };
    const [before, after] = await Promise.all([collect(existing), collect(incoming)]);
    return [
      [...after.keys()].filter((key) => !before.has(key)).sort(),
      [...after.keys()]
        .filter((key) => before.has(key) && before.get(key) !== after.get(key))
        .sort(),
      [...before.keys()].filter((key) => !after.has(key)).sort(),
    ];
  }

  async #annotate(snapshot: {
    entries?: Array<{ candidate: Candidate; installed?: boolean }>;
    cached_at?: string;
    stale?: boolean;
  }) {
    const names = new Set((await this.installed()).map((skill) => skill.display_name));
    return {
      entries: (snapshot.entries ?? []).map((entry) => ({
        ...entry.candidate,
        installed: names.has(entry.candidate.name),
      })),
      cached_at: snapshot.cached_at ?? new Date().toISOString(),
      stale: snapshot.stale === true,
    };
  }

  async #displayName(root: string, fallback: string) {
    try {
      return this.#frontmatter(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).name;
    } catch {
      return fallback;
    }
  }

  async #lock(): Promise<LockFile> {
    const lock = (await this.#readJson(path.join(this.root, "skills.lock.json")).catch(
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)),
    )) as Partial<LockFile> | null;
    if (!lock) return { schema_version: 1, skills: {}, previous: {} };
    if (lock.schema_version !== 1) throw new Error("Unsupported Skill lock schema version");
    return { schema_version: 1, skills: lock.skills ?? {}, previous: lock.previous ?? {} };
  }

  async #writeLock(lock: LockFile) {
    await this.#writeJson(path.join(this.root, "skills.lock.json"), lock);
  }
  async #readJson(file: string) {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  }
  async #writeJson(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async #isLink(file: string) {
    return fs.lstat(file).then(
      (info) => info.isSymbolicLink(),
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    );
  }
  #inside(value: string, root: string) {
    const relative = path.relative(root, value);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }
  #validateId(name: string) {
    if (
      !name ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".." ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error("Skill library identifier is invalid");
  }
  #validateSkillName(name: string) {
    if (
      !name ||
      name.length > 64 ||
      !/^[a-z0-9-]+$/.test(name) ||
      !/^[a-z0-9]/.test(name) ||
      !/[a-z0-9]$/.test(name) ||
      name.includes("--")
    )
      throw new Error("Skill name must use lowercase letters, numbers, and single hyphens");
  }
  #validateRelative(value: string) {
    if (
      !value ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Skill package contains an unsafe path");
  }
  #validateRepoSegment(value: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..")
      throw new Error("GitHub URL contains an invalid repository path");
  }
  #validateRepoPath(value: string) {
    if (
      value &&
      (value.startsWith("/") ||
        value.includes("\\") ||
        value.split("/").some((part) => !part || part === ".." || part === "."))
    )
      throw new Error("GitHub repository path is unsafe");
  }
  #sameSource(a: Source, b: Source) {
    return (
      a.repository.toLowerCase() === b.repository.toLowerCase() &&
      a.ref === b.ref &&
      a.path === b.path
    );
  }
  #string(value: unknown, name: string) {
    if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
    return value;
  }
}
