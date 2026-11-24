import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionApprovalAuditRisk } from "@agentkib/runtime-protocol";

type SessionInteractionRiskReason =
  | "deletion"
  | "network"
  | "dependency-install"
  | "outside-workspace"
  | "git-push"
  | "unknown-operation"
  | "unknown-workspace"
  | "workspace-write"
  | "read-only"
  | "test"
  | "static-check"
  | "question";

type SessionInteractionRisk = SessionApprovalAuditRisk & { reason: SessionInteractionRiskReason };

export interface InteractionRiskInput {
  kind: "question" | "command" | "read" | "write" | "delete" | "network" | "unknown";
  command?: string | readonly string[];
  cwd?: string;
  paths?: readonly string[];
  network?: boolean;
}

type ReviewedCommand = {
  paths: readonly string[];
  kind: "read" | "write" | "test" | "check";
};

const packageManagers = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv"]);
const installCommands = new Set([
  "install",
  "add",
  "ci",
  "update",
  "upgrade",
  "dlx",
  "exec",
  "sync",
]);
const networkCommands = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "invoke-webrequest",
  "invoke-restmethod",
]);
const deletionCommands = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "remove-item"]);
const testManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
const checkScripts = new Set(["lint", "typecheck", "format:check"]);

function high(reason: SessionInteractionRiskReason): SessionInteractionRisk {
  return { level: "high", reason };
}

/** A deliberately small literal subset. Anything with expansion or shell evaluation stays high. */
function literalCommands(command: string): string[][] | undefined {
  const tokens = /[ \t]+|\r?\n|&&|\|\||[;|]|"([^"\r\n]+)"|'([^'\r\n]+)'|[^"'\s&;|<>]+/gy;
  const commands: string[][] = [[]];
  let separated = true;
  while (tokens.lastIndex < command.length) {
    const match = tokens.exec(command);
    if (!match) return undefined;
    const token = match[0];
    if (/^[ \t]/.test(token)) {
      separated = true;
      continue;
    }
    const current = commands[commands.length - 1];
    if (/^(?:\r?\n|&&|\|\||[;|])$/.test(token)) {
      if (!current.length) return undefined;
      commands.push([]);
      separated = true;
      continue;
    }
    // Adjacent quoted words concatenate in a shell. Windows CMD doesn't quote with apostrophes.
    if (!separated || (process.platform === "win32" && match[2] !== undefined)) return undefined;
    const word = match[1] ?? match[2] ?? token;
    if (!/^[\p{L}\p{N}_./,:=+ @*?~%-]+$/u.test(word)) return undefined;
    current.push(word);
    separated = false;
  }
  return commands;
}

function commandHazard(argv: readonly string[]): SessionInteractionRiskReason | undefined {
  const [program = "", subcommand = ""] = argv;
  const executable = path.win32
    .basename(program)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, "");
  if (executable === "git" && subcommand === "push") return "git-push";
  if (
    deletionCommands.has(executable) ||
    (executable === "git" && ["clean", "rm"].includes(subcommand)) ||
    (executable === "find" && argv.includes("-delete"))
  )
    return "deletion";
  if (
    ["npx", "bunx"].includes(executable) ||
    (packageManagers.has(executable) && installCommands.has(subcommand)) ||
    (executable === "flutter" && subcommand === "pub")
  )
    return "dependency-install";
  if (
    networkCommands.has(executable) ||
    (executable === "git" && ["clone", "fetch", "pull", "ls-remote"].includes(subcommand))
  )
    return "network";
  return undefined;
}

function reviewedCommand(argv: readonly string[]): ReviewedCommand | undefined {
  const [program, subcommand, ...rest] = argv;
  // Apply flags only to commands whose option grammar is explicitly recognized.
  if (argv.some((word) => !word || /[<>|&;`$*?~%\p{Cc}]/u.test(word))) return undefined;
  if (
    (argv.length === 1 && program === "pwd") ||
    (argv.length === 2 && program === "git" && subcommand === "status")
  )
    return { kind: "read", paths: [] };
  if (["cat", "ls", "wc", "stat"].includes(program)) {
    const args = argv.slice(subcommand === "--" ? 2 : 1);
    if (args.every((word) => !word.startsWith("-"))) return { kind: "read", paths: args };
  }
  if (["touch", "mkdir"].includes(program)) {
    const args = argv.slice(subcommand === "--" ? 2 : 1);
    if (args.length && args.every((word) => !word.startsWith("-")))
      return { kind: "write", paths: args };
  }
  if (testManagers.has(program) && subcommand === "test" && !rest.length)
    return { kind: "test", paths: [] };
  if (
    (["flutter", "dart"].includes(program) && subcommand === "test") ||
    (program === "node" && subcommand === "--test") ||
    (program === "vitest" && subcommand === "run")
  ) {
    if (rest.every((word) => !word.startsWith("-"))) return { kind: "test", paths: rest };
  }
  if (
    (testManagers.has(program) && checkScripts.has(subcommand) && !rest.length) ||
    (testManagers.has(program) &&
      subcommand === "run" &&
      rest.length === 1 &&
      checkScripts.has(rest[0]))
  )
    return { kind: "check", paths: [] };
  if (
    (["flutter", "dart"].includes(program) && subcommand === "analyze") ||
    (program === "prettier" && subcommand === "--check")
  ) {
    if (rest.every((word) => !word.startsWith("-"))) return { kind: "check", paths: rest };
  }
  if (program === "tsc" && subcommand === "--noEmit" && !rest.length)
    return { kind: "check", paths: [] };
  return undefined;
}

function localPath(value: string): boolean {
  if (
    !value ||
    value.length > 4096 ||
    /^[\\/]{2}|^~|\p{Cc}/u.test(value) ||
    (!path.isAbsolute(value) && /^[a-z]:/i.test(value))
  )
    return false;
  if (process.platform !== "win32" && value.includes("\\")) return false;
  const components = value.slice(path.parse(value).root.length).split(/[\\/]/);
  return components.every(
    (part) =>
      part !== ".." &&
      (process.platform !== "win32" ||
        part === "." ||
        (!/[:*?"<>|]|[. ]$/.test(part) &&
          !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(part))),
  );
}

function workspaceRelative(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
    ? undefined
    : relative;
}

async function checkedTarget(
  root: string,
  relative: string,
  requireDirectory: boolean,
): Promise<boolean> {
  if (!relative) return true;
  const components = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    try {
      const info = await lstat(current);
      // Reject links before checking descendants or following their targets. Hard-linked files
      // may also name files outside this workspace.
      if (info.isSymbolicLink() || !(info.isDirectory() || (info.isFile() && info.nlink === 1)))
        return false;
      if ((requireDirectory || index < components.length - 1) && !info.isDirectory()) return false;
    } catch (error) {
      return !requireDirectory && (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

export async function classifyInteractionRisk(
  input: InteractionRiskInput,
  workspaceRoot: string | undefined,
): Promise<SessionInteractionRisk> {
  if (input.kind === "question") return { level: "low", reason: "question" };
  if (input.kind === "delete") return high("deletion");
  if (input.network || input.kind === "network") return high("network");

  let command: ReviewedCommand | undefined;
  if (input.kind === "command") {
    const args = input.command;
    const commands =
      typeof args === "string"
        ? args.length <= 16 * 1024
          ? literalCommands(args)
          : undefined
        : args && args.length <= 256
          ? [args]
          : undefined;
    if (!commands) return high("unknown-operation");
    for (const argv of commands) {
      const reason = commandHazard(argv);
      if (reason) return high(reason);
    }
    // Never label pipelines or compound shell invocations safe based on a few tokens.
    if (commands.length === 1) command = reviewedCommand(commands[0]);
    if (!command) return high("unknown-operation");
  }

  if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || !localPath(workspaceRoot))
    return high("unknown-workspace");
  const root = await realpath(workspaceRoot).catch(() => undefined);
  if (!root || !localPath(root) || !(await lstat(root).catch(() => undefined))?.isDirectory())
    return high("unknown-workspace");
  const paths = [...(input.paths ?? []), ...(command?.paths ?? [])];
  if (paths.length > 128) return high("unknown-operation");
  // A native process can operate from a subdirectory of the registered workspace.
  // Its actual CWD is required to resolve relative operands or an implicit command target.
  const cwd =
    input.cwd ??
    (input.kind !== "command" && paths.every(path.isAbsolute) ? workspaceRoot : undefined);
  if (!cwd) return high("unknown-workspace");

  const relativeToWorkspace = (target: string) =>
    workspaceRelative(workspaceRoot, target) ?? workspaceRelative(root, target);
  if (!path.isAbsolute(cwd) || !localPath(cwd)) return high("outside-workspace");
  const workingDirectory = relativeToWorkspace(cwd);
  if (workingDirectory === undefined || !(await checkedTarget(root, workingDirectory, true)))
    return high("outside-workspace");
  for (const value of paths) {
    if (!localPath(value)) return high("outside-workspace");
    const relative = relativeToWorkspace(path.resolve(cwd, value));
    if (relative === undefined || !(await checkedTarget(root, relative, false)))
      return high("outside-workspace");
  }

  if (command?.kind === "test") return { level: "low", reason: "test" };
  if (command?.kind === "check") return { level: "low", reason: "static-check" };
  if (command?.kind === "write" || (input.kind === "write" && paths.length))
    return { level: "file-modification", reason: "workspace-write" };
  if (command?.kind === "read" || (input.kind === "read" && paths.length))
    return { level: "low", reason: "read-only" };
  return high("unknown-operation");
}
