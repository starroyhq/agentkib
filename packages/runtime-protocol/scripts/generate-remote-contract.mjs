import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkRemoteErrorRetry } from "./check-remote-error-retry.mjs";

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    base: { type: "string" },
    "dart-output": { type: "string" },
  },
});

const source = "packages/runtime-protocol/remote-contract.json";
const contract = JSON.parse(
  readFileSync(new URL("../remote-contract.json", import.meta.url), "utf8"),
);
const header = `// Generated from ${source} (contract v${contract.contractVersion}). Do not edit.\n`;
const tsPath = fileURLToPath(new URL("../src/generated/remote-contract.ts", import.meta.url));
const dartPath =
  values["dart-output"] ??
  fileURLToPath(new URL("../generated/remote_protocol.g.dart", import.meta.url));

const {
  versions,
  capabilities,
  conversationEvents,
  headers,
  controlOutcomes,
  routes,
  errorRetryPolicies,
  errors,
} = contract;
let previousErrors;
if (values.base !== undefined) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(values.base)) {
    throw new Error("--base must be a full Git commit hash.");
  }
  const previous = execFileSync("git", ["show", `${values.base}:${source}`], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });
  previousErrors = JSON.parse(previous).errors;
  if (!previousErrors) throw new Error("The base commit has no remote error contract.");
}
checkRemoteErrorRetry(errorRetryPolicies, errors, previousErrors);
const paths = Object.fromEntries(
  Object.entries(routes.entries).map(([key, { path }]) => [key, path]),
);
paths.receipt = routes.receipt.path;
paths.socket = routes.socket.path;

const routeSpecs = { GET: {}, POST: {} };
for (const { path, methods } of Object.values(routes.entries)) {
  for (const [method, spec] of Object.entries(methods)) routeSpecs[method][path] = spec;
}
const legacyCodex = {
  prefix: routes.legacyCodex.prefix,
  postOperations: routes.legacyCodex.postOperations,
  postTarget: paths[routes.legacyCodex.postTarget],
  nonControlPath: paths[routes.legacyCodex.nonControlPath],
  getAliases: Object.fromEntries(
    Object.entries(routes.legacyCodex.getAliases).map(([alias, target]) => [
      paths[alias],
      paths[target],
    ]),
  ),
};
const errorCodes = Object.fromEntries(Object.entries(errors).map(([key, { code }]) => [key, code]));

const constants = {
  REMOTE_CONTRACT_VERSION: contract.contractVersion,
  PROTOCOL_VERSION: versions.runtime.major,
  CONVERSATION_PROTOCOL_VERSION: versions.conversation.major,
  REMOTE_VERSIONS: versions,
  REMOTE_FEATURE_VERSIONS: versions.features,
  REMOTE_CAPABILITIES: capabilities,
  REMOTE_CONVERSATION_EVENTS: conversationEvents,
  REMOTE_HEADERS: headers,
  REMOTE_CONTROL_OUTCOMES: controlOutcomes,
  REMOTE_WORKER_REPORT_CONTRACT: contract.workerReport,
  REMOTE_WORKER_ROLE_CONTRACT: contract.workerRole,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT: contract.projectAgentAssignment,
  REMOTE_SENT_ATTACHMENT_CONTRACT: contract.sentAttachment,
  REMOTE_SESSION_QUESTION_CONTRACT: contract.sessionQuestion,
  REMOTE_READ_STATE_UPDATE_CONTRACT: contract.readStateUpdate,
  REMOTE_ROUTE_BASE: routes.basePath,
  REMOTE_ROUTE: paths,
  REMOTE_REQUEST_PATH: Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, path.slice(1)]),
  ),
  REMOTE_ROUTE_PREFIXES: routes.prefixes,
  REMOTE_ROUTE_SPECS: routeSpecs,
  REMOTE_LEGACY_CODEX: legacyCodex,
  REMOTE_MANAGED_ACTION_OPERATIONS: [
    ...routes.legacyCodex.postOperations,
    ...routes.managedActionAdditionalOperations,
  ],
  REMOTE_RECEIPT_ROUTE: routes.receipt,
  REMOTE_SOCKET_ROUTE: routes.socket,
  REMOTE_ERROR_CODES: errorCodes,
  REMOTE_ERROR_RETRY_POLICIES: errorRetryPolicies,
  REMOTE_ERROR_CONTRACT: errors,
};

const tsAnnotations = {
  REMOTE_MANAGED_ACTION_OPERATIONS: ": readonly string[]",
  REMOTE_ROUTE_SPECS:
    ': Readonly<Record<"GET" | "POST", Partial<Record<string, { lan?: true; control?: true }>>>>',
  REMOTE_LEGACY_CODEX:
    ": { prefix: string; postOperations: readonly string[]; postTarget: string; nonControlPath: string; getAliases: Partial<Record<string, string>> }",
};

function contractType(schema) {
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  switch (schema.type) {
    case "string":
    case "boolean":
    case "number":
      return schema.type;
    case "integer":
      return "number";
    case "array":
      return `Array<${contractType(schema.items)}>`;
    case "object": {
      if (schema.additionalProperties)
        return `Record<string, ${contractType(schema.additionalProperties)}>`;
      return `{\n${Object.entries(schema.properties)
        .map(([name, field]) => {
          const description = field.description ? `/** ${field.description} */\n` : "";
          return `${description}${name}${schema.required.includes(name) ? "" : "?"}: ${contractType(field)};`;
        })
        .join("\n")}\n}`;
    }
    default:
      throw new Error(`Unknown contract schema type: ${schema.type}`);
  }
}

const workerReportSchema = contract.workerReport.schema;
const tsTypes =
  Object.entries({
    ...workerReportSchema.$defs,
    WorkerReportView: workerReportSchema,
    WorkerRoleInput: contract.workerRole.input,
    WorkerRole: contract.workerRole.view,
    WorkerRoleChange: contract.workerRole.change,
    ...contract.sentAttachment.schema.$defs,
    SessionQuestionOption: contract.sessionQuestion.option,
    SessionQuestionReplyFields: contract.sessionQuestion.reply,
    ConversationReadStateMark: contract.readStateUpdate.properties.mark,
  })
    .map(([name, schema]) => `export type ${name} = ${contractType(schema)};\n`)
    .join("\n") +
  `\nexport type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];\n` +
  `export type RemoteErrorRetry = (typeof REMOTE_ERROR_RETRY_POLICIES)[number];\n`;
const tsBody = Object.entries(constants)
  .map(([key, value]) => {
    const annotation = tsAnnotations[key];
    return `export const ${key}${annotation ?? ""} = ${JSON.stringify(value, null, 2)}${annotation ? "" : " as const"};\n`;
  })
  .join("\n");
const formatter = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../../../node_modules/oxfmt/bin/oxfmt", import.meta.url)),
    `--stdin-filepath=${tsPath}`,
  ],
  {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    input: header + tsBody + "\n" + tsTypes,
    encoding: "utf8",
  },
);
if (formatter.error) throw formatter.error;
if (formatter.status !== 0) throw new Error(formatter.stderr || formatter.stdout);

function dartValue(value, depth = 1) {
  const indentation = "  ".repeat(depth);
  if (typeof value === "string") return JSON.stringify(value).replaceAll("$", "\\$");
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${indentation}${dartValue(item, depth + 1)},\n`).join("")}${indentation.slice(2)}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "<String, Object?>{}";
    return `{\n${entries.map(([key, entry]) => `${indentation}${dartValue(key)}: ${dartValue(entry, depth + 1)},\n`).join("")}${indentation.slice(2)}}`;
  }
  return JSON.stringify(value);
}

function dartName(name) {
  return name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

const dart = `${header}\nabstract final class AgentKibRemoteContract {\n${Object.entries(constants)
  .map(([key, value]) => `  static const ${dartName(key)} = ${dartValue(value, 2)};\n`)
  .join("\n")}}\n`;

for (const [path, output] of [
  [tsPath, formatter.stdout],
  [dartPath, dart],
]) {
  if (values.check) {
    if (readFileSync(path, "utf8") !== output) {
      console.error(
        `${path} is stale. Run node packages/runtime-protocol/scripts/generate-remote-contract.mjs.`,
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(path, output);
  }
}
