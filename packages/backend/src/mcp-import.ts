import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";
import { McpDiagnosticError, mcpErrorDiagnostic } from "./mcp-diagnostics";
import { parse as parseToml } from "smol-toml";
import { serverSchema, type McpServer } from "./mcp-config-read";
import type { Agent } from "./doctor-files";

export type ParsedMcpImport = {
  key: string;
  server?: McpServer;
  error?: string;
  error_message?: McpDiagnosticMessage;
  required_env: string[];
  required_headers: string[];
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const SECRET_KEY =
  /(?:token|password|secret|api[-_]?key|authorization|credential)|^(?:key|auth|accesskey|signature|sig)$/i;
export const isMcpCredentialKey = (key: string) => SECRET_KEY.test(key.replace(/^-+/, ""));
const isMcpCredentialHeader = (name: string) =>
  isMcpCredentialKey(name) || /(?:^|[-_])(?:auth|key|cookies?)(?:$|[-_])/i.test(name);

type PrivateValueRecorder = (value: string) => void;

const MAX_PRIVATE_VALUES = 1024;
class McpRedactionLimitError extends Error {
  constructor(context: "migration preview" | "configuration") {
    super(
      `MCP ${context} exceeds the redaction complexity limit; simplify the configuration and preview again`,
    );
  }
}

/** One preview shares these limits across files and both sides of every change. */
export class McpRedactionBudget {
  #remainingValues = MAX_PRIVATE_VALUES;
  // Count UTF-16 code units, including repeated work on derived suffixes.
  #remainingScan = 8 * 1024 * 1024;
  #remainingReplacement = 32 * 1024 * 1024;
  #remainingOutput = 8 * 1024 * 1024;

  constructor(readonly context: "migration preview" | "configuration" = "migration preview") {}

  derive(): void {
    if (--this.#remainingValues < 0) throw new McpRedactionLimitError(this.context);
  }
  scan(text: string): void {
    if ((this.#remainingScan -= text.length) < 0) throw new McpRedactionLimitError(this.context);
  }
  replace(text: string, secret: string): void {
    if ((this.#remainingReplacement -= text.length + secret.length) < 0)
      throw new McpRedactionLimitError(this.context);
  }
  output(length: number): void {
    if ((this.#remainingOutput -= length) < 0) throw new McpRedactionLimitError(this.context);
  }
  checkSecretCount(count: number): void {
    if (count > MAX_PRIVATE_VALUES) throw new McpRedactionLimitError(this.context);
  }
}

function redactMcpHeaders(value: string, record?: PrivateValueRecorder): string {
  // A whole argv header can contain spaces, cookies, and quoted Digest parameters.
  // Shell fragments instead need their surrounding quote boundaries preserved.
  const argument =
    /^([ \t]*(?:(?:--header(?:=|[ \t]+)|-H)[ \t]*)?)([A-Za-z][\w-]*)([ \t]*:[ \t]*)/.exec(value);
  if (argument && isMcpCredentialHeader(argument[2]!) && value.slice(argument[0].length).trim()) {
    record?.(value.slice(argument[0].length));
    return argument[0] + "[redacted]";
  }
  return value
    .replace(
      /(["'])([A-Za-z][\w-]*)([ \t]*:[ \t]*)((?:\\[\s\S]|(?!\1)[^\\])*)\\?(?:\1|$)/g,
      (match: string, quote: string, name: string, separator: string, contents: string) => {
        if (!isMcpCredentialHeader(name) || !contents.trim()) return match;
        record?.(contents);
        return quote + name + separator + "[redacted]" + (match.endsWith(quote) ? quote : "");
      },
    )
    .replace(
      /(^|[\s=])(-H)?([A-Za-z][\w-]*)([ \t]*:[ \t]*)((?:\\[\s\S]|[^\s"';&|\\])*)/g,
      (
        match: string,
        prefix: string,
        flag: string | undefined,
        name: string,
        separator: string,
        contents: string,
      ) => {
        if (!isMcpCredentialHeader(name) || !contents) return match;
        record?.(contents);
        return prefix + (flag ?? "") + name + separator + "[redacted]";
      },
    );
}

/** Also handles URLs embedded in stdio arguments and shell fragments. */
export function redactMcpText(
  value: string,
  secrets: readonly string[] = [],
  budget = new McpRedactionBudget("configuration"),
): string {
  return scrubMcpText(value, secrets, undefined, budget);
}

/** Use the redactor's evidence to hide the same credential elsewhere in a preview. */
export function mcpTextPrivateValues(value: string, budget = new McpRedactionBudget()): string[] {
  const values = new Set<string>(),
    pending = [value];
  const record = (found: string) => {
    // Charge before allocating literal variants, including values found inside URLs.
    budget.scan(found);
    const trimmed = found.trim();
    // Also recognize a repeated shell literal, without assuming that the source
    // is shell code: the display still hides the full original argv value.
    const shellLiteral =
      /^(?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\(?:[\s\S]|$)|[^\s"'\\;&|])+/.exec(
        trimmed,
      )?.[0];
    // Shell words can concatenate quoted and bare pieces. Preserve both the
    // written expression and its static literal value; never evaluate expansion.
    const unquote = (text: string, decode: boolean) =>
      text.replace(
        /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/g,
        (
          match,
          single: string | undefined,
          double: string | undefined,
          escaped: string | undefined,
        ) => {
          if (single !== undefined) return single;
          if (double !== undefined)
            return decode
              ? double.replace(
                  /\\(["\\$`])|\\\r?\n/g,
                  (_match, char: string | undefined) => char ?? "",
                )
              : double;
          return decode ? (escaped === "\n" ? "" : escaped!) : match;
        },
      );
    const candidates = [found, trimmed, shellLiteral ?? ""].flatMap((text) => [
      text,
      unquote(text, false),
      unquote(text, true),
    ]);
    for (const candidate of candidates)
      if (candidate && !values.has(candidate)) {
        budget.derive();
        values.add(candidate);
        pending.push(candidate);
      }
  };
  // A header can contain a Bearer token or URL. Scan each newly identified value
  // as well, without recursion or a second set of credential recognition rules.
  for (let index = 0; index < pending.length; index++)
    scrubMcpText(pending[index]!, [], record, budget);
  return [...values];
}

/** Match original text only: generated markers cannot themselves become new matches. */
function redactPrivateLiterals(
  value: string,
  secrets: readonly string[],
  budget: McpRedactionBudget,
): string {
  const unique = new Set(secrets.filter(Boolean));
  budget.checkSecretCount(unique.size);
  if (!value || !unique.size) return value;
  const ends = new Uint32Array(value.length);
  for (const secret of unique) {
    budget.replace(value, secret);
    if (secret.length > value.length) continue;
    // KMP keeps repeated-prefix inputs linear in the charged input lengths,
    // including overlapping occurrences of the same secret.
    const prefix = new Uint32Array(secret.length);
    for (let index = 1, matched = 0; index < secret.length; index++) {
      while (matched && secret[index] !== secret[matched]) matched = prefix[matched - 1]!;
      if (secret[index] === secret[matched]) matched++;
      prefix[index] = matched;
    }
    for (let index = 0, matched = 0; index < value.length; index++) {
      while (matched && value[index] !== secret[matched]) matched = prefix[matched - 1]!;
      if (value[index] === secret[matched]) matched++;
      if (matched === secret.length) {
        const start = index + 1 - matched;
        ends[start] = Math.max(ends[start]!, index + 1);
        matched = prefix[matched - 1]!;
      }
    }
  }
  const pieces: string[] = [];
  let plain = 0;
  for (let index = 0; index < value.length; index++) {
    if (!ends[index]) continue;
    let end = ends[index]!;
    for (let next = index + 1; next <= end && next < value.length; next++)
      end = Math.max(end, ends[next]!);
    budget.output(index - plain + "[redacted]".length);
    pieces.push(value.slice(plain, index), "[redacted]");
    plain = end;
    index = end - 1;
  }
  if (!pieces.length) return value;
  budget.output(value.length - plain);
  pieces.push(value.slice(plain));
  return pieces.join("");
}

function scrubMcpText(
  value: string,
  secrets: readonly string[],
  record: PrivateValueRecorder | undefined,
  budget: McpRedactionBudget,
): string {
  budget.scan(value);
  const text = redactPrivateLiterals(value, secrets, budget);
  if (text !== value) budget.scan(text);
  return redactMcpHeaders(text, record)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (source) => {
      try {
        const url = new URL(source);
        let changed = false;
        for (const field of ["username", "password"] as const)
          if (url[field]) {
            record?.(url[field]);
            if (record) {
              try {
                record(decodeURIComponent(url[field]));
              } catch (error) {
                if (error instanceof McpRedactionLimitError) throw error;
                // Invalid escapes are still protected in their original form.
              }
            }
            url[field] = "[redacted]";
            changed = true;
          }
        for (const key of url.searchParams.keys())
          if (isMcpCredentialKey(key)) {
            for (const item of url.searchParams.getAll(key)) record?.(item);
            url.searchParams.set(key, "[redacted]");
            changed = true;
          }
        return changed ? url.toString() : source;
      } catch (error) {
        if (error instanceof McpRedactionLimitError) throw error;
        // Keep ordinary command text; malformed URL userinfo is still private.
        return source.replace(
          /^(https?:\/\/)([^/]*)@/i,
          (_match, prefix: string, userinfo: string) => {
            for (const item of userinfo.split(":")) record?.(item);
            return `${prefix}[redacted]@`;
          },
        );
      }
    })
    .replace(
      /((?:token|password|secret|api[-_]?key|authorization|credential)=)((?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\(?:[\s\S]|$)|[^\s"'\\])+)/gi,
      (_match, prefix: string, privateValue: string) => {
        record?.(privateValue);
        return `${prefix}[redacted]`;
      },
    )
    .replace(
      /(^|[?&\s-])((?:key|auth|accesskey|signature|sig)=)((?:"(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\(?:[\s\S]|$)|[^\s"'\\&])+)/gi,
      (_match, prefix: string, key: string, privateValue: string) => {
        record?.(privateValue);
        return `${prefix}${key}[redacted]`;
      },
    )
    .replace(
      /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)/gi,
      (_match, scheme: string, privateValue: string) => {
        record?.(privateValue);
        return `${scheme} [redacted]`;
      },
    )
    .replace(
      /(^|[^A-Za-z0-9_-])((?:sk-|ghp_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{12,})/gi,
      (_match, prefix: string, privateValue: string) => {
        record?.(privateValue);
        return `${prefix}[redacted]`;
      },
    );
}

/** Never put inline credentials into the renderer's searchable/copyable public document. */
export function publicMcpConfig(server: McpServer): McpServer {
  const result = structuredClone(server);
  const budget = new McpRedactionBudget("configuration");
  const secrets = [...Object.values(server.env), ...Object.values(server.headers)].filter(Boolean);
  const mask = (value: string) => redactMcpText(value, secrets, budget);
  result.env = {};
  result.headers = {};
  delete result.oauth_credentials;
  delete result.native_source;
  delete result.local_values_only;
  delete result.deleted_env;
  delete result.deleted_headers;
  delete result.clear_oauth;
  if (result.transport !== "stdio") {
    try {
      const url = new URL(result.url);
      let changed = false;
      if (url.username) {
        url.username = "[redacted]";
        changed = true;
      }
      if (url.password) {
        url.password = "[redacted]";
        changed = true;
      }
      for (const key of url.searchParams.keys())
        if (isMcpCredentialKey(key)) {
          url.searchParams.set(key, "[redacted]");
          changed = true;
        }
      result.url = mask(changed ? url.toString() : result.url);
    } catch (error) {
      if (error instanceof McpRedactionLimitError) throw error;
      result.url = "[invalid URL]";
    }
  } else {
    result.command = mask(result.command);
    result.args = result.args.map((value, index, args) => {
      if (index > 0 && isMcpCredentialKey(args[index - 1]!) && args[index - 1]!.startsWith("-"))
        return "[redacted]";
      return mask(value);
    });
    if (result.cwd) result.cwd = mask(result.cwd);
  }
  return result;
}

/** Public redaction is intentionally broader than evidence of an inline credential. */
export function hasInlineMcpCredentials(server: McpServer): boolean {
  const connection = (config: McpServer): string[] =>
    config.transport === "stdio"
      ? [config.command, ...config.args, config.cwd ?? ""]
      : [config.url];
  const text = connection(server),
    syntaxOnly = connection(publicMcpConfig({ ...server, env: {}, headers: {} }));
  if (text.some((value, index) => value !== syntaxOnly[index])) return true;
  for (const kind of ["env", "headers"] as const)
    for (const [key, value] of Object.entries(server[kind])) {
      if (!value) continue;
      const credential =
        (kind === "env" ? isMcpCredentialKey(key) : isMcpCredentialHeader(key)) ||
        redactMcpText(value) !== value;
      // Recognized ordinary settings can legitimately repeat as arguments. Keep
      // this semantic exception narrow; an arbitrary value under DEBUG/NODE_ENV
      // or Content-Type still receives the unknown-private-value protection below.
      if (
        !credential &&
        (kind === "env"
          ? (key === "DEBUG" && /^(?:0|1|true|false)$/i.test(value)) ||
            (key === "NODE_ENV" && /^(?:development|production|test)$/.test(value)) ||
            (key === "PORT" && /^\d{1,5}$/.test(value) && Number(value) <= 65535)
          : key.toLowerCase() === "content-type" &&
            /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/i.test(value))
      )
        continue;
      if (
        text.some((field) => {
          if (redactMcpText(field, [value]) === field) return false;
          if (credential) return true;
          // Unknown names can also hold secrets: reject complete repeated argv,
          // assignment, URL or path units, but not incidental substrings such as
          // a setting of "1" in "server@1.0.0". Sensitive keys have no such exemption.
          for (
            let index = field.indexOf(value);
            index >= 0;
            index = field.indexOf(value, index + 1)
          ) {
            const before = field[index - 1],
              after = field[index + value.length],
              part = /[\p{L}\p{N}_.~+%-]/u;
            if ((!before || !part.test(before)) && (!after || !part.test(after))) return true;
          }
          return false;
        })
      )
        return true;
    }
  return false;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const map = object(value);
  if (!map || Object.values(map).some((item) => typeof item !== "string"))
    throw new McpDiagnosticError(`${name} must contain string values`, "string_map", {
      field: name,
    });
  if (Object.keys(map).some((key) => !key || /[\0\r\n]/.test(key)))
    throw new McpDiagnosticError(`${name} contains an invalid key`, "map_key", { field: name });
  return map as Record<string, string>;
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new McpDiagnosticError(`${name} must be a string list`, "string_list", { field: name });
  return value;
}
function known(raw: Record<string, unknown>, keys: string[]) {
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key));
  if (unknown.length)
    throw new McpDiagnosticError(
      `Unsupported MCP fields: ${unknown.join(", ")}`,
      "unsupported_fields",
    );
}

function hasSubstitution(value: unknown, pattern: RegExp, includeKeys = false): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value))
    return value.some((item) => hasSubstitution(item, pattern, includeKeys));
  const map = object(value);
  return (
    !!map &&
    Object.entries(map).some(
      ([key, item]) =>
        (includeKeys && pattern.test(key)) || hasSubstitution(item, pattern, includeKeys),
    )
  );
}

function rejectOpenCodeSubstitutions(value: unknown): void {
  if (hasSubstitution(value, /\{(?:env|file):[^}]+\}/, true))
    throw new McpDiagnosticError(
      "OpenCode env/file substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "OpenCode" },
    );
}

function rejectClaudeSubstitutions(raw: Record<string, unknown>): void {
  const fields = [raw.command, raw.args, raw.env, raw.url, raw.headers];
  if (hasSubstitution(fields, /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/))
    throw new McpDiagnosticError(
      "Claude Code environment substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "Claude Code" },
    );
}

function rejectCursorSubstitutions(raw: Record<string, unknown>): void {
  const fields = [raw.command, raw.args, raw.cwd, raw.env, raw.url, raw.headers];
  if (
    hasSubstitution(
      fields,
      /\$\{(?:env:[^}]+|userHome|workspaceFolder|workspaceFolderBasename|pathSeparator|\/)\}/,
    )
  )
    throw new McpDiagnosticError(
      "Cursor environment/context substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "Cursor" },
    );
}

export function normalizeMcpImport(
  name: string,
  value: unknown,
  agent?: Agent,
  native = false,
): McpServer {
  const raw = object(value);
  if (!raw) throw new McpDiagnosticError("MCP entry must be an object", "entry_object");
  // OpenCode expands these before parsing, including nested values and map keys.
  // Hub cannot retain that runtime context or the source-relative file lookup.
  if (agent === "opencode") rejectOpenCodeSubstitutions([name, raw]);
  if (agent === "claude-code") rejectClaudeSubstitutions(raw);
  if (agent === "cursor") rejectCursorSubstitutions(raw);
  if (agent === "hermes" && hasSubstitution(raw, /\$\{[^}]+\}/))
    throw new McpDiagnosticError(
      "Hermes environment/context substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "Hermes" },
    );
  // Devin expands `${env:VAR}` and `${file:/path}` when it starts a server.
  if (agent === "devin" && hasSubstitution(raw, /\$\{(?:env|file):[^}]+\}/))
    throw new McpDiagnosticError(
      "Devin environment/file substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "Devin" },
    );
  // Escaped OpenClaw references also change at runtime: $${VAR} becomes ${VAR}.
  if (agent === "open-claw" && hasSubstitution(raw, /\$\{[A-Z_][A-Z0-9_]*(?::-[^${}]*)?\}/))
    throw new McpDiagnosticError(
      "OpenClaw environment substitutions cannot be collected; use literal configuration and enter credentials separately",
      "native_substitution",
      { agent: "OpenClaw" },
    );
  let normalized: Record<string, unknown>;
  if (typeof raw.id === "string" && typeof raw.transport === "string") {
    known(raw, [
      "id",
      "name",
      "transport",
      "command",
      "args",
      "cwd",
      "url",
      "enabled",
      "env",
      "headers",
      "targets",
      "allow_tools",
      "lan_allow_tools",
      "supports_parallel_tool_calls",
      "package",
      "required_env",
      "required_headers",
    ]);
    normalized = { ...raw };
    if (
      raw.transport === "stdio"
        ? raw.url !== undefined
        : raw.command !== undefined || raw.args !== undefined || raw.cwd !== undefined
    )
      throw new McpDiagnosticError("MCP entry mixes process and URL fields", "mixed_fields");
  } else if (raw.type === "local" || raw.type === "remote") {
    if (!agent) rejectOpenCodeSubstitutions([name, raw]);
    known(
      raw,
      raw.type === "local"
        ? ["type", "command", "environment", "enabled"]
        : ["type", "url", "headers", "enabled", "oauth"],
    );
    // Hub's HTTP transport attempts OAuth after a challenge. Dropping even
    // `false` would enable behavior the source explicitly disabled.
    if (raw.oauth !== undefined)
      throw new McpDiagnosticError(
        "Explicit OpenCode OAuth settings cannot be preserved during collection",
        "opencode_oauth",
      );
    if (raw.type === "local") {
      const parts = strings(raw.command, "command");
      if (!parts.length)
        throw new McpDiagnosticError("OpenCode local command is empty", "command_empty");
      normalized = {
        transport: "stdio",
        command: parts[0],
        args: parts.slice(1),
        env: stringMap(raw.environment, "environment"),
      };
    } else
      normalized = {
        transport: "streamable-http",
        url: raw.url,
        headers: stringMap(raw.headers, "headers"),
      };
  } else {
    known(raw, [
      "type",
      "transport",
      "url",
      "serverUrl",
      "command",
      "args",
      "cwd",
      "env",
      "headers",
      "http_headers",
      "enabled",
      "disabled",
      "enabled_tools",
      "enabledTools",
      "disabledTools",
    ]);
    for (const declaration of [raw.transport, raw.type])
      if (
        declaration !== undefined &&
        (typeof declaration !== "string" ||
          !["stdio", "http", "streamable-http"].includes(declaration))
      )
        throw new McpDiagnosticError(
          "SSE and unknown transports cannot be collected",
          "transport_unsupported",
        );
    const normalizedTransport = (value: unknown) => (value === "http" ? "streamable-http" : value);
    if (
      raw.transport !== undefined &&
      raw.type !== undefined &&
      normalizedTransport(raw.transport) !== normalizedTransport(raw.type)
    )
      throw new McpDiagnosticError(
        "Conflicting MCP transport declarations cannot be collected",
        "transport_conflict",
      );
    const transport = raw.transport ?? raw.type;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
      throw new McpDiagnosticError("enabled must be a boolean", "enabled_boolean");
    if (raw.disabled !== undefined && typeof raw.disabled !== "boolean")
      throw new McpDiagnosticError("disabled must be a boolean", "disabled_boolean");
    if (raw.url !== undefined && raw.serverUrl !== undefined)
      throw new McpDiagnosticError("Multiple MCP URLs are ambiguous", "ambiguous_urls");
    if (raw.headers !== undefined && raw.http_headers !== undefined)
      throw new McpDiagnosticError("Multiple header maps are ambiguous", "ambiguous_headers");
    if (raw.enabled_tools !== undefined && raw.enabledTools !== undefined)
      throw new McpDiagnosticError("Multiple tool lists are ambiguous", "ambiguous_tools");
    const disabled = strings(raw.disabledTools, "disabledTools");
    const allowList = raw.enabled_tools !== undefined ? raw.enabled_tools : raw.enabledTools;
    const allowed = strings(allowList, "enabled tools");
    if (disabled.length && !allowed.length)
      throw new McpDiagnosticError(
        "A tool deny list without a finite allow list cannot be represented",
        "tool_deny_list",
      );
    const tools = allowed.filter((tool) => !disabled.includes(tool));
    // A native explicit empty list means no tools; Hub's legacy [] means all.
    // Reject this conversion rather than broadening access on later enablement.
    if (allowList !== undefined && !tools.length)
      throw new McpDiagnosticError(
        "An empty effective native allow list needs an explicit Hub tool policy",
        "empty_tool_list",
      );
    const url = raw.url ?? raw.serverUrl;
    if (url !== undefined && transport === "stdio")
      throw new McpDiagnosticError("Declared stdio transport conflicts with MCP URL", "stdio_url");
    if (
      url !== undefined &&
      (raw.command !== undefined || raw.args !== undefined || raw.cwd !== undefined)
    )
      throw new McpDiagnosticError("MCP entry mixes process and URL fields", "mixed_fields");
    if (url === undefined && (transport === "http" || transport === "streamable-http"))
      throw new McpDiagnosticError("MCP URL is missing", "url_missing");
    normalized = {
      ...(url !== undefined
        ? { transport: "streamable-http", url }
        : {
            transport: "stdio",
            command: raw.command,
            args: strings(raw.args, "args"),
            ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
          }),
      env: stringMap(raw.env, "env"),
      headers: stringMap(raw.headers ?? raw.http_headers, "headers"),
      allow_tools: tools,
    };
  }
  const id =
    typeof normalized.id === "string"
      ? normalized.id
      : name
          .replace(/[^A-Za-z0-9_-]/g, "-")
          .toLowerCase()
          .replace(/^-+|-+$/g, "");
  const server = serverSchema.parse({
    ...normalized,
    id,
    name: normalized.name ?? name,
    enabled: false,
    ...(agent ? { targets: [agent] } : {}),
  });
  if (!/^[A-Za-z0-9_-]+$/.test(server.id) || !server.name.trim())
    throw new McpDiagnosticError("MCP server needs a nonempty valid ID and name", "invalid_id");
  if (server.transport === "sse")
    throw new McpDiagnosticError("SSE cannot be collected", "transport_unsupported");
  if (server.transport === "stdio") {
    if (!server.command.trim())
      throw new McpDiagnosticError("MCP command is empty", "command_empty");
  } else {
    const url = new URL(server.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new McpDiagnosticError("MCP URL must use HTTP or HTTPS", "url_protocol");
  }
  if (hasInlineMcpCredentials(server))
    throw new McpDiagnosticError(
      "Inline credentials must be moved to env or headers before collection",
      "inline_credentials",
    );
  server.required_env = [...new Set([...(server.required_env ?? []), ...Object.keys(server.env)])];
  server.required_headers = [
    ...new Set([...(server.required_headers ?? []), ...Object.keys(server.headers)]),
  ];
  if (native) {
    server.env = {};
    server.headers = {};
  }
  return server;
}

export function parseMcpImport(text: string): ParsedMcpImport[] {
  if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024)
    throw new McpDiagnosticError("MCP import must contain at most 1 MiB", "import_size");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseToml(text);
    } catch {
      throw new McpDiagnosticError("Paste valid MCP JSON or TOML", "import_syntax");
    }
  }
  const root = object(parsed);
  if (!root) throw new McpDiagnosticError("MCP import must be an object", "import_object");
  let entries: [string, unknown][];
  if ("mcpServers" in root || "mcp_servers" in root || "mcp" in root) {
    const wrapper = ["mcpServers", "mcp_servers", "mcp"].filter((key) => key in root);
    if (wrapper.length !== 1 || Object.keys(root).some((key) => key !== wrapper[0]))
      throw new McpDiagnosticError(
        "Paste only one MCP container without unrelated application settings",
        "import_container_only",
      );
    const servers = object(root[wrapper[0]!]);
    if (!servers)
      throw new McpDiagnosticError("MCP container must be an object", "import_container_object");
    entries = Object.entries(servers);
  } else if ("command" in root || "url" in root || "transport" in root || "type" in root)
    entries = [[typeof root.id === "string" ? root.id : "imported-server", root]];
  else entries = Object.entries(root);
  if (!entries.length || entries.length > 128)
    throw new McpDiagnosticError("Select between 1 and 128 MCP servers", "import_count");
  return entries.map(([name, value], index) => {
    try {
      if ("mcp" in root) rejectOpenCodeSubstitutions([name, value]);
      const raw = object(value);
      // mcpServers is shared by clients; ambiguous client expressions are not literals.
      // Explicit AgentKib entries and OpenCode's own branch retain their format semantics.
      if (
        "mcpServers" in root &&
        raw &&
        !(typeof raw.id === "string" && typeof raw.transport === "string") &&
        raw.type !== "local" &&
        raw.type !== "remote"
      ) {
        rejectClaudeSubstitutions(raw);
        rejectCursorSubstitutions(raw);
      }
      const server = normalizeMcpImport(name, value);
      return {
        key: String(index),
        server,
        required_env: server.required_env ?? [],
        required_headers: server.required_headers ?? [],
      };
    } catch (error) {
      // Parsing diagnostics contain field names, never the supplied private values.
      return {
        key: String(index),
        error_message: mcpErrorDiagnostic(error),
        error:
          error instanceof Error && !(error.name === "ZodError")
            ? error.message
            : "Invalid MCP entry",
        required_env: [],
        required_headers: [],
      };
    }
  });
}
