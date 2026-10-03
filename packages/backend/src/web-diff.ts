import path from "node:path";
import { z } from "zod";
import { canonicalize, pathIdentity } from "./paths";
import { Git } from "./git";
import { BackendStore } from "./store";
import { parameters } from "./rpc";

const requestSchema = z
  .object({
    operation: z.literal("diff"),
    workspaceId: z.string().min(1),
    kind: z.enum(["commit", "worktree", "staged"]),
    path: z.string().nullable().optional(),
    oid: z.string().nullable().optional(),
  })
  .strict();

type ChangedFile = { status: string; path: string; old_path?: string | null };

export async function webDiff(value: unknown, store: BackendStore, git: Git) {
  const request = parameters(requestSchema, value);
  const workspace = canonicalize(store.workspacePath(request.workspaceId));
  if (sensitiveRoot(workspace)) throw new Error("diff-sensitive-path");
  const repository = await git.repository(workspace);
  if (
    repository &&
    pathIdentity(canonicalize(repository.worktree_root)) !== pathIdentity(workspace)
  )
    throw new Error("diff-workspace-must-be-repository-root");
  if (request.path !== undefined && request.path !== null) validateSelectedPath(request.path);
  const diffRequest = {
    kind: request.kind,
    ...(request.path == null ? {} : { path: request.path }),
    ...(request.oid == null ? {} : { oid: request.oid }),
  };
  const verifyPaths = async () => {
    const files = await changedFiles(git, workspace, request.kind, request.oid);
    if (
      request.path &&
      !files.some((file) => file.path === request.path || file.old_path === request.path)
    )
      throw new Error("diff-path-not-changed-file");
    for (const file of files) {
      if (request.path && file.path !== request.path && file.old_path !== request.path) continue;
      if (sensitiveDiffPath(file.path) || (file.old_path && sensitiveDiffPath(file.old_path)))
        throw new Error("diff-sensitive-path");
    }
  };
  await verifyPaths();
  const result = await git.diff(workspace, diffRequest);
  await verifyPaths();
  if (
    pathIdentity(canonicalize(store.workspacePath(request.workspaceId))) !== pathIdentity(workspace)
  )
    throw new Error("workspace-unavailable");
  return result;
}

async function changedFiles(
  git: Git,
  workspace: string,
  kind: "commit" | "worktree" | "staged",
  oid?: string | null,
): Promise<ChangedFile[]> {
  if (kind === "commit") {
    if (!oid) throw new Error("Commit diff requires an oid");
    const files = await git.commitFiles(workspace, oid);
    return (files ?? []).map((file) => ({
      status: String(file.status),
      path: String(file.path),
      old_path: typeof file.old_path === "string" ? file.old_path : null,
    }));
  }
  const repository = await git.repository(workspace);
  if (!repository) return [];
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-status", "-z"];
  if (kind === "staged") args.push("--cached");
  const bytes = (await git.run(repository.worktree_root, args, 8 * 1024 * 1024)).bytes;
  const fields = bytes.toString("utf8").split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (/^[RC]/.test(status)) {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (!oldPath || !filePath) break;
      files.push({ status, old_path: oldPath, path: filePath });
    } else {
      const filePath = fields[index++];
      if (!filePath) break;
      files.push({ status, path: filePath });
    }
  }
  return files;
}

function validateSelectedPath(value: string): void {
  if (
    !value ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    [...value].some((character) => "*?[]:".includes(character))
  )
    throw new Error("diff-invalid-path");
  if (sensitiveDiffPath(value)) throw new Error("diff-sensitive-path");
}

function sensitiveRoot(root: string): boolean {
  const parts = root
    .split(path.sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  return parts.some((part, index) => {
    if (
      [
        ".git",
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".claude",
        ".gemini",
        ".agentkib",
        "ai.agentkib",
        "ai.agentkib.dev",
      ].includes(part)
    )
      return true;
    return part === ".codex" && !(parts[index + 1] === "worktrees" && Boolean(parts[index + 2]));
  });
}

function sensitiveDiffPath(value: string): boolean {
  return value
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .some((part) => {
      const base = part.split(".", 1)[0] ?? part;
      return (
        part === ".." ||
        [
          ".git",
          ".ssh",
          ".aws",
          ".agentkib",
          "ai.agentkib",
          "ai.agentkib.dev",
          ".codex",
          ".npmrc",
          ".netrc",
          ".env",
          "secret",
          "secrets",
        ].includes(part) ||
        part.startsWith(".env.") ||
        part.startsWith("secret.") ||
        part.startsWith("secrets.") ||
        part.includes("credential") ||
        [
          "privatekey",
          "private_key",
          "private-key",
          "auth",
          "oauth",
          "token",
          "tokens",
          "access_token",
          "access-token",
          "accesstoken",
          "refresh_token",
          "refresh-token",
          "refreshtoken",
        ].includes(base) ||
        part.startsWith("id_rsa") ||
        part.startsWith("id_ed25519") ||
        [".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx", ".keystore"].some((suffix) =>
          part.endsWith(suffix),
        )
      );
    });
}
