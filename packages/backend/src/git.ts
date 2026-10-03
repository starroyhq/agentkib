import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { Commands } from "./commands";
import { canonicalize, pathIdentity } from "./paths";
import { timestamp } from "./timestamps";
import { optionalString, parameters, unsigned } from "./rpc";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
const MB = 1024 * 1024;
const querySchema = z.object({
  cursor: optionalString,
  limit: unsigned.nullable().optional(),
  reference: optionalString,
  author: optionalString,
  since: optionalString,
  until: optionalString,
  path: optionalString,
  merges_only: z.boolean(),
});
const diffSchema = z.object({
  kind: z.enum(["commit", "worktree", "staged"]),
  path: optionalString,
  oid: optionalString,
});
type DiffRequest = z.infer<typeof diffSchema>;
interface Repository {
  repository_root: string;
  worktree_root: string;
}
interface Ref {
  name: string;
  full_name: string;
  kind: string;
  current: boolean;
}
export class Git {
  constructor(
    readonly commands: Commands,
    readonly workspacePath: (id: string) => string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}
  async request(method: string, value: unknown): Promise<unknown> {
    if (method === RUNTIME_METHODS.workspaceGitSummary) {
      const params = parameters(z.object({ id: z.string() }), value);
      return this.summary(this.workspacePath(params.id));
    }
    if (method === RUNTIME_METHODS.workspaceGitHistory) {
      const params = parameters(
        z.object({ workspaceId: z.string(), query: querySchema.default({ merges_only: false }) }),
        value,
      );
      return this.history(this.workspacePath(params.workspaceId), params.query);
    }
    if (method === RUNTIME_METHODS.gitCommitFiles) {
      const params = parameters(z.object({ workspaceId: z.string(), oid: z.string() }), value);
      return this.commitFiles(this.workspacePath(params.workspaceId), params.oid);
    }
    const params = parameters(z.object({ workspaceId: z.string(), request: diffSchema }), value);
    return this.diff(this.workspacePath(params.workspaceId), params.request);
  }
  run(root: string, args: string[], limit = 2 * MB, allowFailure = false, strictOutput = false) {
    return this.commands.run(
      "git",
      ["-c", "color.ui=false", "-c", "core.quotepath=false", ...args],
      {
        cwd: root,
        env: { ...this.environment, GIT_OPTIONAL_LOCKS: "0" },
        limit,
        allowFailure,
        strictOutput,
      },
    );
  }
  async repository(workspace: string): Promise<Repository | null> {
    const resolved = canonicalize(workspace);
    const probe = await this.run(resolved, ["rev-parse", "--show-toplevel"], 65536, true);
    if (!probe.success) return null;
    const root = canonicalize(probe.bytes.toString("utf8").trim());
    const inside = (left: string, right: string) => {
      const a = pathIdentity(left),
        b = pathIdentity(right);
      return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
    };
    if (!inside(resolved, root) && !inside(root, resolved))
      throw new Error("Git repository is outside the workspace boundary");
    const common = (
      await this.run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 65536)
    ).bytes
      .toString("utf8")
      .trim();
    return { repository_root: path.dirname(common), worktree_root: root };
  }
  async summary(workspace: string) {
    const repository = await this.repository(workspace);
    if (!repository) return null;
    const root = repository.worktree_root;
    const bytes = (
      await this.run(root, ["status", "--porcelain=v2", "-z", "--branch", "--show-stash"])
    ).bytes;
    const refs = (await this.run(root, ["for-each-ref", "--format=%(refname)%09%(HEAD)"])).bytes
      .toString("utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const i = line.indexOf("\t");
        return i < 0 ? [] : [refLabel(line.slice(0, i), line.slice(i + 1).trim() === "*")];
      });
    const result = {
      ...repository,
      head: null as string | null,
      head_oid: null as string | null,
      upstream: null as string | null,
      ahead: 0,
      behind: 0,
      stash_count: 0,
      detached: false,
      refs,
      changes: [] as Record<string, unknown>[],
    };
    const records = bytes.toString("utf8").split("\0").filter(Boolean);
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.startsWith("# branch.head ")) {
        const value = record.slice(14);
        result.detached = value === "(detached)";
        result.head = result.detached || value === "(unknown)" ? null : value;
      } else if (record.startsWith("# branch.oid ")) {
        const value = record.slice(13);
        result.head_oid = value === "(initial)" ? null : value;
      } else if (record.startsWith("# branch.upstream ")) result.upstream = record.slice(18);
      else if (record.startsWith("# branch.ab ")) {
        for (const value of record.slice(12).split(/\s+/)) {
          if (value.startsWith("+")) result.ahead = Number(value.slice(1)) || 0;
          if (value.startsWith("-")) result.behind = Number(value.slice(1)) || 0;
        }
      } else if (record.startsWith("# stash ")) result.stash_count = Number(record.slice(8)) || 0;
      else if (record.startsWith("? "))
        result.changes.push({
          path: record.slice(2),
          old_path: null,
          kind: "untracked",
          index_status: null,
          worktree_status: "?",
          conflicted: false,
        });
      else if (/^[12u] /.test(record)) {
        const renamed = record.startsWith("2 "),
          conflicted = record.startsWith("u "),
          count = renamed ? 10 : conflicted ? 11 : 9;
        const fields = splitN(record, " ", count),
          xy = fields[1] ?? "..";
        const index_status = xy[0] && xy[0] !== "." ? xy[0] : null,
          worktree_status = xy[1] && xy[1] !== "." ? xy[1] : null;
        result.changes.push({
          path: fields.at(-1) ?? "",
          old_path: renamed && index + 1 < records.length ? records[++index] : null,
          kind: conflicted
            ? "conflict"
            : ((
                {
                  M: "modified",
                  A: "added",
                  D: "deleted",
                  R: "renamed",
                  C: "copied",
                  T: "type-changed",
                  U: "conflict",
                } as Record<string, string>
              )[index_status ?? worktree_status ?? ""] ?? "unknown"),
          index_status,
          worktree_status,
          conflicted,
        });
      }
    }
    return result;
  }
  async fingerprint(root: string): Promise<string> {
    const refs = await this.run(
      root,
      ["for-each-ref", "--format=%(refname)%00%(objectname)"],
      8 * MB,
    );
    const head = await this.run(root, ["rev-parse", "HEAD"], 65536, true);
    return createHash("sha256").update(refs.bytes).update(head.bytes).digest("hex");
  }
  async history(workspace: string, query: z.infer<typeof querySchema>) {
    const repository = await this.repository(workspace);
    if (!repository) return null;
    const root = repository.worktree_root,
      fingerprint = await this.fingerprint(root);
    let offset = 0;
    if (query.cursor != null) {
      if (!/^(?:[a-fA-F0-9]{2})+$/.test(query.cursor))
        throw new Error("Invalid Git history cursor");
      let cursor: { fingerprint: string; offset: number };
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "hex").toString("utf8"));
        if (
          typeof cursor.fingerprint !== "string" ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw new Error();
      } catch {
        throw new Error("Invalid Git history cursor");
      }
      if (cursor.fingerprint !== fingerprint)
        throw new Error("Git history changed; reload from the first page");
      offset = cursor.offset;
    }
    const limit = Math.min(500, Math.max(1, query.limit ?? 300));
    const args = [
      "log",
      "--topo-order",
      "--parents",
      "--decorate=full",
      "--date=iso-strict",
      "--format=%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s",
      `--skip=${offset}`,
      `--max-count=${limit + 1}`,
    ];
    for (const key of ["author", "since", "until"] as const) {
      const value = query[key]?.trim();
      if (value) args.push(`--${key}=${value}`);
    }
    if (query.merges_only) args.push("--merges");
    const reference = query.reference?.trim();
    if (reference) {
      if (reference.startsWith("-") || reference.includes("\0"))
        throw new Error("Invalid Git reference");
      if (
        !(await this.run(root, ["rev-parse", "--verify", "--quiet", reference], 65536, true))
          .success
      )
        throw new Error("Git reference does not exist");
      args.push(reference);
    } else args.push("--all");
    const selectedPath = query.path?.trim();
    if (selectedPath) {
      relativePath(selectedPath);
      args.push("--", selectedPath);
    }
    const records = (await this.run(root, args, 16 * MB)).bytes
      .toString("utf8")
      .split("\x1e")
      .slice(1);
    const commits = records.flatMap((record) => {
      const fields = splitN(record.replace(/\n$/, ""), "\x1f", 6);
      if (fields.length !== 6) return [];
      const [oid, parents, author, at, decorations, subject] = fields.map(text);
      return [
        {
          oid,
          parents: parents ? parents.split(/\s+/) : [],
          subject: [...subject!]
            .filter((char) => !/[\p{Cc}]/u.test(char) || char === "\t")
            .slice(0, 500)
            .join(""),
          author_name: author,
          authored_at: timestamp(at),
          refs: decorations!.split(",").flatMap((part) => {
            let name = part.trim();
            const current = name.startsWith("HEAD -> ");
            if (current) name = name.slice(8);
            name = name.replace(/^tag: /, "");
            return name ? [refLabel(name, current)] : [];
          }),
        },
      ];
    });
    return {
      commits: commits.slice(0, limit),
      next_cursor:
        commits.length > limit
          ? Buffer.from(JSON.stringify({ fingerprint, offset: offset + limit })).toString("hex")
          : null,
      repository_fingerprint: fingerprint,
    };
  }
  async firstParent(root: string, oid: string): Promise<string | null> {
    return (
      (await this.run(root, ["rev-list", "--parents", "-n", "1", oid], 65536)).bytes
        .toString("utf8")
        .trim()
        .split(/\s+/)[1] ?? null
    );
  }
  async commitFiles(workspace: string, oid: string) {
    const repository = await this.repository(workspace);
    if (!repository) return null;
    validateOid(oid);
    const parent = await this.firstParent(repository.worktree_root, oid);
    return nameStatus(
      (
        await this.run(
          repository.worktree_root,
          [
            "diff-tree",
            "-r",
            "-M",
            "--no-commit-id",
            "--name-status",
            "-z",
            ...(parent ? [parent, oid] : ["--root", oid]),
          ],
          8 * MB,
        )
      ).bytes,
    );
  }
  async diff(workspace: string, request: DiffRequest) {
    const repository = await this.repository(workspace);
    if (!repository) return null;
    if (request.path != null) relativePath(request.path);
    let args = ["diff"];
    if (request.kind === "commit") {
      if (request.oid == null) throw new Error("Commit diff requires an oid");
      validateOid(request.oid);
      const parent = await this.firstParent(repository.worktree_root, request.oid);
      args = parent ? ["diff", parent, request.oid] : ["show", "--format=", request.oid];
    } else if (request.kind === "staged") args.push("--cached");
    args.push("--no-ext-diff", "--no-textconv", "--no-color");
    if (request.path != null) args.push("--", request.path);
    const result = await this.run(repository.worktree_root, args, 4 * MB, true),
      patch = result.bytes.toString("utf8");
    return {
      patch,
      binary: patch.includes("GIT binary patch") || patch.includes("Binary files "),
      submodule: patch.includes("Subproject commit ") || patch.includes("-Subproject commit "),
      encoding_lossy: !isUtf8(result.bytes),
      truncated: result.truncated,
    };
  }
}
function text(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}
function refLabel(full_name: string, current: boolean): Ref {
  for (const [prefix, kind] of [
    ["refs/heads/", "local-branch"],
    ["refs/remotes/", "remote-branch"],
    ["refs/tags/", "tag"],
  ] as const) {
    if (full_name.startsWith(prefix))
      return { name: full_name.slice(prefix.length), full_name, kind, current };
  }
  return { name: full_name, full_name, kind: full_name === "HEAD" ? "head" : "other", current };
}
function splitN(value: string, separator: string, count: number): string[] {
  const fields: string[] = [];
  let remaining = value;
  for (let n = 1; n < count; n++) {
    const index = remaining.indexOf(separator);
    if (index < 0) break;
    fields.push(remaining.slice(0, index));
    remaining = remaining.slice(index + separator.length);
  }
  fields.push(remaining);
  return fields;
}
function relativePath(value: string): void {
  if (!value || value.includes("\0")) throw new Error("Invalid empty Git path");
  if (
    path.isAbsolute(value) ||
    (process.platform === "win32" ? value.split(/[\\/]/) : value.split("/")).includes("..")
  )
    throw new Error("Git path must stay inside the repository");
}
function validateOid(value: string): void {
  if (!/^[a-fA-F0-9]{7,64}$/.test(value)) throw new Error("Invalid Git object id");
}
function nameStatus(bytes: Buffer): Record<string, unknown>[] {
  const fields = bytes.toString("utf8").split("\0").filter(Boolean).map(text),
    result: Record<string, unknown>[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (/^[RC]/.test(status)) {
      if (index + 1 >= fields.length) break;
      result.push({ status, old_path: fields[index++], path: fields[index++] });
    } else {
      if (index >= fields.length) break;
      result.push({ status, path: fields[index++], old_path: null });
    }
  }
  return result;
}
