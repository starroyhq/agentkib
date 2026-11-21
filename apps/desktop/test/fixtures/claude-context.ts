import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog } from "../../../../packages/backend/src/catalog";
import { claudeProjectKey } from "../../../../packages/backend/src/agents/claude/claude-project-path";
import { Commands } from "../../../../packages/backend/src/commands";
import { Context, type ClaudeContextInternals } from "../../../../packages/backend/src/context";
import { McpBuiltins } from "../../../../packages/backend/src/mcp-builtin";
import { canonicalize } from "../../../../packages/backend/src/paths";
import type { BackendStore } from "../../../../packages/backend/src/store";

/**
 * A throw-away project for context resolution. Everything is synthetic and lives under one
 * temporary tree: the project, a home directory, and a bin directory holding the only `claude`
 * the backend can find. PATH, HOME and USERPROFILE all point into that tree because command
 * lookup also scans the home directory, and a real installation there would make the
 * "version unknown" cases depend on the machine running the tests. The folder for managed
 * policy files points into the tree too, so a policy file on the machine cannot change a result.
 */
export function contextFixture(internals: ClaudeContextInternals = {}) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-claude-context-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const managedDir = path.join(root, "managed-policy");
  for (const directory of [home, bin, project]) mkdirSync(directory, { recursive: true });
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: bin };
  const commands = new Commands();
  const catalog = {
    installations: () => [{ agent: "claude-code", installed: true }],
    memories: () => [],
  } as unknown as Catalog;
  const context = new Context(catalog, commands, environment, { managedDir, ...internals });
  const absolute = (file: string) => (path.isAbsolute(file) ? file : path.join(project, file));
  return {
    root,
    home,
    bin,
    project,
    managedDir,
    environment,
    commands,
    context,
    /** Paths inside the project. */
    at: (...parts: string[]) => path.join(project, ...parts),
    /** Paths inside the fake home directory. */
    inHome: (...parts: string[]) => path.join(home, ...parts),
    /** Paths inside the temp tree but outside the project. */
    outside: (...parts: string[]) => path.join(root, ...parts),
    /** Write a file, creating parent directories. Relative paths are relative to the project. */
    write(file: string, content: string | Buffer = "") {
      const target = absolute(file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    mkdir(directory: string) {
      mkdirSync(absolute(directory), { recursive: true });
      return absolute(directory);
    },
    link(target: string, file: string) {
      const location = absolute(file);
      mkdirSync(path.dirname(location), { recursive: true });
      symlinkSync(target, location);
      return location;
    },
    /** The organization policy CLAUDE.md. */
    managed(content: string) {
      return this.write(path.join(managedDir, "CLAUDE.md"), content);
    },
    /** A file in the user's Claude folder (`~/.claude`). */
    user(name: string, content: string | Buffer = "") {
      return this.write(path.join(home, ".claude", name), content);
    },
    /** Where auto memory for `directory` (the project by default) lives. */
    memoryFile(directory = project) {
      const key = claudeProjectKey(directory, environment);
      if (!key.ok) throw new Error(`no key: ${key.reason}`);
      return path.join(home, ".claude", "projects", key.key, "memory", "MEMORY.md");
    },
    memory(content: string | Buffer, directory = project) {
      return this.write(this.memoryFile(directory), content);
    },
    /**
     * Install a fake `claude` that prints `output` for `--version`. When `log` is given, every
     * invocation appends a line to it, so tests can tell whether the CLI was run at all.
     */
    claude(output: string, options: { log?: string; exitCode?: number } = {}) {
      const executable = path.join(bin, "claude");
      const record = options.log ? `echo run >> '${options.log}'\n` : "";
      writeFileSync(
        executable,
        `#!/bin/sh\n${record}printf '%s\\n' '${output}'\nexit ${options.exitCode ?? 0}\n`,
      );
      chmodSync(executable, 0o755);
      return executable;
    },
    /** Resolve the effective Claude Code context, like the Doctor does. */
    resolve(
      cwd = project,
      options?: { externalBodies?: boolean; includeOutsideSources?: boolean },
    ) {
      return context.resolve(project, cwd, "claude-code", null, [], options);
    },
    /** What the app and the CLI get. */
    request(cwd = project) {
      return context.request({ project, cwd, agent: "claude-code" });
    },
    /** What an Agent connected over MCP gets (`agent` is the one in the connection URL). */
    mcp(cwd = project, agent = "claude-code") {
      return new McpBuiltins({} as BackendStore, context, root).call(
        project,
        "workspace",
        agent,
        "workspace_get_context",
        { cwd },
      ) as Promise<Awaited<ReturnType<typeof context.request>>>;
    },
    dispose() {
      commands.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export type ContextFixture = ReturnType<typeof contextFixture>;
