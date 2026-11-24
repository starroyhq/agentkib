import type { LiveSessionAgent } from "@agentkib/runtime-protocol";
import type { InteractionRiskInput } from "./interaction-risk";

type RecordValue = Record<string, unknown>;
type InteractionEvidence = {
  summary?: string;
  toolName?: string;
  command?: string | string[];
  cwd?: string;
  parameters?: unknown;
  riskInput: InteractionRiskInput;
  policyRiskInput?: InteractionRiskInput;
};

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown, maxBytes = 16 * 1024): string | undefined {
  return typeof value === "string" &&
    value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

function onlyKeys(record: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function pathValue(value: unknown): string | undefined {
  const path = text(value, 4096);
  return path?.includes("[REDACTED") ? undefined : path;
}

function changesRisk(value: unknown): InteractionRiskInput {
  if (!Array.isArray(value) || !value.length || value.length > 100) return { kind: "unknown" };
  const paths: string[] = [];
  let removes = false;
  for (const change of value) {
    const file = record(change);
    const kind = record(file?.kind);
    const path = pathValue(file?.path);
    if (
      !file ||
      !onlyKeys(file, ["path", "kind", "diff"]) ||
      !kind ||
      !onlyKeys(kind, ["type", "movePath"]) ||
      !path ||
      !["add", "update", "delete"].includes(String(kind.type))
    )
      return { kind: "unknown" };
    paths.push(path);
    if (kind.type === "delete") removes = true;
    if (kind.movePath != null) {
      const destination = pathValue(kind.movePath);
      if (!destination) return { kind: "unknown" };
      paths.push(destination);
      removes = true;
    }
  }
  return { kind: removes ? "delete" : "write", paths };
}

function codexApproval(value: RecordValue): InteractionEvidence {
  const context = record(value.requestContext);
  const command = text(value.command);
  const cwd = pathValue(value.cwd ?? context?.cwd);
  const network =
    context?.networkApprovalContext != null ||
    context?.proposedNetworkPolicyAmendments != null ||
    value.presentation === "network";
  const permissions =
    context?.additionalPermissions != null ||
    context?.permissions != null ||
    context?.grantRoot != null;
  const proposedRule = context?.proposedExecpolicyAmendment ?? value.proposedExecpolicyAmendment;
  let riskInput: InteractionRiskInput = { kind: "unknown" };
  if (network) riskInput = { kind: "network" };
  else if (!permissions && (value.environmentId == null || value.environmentId === "local")) {
    if (value.method === "item/fileChange/requestApproval") riskInput = changesRisk(value.changes);
    else if (value.method === "item/commandExecution/requestApproval" && command)
      riskInput = { kind: "command", command };
  }
  let parameters = value.input;
  if (value.changes != null)
    parameters = { changes: value.changes, ...(permissions ? { requestContext: context } : {}) };
  else if (network || permissions) parameters ??= context;
  else if (proposedRule != null) parameters ??= { proposedExecpolicyAmendment: proposedRule };
  return {
    summary:
      text(value.agentDescription) ?? text(context?.reason) ?? text(record(value.input)?.message),
    toolName: text(value.toolName, 512),
    command,
    cwd,
    parameters,
    riskInput: { ...riskInput, cwd },
    ...(proposedRule != null
      ? {
          policyRiskInput:
            Array.isArray(proposedRule) && proposedRule.every((part) => typeof part === "string")
              ? { kind: "command", command: proposedRule, cwd }
              : { kind: "unknown" },
        }
      : {}),
  };
}

const CLAUDE_FILE_TOOLS = {
  Read: { kind: "read", keys: ["file_path", "offset", "limit", "pages"] },
  Write: { kind: "write", keys: ["file_path", "content"] },
  Edit: { kind: "write", keys: ["file_path", "old_string", "new_string", "replace_all"] },
  NotebookEdit: {
    kind: "write",
    keys: ["notebook_path", "cell_id", "cell_type", "new_source", "edit_mode"],
  },
} as const;

function nativeToolRisk(
  agent: "claude-code" | "deepseek-harness",
  tool: string | undefined,
  input: RecordValue | undefined,
  command: string | undefined,
): InteractionRiskInput {
  if (!tool || !input) return { kind: "unknown" };
  if (agent === "claude-code") {
    if (tool === "WebFetch" || tool === "WebSearch") return { kind: "network" };
    if (tool === "Bash") {
      return command &&
        (input.dangerouslyDisableSandbox === undefined ||
          input.dangerouslyDisableSandbox === false) &&
        onlyKeys(input, [
          "command",
          "description",
          "timeout",
          "run_in_background",
          "dangerouslyDisableSandbox",
        ])
        ? { kind: "command", command }
        : { kind: "unknown" };
    }
    if (!Object.hasOwn(CLAUDE_FILE_TOOLS, tool)) return { kind: "unknown" };
    const info = CLAUDE_FILE_TOOLS[tool as keyof typeof CLAUDE_FILE_TOOLS];
    const path = pathValue(tool === "NotebookEdit" ? input.notebook_path : input.file_path);
    return path && onlyKeys(input, info.keys)
      ? { kind: info.kind, paths: [path] }
      : { kind: "unknown" };
  }
  if (tool === "web_fetch" || tool === "web_search") return { kind: "network" };
  if (tool === "delete_file" || tool === "move_file") return { kind: "delete" };
  if (tool === "bash" && command && onlyKeys(input, ["command", "description", "timeout", "cwd"]))
    return { kind: "command", command };
  const path = pathValue(input.path);
  if (tool === "read_file" && path && onlyKeys(input, ["path", "offset", "limit", "cwd"]))
    return { kind: "read", paths: [path] };
  if (tool === "write_file" && path && onlyKeys(input, ["path", "content", "cwd"]))
    return { kind: "write", paths: [path] };
  return { kind: "unknown" };
}

function nativeToolApproval(
  agent: "claude-code" | "deepseek-harness",
  value: RecordValue,
): InteractionEvidence {
  const input = record(value.input);
  const context = record(value.context);
  const toolName = text(value.toolName, 512);
  const command = text(input?.command);
  const cwd = pathValue(value.cwd ?? input?.cwd);
  const blockedPath = pathValue(context?.blockedPath);
  const risk =
    context?.blockedPath != null && !blockedPath
      ? { kind: "unknown" as const }
      : nativeToolRisk(agent, toolName, input, command);
  return {
    summary:
      text(record(value.command)?.reason) ??
      text(input?.description) ??
      text(context?.decisionReason) ??
      text(context?.description),
    toolName,
    command,
    cwd,
    parameters: value.input,
    riskInput: {
      ...risk,
      cwd,
      ...(blockedPath ? { paths: [...(risk.paths ?? []), blockedPath] } : {}),
    },
  };
}

function acpPathRisk(call: RecordValue, input: RecordValue | undefined): InteractionRiskInput {
  const reading = call.kind === "read";
  if (!reading && call.kind !== "edit") return { kind: "unknown" };
  const paths: string[] = [];
  if (input) {
    const permitted = ["path", "filePath", "cwd", "workingDirectory"];
    if (!reading) permitted.push("oldText", "newText");
    if (!onlyKeys(input, permitted)) return { kind: "unknown" };
    const rawPaths = [input.path, input.filePath].filter((path) => path !== undefined);
    const found = rawPaths.map(pathValue);
    if (!found.length || found.some((path) => path === undefined)) return { kind: "unknown" };
    for (const path of found) paths.push(path!);
  }
  if (call.content != null) {
    if (reading || !Array.isArray(call.content)) return { kind: "unknown" };
    for (const entry of call.content) {
      const change = record(entry);
      const path = pathValue(change?.path);
      if (!change || change.type !== "diff" || !path || typeof change.newText !== "string")
        return { kind: "unknown" };
      paths.push(path);
    }
  }
  if (!paths.length) return { kind: "unknown" };
  if (call.locations != null) {
    if (!Array.isArray(call.locations)) return { kind: "unknown" };
    for (const entry of call.locations) {
      const path = pathValue(record(entry)?.path);
      if (!path) return { kind: "unknown" };
      paths.push(path);
    }
  }
  return { kind: reading ? "read" : "write", paths: [...new Set(paths)] };
}

function acpApproval(value: RecordValue): InteractionEvidence {
  const call = record(value.toolCall) ?? {};
  const input = record(call.rawInput);
  const command = text(input?.command ?? input?.cmd ?? input?.script);
  const cwd = pathValue(input?.cwd ?? input?.workingDirectory ?? value.cwd);
  const toolName = text(call.name, 512);
  const mcp =
    value.presentation === "mcp" || toolName === "call_mcp_tool" || toolName?.startsWith("mcp_");
  let riskInput: InteractionRiskInput = { kind: "unknown" };
  if (!mcp && (call.kind === "delete" || call.kind === "move")) riskInput = { kind: "delete" };
  else if (!mcp && call.kind === "fetch") riskInput = { kind: "network" };
  else if (
    !mcp &&
    !(input?.cwd != null && input.workingDirectory != null && input.cwd !== input.workingDirectory)
  ) {
    if (
      ["execute", "command", "terminal", "shell"].includes(String(call.kind)) &&
      command &&
      input &&
      call.content == null &&
      call.locations == null &&
      ["command", "cmd", "script"].filter((key) => input[key] !== undefined).length === 1 &&
      onlyKeys(input, ["command", "cmd", "script", "cwd", "workingDirectory"])
    )
      riskInput = { kind: "command", command };
    else if (input || call.rawInput == null) riskInput = acpPathRisk(call, input);
  }
  return {
    summary: text(value.agentDescription),
    toolName,
    command,
    cwd,
    parameters:
      call.content != null || call.locations != null
        ? { input: call.rawInput, content: call.content, locations: call.locations }
        : call.rawInput,
    riskInput: { ...riskInput, cwd },
  };
}

/** Read the provider's public native evidence. Agent prose is never used for classification. */
export function interactionEvidence(
  agent: LiveSessionAgent,
  kind: "approval" | "question",
  value: RecordValue,
): InteractionEvidence {
  if (kind === "question") {
    const questions = Array.isArray(value.questions) ? value.questions : [];
    return {
      summary: text(value.agentDescription) ?? text(record(questions[0])?.question),
      parameters: questions,
      riskInput: { kind: value.permissionIntent === true ? "unknown" : "question" },
    };
  }
  if (agent === "codex") return codexApproval(value);
  if (agent === "claude-code" || agent === "deepseek-harness")
    return nativeToolApproval(agent, value);
  return acpApproval(value);
}
