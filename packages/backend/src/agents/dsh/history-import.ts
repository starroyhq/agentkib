import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { changeSet as changeSetSchema } from "../../change-apply";
import type { ChangeSet } from "../../change-plan";
import { applyRequest } from "../../changes";
import { hash } from "../../doctor-files";
import {
  fingerprintHandoff,
  handoffCheckpoint,
  handoffCommit,
  serializeHandoff,
} from "../../handoff-work";
import { acquirePortableFileLease } from "../../managed-session-lock";
import { pathIdentity } from "../../paths";
import { sessionDocument, type DocumentOptions, type SessionDocument } from "../../session-model";
import {
  atomicPrivateWrite,
  createPrivateFile,
  ensureInside,
  importDirectory,
  NativeImportOutcomeUnknownError,
  safeRegularFile,
} from "../../session-native-import-owner";
import type { BackendStore } from "../../store";
import {
  assertContinuationWorkspaceIdentity,
  requireUniqueContinuationWorkspace,
} from "../../workspace-identity";

const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const MAX_PLAN_BYTES = MAX_DOCUMENT_BYTES + 16 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TURNS = 25_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z.strictObject({
  runtimeId: z.uuid(),
  workspaceId: z.string().min(1).max(256),
});
export type DshHistoryImportContext = z.infer<typeof contextSchema>;

export interface DshHistoryImportBridge {
  historyImportContext(cwd: string): Promise<DshHistoryImportContext>;
  importHistory(value: {
    context: DshHistoryImportContext;
    workspaceId: string;
    cwd: string;
    nativeId: string;
    document: SessionDocument;
    verifyOnly: boolean;
    beforeDispatch?: () => void;
  }): Promise<{ sessionId: string }>;
}

const requestSchema = z.strictObject({
  mode: z.literal("native-import"),
  target_agent: z.literal("deepseek-harness"),
  workspace_id: z.string().min(1).max(256),
  operation_id: z.uuid(),
  plan_hash: fingerprintSchema,
});
const planSchema = z.strictObject({
  schema_version: z.literal(1),
  operation_id: z.uuid(),
  target_agent: z.literal("deepseek-harness"),
  target_session_id: z.uuid(),
  workspace_id: z.string().min(1).max(256),
  workspace: z.string().min(1).max(4096),
  source_session_id: z.string().min(1).max(256),
  source_fingerprint: fingerprintSchema,
  include_pre_compaction_history: z.boolean(),
  context: contextSchema,
  document: sessionDocument,
});
const attemptSchema = z.strictObject({ plan_hash: fingerprintSchema });
const receiptSchema = z.strictObject({
  schema_version: z.literal(1),
  plan_hash: fingerprintSchema,
  target_session_id: z.uuid(),
  session_id: z.string().min(1).max(256),
  verified: z.literal(true),
  launched: z.literal(true),
});

export function prepareDshHistoryDocument(source: SessionDocument): SessionDocument {
  if (source.turns.length > MAX_TURNS) throw new Error("dsh-native-import-too-large");
  const hasMessage = source.turns.some(
    (turn) =>
      turn.role !== "tool" &&
      turn.blocks.some((block) => block.type === "text" && block.text.trim()),
  );
  const document = structuredClone(source);
  let tools = 0;
  let omitted = 0;
  let images = 0;
  for (const turn of document.turns) {
    turn.blocks = turn.blocks.map((block) => {
      if (
        block.type === "tool-call" ||
        block.type === "tool-result" ||
        (turn.role === "tool" && block.type === "text")
      )
        tools++;
      if (block.type !== "attachment") return block;
      if (
        turn.role === "user" &&
        block.kind === "image" &&
        IMAGE_TYPES.has(block.media_type) &&
        block.inline_base64 &&
        block.inline_base64.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      ) {
        const bytes = Buffer.from(block.inline_base64, "base64");
        if (
          bytes.length <= MAX_IMAGE_BYTES &&
          bytes.length > 0 &&
          bytes.toString("base64") === block.inline_base64
        ) {
          images++;
          return block;
        }
      }
      omitted++;
      return {
        type: "text",
        text: "[Historical attachment unavailable: " + (block.filename || block.media_type) + "]",
      };
    });
  }
  for (const [code, count] of [
    ["target-tool-summary", tools],
    ["target-attachment-omitted", omitted],
  ] as const) {
    if (!count) continue;
    const previous = document.losses.find((loss) => loss.code === code);
    if (previous) previous.count += count;
    else document.losses.push({ code, count });
  }
  if (!hasMessage && !images) throw new Error("dsh-native-import-empty");
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES)
    throw new Error("dsh-native-import-too-large");
  return document;
}

export function dshImportFingerprint(context: DshHistoryImportContext): string {
  return hash(JSON.stringify(contextSchema.parse(context)));
}

export async function planDshHistoryImport(input: {
  bridge: Partial<Pick<DshHistoryImportBridge, "historyImportContext">> | undefined;
  dataDir: string;
  workspace: string;
  workspaceId: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  targetFingerprint: string | undefined;
  document: SessionDocument;
  includePreCompactionHistory: boolean;
  acceptLosses: boolean;
}): Promise<{ change_set: ChangeSet; launch_request: Record<string, unknown> }> {
  if (!input.bridge?.historyImportContext) throw new Error("dsh-runtime-offline");
  const context = await input.bridge.historyImportContext(input.workspace);
  if (dshImportFingerprint(context) !== input.targetFingerprint)
    throw new Error("Target import settings changed after preview");
  const document = prepareDshHistoryDocument(input.document);
  if (document.losses.some(({ code }) => code !== "reasoning-excluded") && !input.acceptLosses)
    throw new Error("Continuation losses must be acknowledged");
  const operation = randomUUID();
  const plan = planSchema.parse({
    schema_version: 1,
    operation_id: operation,
    target_agent: "deepseek-harness",
    target_session_id: operation,
    workspace_id: input.workspaceId,
    workspace: input.workspace,
    source_session_id: input.sourceSessionId,
    source_fingerprint: input.sourceFingerprint,
    include_pre_compaction_history: input.includePreCompactionHistory,
    context,
    document,
  });
  const { content, hash: planHash } = await serializeHandoff(plan, false, false);
  const target = path.join(
    importDirectory(input.dataDir, input.workspaceId, operation),
    "plan.json",
  );
  ensureInside(input.dataDir, target);
  return {
    change_set: {
      id: operation,
      project_root: input.workspace,
      created_at: new Date().toISOString(),
      requires_home_approval: true,
      changes: [
        {
          target,
          scope: "application-data",
          original_hash: null,
          before: "",
          after: content,
          risk: "high",
          validator: "json",
        },
      ],
    },
    launch_request: {
      mode: "native-import",
      target_agent: "deepseek-harness",
      operation_id: operation,
      workspace_id: input.workspaceId,
      plan_hash: planHash,
    },
  };
}

function loadDshImportPlan(
  dataDir: string,
  request: z.infer<typeof requestSchema>,
  content?: string,
) {
  const directory = importDirectory(dataDir, request.workspace_id, request.operation_id);
  const planFile = path.join(directory, "plan.json");
  ensureInside(dataDir, planFile);
  const raw = content ?? safeRegularFile(planFile, MAX_PLAN_BYTES).toString("utf8");
  if (Buffer.byteLength(raw) > MAX_PLAN_BYTES || hash(raw) !== request.plan_hash)
    throw new Error("DSH import differs from the approved plan");
  const plan = planSchema.parse(JSON.parse(raw));
  if (
    plan.operation_id !== request.operation_id ||
    plan.target_session_id !== request.operation_id ||
    plan.workspace_id !== request.workspace_id ||
    plan.document.source.workspace_id !== request.workspace_id
  )
    throw new Error("DSH import identity changed");
  return { directory, planFile, plan };
}

export function validateDshImportApplicationData(
  value: unknown,
  launch: unknown,
  workspaceId: string,
  dataDir: string,
) {
  const request = requestSchema.parse(launch);
  const batch = changeSetSchema.parse(value);
  if (
    request.workspace_id !== workspaceId ||
    batch.id !== request.operation_id ||
    !batch.requires_home_approval ||
    batch.changes.length !== 1
  )
    throw new Error("DSH import requires a reviewed plan and Agent Home approval");
  const change = batch.changes[0]!;
  const loaded = loadDshImportPlan(dataDir, request, change.after);
  if (
    change.scope !== "application-data" ||
    change.validator !== "json" ||
    change.original_hash !== null ||
    change.before !== "" ||
    change.target !== loaded.planFile ||
    pathIdentity(batch.project_root) !== pathIdentity(loaded.plan.workspace)
  )
    throw new Error("DSH import contains an unexpected plan change");
  return loaded.planFile;
}

type SourceReader = { document(id: string, options?: DocumentOptions): Promise<SessionDocument> };

export class DshHistoryImport {
  constructor(
    private readonly dataDir: string,
    private readonly store: BackendStore,
    private readonly sessions: SourceReader,
    private readonly bridge: DshHistoryImportBridge | undefined,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async continue(value: unknown) {
    const input = z
      .strictObject({
        launchRequest: requestSchema,
        changeSet: changeSetSchema,
        approveHome: z.literal(true),
      })
      .parse(value);
    const request = input.launchRequest;
    const identity = requireUniqueContinuationWorkspace(this.store, request.workspace_id);
    const planFile = validateDshImportApplicationData(
      input.changeSet,
      request,
      identity.archiveWorkspaceId,
      this.dataDir,
    );
    if (!existsSync(planFile)) {
      await handoffCommit(() => {
        assertContinuationWorkspaceIdentity(this.store, request.workspace_id, identity);
        return applyRequest(
          { changeSet: input.changeSet, approveHome: true },
          this.store,
          this.dataDir,
          this.environment,
          (batch, workspaceId, dataDir) => [
            validateDshImportApplicationData(batch, request, workspaceId, dataDir),
          ],
        );
      });
    }
    return this.launch(request);
  }

  async launch(value: unknown): Promise<{ target_agent: "deepseek-harness"; session_id: string }> {
    const request = requestSchema.parse(value);
    const { directory, plan } = loadDshImportPlan(this.dataDir, request);
    const identity = requireUniqueContinuationWorkspace(
      this.store,
      request.workspace_id,
      plan.workspace,
    );
    const assertWorkspace = () =>
      assertContinuationWorkspaceIdentity(this.store, request.workspace_id, identity);
    const attempt = path.join(directory, "attempted.json");
    const receipt = path.join(directory, "receipt.json");
    const lock = path.join(directory, "import.lock");
    ensureInside(this.dataDir, lock);
    const release = acquirePortableFileLease(lock);
    try {
      assertWorkspace();
      if (existsSync(receipt)) {
        const previous = receiptSchema.parse(
          JSON.parse(safeRegularFile(receipt, 4096).toString("utf8")),
        );
        if (
          previous.plan_hash !== request.plan_hash ||
          previous.target_session_id !== plan.target_session_id
        )
          throw new Error("DSH import receipt does not match the approved plan");
        return { target_agent: "deepseek-harness", session_id: previous.session_id };
      }
      const verifyOnly = existsSync(attempt);
      if (verifyOnly) {
        const previous = attemptSchema.parse(
          JSON.parse(safeRegularFile(attempt, 4096).toString("utf8")),
        );
        if (previous.plan_hash !== request.plan_hash)
          throw new Error("DSH import attempt does not match the approved plan");
      } else {
        const summary = this.store.sessions.get(plan.source_session_id);
        if (
          !summary ||
          requireUniqueContinuationWorkspace(this.store, summary.workspace_id)
            .archiveWorkspaceId !== request.workspace_id
        )
          throw new Error("DSH import source is unavailable");
        const current = await this.sessions.document(plan.source_session_id, {
          includePreCompactionHistory: plan.include_pre_compaction_history,
        });
        current.source.workspace_id = request.workspace_id;
        if (
          (await fingerprintHandoff(current)) !== plan.source_fingerprint ||
          JSON.stringify(sessionDocument.parse(prepareDshHistoryDocument(current))) !==
            JSON.stringify(plan.document)
        )
          throw new Error("Source changed after DSH import preview");
      }
      handoffCheckpoint();
      if (!this.bridge) throw new Error("dsh-runtime-offline");
      const bridge = this.bridge;
      try {
        return await handoffCommit(async () => {
          assertWorkspace();
          const result = await bridge.importHistory({
            context: plan.context,
            workspaceId: identity.registeredId,
            cwd: identity.project,
            nativeId: plan.target_session_id,
            document: plan.document,
            verifyOnly,
            beforeDispatch: verifyOnly
              ? undefined
              : () => {
                  assertWorkspace();
                  createPrivateFile(
                    directory,
                    attempt,
                    Buffer.from(JSON.stringify({ plan_hash: request.plan_hash })),
                  );
                },
          });
          assertWorkspace();
          atomicPrivateWrite(
            directory,
            receipt,
            Buffer.from(
              JSON.stringify(
                receiptSchema.parse({
                  schema_version: 1,
                  plan_hash: request.plan_hash,
                  target_session_id: plan.target_session_id,
                  session_id: result.sessionId,
                  verified: true,
                  launched: true,
                }),
              ),
            ),
          );
          return { target_agent: "deepseek-harness", session_id: result.sessionId };
        });
      } catch (error) {
        if (!existsSync(attempt)) throw error;
        throw new NativeImportOutcomeUnknownError("DSH import outcome needs reconciliation");
      }
    } finally {
      release();
    }
  }
}
