import { claudeConfigFiles, claudeManagedDir, resolveClaudeConfig } from "./claude-config";
import type { ClaudeConfig } from "./claude-config";
import { resolveRepoRoot } from "./claude-memory";
import {
  defaultIo,
  flavor,
  isInside,
  pathKey,
  probe,
  type ClaudeIo,
  type OutsideMode,
  type ProbeContext,
} from "./context-claude-sources";
import { userHome } from "./mcp-config-read";
import { sanitizeSessionText } from "./session-handoff";

// Claude Code settings, read-only. Basis, https://code.claude.com/docs/en/settings and
// https://code.claude.com/docs/en/managed-settings:
// - Files: managed (`managed-settings.json` and `managed-settings.d/*.json` in the policy folder),
//   local (`.claude/settings.local.json`, kept at the repository root), project
//   (`.claude/settings.json` of the working directory) and user (`<config>/settings.json`).
// - Precedence, highest first: managed, command line (`--settings`), local, project, user.
// - Lists such as `permissions.allow` merge across files instead of overriding. Documented for
//   the managed drop-in files: single values are replaced by the later file, lists are combined,
//   nested blocks merge key by key. Between the other layers the same rules are assumed (not
//   verified for nested blocks other than `permissions`).
// - Strict JSON: a comment or a trailing comma is a syntax error.
//
// What AgentKib cannot see: `--settings` and `--setting-sources` (command line), policy delivered
// as a macOS configuration profile or a Windows registry value, and server-managed settings from
// the claude.ai console. The result can therefore differ from what a running Claude Code uses.
//
// Secrets. A settings file can hold credentials in several places, so nothing leaves this module
// as raw text. Outgoing text is built only from (a) key names, (b) an allow list of plain values
// that never carry credentials (`SHOWN_VALUES`), and (c) commands, rules and URLs after
// `redactText`. The `env` block shows names only. Credential helpers (`apiKeyHelper` and the
// like) show "configured". Values of keys that are not listed here are never shown.

export type SettingsLayerId = "managed" | "local" | "project" | "user";
/** Highest precedence first. The command line (`--settings`) sits between managed and local. */
export const LAYER_ORDER: readonly SettingsLayerId[] = ["managed", "local", "project", "user"];
export type SettingsFileStatus =
  | "ok"
  | "missing"
  | "unparseable"
  | "not-object"
  | "too-large"
  | "unreadable"
  | "network"
  | "sensitive";
export interface SettingsFile {
  layer: SettingsLayerId;
  /** The path as written. Callers decide whether to show it. */
  file: string;
  status: SettingsFileStatus;
  /** Where a syntax error is (1-based). Never the text around it. */
  position?: { line: number; column: number };
  /** The file is not below the workspace root. */
  outside: boolean;
  /** Top-level key names of a parsed file, sorted and bounded. */
  keys: string[];
}
export type InstructionFiles =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";
export interface McpPolicyEntry {
  serverName?: string;
  serverUrl?: string;
  serverCommand?: string[];
}

const MAX_BYTES = 256 * 1024;
const MAX_KEYS = 200;
const MAX_NAME_CHARS = 80;
const MAX_TEXT_CHARS = 200;
const MAX_LIST = 50;
const MAX_ENTRIES = 256;
const MAX_DROP_INS = 64;
const MAX_DEPTH = 8;
const AGENTS_PLUGIN_IDS = ["cc-plugin-agents-md@builtin", "agents-md@builtin"] as const;
const INSTRUCTION_VALUES: readonly string[] = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
];
/** Keys whose plain value is safe to show: none of them holds a credential, a command or a URL. */
const SHOWN_VALUES = new Set([
  "model",
  "outputStyle",
  "language",
  "theme",
  "effortLevel",
  "defaultShell",
  "agent",
  "alwaysThinkingEnabled",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "autoCompactEnabled",
  "cleanupPeriodDays",
  "includeCoAuthoredBy",
  "includeGitInstructions",
  "enableAllProjectMcpServers",
  "allowManagedMcpServersOnly",
  "disableAllHooks",
  "editorMode",
  "verbose",
  "fastMode",
  "autoUpdatesChannel",
  "respectGitignore",
  "plansDirectory",
  "spinnerTipsEnabled",
  "timeZone",
  "viewMode",
  "teammateMode",
]);
/** Keys that name a command which produces a credential: only "configured" is ever shown. */
const CREDENTIAL_HELPERS = new Set([
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "proxyAuthHelper",
  "policyHelper",
]);
/** Keys with a command that is shown after redaction. */
const COMMAND_KEYS = new Set(["statusLine", "subagentStatusLine", "fileSuggestion"]);
/** Handled by dedicated lines; they are not repeated among the other keys. */
const DEDICATED = new Set([
  ...SHOWN_VALUES,
  ...CREDENTIAL_HELPERS,
  ...COMMAND_KEYS,
  "permissions",
  "env",
  "hooks",
  "enabledPlugins",
  "claudeMd",
  "claudeMdExcludes",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "allowedMcpServers",
  "deniedMcpServers",
  "managedMcpServers",
  "pluginConfigs",
  "extraKnownMarketplaces",
]);
/** A later value replaces the earlier one whole instead of merging. */
const WHOLE_VALUE_KEYS = new Set(["fallbackModel", "modelPicker"]);

type Obj = { [key: string]: unknown };
const isObject = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Obj, key: string) => Object.hasOwn(value, key);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// ---- redaction -------------------------------------------------------------------------------

const SECRET_WORD = "(?:token|key|secret|passw(?:or)?d|passwd|auth|credential|bearer|cookie|sig)";
const SHELL_SPACING = String.raw`(?:\s|\\\r?\n)`;
const SECRET_NAME = new RegExp(SECRET_WORD, "i");
const ACCOUNT_ARGUMENT = new RegExp(
  `(^|[\\s(;&|])(?:--(?:proxy-)?user(?:=|${SHELL_SPACING}+)|-[uU]${SHELL_SPACING}*)`,
  "g",
);
const HEADER_ARGUMENT = new RegExp(
  `(^|[\\s(;&|])(?:--(?:proxy-)?header(?:=|${SHELL_SPACING}+)|-H${SHELL_SPACING}*)`,
  "g",
);
// Only curl's argument-free short options may precede u/U in a combined option. An option
// such as -d consumes the rest of its word as data and must not turn it into a credential.
const CURL_ACCOUNT =
  /^(--(?:proxy-)?user(?:=|$)|-[aBqfGgIiJkLlMnNOpRjsSvVZ012346#]*[uU])([\s\S]*)$/;
const CURL_HEADER = /^(--(?:proxy-)?header(?:=|$)|-[aBqfGgIiJkLlMnNOpRjsSvVZ012346#]*H)([\s\S]*)$/;
const SECRET_HEADER =
  /^\s*(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*:/i;

/** Only literal shell words are interpreted. Dynamic or incomplete words hide the remainder:
 * matching substitutions would require a shell parser (including nesting, heredocs and case
 * patterns), and guessing their closing delimiter could expose part of the credential. */
function shellArgument(text: string, start: number): { end: number; literal: string | null } {
  let quote: "'" | '"' | undefined;
  const literal: string[] = [];
  let at = start;
  for (; at < text.length; at++) {
    const character = text[at]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else literal.push(character);
    } else if (character === "\\") {
      if (++at === text.length) return { end: text.length, literal: null };
      if (text[at] === "\r" && text[at + 1] === "\n") at++;
      else if (text[at] !== "\n") literal.push(text[at]!);
    } else if (
      character === "`" ||
      (character === "$" &&
        (["(", "{", "[", "'", '"'].includes(text[at + 1]!) ||
          /[A-Za-z0-9_@*#?$!-]/.test(text[at + 1] ?? "")))
    ) {
      return { end: text.length, literal: null };
    } else if (quote === '"') {
      if (character === '"') quote = undefined;
      else literal.push(character);
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/[\s;&|()<>]/.test(character)) {
      break;
    } else literal.push(character);
  }
  return { end: at, literal: quote ? null : literal.join("") };
}
function shellSpacingEnd(text: string, start: number): number {
  let at = start;
  while (at < text.length) {
    if (/\s/.test(text[at]!)) at++;
    else if (text[at] === "\\" && text[at + 1] === "\n") at += 2;
    else if (text[at] === "\\" && text[at + 1] === "\r" && text[at + 2] === "\n") at += 3;
    else break;
  }
  return at;
}
function cleanControls(text: string): string {
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
      ? " "
      : character;
  }).join("");
}
function redactUrlAccounts(text: string): string {
  const schemes = /[a-z0-9+.-]+/gi;
  const pieces: string[] = [];
  let copied = 0;
  for (let match = schemes.exec(text); match; match = schemes.exec(text)) {
    const end = match.index + match[0].length;
    if (!text.startsWith("://", end) || !/[a-z]/i.test(match[0])) continue;
    const start = end + 3;
    let at = start;
    let accountEnd = -1;
    while (at < text.length && !/[\s/'"]/.test(text[at]!)) {
      if (text[at] === "@" && accountEnd < 0) accountEnd = at;
      at++;
    }
    if (accountEnd >= start) {
      pieces.push(text.slice(copied, start), "[REDACTED]");
      copied = accountEnd;
    }
    schemes.lastIndex = at;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}
function redactQueryValues(text: string): string {
  const prefixes = /[?&#;]([^=?&\s'"#;]*)=/g;
  const pieces: string[] = [];
  let copied = 0;
  for (let match = prefixes.exec(text); match; match = prefixes.exec(text)) {
    if (!SECRET_NAME.test(match[1]!)) continue;
    const start = prefixes.lastIndex;
    let end = start;
    while (end < text.length && !/[&\s'"#;]/.test(text[end]!)) end++;
    if (end === start) continue;
    pieces.push(text.slice(copied, start), "[REDACTED]");
    copied = end;
    prefixes.lastIndex = end;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}

/**
 * Text that may be a command, a rule or a URL, made safe to show. Complete secret arguments
 * must be hidden before the shared line-oriented redaction or control-character cleanup:
 * both can split escaped spaces, joined quotes and continued values and leave a suffix behind.
 * URL, header and opaque-value rules follow. Shortened last, never through a raw secret.
 */
export function redactText(text: string, maxCharacters = MAX_TEXT_CHARS): string {
  return redactCommandText(text, 0, maxCharacters);
}
function redactCommandText(text: string, depth: number, maxCharacters = MAX_TEXT_CHARS): string {
  // Protect already-redacted arguments from broad header/line rules. For example, applying
  // those rules to `--api-key=[REDACTED]; echo ok` would also remove the ordinary command.
  // Escape input markers first, so restoration always uses a fixed-size delimiter. Growing a
  // delimiter to exceed a malicious run would make the final pattern repeatedly rescan it.
  const marker = "\ue000";
  const argumentsHidden: string[] = [];
  const restore = (value: string) =>
    value.replace(
      /\ue000(\d+)\ue000/g,
      (_match, index: string) => argumentsHidden[Number(index)] ?? "[REDACTED]",
    );
  const protect = (safe: string): string => {
    // A nested script/prefix may already contain protected literal markers from this pass.
    argumentsHidden.push(restore(safe));
    return `${marker}${argumentsHidden.length - 1}${marker}`;
  };
  text = text.replaceAll(marker, () => protect(marker));
  const hideArgument = (prefix: string): string => {
    return protect(`${cleanControls(prefix)}[REDACTED]`);
  };
  const hideNamedArguments = (input: string, assignment: boolean): string => {
    // Consume each complete name once, then inspect it. Secret words must not sit between
    // overlapping unbounded character groups: long near-matches otherwise take quadratic time.
    const names = assignment ? /[a-z0-9_]+/gi : /[-a-z0-9_]+/gi;
    const pieces: string[] = [];
    let copied = 0;
    for (let match = names.exec(input); match; match = names.exec(input)) {
      const offset = assignment ? 0 : match[0].indexOf("-");
      if (offset < 0 || !SECRET_NAME.test(match[0].slice(offset))) continue;
      const end = match.index + match[0].length;
      let start = shellSpacingEnd(input, end);
      if (input[start] === "=") start = shellSpacingEnd(input, start + 1);
      else if (assignment || start === end) continue;
      const argument = shellArgument(input, start);
      if (argument.end === start) continue;
      const prefix = match.index + offset;
      pieces.push(input.slice(copied, prefix), hideArgument(input.slice(prefix, start)));
      copied = argument.end;
      names.lastIndex = copied;
    }
    pieces.push(input.slice(copied));
    return pieces.join("");
  };
  const hideArguments = (
    input: string,
    pattern: RegExp,
    sensitive: (literal: string | null, index: number) => boolean = () => true,
  ): string => {
    pattern.lastIndex = 0;
    let output = "";
    let copied = 0;
    for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
      const start = match.index + match[0].length;
      const argument = shellArgument(input, start);
      // Even a plain argument was fully inspected. Do not rescan option-looking text inside
      // that same quoted word after the sensitivity check rejects it.
      pattern.lastIndex = argument.end;
      if (argument.end === start || !sensitive(argument.literal, match.index)) continue;
      const boundary = /^[\s(;&|]+/.exec(match[0])?.[0] ?? "";
      output +=
        input.slice(copied, match.index) + boundary + hideArgument(match[0].slice(boundary.length));
      copied = argument.end;
      pattern.lastIndex = copied;
    }
    return output + input.slice(copied);
  };
  const accountSensitive = (literal: string | null) => literal === null || literal.includes(":");
  const headerSensitive = (literal: string | null) =>
    literal === null || SECRET_HEADER.test(literal);
  type Word = { start: number; end: number; literal: string | null };
  // Walk literal words and the wrappers whose argument boundaries are known. Unknown
  // execution contexts with credential-looking curl text are opaque, not assumed safe.
  // Quoted separators remain data, so `echo curl -su name:group` is not treated as curl.
  const shellCommands = (input: string): string => {
    const patches: { start: number; end: number; text: string }[] = [];
    let hiddenRemainder = false;
    const hideRest = (start: number) => {
      patches.push({ start, end: input.length, text: hideArgument("") });
      hiddenRemainder = true;
    };
    const hideWord = (word: Word) => {
      patches.push({ start: word.start, end: word.end, text: hideArgument("") });
      if (word.literal === null) hiddenRemainder = true;
    };
    const hideUncertain = (words: Word[], start: number) => {
      const remaining = words.slice(start);
      const decoded = remaining
        .map((word) => word.literal ?? input.slice(word.start, word.end))
        .join(" ");
      // An opaque wrapper may execute a quoted argument as another script. Collapse quote/
      // escape syntax only for conservative detection, never to infer an execution boundary.
      const inspection = decoded.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "");
      const curl = /\bcurl(?:\.exe)?\b/.test(inspection);
      const account =
        /(?:^|[\s'"])(?:--(?:proxy-)?user(?:[=\s]|$)|-[aBqfGgIiJkLlMnNOpRjsSvVZ012346#]*[uU])/.test(
          inspection,
        );
      const uncertain = remaining.some((word) => word.literal === null);
      const dynamic = uncertain || /[$`]/.test(decoded);
      const secretOption = [...inspection.matchAll(/--?[-a-z0-9_]+/gi)].some((match) =>
        SECRET_NAME.test(match[0]),
      );
      const header =
        /(?:^|\s)(?:--(?:proxy-)?header(?:[=\s]|$)|-[aBqfGgIiJkLlMnNOpRjsSvVZ012346#]*H)/.test(
          inspection,
        );
      const secretHeader = /(?:authorization|api-key|x-auth-token|cookie)\s*:/i.test(inspection);
      if (
        (curl && (account || dynamic)) ||
        (curl && header && secretHeader) ||
        (uncertain && (secretOption || header)) ||
        (dynamic && (account || (inspection.includes(":") && /(?:^|\s)-/.test(inspection))))
      ) {
        hideRest(words[start]!.start);
      }
    };
    const literalArguments = (words: Word[]) => {
      for (let index = 0; index < words.length; index++) {
        const word = words[index]!;
        if (word.literal === null) {
          // The spelling of a dynamic option cannot establish whether it is sensitive.
          // An ordinary dynamic argument remains available to the command/wrapper check.
          const spelling = input.slice(word.start, word.end).replace(/['"\\]/g, "");
          if (spelling.startsWith("-")) {
            hideRest(word.start);
            return;
          }
          continue;
        }
        const assignment = /^([a-z_][a-z0-9_]*=)([\s\S]+)$/i.exec(word.literal);
        if ((assignment && SECRET_NAME.test(assignment[1]!)) || SECRET_HEADER.test(word.literal)) {
          const prefix = assignment?.[1] ?? "";
          patches.push({
            start: word.start,
            end: word.end,
            text: hideArgument(input.startsWith(prefix, word.start) ? prefix : ""),
          });
          continue;
        }
        const named = /^(-[-a-z0-9_]+)(=|$)/i.exec(word.literal);
        const header = /^(--(?:proxy-)?header=|-H)([\s\S]+)$/.exec(word.literal);
        const separateHeader = /^(?:--(?:proxy-)?header|-H)$/.test(word.literal);
        const secret = named !== null && SECRET_NAME.test(named[1]!);
        if (secret || header || separateHeader) {
          const prefix = header?.[1] ?? (named?.[2] === "=" ? `${named[1]}=` : undefined);
          if (prefix) {
            const value = word.literal.slice(prefix.length);
            if (value && (secret || headerSensitive(value)))
              patches.push({
                start: word.start,
                end: word.end,
                text: hideArgument(input.startsWith(prefix, word.start) ? prefix : ""),
              });
          } else {
            const value = words[index + 1];
            if (value && (secret || headerSensitive(value.literal))) hideWord(value);
            // A header value remains one argument even when it happens to look like a flag.
            if (value) index++;
          }
          continue;
        }
        // Reconstruct only words whose decoded URL contains a credential. Safe literal words
        // retain their original quoting/escaping; raw-only URL scans miss joined query names.
        const safeUrl = redactQueryValues(redactUrlAccounts(word.literal));
        if (safeUrl !== word.literal)
          patches.push({ start: word.start, end: word.end, text: safeUrl });
      }
    };
    const command = (words: Word[]) => {
      literalArguments(words);
      if (hiddenRemainder) return;
      let at = 0;
      while (at < words.length) {
        const word = words[at]!;
        if (word.literal === null) {
          // A dynamic assignment or executable can hide the true command boundary. Preserve
          // ordinary dynamic text, but never show a remaining credential-looking curl call.
          hideUncertain(words, at);
          return;
        }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word.literal)) {
          at++;
          continue;
        }
        const executable = word.literal.replace(/^.*[/\\]/, "").replace(/\.exe$/, "");
        if (executable === "env" || executable === "command") {
          at++;
          while (at < words.length) {
            const option = words[at]!.literal;
            if (option === "--") {
              at++;
              break;
            }
            if (
              (executable === "command" && option === "-p") ||
              (executable === "env" &&
                (option === "-i" ||
                  option === "--ignore-environment" ||
                  (option !== null && /^--(?:unset|chdir)=/.test(option))))
            ) {
              at++;
              continue;
            }
            if (executable === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option!)) {
              const argument = words[at + 1];
              if (!argument) return;
              if (argument.literal === null) {
                hideRest(argument.start);
                return;
              }
              at += 2;
              continue;
            }
            // env -S and shell expansions can synthesize arbitrary options. Do not guess
            // where a credential ends in such a command: hide its remaining words.
            if (option === null || (executable === "env" && option.startsWith("-"))) {
              hideUncertain(words, at);
              return;
            }
            if (option.startsWith("-")) {
              // command -v/-V only reports a command; other unsupported options are opaque.
              if (option !== "-v" && option !== "-V") hideUncertain(words, at);
              return;
            }
            break;
          }
          continue;
        }
        if (["sh", "bash", "zsh", "dash", "ksh"].includes(executable)) {
          let scriptHandled = false;
          for (let index = at + 1; index < words.length; index++) {
            const option = words[index]!.literal;
            if (option === null) {
              hideRest(words[index]!.start);
              break;
            }
            if (!/^-[a-z]+$/.test(option)) break;
            if (!option.includes("c")) continue;
            const script = words[index + 1];
            if (!script) break;
            scriptHandled = true;
            if (script.literal === null || depth >= 4) {
              hideWord(script);
            } else {
              const sanitized = redactCommandText(script.literal, depth + 1, maxCharacters);
              // The outer pass must not interpret a script's closing quote as the start of
              // a credential word (for example `sh -c 'python -u script.py'`). Only keep a
              // fragment here after its full redaction pass, including URL/header rules.
              const protectedScript = protect(
                sanitized === script.literal
                  ? input.slice(script.start, script.end)
                  : `'${sanitized.replace(/'/g, "'\\''")}'`,
              );
              patches.push({
                start: script.start,
                end: script.end,
                text: protectedScript,
              });
            }
            break;
          }
          if (!scriptHandled && !hiddenRemainder) hideUncertain(words, at);
          return;
        }
        if (executable !== "curl") {
          // Literal echo/printf descriptions and escaped parameter names are data. Expansions
          // in their arguments can still execute a command and must pass the opaque check.
          const literalText =
            executable === "echo" || executable === "printf" || executable.includes("$");
          if (!literalText || words.some((item) => item.literal === null)) hideUncertain(words, at);
          return;
        }
        for (let index = at + 1; index < words.length; index++) {
          const argument = words[index]!;
          if (argument.literal === null) {
            hideRest(argument.start);
            break;
          }
          const combined = CURL_ACCOUNT.exec(argument.literal);
          const header = CURL_HEADER.exec(argument.literal);
          if (header) {
            if (header[2]) {
              if (headerSensitive(header[2]))
                patches.push({
                  start: argument.start,
                  end: argument.end,
                  text: hideArgument(
                    input.startsWith(header[1]!, argument.start) ? header[1]! : "",
                  ),
                });
            } else {
              const value = words[index + 1];
              if (value && headerSensitive(value.literal)) hideWord(value);
              if (value) index++;
            }
            continue;
          }
          if (!combined) continue;
          if (combined[2]) {
            if (accountSensitive(combined[2]))
              patches.push({
                start: argument.start,
                end: argument.end,
                text: hideArgument(
                  input.startsWith(combined[1]!, argument.start) ? combined[1]! : "",
                ),
              });
          } else {
            const credential = words[index + 1];
            if (!credential || !accountSensitive(credential.literal)) continue;
            hideWord(credential);
            if (credential.literal === null) break;
            index++;
          }
        }
        return;
      }
    };
    let words: Word[] = [];
    for (let at = 0; at < input.length;) {
      const character = input[at]!;
      if (/[;&|()<>\n\r]/.test(character)) {
        command(words);
        words = [];
        // An opaque wrapper hid the remainder. Do not parse it again or duplicate patches.
        if (hiddenRemainder) break;
        at++;
      } else if (character === "\\" && input[at + 1] === "\n") at += 2;
      else if (character === "\\" && input[at + 1] === "\r" && input[at + 2] === "\n") at += 3;
      else if (/\s/.test(character)) at++;
      else {
        const argument = shellArgument(input, at);
        words.push({ start: at, ...argument });
        at = argument.end;
      }
    }
    if (words.length && !hiddenRemainder) command(words);
    let output = "";
    let copied = 0;
    const byStart = new Map<number, (typeof patches)[number]>();
    for (const patch of patches) {
      const previous = byStart.get(patch.start);
      if (!previous || patch.end > previous.end) byStart.set(patch.start, patch);
    }
    // Two inspections can redact the same word (for example a curl header). Apply spans in
    // input order without sorting or revisiting bytes covered by an enclosing opaque span.
    for (let at = 0; at < input.length;) {
      const patch = byStart.get(at);
      if (!patch) at++;
      else {
        output += input.slice(copied, at) + patch.text;
        copied = patch.end;
        at = patch.end;
      }
    }
    return output + input.slice(copied);
  };
  let output = shellCommands(text);
  output = hideNamedArguments(output, false);
  output = hideNamedArguments(output, true);
  // Curl account options do not contain a secret keyword. Match one complete shell argument,
  // including joined quotes and escaped spaces, so a quoted password cannot leak its suffix.
  // Require user:password syntax: unrelated flags (such as python -u) keep their plain values.
  output = hideArguments(output, ACCOUNT_ARGUMENT, accountSensitive);
  output = hideArguments(output, HEADER_ARGUMENT, headerSensitive);
  output = cleanControls(output);
  output = sanitizeSessionText(output, { value: 0 });
  // Scan maximal scheme/parameter names before inspecting their delimiters. A failed URL or
  // query match must not retry the same long name at every punctuation/secret-word boundary.
  output = redactUrlAccounts(output);
  // Ordinary values can contain nested URLs. Leave them in the scan; consume a complete
  // value only when its own parameter name is sensitive.
  output = redactQueryValues(output);
  output = output.replace(
    /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n"']+)/gi,
    "$1$2[REDACTED]",
  );
  // Opaque runs: a long word with digits and letters, or base64 that contains slashes. Plain words
  // and ordinary paths do not look like that.
  output = output.replace(
    /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+=]{32,}(?![A-Za-z0-9_\-+/=])/g,
    (blob) => (/\d/.test(blob) && /[A-Za-z]/.test(blob) ? "[REDACTED]" : blob),
  );
  output = output.replace(
    /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9+]{16,}\/[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9_\-+/=])/g,
    (blob) => (/[a-z]/.test(blob) && /[A-Z]/.test(blob) && /\d/.test(blob) ? "[REDACTED]" : blob),
  );
  output = restore(output);
  return output.length > maxCharacters ? `${output.slice(0, maxCharacters)}…` : output;
}

/** A key or identifier taken from a file, bounded and redacted. */
function safeName(name: string): string {
  const cleaned = redactText(name);
  return cleaned.length > MAX_NAME_CHARS ? `${cleaned.slice(0, MAX_NAME_CHARS)}…` : cleaned;
}

// ---- merging ---------------------------------------------------------------------------------

function fresh(): Obj {
  return Object.create(null) as Obj;
}
function unionList(base: unknown[], over: unknown[]): unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];
  for (const item of [...base, ...over]) {
    const key = typeof item === "string" ? `s:${item}` : `j:${JSON.stringify(item) ?? "undefined"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  // File byte limits bound input; display limits must never remove effective policy.
  return output;
}
/** `over` wins for single values, lists are combined, nested blocks merge key by key. */
function merge(base: Obj, over: Obj, top = true, depth = 0): Obj {
  const output = fresh();
  for (const key of Object.keys(base)) output[key] = base[key];
  for (const key of Object.keys(over)) {
    const next = over[key];
    const previous = own(output, key) ? output[key] : undefined;
    if (top && WHOLE_VALUE_KEYS.has(key)) output[key] = next;
    else if (Array.isArray(previous) && Array.isArray(next))
      output[key] = unionList(previous, next);
    else if (isObject(previous) && isObject(next) && depth < MAX_DEPTH)
      output[key] = merge(previous, next, false, depth + 1);
    else output[key] = next;
  }
  return output;
}

function syntaxPosition(
  text: string,
  error: unknown,
): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : "";
  const found = /position (\d+)/.exec(message);
  if (!found) return undefined;
  const index = Math.min(Number(found[1]), text.length);
  let line = 1;
  let column = 1;
  for (let at = 0; at < index; at++) {
    if (text[at] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

// ---- reading ---------------------------------------------------------------------------------

export interface ClaudeSettingsOptions {
  /** Canonical workspace root. */
  root: string;
  /** Canonical working directory inside the root; the project layer is read from here. */
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** `none` reads nothing at all. */
  mode: OutsideMode;
  config?: ClaudeConfig;
  /** Where organization policy files live; `null` for none. Defaults to the platform's folder. */
  managedDir?: string | null;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  /** Whether a file must not be read (credential stores), given the written and the real path. */
  sensitive?: (written: string, real: string) => boolean;
  /** Read the managed and user layers only: there is no project to take the other two from. */
  withoutProject?: boolean;
}

interface Loaded {
  file: SettingsFile;
  data?: Obj;
}
type ManagedDropInsIssue = "limited" | "unreadable" | "network";

function readFileLayer(
  layer: SettingsLayerId,
  written: string,
  base: string | null,
  options: ClaudeSettingsOptions,
  context: ProbeContext,
): Loaded {
  const outsideRoot = (real: string) => !isInside(real, options.root, context.platform);
  const result = (
    status: SettingsFileStatus,
    extra: Partial<SettingsFile> = {},
    data?: Obj,
  ): Loaded => ({
    file: {
      layer,
      file: written,
      status,
      outside: extra.outside ?? outsideRoot(written),
      keys: [],
      ...extra,
    },
    ...(data ? { data } : {}),
  });
  const found = probe(written, base, context);
  if (found.kind === "missing") return result("missing");
  if (found.kind === "network") return result("network");
  if (found.kind !== "file") return result("unreadable");
  const outside = outsideRoot(found.real);
  if (options.sensitive?.(written, found.real)) return result("sensitive", { outside });
  if (found.size > MAX_BYTES) return result("too-large", { outside });
  let bytes: Buffer;
  try {
    bytes = context.io.readFile(found.real, MAX_BYTES + 1);
  } catch {
    return result("unreadable", { outside });
  }
  if (bytes.length > MAX_BYTES) return result("too-large", { outside });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return result("unparseable", { outside });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const position = syntaxPosition(text, error);
    return result("unparseable", { outside, ...(position ? { position } : {}) });
  }
  if (!isObject(parsed)) return result("not-object", { outside });
  const keys = Object.keys(parsed)
    .sort()
    .slice(0, MAX_KEYS)
    .map((key) => safeName(key));
  return result("ok", { outside, keys }, parsed);
}

export function readClaudeSettings(options: ClaudeSettingsOptions): ClaudeSettings {
  if (options.mode === "none")
    return new ClaudeSettings(options.platform ?? process.platform, [], new Map(), new Map());
  const platform = options.platform ?? process.platform;
  const context: ProbeContext = { io: options.io ?? defaultIo, platform };
  const p = flavor(platform);
  const home = userHome(options.environment);
  const config = options.config ?? resolveClaudeConfig(options.environment, home, platform);
  const loaded: Loaded[] = [];
  let managedDropInsIssue: ManagedDropInsIssue | undefined;
  const layers = new Map<SettingsLayerId, Obj>();
  const origins = new Map<string, string>();
  const fold = (layer: SettingsLayerId, items: Loaded[]) => {
    let merged = fresh();
    for (const item of items) {
      loaded.push(item);
      if (!item.data) continue;
      for (const key of Object.keys(item.data)) origins.set(`${layer}:${key}`, item.file.file);
      merged = merge(merged, item.data);
    }
    if (items.some((item) => item.data)) layers.set(layer, merged);
  };

  // managed: the file first, then the drop-ins in alphabetical order; a later one wins.
  const managed =
    options.managedDir === undefined ? claudeManagedDir(platform) : options.managedDir;
  if (managed) {
    const items = [
      readFileLayer("managed", p.join(managed, "managed-settings.json"), null, options, context),
    ];
    const directory = probe(p.join(managed, "managed-settings.d"), null, context);
    if (directory.kind === "dir") {
      let names: string[] = [];
      try {
        names = context.io.readdir(directory.real);
      } catch {
        managedDropInsIssue = "unreadable";
      }
      names = names
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      if (names.length > MAX_DROP_INS) managedDropInsIssue = "limited";
      for (const name of names.slice(0, MAX_DROP_INS)) {
        const item = readFileLayer("managed", p.join(directory.real, name), null, options, context);
        // A name returned by readdir is known to exist. Losing it before the read is an
        // incomplete snapshot, unlike an optional settings file that was absent throughout.
        if (item.file.status === "missing") item.file.status = "unreadable";
        items.push(item);
      }
    } else if (directory.kind !== "missing")
      managedDropInsIssue = directory.kind === "network" ? "network" : "unreadable";
    fold("managed", items);
  }

  if (options.withoutProject) {
    fold("user", [
      readFileLayer("user", claudeConfigFiles(config, platform).settings, null, options, context),
    ]);
    return new ClaudeSettings(
      platform,
      loaded.map((item) => item.file),
      layers,
      origins,
      managedDropInsIssue,
    );
  }
  // local: the repository root's file wins over the working directory's older copy.
  const repository = resolveRepoRoot(options.cwd, context).base;
  const localDirs =
    pathKey(repository, platform) === pathKey(home, platform)
      ? [options.cwd]
      : pathKey(repository, platform) === pathKey(options.cwd, platform)
        ? [options.cwd]
        : [options.cwd, repository];
  fold(
    "local",
    localDirs.map((dir) =>
      readFileLayer("local", p.join(dir, ".claude", "settings.local.json"), null, options, context),
    ),
  );
  fold("project", [
    readFileLayer(
      "project",
      p.join(options.cwd, ".claude", "settings.json"),
      options.cwd,
      options,
      context,
    ),
  ]);
  fold("user", [
    readFileLayer("user", claudeConfigFiles(config, platform).settings, null, options, context),
  ]);
  return new ClaudeSettings(
    platform,
    loaded.map((item) => item.file),
    layers,
    origins,
    managedDropInsIssue,
  );
}

// ---- model -----------------------------------------------------------------------------------

/** Text that is safe to show, with the layer it came from. */
export interface Shown {
  text: string;
  layer: SettingsLayerId;
}
export interface HookSummary {
  /** A settings layer, or `plugin:<id>` for the hooks of a plugin. */
  layer: string;
  event: string;
  matcher?: string;
  type: string;
  /** Redacted. Only the command, URL or a size, never headers or prompt text. */
  detail: string;
}
export type View = "full" | "project-metadata";

export class ClaudeSettings {
  readonly files: readonly SettingsFile[];
  #layers: Map<SettingsLayerId, Obj>;
  #origins: Map<string, string>;
  #platform: NodeJS.Platform;
  #managedDropInsIssue?: ManagedDropInsIssue;

  constructor(
    platform: NodeJS.Platform,
    files: SettingsFile[],
    layers: Map<SettingsLayerId, Obj>,
    origins: Map<string, string>,
    managedDropInsIssue?: ManagedDropInsIssue,
  ) {
    this.#platform = platform;
    this.files = files;
    this.#layers = layers;
    this.#origins = origins;
    this.#managedDropInsIssue = managedDropInsIssue;
  }

  /** At least one settings file was found and parsed. */
  get any(): boolean {
    return this.#layers.size > 0;
  }
  /**
   * A settings file exists or the scan is incomplete. Failed reads must keep diagnostics visible
   * even when no other settings file was available; absent optional files alone remain silent.
   */
  get anyFile(): boolean {
    return !this.complete || this.files.some((file) => file.status !== "missing");
  }
  /** Whether every discovered settings source was read within the local scan's limits. */
  get complete(): boolean {
    return (
      this.#managedDropInsIssue === undefined &&
      this.files.every((file) => file.status === "ok" || file.status === "missing")
    );
  }
  #dropInsCoverage(): string | undefined {
    switch (this.#managedDropInsIssue) {
      case "limited":
        return `Managed settings drop-ins are incomplete: the ${MAX_DROP_INS}-file read limit was reached; additional files were not read.`;
      case "network":
        return "Managed settings drop-ins are incomplete: the directory is a network path and was not read.";
      case "unreadable":
        return "Managed settings drop-ins are incomplete: the directory could not be read.";
    }
  }
  /** Layers that hold data, highest precedence first. */
  #present(): SettingsLayerId[] {
    return LAYER_ORDER.filter((layer) => this.#layers.has(layer));
  }
  /** The layers that set `key`, highest precedence first. */
  #setting(key: string): { layer: SettingsLayerId; value: unknown }[] {
    return this.#present()
      .filter((layer) => own(this.#layers.get(layer)!, key))
      .map((layer) => ({ layer, value: this.#layers.get(layer)![key] }));
  }
  #merged(): Obj {
    let output = fresh();
    for (const layer of [...LAYER_ORDER].reverse()) {
      const data = this.#layers.get(layer);
      if (data) output = merge(output, data);
    }
    return output;
  }

  // ---- values used by the other features ----

  /** `claudeMdExcludes` patterns: arrays merge across every layer. */
  claudeMdExcludes(): string[] {
    const value = this.#merged().claudeMdExcludes;
    // Settings reads bound the input bytes; the shared matcher budget decides long rules.
    return strings(value).filter((pattern) => pattern !== "");
  }
  /** The `claudeMd` text. Honored in managed settings only. */
  managedClaudeMd(): { text: string; file: string } | null {
    const data = this.#layers.get("managed");
    const text = data && own(data, "claudeMd") ? data.claudeMd : undefined;
    if (typeof text !== "string" || text.trim() === "") return null;
    return { text, file: this.#origins.get("managed:claudeMd") ?? "managed settings" };
  }
  /**
   * The "Project instructions" choice, kept under `pluginConfigs["cc-plugin-agents-md@builtin"]`
   * (`agents-md@builtin` before 2.1.285). Read from managed, user (and `--settings`, not visible)
   * settings; project and local settings are ignored, which is reported in `ignoredIn`.
   */
  instructionFiles(): {
    value: InstructionFiles;
    layer?: SettingsLayerId;
    ignoredIn: SettingsLayerId[];
    invalid: boolean;
  } {
    const read = (layer: SettingsLayerId) => {
      const configs = this.#layers.get(layer)?.pluginConfigs;
      if (!isObject(configs)) return undefined;
      for (const id of AGENTS_PLUGIN_IDS) {
        const entry = own(configs, id) ? configs[id] : undefined;
        const options = isObject(entry) && isObject(entry.options) ? entry.options : undefined;
        if (options && own(options, "instructionFiles")) return options.instructionFiles;
      }
      return undefined;
    };
    const ignoredIn = (["local", "project"] as const).filter((layer) => read(layer) !== undefined);
    let invalid = false;
    for (const layer of ["managed", "user"] as const) {
      const value = read(layer);
      if (value === undefined) continue;
      if (typeof value === "string" && INSTRUCTION_VALUES.includes(value))
        return { value: value as InstructionFiles, layer, ignoredIn, invalid };
      invalid = true;
    }
    return { value: "claude-md-or-agents-md", ignoredIn, invalid };
  }
  /**
   * Auto memory settings. `enabled` is false when the highest layer that sets
   * `autoMemoryEnabled` says false. `autoMemoryDirectory` is applied from managed and user
   * settings only: project and local files can set it too, but Claude Code honors that only in a
   * trusted folder, which AgentKib cannot see, and a cloned repository must not be able to point
   * the preview at a folder of its choice.
   */
  autoMemory(): {
    enabled: boolean;
    enabledLayer?: SettingsLayerId;
    directory?: { value: string; layer: SettingsLayerId };
    directoryIgnoredIn: SettingsLayerId[];
    directoryInvalid: boolean;
  } {
    const enabledSet = this.#setting("autoMemoryEnabled").find(
      (entry) => typeof entry.value === "boolean",
    );
    const directories = this.#setting("autoMemoryDirectory").filter(
      (entry) => typeof entry.value === "string",
    );
    const trusted = directories.find(
      (entry) => entry.layer === "managed" || entry.layer === "user",
    );
    const value = trusted?.value as string | undefined;
    const valid =
      value !== undefined &&
      value.length <= 1024 &&
      (value.startsWith("~/") || flavor(this.#platform).isAbsolute(value)) &&
      !value.split(/[\\/]+/).includes("..");
    return {
      enabled: enabledSet?.value !== false,
      ...(enabledSet ? { enabledLayer: enabledSet.layer } : {}),
      ...(trusted && valid ? { directory: { value: value!, layer: trusted.layer } } : {}),
      directoryIgnoredIn: directories
        .map((entry) => entry.layer)
        .filter((layer) => layer === "project" || layer === "local"),
      directoryInvalid: trusted !== undefined && !valid,
    };
  }
  /** Approval state of `.mcp.json` servers (project scope). */
  mcpApprovals(): {
    enableAll?: { value: boolean; layer: SettingsLayerId };
    enabled: Map<string, SettingsLayerId[]>;
    disabled: Map<string, SettingsLayerId[]>;
  } {
    const enableAll = this.#setting("enableAllProjectMcpServers").find(
      (entry) => typeof entry.value === "boolean",
    );
    const collect = (key: string) => {
      const map = new Map<string, SettingsLayerId[]>();
      for (const entry of this.#setting(key))
        for (const name of strings(entry.value))
          map.set(name, [...(map.get(name) ?? []), entry.layer]);
      return map;
    };
    return {
      ...(enableAll
        ? { enableAll: { value: enableAll.value as boolean, layer: enableAll.layer } }
        : {}),
      enabled: collect("enabledMcpjsonServers"),
      disabled: collect("disabledMcpjsonServers"),
    };
  }
  /**
   * MCP allow and deny lists. `allowedMcpServers` merges across layers unless
   * `allowManagedMcpServersOnly` is set in managed settings, which makes the managed list the
   * only one. `deniedMcpServers` always merges.
   */
  mcpPolicy(): {
    /** False means these partial values cannot establish loading or precedence. */
    complete: boolean;
    allowed?: McpPolicyEntry[];
    denied: McpPolicyEntry[];
    managedOnly: boolean;
    managedServers: Obj;
  } {
    const entries = (value: unknown): McpPolicyEntry[] =>
      (Array.isArray(value) ? value : []).flatMap((item): McpPolicyEntry[] => {
        if (!isObject(item)) return [];
        const entry: McpPolicyEntry = {};
        if (typeof item.serverName === "string") entry.serverName = item.serverName;
        if (typeof item.serverUrl === "string") entry.serverUrl = item.serverUrl;
        if (
          Array.isArray(item.serverCommand) &&
          item.serverCommand.every((part) => typeof part === "string")
        )
          entry.serverCommand = item.serverCommand as string[];
        return Object.keys(entry).length ? [entry] : [];
      });
    const managed = this.#layers.get("managed");
    const managedOnly = managed?.allowManagedMcpServersOnly === true;
    const merged = this.#merged();
    const source = managedOnly ? managed!.allowedMcpServers : merged.allowedMcpServers;
    const servers =
      managed && isObject(managed.managedMcpServers) ? managed.managedMcpServers : fresh();
    return {
      complete: this.complete,
      ...(Array.isArray(source) ? { allowed: entries(source) } : {}),
      denied: entries(merged.deniedMcpServers),
      managedOnly,
      managedServers: servers,
    };
  }
  /** The managed settings file that holds `managedMcpServers`, as written. */
  managedServersFile(): string | undefined {
    return this.#origins.get("managed:managedMcpServers");
  }
  /** `enabledPlugins`: nested blocks merge key by key, the highest layer wins for each plugin. */
  enabledPlugins(): Map<string, { enabled: boolean; layer: SettingsLayerId }> {
    const output = new Map<string, { enabled: boolean; layer: SettingsLayerId }>();
    for (const layer of [...LAYER_ORDER].reverse()) {
      const plugins = this.#layers.get(layer)?.enabledPlugins;
      if (!isObject(plugins)) continue;
      // File byte/read limits bound input. Display limits must not discard effective switches.
      for (const id of Object.keys(plugins))
        if (typeof plugins[id] === "boolean") output.set(id, { enabled: plugins[id], layer });
    }
    return output;
  }
  /** Hooks of every layer. They run side by side, so nothing overrides anything. */
  hooks(): HookSummary[] {
    const output: HookSummary[] = [];
    for (const layer of this.#present()) {
      const hooks = this.#layers.get(layer)!.hooks;
      output.push(...summarizeHooks(hooks, layer));
    }
    return output;
  }
  /** Names of the `env` block, never the values. */
  envNames(): { name: string; layer: SettingsLayerId }[] {
    const output: { name: string; layer: SettingsLayerId }[] = [];
    for (const layer of this.#present()) {
      const env = this.#layers.get(layer)!.env;
      if (isObject(env))
        for (const name of Object.keys(env).slice(0, MAX_ENTRIES))
          output.push({ name: safeName(name), layer });
    }
    return output;
  }
  /** Whether the `env` block of a layer sets `name` (for notes only; the value stays unread). */
  envSets(name: string): SettingsLayerId | undefined {
    return this.#present().find((layer) => {
      const env = this.#layers.get(layer)!.env;
      return isObject(env) && own(env, name);
    });
  }

  // ---- text ----

  /**
   * The settings as text. `full` is for the app and the CLI. `project-metadata` is for the MCP
   * tool: the project layer only, without anything that could hold a secret (no env names or
   * values, no rules, commands or URLs, only counts).
   */
  describe(view: View): string {
    const files =
      view === "full" ? this.files : this.files.filter((file) => file.layer === "project");
    const lines = [
      view === "full"
        ? "Settings files (highest precedence first; the command line, --settings, is not visible):"
        : "Settings file of this project:",
    ];
    for (const file of files) {
      if (file.layer === "managed" && file.status === "missing") continue;
      const shown = view === "full" ? file.file : `${file.layer} layer`;
      const keys =
        file.status === "ok" && file.keys.length
          ? `; keys: ${file.keys.slice(0, 40).join(", ")}`
          : "";
      lines.push(`- ${file.layer}: ${shown} - ${describeStatus(file)}${keys}`);
    }
    if (view === "full") {
      const dropInsCoverage = this.#dropInsCoverage();
      if (dropInsCoverage) lines.push(dropInsCoverage);
      if (!this.complete)
        lines.push(
          "Settings coverage is incomplete; MCP loading and precedence cannot be determined.",
        );
    }
    const layers =
      view === "full" ? this.#present() : this.#present().filter((layer) => layer === "project");
    if (!layers.length) return lines.join("\n");
    lines.push(
      "",
      view === "full"
        ? this.complete
          ? "Effective values (highest precedence first):"
          : "Values from readable files (settings coverage is incomplete):"
        : "Values in this layer:",
    );
    lines.push(...this.#valueLines(view, layers));
    return lines.join("\n");
  }

  /**
   * One line per settings file that exists, with the layer, whether it parses and its top-level
   * key names. No path, no value: this is what the MCP tool says about files it must not show.
   */
  metadataLines(except: readonly SettingsLayerId[] = []): string[] {
    const lines = this.files
      .filter((file) => file.status !== "missing" && !except.includes(file.layer))
      .map((file) => {
        const keys =
          file.status === "ok" && file.keys.length ? ` (${file.keys.slice(0, 40).join(", ")})` : "";
        return `Claude Code settings, ${file.layer} layer: ${describeStatus(file)}${keys}. The values are not included in this result.`;
      });
    const dropInsCoverage = this.#dropInsCoverage();
    if (dropInsCoverage && !except.includes("managed"))
      lines.push(`Claude Code settings, managed layer: ${dropInsCoverage}`);
    return lines;
  }

  #valueLines(view: View, layers: readonly SettingsLayerId[]): string[] {
    const full = view === "full";
    const lines: string[] = [];
    const has = (layer: SettingsLayerId, key: string) => own(this.#layers.get(layer)!, key);
    const where = (key: string) => layers.filter((layer) => has(layer, key));
    const value = (key: string) => this.#layers.get(where(key)[0]!)![key];
    const tag = (key: string) => `(${where(key)[0]})`;

    for (const key of [...SHOWN_VALUES].sort()) {
      if (!where(key).length) continue;
      const raw = value(key);
      if (typeof raw === "boolean" || typeof raw === "number")
        lines.push(`${key} = ${String(raw)} ${tag(key)}`);
      else if (typeof raw === "string")
        lines.push(`${key} = ${JSON.stringify(redactText(raw))} ${tag(key)}`);
      else lines.push(`${key} = (not a plain value) ${tag(key)}`);
    }

    // permissions
    const permissionLayers = layers.filter((layer) =>
      isObject(this.#layers.get(layer)!.permissions),
    );
    if (permissionLayers.length) {
      const mode = permissionLayers.find((layer) => {
        const raw = (this.#layers.get(layer)!.permissions as Obj).defaultMode;
        // `auto` and `bypassPermissions` do not take effect from project or local settings.
        return (
          typeof raw === "string" &&
          !(
            (layer === "project" || layer === "local") &&
            (raw === "auto" || raw === "bypassPermissions")
          )
        );
      });
      if (mode)
        lines.push(
          `permissions.defaultMode = ${JSON.stringify(redactText((this.#layers.get(mode)!.permissions as Obj).defaultMode as string))} (${mode})`,
        );
      for (const list of ["allow", "ask", "deny", "additionalDirectories"] as const) {
        const rules = new Set<string>();
        const from: SettingsLayerId[] = [];
        for (const layer of permissionLayers) {
          const items = strings((this.#layers.get(layer)!.permissions as Obj)[list]);
          if (items.length) from.push(layer);
          for (const item of items) rules.add(item);
        }
        if (!rules.size) continue;
        lines.push(
          `permissions.${list}: ${rules.size} ${rules.size === 1 ? "entry" : "entries"} (${from.join(", ")})`,
        );
        // Rules can contain commands and URLs, so only the app gets to see them, redacted.
        if (full)
          for (const rule of [...rules].slice(0, MAX_LIST)) lines.push(`  - ${redactText(rule)}`);
        if (full && rules.size > MAX_LIST) lines.push(`  … (+${rules.size - MAX_LIST} more)`);
      }
    }

    // env: names only
    const env = this.envNames().filter((entry) => layers.includes(entry.layer));
    if (env.length) {
      const names = [...new Set(env.map((entry) => entry.name))];
      lines.push(
        full
          ? `env: ${names.length} ${names.length === 1 ? "name" : "names"}, values hidden: ${names.slice(0, MAX_LIST).join(", ")}`
          : `env: ${names.length} ${names.length === 1 ? "name" : "names"}, values hidden`,
      );
    }

    // credential helpers: configured, never the command
    for (const key of [...CREDENTIAL_HELPERS].sort())
      if (where(key).length) lines.push(`${key}: configured, value hidden ${tag(key)}`);
    // commands that are shown redacted in the app
    for (const key of [...COMMAND_KEYS].sort()) {
      if (!where(key).length) continue;
      const raw = value(key);
      const command =
        typeof raw === "string"
          ? raw
          : isObject(raw) && typeof raw.command === "string"
            ? raw.command
            : undefined;
      if (!full) lines.push(`${key}: configured ${tag(key)}`);
      else if (command !== undefined)
        lines.push(`${key}: command ${redactText(command)} ${tag(key)}`);
      else lines.push(`${key}: configured ${tag(key)}`);
    }

    // hooks
    const hooks = this.hooks().filter((hook) => (layers as readonly string[]).includes(hook.layer));
    if (hooks.length) {
      if (full) {
        lines.push("hooks:");
        for (const hook of hooks.slice(0, MAX_LIST))
          lines.push(
            `  - ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.type}${hook.detail ? ` ${hook.detail}` : ""} (${hook.layer})`,
          );
        if (hooks.length > MAX_LIST) lines.push(`  … (+${hooks.length - MAX_LIST} more)`);
      } else {
        const events = new Set(hooks.map((hook) => hook.event));
        lines.push(
          `hooks: ${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"} for ${events.size} ${events.size === 1 ? "event" : "events"}, commands hidden`,
        );
      }
    }

    // plugins
    const plugins = [...this.enabledPlugins()].filter(([, entry]) => layers.includes(entry.layer));
    if (plugins.length)
      lines.push(
        `enabledPlugins: ${plugins
          .slice(0, MAX_LIST)
          .map(([id, entry]) => `${safeName(id)} ${entry.enabled ? "on" : "off"} (${entry.layer})`)
          .join(", ")}`,
      );

    // lists shown by name
    for (const key of [
      "claudeMdExcludes",
      "enabledMcpjsonServers",
      "disabledMcpjsonServers",
    ] as const) {
      const items = [
        ...new Set(where(key).flatMap((layer) => strings(this.#layers.get(layer)![key]))),
      ];
      if (!items.length) continue;
      lines.push(
        full
          ? `${key}: ${items.length} (${where(key).join(", ")}): ${items
              .slice(0, MAX_LIST)
              .map((item) => redactText(item))
              .join(", ")}`
          : `${key}: ${items.length}`,
      );
    }
    for (const key of ["allowedMcpServers", "deniedMcpServers"] as const) {
      const count = [
        ...new Set(
          where(key).flatMap((layer) =>
            Array.isArray(this.#layers.get(layer)![key])
              ? (this.#layers.get(layer)![key] as unknown[]).map((item) => JSON.stringify(item))
              : [],
          ),
        ),
      ].length;
      if (where(key).length)
        lines.push(
          `${key}: ${count} ${count === 1 ? "entry" : "entries"} (${where(key).join(", ")})`,
        );
    }
    const servers = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.managedMcpServers;
      return isObject(raw) ? Object.keys(raw) : [];
    });
    if (servers.length)
      lines.push(
        `managedMcpServers: ${servers.length} (names and definitions are shown in the MCP view)`,
      );
    if (where("claudeMd").length) {
      const text = this.managedClaudeMd();
      lines.push(
        `claudeMd: ${text ? `${Buffer.byteLength(text.text)} bytes` : "empty"} (managed; shown with the instructions)`,
      );
    }
    // plugin configuration: ids and the instruction choice only, option values can be secrets
    const configs = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.pluginConfigs;
      return isObject(raw) ? Object.keys(raw).map(safeName) : [];
    });
    if (configs.length)
      lines.push(
        `pluginConfigs: ${configs.length} plugin(s), option values hidden: ${[...new Set(configs)].slice(0, MAX_LIST).join(", ")}`,
      );
    const choice = this.instructionFiles();
    if (choice.layer && layers.includes(choice.layer))
      lines.push(`Project instructions = ${choice.value} (${choice.layer})`);
    const marketplaces = layers.flatMap((layer) => {
      const raw = this.#layers.get(layer)!.extraKnownMarketplaces;
      return isObject(raw) ? Object.keys(raw).map(safeName) : [];
    });
    if (marketplaces.length)
      lines.push(
        `extraKnownMarketplaces: ${[...new Set(marketplaces)].slice(0, MAX_LIST).join(", ")} (sources hidden)`,
      );

    // everything else: names only
    const other = new Map<string, SettingsLayerId>();
    for (const layer of layers)
      for (const key of Object.keys(this.#layers.get(layer)!))
        if (!DEDICATED.has(key) && !other.has(key)) other.set(key, layer);
    if (other.size)
      lines.push(
        `Other keys set (values not shown): ${[...other]
          .slice(0, MAX_KEYS)
          .map(([key, layer]) => `${safeName(key)} (${layer})`)
          .join(", ")}`,
      );
    return lines;
  }
}

function describeStatus(file: SettingsFile): string {
  switch (file.status) {
    case "ok":
      return `parsed, ${file.keys.length} ${file.keys.length === 1 ? "key" : "keys"}`;
    case "missing":
      return "not found";
    case "unparseable":
      return file.position
        ? `cannot be parsed (line ${file.position.line}, column ${file.position.column})`
        : "cannot be parsed";
    case "not-object":
      return "cannot be used (the top level is not an object)";
    case "too-large":
      return `skipped (larger than ${MAX_BYTES / 1024} KiB)`;
    case "network":
      return "skipped (network path)";
    case "sensitive":
      return "skipped (sensitive path)";
    default:
      return "could not be read";
  }
}

export function summarizeHooks(hooks: unknown, layer: string): HookSummary[] {
  if (!isObject(hooks)) return [];
  const output: HookSummary[] = [];
  for (const event of Object.keys(hooks).slice(0, 40)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups.slice(0, 20)) {
      if (!isObject(group)) continue;
      const matcher = typeof group.matcher === "string" ? safeName(group.matcher) : undefined;
      const list = Array.isArray(group.hooks) ? group.hooks.slice(0, 20) : [];
      for (const hook of list) {
        if (!isObject(hook)) continue;
        const type = typeof hook.type === "string" ? safeName(hook.type) : "command";
        let detail = "";
        if (typeof hook.command === "string") detail = redactText(hook.command);
        else if (typeof hook.url === "string") detail = redactText(hook.url);
        else if (typeof hook.prompt === "string") detail = `(${hook.prompt.length} characters)`;
        output.push({
          layer,
          event: safeName(event),
          ...(matcher ? { matcher } : {}),
          type,
          detail,
        });
      }
    }
  }
  return output;
}
