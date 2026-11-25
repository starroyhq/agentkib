import { privateFilePathPart, type ConversationTurnSummary } from "@agentkib/runtime-protocol";

const MAX_ITEMS = 256;
const MAX_FILES = 32;
const MAX_CHECKS = 24;
const MAX_PATH = 256;
const CHECK_SCRIPT = /^(test|lint|typecheck|check|format:check)(:[a-z0-9-]{1,24}){0,2}$/;
const CHECK_PROGRAMS = new Set(["eslint", "jest", "mypy", "oxlint", "pytest", "tsc", "vitest"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_OPTIONS_WITH_VALUE = new Set(["--filter", "-F", "--dir", "-C", "--workspace"]);
const CHECK_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  cargo: ["check", "clippy", "test"],
  dotnet: ["test"],
  go: ["test", "vet"],
  gradle: ["check", "test"],
  gradlew: ["check", "test"],
  node: ["--test"],
  playwright: ["test"],
  ruff: ["check"],
  swift: ["test"],
  xcodebuild: ["test"],
};

const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validExitCode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type File = NonNullable<ConversationTurnSummary["files"]>[number];
type Check = NonNullable<ConversationTurnSummary["checks"]>[number];

/** Known check invocations have attributable exit statuses. Keep their names, without arguments. */
function checkName(command: string): string | undefined {
  if (/[\r\n;|&<>`$]/.test(command)) return;
  const tokens = command.trim().split(/\s+/);
  if (
    tokens.some((token) =>
      /^(?:-h|--help|--version|--showConfig|--listTests|--collect-only|--dry-run)$/.test(token),
    )
  )
    return;
  if (/^(?:\S*\/)?g?timeout$/.test(tokens[0] ?? "")) {
    tokens.shift();
    if (tokens[0] === "-k") tokens.splice(0, 2);
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(tokens.shift() ?? "")) return;
  }
  const basename = (token: string | undefined) =>
    token
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(exe|cmd|bat)$/i, "");
  const program = basename(tokens.shift());
  if (!program) return;
  if (PACKAGE_MANAGERS.has(program)) {
    while (tokens[0]?.startsWith("-")) {
      const option = tokens.shift()!;
      if (PACKAGE_OPTIONS_WITH_VALUE.has(option)) tokens.shift();
      else if (!/^(--workspace-root|-w|--recursive|-r|--filter=\S+|--dir=\S+)$/.test(option))
        return;
    }
    if (tokens[0] === "exec" || tokens[0] === "x") {
      const nested = basename(tokens[1]);
      const check = nested && checkProgram(nested, tokens.slice(2));
      return check ? `${program} ${tokens[0]} ${check}` : undefined;
    }
    const script = tokens[tokens[0] === "run" ? 1 : 0];
    return script && CHECK_SCRIPT.test(script) ? `${program} ${script}` : undefined;
  }
  return checkProgram(program, tokens);
}

function checkProgram(program: string, tokens: string[]): string | undefined {
  if (CHECK_PROGRAMS.has(program)) return program;
  if (program === "python" || program === "python3")
    return tokens[0] === "-m" && (tokens[1] === "unittest" || tokens[1] === "pytest")
      ? `${program} -m ${tokens[1]}`
      : undefined;
  if (program === "git")
    return tokens[0] === "diff" && tokens.includes("--check") ? "git diff --check" : undefined;
  if (program === "oxfmt" || program === "prettier")
    return tokens.includes("--check") ? `${program} --check` : undefined;
  const subcommand = tokens[0];
  return subcommand &&
    Object.hasOwn(CHECK_SUBCOMMANDS, program) &&
    CHECK_SUBCOMMANDS[program]?.includes(subcommand)
    ? `${program} ${subcommand}`
    : undefined;
}

function workspacePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_PATH ||
    /[:\u0000-\u001f\u007f-\u009f]/.test(value) ||
    /^[~\\/]/.test(value) ||
    value.endsWith("…")
  )
    return;
  const parts = value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== ".");
  if (!parts.length || parts.some((part) => !part || privateFilePathPart(part))) return;
  return parts.join("/");
}

/** Projects authorized, normalized tool rows for one turn, without raw inputs or outputs. */
export class TurnSummaryProjection {
  #files = new Map<string, File>();
  #checks: Check[] = [];
  #items = new Set<string>();
  #partial = false;

  constructor(readonly turnId: string) {}

  add(event: {
    id?: unknown;
    kind?: unknown;
    turn_id?: unknown;
    tool?: unknown;
    tool_name?: unknown;
    tool_status?: unknown;
  }): void {
    const { id, tool, tool_status: status } = event;
    if (
      event.turn_id !== this.turnId ||
      event.kind !== "tool-summary" ||
      typeof id !== "string" ||
      this.#items.has(id) ||
      !object(tool) ||
      !Array.isArray(tool.content) ||
      (status !== "completed" && status !== "failed" && status !== "unknown")
    )
      return;
    if (this.#items.size >= MAX_ITEMS) {
      this.#partial = true;
      return;
    }
    this.#items.add(id);
    const diffs = new Set<string>();
    for (const entry of tool.content) {
      if (!object(entry)) continue;
      if (
        tool.kind === "execute" &&
        entry.type === "terminal" &&
        typeof entry.command === "string"
      ) {
        const name = checkName(entry.command);
        if (!name) continue;
        if (this.#checks.length >= MAX_CHECKS) {
          this.#partial = true;
          continue;
        }
        const code = validExitCode(entry.exit_code) ? entry.exit_code : undefined;
        this.#checks.push({
          name,
          status:
            code !== undefined
              ? code === 0
                ? "passed"
                : "failed"
              : status === "completed"
                ? "passed"
                : status === "failed"
                  ? "failed"
                  : "unknown",
          ...(code !== undefined ? { exit_code: code } : {}),
        });
      }
      if (entry.type !== "diff" || status !== "completed") continue;
      const original = workspacePath(entry.path);
      const changed = entry.move_path ? workspacePath(entry.move_path) : original;
      if (!original || !changed) {
        this.#partial = true;
        continue;
      }
      // Some ACP providers repeat the same diff in the start and final update.
      const preview = typeof entry.preview === "string" ? entry.preview : "";
      const added = validCount(entry.added) ? entry.added : undefined;
      const removed = validCount(entry.removed) ? entry.removed : undefined;
      const key = JSON.stringify([original, changed, added, removed, preview]);
      if (diffs.has(key)) continue;
      diffs.add(key);
      const file = this.#files.get(changed) ?? { path: changed };
      if (this.#files.size >= MAX_FILES && !this.#files.has(changed)) {
        this.#partial = true;
        continue;
      }
      // A Claude Write can overwrite an existing file. Its display diff only knows the new text.
      // NotebookEdit without a patch likewise has no old text for its line counts.
      if (
        (event.tool_name === "Write" && entry.change === "add") ||
        (event.tool_name === "NotebookEdit" && !/^@@ -\d+/m.test(preview)) ||
        added === undefined ||
        removed === undefined ||
        (added === 0 && removed === 0 && !preview)
      )
        this.#partial = true;
      else {
        file.added = (file.added ?? 0) + added;
        file.removed = (file.removed ?? 0) + removed;
      }
      this.#files.set(changed, file);
    }
    if (tool.truncated) this.#partial = true;
  }

  summary(partial = false): ConversationTurnSummary | undefined {
    if (!this.#files.size && !this.#checks.length) return;
    return {
      ...(this.#files.size
        ? { files: [...this.#files.values()].map((file) => ({ ...file })) }
        : {}),
      ...(this.#checks.length ? { checks: [...this.#checks] } : {}),
      ...(this.#partial || partial ? { partial: true } : {}),
    };
  }
}

/** Validates a summary read from the local turn metadata ledger. */
export function cleanTurnSummary(value: unknown): ConversationTurnSummary | undefined {
  if (!object(value)) return;
  const files: File[] = [];
  const checks: Check[] = [];
  for (const raw of Array.isArray(value.files) ? value.files.slice(0, MAX_FILES) : []) {
    if (!object(raw)) continue;
    const shown = workspacePath(raw.path);
    if (shown)
      files.push({
        path: shown,
        ...(validCount(raw.added) ? { added: raw.added } : {}),
        ...(validCount(raw.removed) ? { removed: raw.removed } : {}),
      });
  }
  for (const raw of Array.isArray(value.checks) ? value.checks.slice(0, MAX_CHECKS) : []) {
    if (
      !object(raw) ||
      typeof raw.name !== "string" ||
      raw.name.length > 100 ||
      checkName(raw.name) !== raw.name ||
      (raw.status !== "passed" && raw.status !== "failed" && raw.status !== "unknown")
    )
      continue;
    checks.push({
      name: raw.name,
      status: raw.status,
      ...(validExitCode(raw.exit_code) ? { exit_code: raw.exit_code } : {}),
    });
  }
  if (!files.length && !checks.length) return;
  return {
    ...(files.length ? { files } : {}),
    ...(checks.length ? { checks } : {}),
    ...(value.partial === true ? { partial: true } : {}),
  };
}
