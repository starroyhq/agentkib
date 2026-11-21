/**
 * Claude Code stores a project's transcripts (and auto memory) in `<config>/projects/<key>/`.
 *
 * The key is the working directory with every character outside [A-Za-z0-9] replaced by "-", one
 * "-" per UTF-16 code unit: nothing is collapsed, trimmed or normalised, so a POSIX path always
 * starts with "-" and a Windows drive path starts with "C--". Claude Code does this with a
 * JavaScript `replace(/[^a-zA-Z0-9]/g, "-")`.
 *
 * Basis:
 * - The directory name is derived from the working directory path, and `CLAUDE_CODE_PROJECT_DIR_NAME`
 *   replaces it when `CLAUDE_CONFIG_DIR` is also set (Claude Code 2.1.234+):
 *   https://code.claude.com/docs/en/env-vars
 * - The character rule and the length cap below are not in the official documentation. They come
 *   from a reading of the shipped binary reported in https://github.com/anthropics/claude-code/issues/91935
 *   and from user reports of `.`, `_`, spaces and CJK characters all becoming "-"
 *   (https://github.com/anthropics/claude-code/issues/40946, #38007, #39424).
 *
 * This follows current Claude Code releases. Older ones used a narrower pattern for some
 * characters (#38007); AgentKib's version gate (2.1 or later) does not distinguish them.
 *
 * Claude Code cuts keys longer than 200 characters to 200 and appends `-<hash>`. That hash comes
 * from Claude Code's own routine and is not documented, so AgentKib cannot reproduce it with
 * certainty. Rather than guess a directory the CLI would never look in, such paths are refused.
 */
import { claudeConfigDirVariable } from "./claude-config";

const MAX_VERBATIM_KEY_LENGTH = 200;

export type ClaudeProjectKeyFailure = "empty-path" | "path-too-long" | "directory-name-overridden";

export type ClaudeProjectKey =
  | { ok: true; key: string }
  | { ok: false; reason: ClaudeProjectKeyFailure };

/** Directory name below `<config>/projects/` that Claude Code uses for `cwd`, or why it is unknown. */
export function claudeProjectKey(cwd: string, env: NodeJS.ProcessEnv = {}): ClaudeProjectKey {
  // Claude Code validates the override itself and falls back to the derived name when it is
  // invalid, so a set override means AgentKib cannot tell which directory the CLI will use.
  // Any truthy value counts here, even a blank or unusable one: Claude Code decides what that means.
  if (claudeConfigDirVariable(env) && env.CLAUDE_CODE_PROJECT_DIR_NAME)
    return { ok: false, reason: "directory-name-overridden" };
  if (!cwd) return { ok: false, reason: "empty-path" };
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length > MAX_VERBATIM_KEY_LENGTH) return { ok: false, reason: "path-too-long" };
  return { ok: true, key };
}
