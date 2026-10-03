import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import type { BackendStore } from "./store";

const MAX_RECORD_BYTES = 256 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function workspaceIdentity(store: BackendStore, workspaceId: string): string {
  const workspace = (store.listWorkspaces() as Array<Record<string, unknown>>).find(
    (item) =>
      typeof item.id === "string" &&
      (item.id === workspaceId || item.manifest_workspace_id === workspaceId),
  );
  if (!workspace) throw new Error("Workspace does not exist");
  return typeof workspace.manifest_workspace_id === "string" && workspace.manifest_workspace_id
    ? workspace.manifest_workspace_id
    : String(workspace.id);
}

function safeDirectory(directory: string): void {
  let current = path.resolve(directory);
  const components: string[] = [];
  for (;;) {
    components.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components) {
    const metadata = lstatSync(component);
    if (!metadata.isDirectory() || isReparseOrSymlink(component, metadata))
      throw new Error("Native import directory is unsafe");
  }
}

function safeRecord(file: string): Buffer {
  let current = path.resolve(file);
  const components: string[] = [];
  for (;;) {
    components.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components.slice(0, -1)) {
    const metadata = lstatSync(component);
    if (!metadata.isDirectory() || isReparseOrSymlink(component, metadata))
      throw new Error("Native import record contains an unsafe directory");
  }
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata) || metadata.size > MAX_RECORD_BYTES)
    throw new Error("Native import record is not a bounded regular file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES)
      throw new Error("Native import record exceeds its read limit");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_RECORD_BYTES + 1 - total));
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      total += bytes;
      if (total > MAX_RECORD_BYTES) throw new Error("Native import record exceeds its read limit");
      chunks.push(chunk.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function targetIdentityValid(target: string, id: string): boolean {
  if (target === "opencode") return /^ses_[0-9a-f]{32}$/i.test(id);
  if (target === "cursor") return /^[0-9a-f-]{36}$/i.test(id);
  return UUID.test(id);
}

function receiptIdentityValid(target: string, plannedId: string, receiptId: string): boolean {
  if (target === "hermes") return /^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(receiptId);
  if (target === "cursor") return /^cursor-ide-v1-[0-9a-f]{64}$/.test(receiptId);
  return receiptId === plannedId && targetIdentityValid(target, receiptId);
}

/** Read persisted native-import receipts for the recovery panel; dispatch stays with its owner. */
export function listNativeImports(
  dataDir: string,
  store: BackendStore,
  requestedWorkspaceId: string,
) {
  const workspaceId = workspaceIdentity(store, requestedWorkspaceId);
  const workspaceHash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
  const root = path.join(dataDir, "continuations", workspaceHash);
  try {
    safeDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const operations = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 512)) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const directory = path.join(root, entry.name, "import");
    const planPath = path.join(directory, "plan.json");
    let plan: Record<string, unknown>;
    let planHash: string;
    try {
      const content = safeRecord(planPath);
      planHash = createHash("sha256").update(content).digest("hex");
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      plan = value as Record<string, unknown>;
      const target = plan.target_agent;
      if (
        plan.schema_version !== 1 ||
        plan.operation_id !== entry.name ||
        plan.workspace_id !== workspaceId ||
        typeof plan.source_session_id !== "string" ||
        !plan.source_session_id ||
        !["opencode", "open-claw", "hermes", "cursor"].includes(String(target)) ||
        !targetIdentityValid(String(target), String(plan.target_session_id ?? ""))
      )
        continue;
    } catch {
      continue;
    }
    let receipt: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          safeRecord(path.join(directory, "receipt.json")),
        ),
      );
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const candidate = value as Record<string, unknown>;
        if (
          candidate.schema_version === 1 &&
          candidate.plan_hash === planHash &&
          typeof candidate.target_session_id === "string" &&
          receiptIdentityValid(
            String(plan.target_agent),
            String(plan.target_session_id),
            candidate.target_session_id,
          )
        )
          receipt = candidate;
      }
    } catch {}
    const status = receipt?.launched
      ? "launched"
      : receipt?.verified
        ? "verified"
        : existsSync(path.join(directory, "attempted.json"))
          ? "outcome-unknown"
          : "prepared";
    operations.push({
      launch_request: {
        mode: "native-import",
        operation_id: plan.operation_id,
        workspace_id: workspaceId,
        target_agent: plan.target_agent,
        plan_hash: planHash,
        ...(plan.target_agent === "cursor" &&
        typeof (plan.context as Record<string, unknown> | undefined)?.binding_id === "string"
          ? { binding_id: (plan.context as Record<string, unknown>).binding_id }
          : {}),
      },
      source_session_id: plan.source_session_id,
      ...(receipt ? { target_session_id: receipt.target_session_id } : {}),
      status,
    });
  }
  return operations;
}
