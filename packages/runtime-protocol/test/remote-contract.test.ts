import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONVERSATION_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  REMOTE_CAPABILITIES,
  REMOTE_CONTRACT_VERSION,
  REMOTE_CONVERSATION_EVENTS,
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  REMOTE_ERROR_RETRY_POLICIES,
  REMOTE_FEATURE_VERSIONS,
  REMOTE_LEGACY_CODEX,
  REMOTE_MANAGED_ACTION_OPERATIONS,
  REMOTE_NOTIFICATION_POLICY_CONTRACT,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT,
  REMOTE_READ_STATE_UPDATE_CONTRACT,
  REMOTE_RECEIPT_ROUTE,
  REMOTE_REQUEST_PATH,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
  REMOTE_ROUTE_SPECS,
  REMOTE_SENT_ATTACHMENT_CONTRACT,
  REMOTE_SESSION_QUESTION_CONTRACT,
  REMOTE_SESSION_STATE_CONTRACT,
  REMOTE_VERSIONS,
  REMOTE_WORKER_REPORT_CONTRACT,
  REMOTE_WORKER_ROLE_CONTRACT,
  parseSessionState,
  type RemoteErrorRetry,
  type SessionQuestionReplyFields,
  type SessionState,
  type WorkerReportView,
} from "../src/generated/remote-contract.ts";
import { checkRemoteErrorRetry } from "../scripts/check-remote-error-retry.mjs";
import type { ConversationQuestionnaire } from "../src/conversation-tools.ts";
import type {
  ProjectAgentAssignmentOptions,
  ProjectAgentAssignWorkersInput,
} from "../src/project-agent-eligibility.ts";
import type { SessionInteractionQuestion } from "../src/session-interactions.ts";
import type { ConversationEventPage } from "../../web-client/src/conversation-event.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/remote-contract.json", import.meta.url), "utf8"),
);

type SessionStateSample = {
  access: { status: string; sessionStateVersion?: 1; sessionStateProviders?: string[] };
  live: { status: string; sendEnabled: boolean; state?: unknown };
};

const sessionStateSamples = JSON.parse(
  readFileSync(new URL("./fixtures/session-state.json", import.meta.url), "utf8"),
) as Record<
  "legacy" | "managedWorker" | "unconfirmedSettings" | "terminalWaitingForSendAck",
  SessionStateSample
>;

test("shared live examples preserve the legacy payload and opt into a closed session state", () => {
  const samples = sessionStateSamples;
  const { container, field, optional, capability, providerCoverage } =
    REMOTE_SESSION_STATE_CONTRACT;
  assert.equal(container, "live");
  assert.equal(optional, true);
  assert.equal(capability, REMOTE_CAPABILITIES.access.sessionStateVersion);
  assert.equal(providerCoverage, REMOTE_CAPABILITIES.access.sessionStateProviders);
  assert.equal(samples.legacy.access[capability], undefined);
  assert.equal(samples.legacy[container][field], undefined);
  assert.equal(samples.legacy.live.sendEnabled, true);
  for (const [key, sample] of Object.entries(samples)) {
    if (key === "legacy") continue;
    assert.equal(sample.access[capability], REMOTE_FEATURE_VERSIONS[capability]);
    assert.deepEqual(sample.access[providerCoverage], ["claude-code"]);
    assert.ok(parseSessionState(sample[container][field]), key);
  }

  const worker = parseSessionState(samples.managedWorker.live.state)!;
  assert.deepEqual(worker.role, { kind: "worker", leadId: "opaque-lead-id" });
  assert.deepEqual(worker.lease, { state: "held", reason: null });
  assert.equal(worker.modelEntry, "agentkib");

  const unconfirmed = parseSessionState(samples.unconfirmedSettings.live.state)!;
  assert.equal(unconfirmed.turn.phase, "idle");
  assert.equal(unconfirmed.controls.send.state, "enabled");
  assert.equal(unconfirmed.controls.assign.state, "enabled");
  assert.deepEqual(unconfirmed.controls.settings, {
    state: "disabled",
    reason: "command-outcome-unknown",
    recovery: { kind: "action", action: "reconcile" },
  });

  const terminal = parseSessionState(samples.terminalWaitingForSendAck.live.state)!;
  assert.equal(terminal.turn.phase, "idle");
  assert.deepEqual(terminal.controls.send, {
    state: "disabled",
    reason: "awaiting-send-ack",
    recovery: { kind: "automatic", signal: "control-readiness" },
  });
});

test("rejects malformed session state combinations from the shared TS and Dart fixtures", () => {
  const invalid = JSON.parse(
    readFileSync(new URL("./fixtures/session-state-invalid.json", import.meta.url), "utf8"),
  ) as Record<string, Partial<Omit<SessionState, "controls">> & { controls?: object }>;
  const worker = parseSessionState(sessionStateSamples.managedWorker.live.state)!;
  for (const [name, fields] of Object.entries(invalid)) {
    assert.equal(
      parseSessionState({
        ...worker,
        ...fields,
        controls: { ...worker.controls, ...fields.controls },
      }),
      null,
      name,
    );
  }
});

test("shared event examples cover the optional Worker report contract", () => {
  const samples = JSON.parse(
    readFileSync(new URL("./fixtures/worker-reports.json", import.meta.url), "utf8"),
  ) as {
    events: Array<{ id: string; kind: string; content: string; worker_reports?: WorkerReportView }>;
  };
  const { schema, field, eventKind, optional } = REMOTE_WORKER_REPORT_CONTRACT;
  const { WorkerReportKind, WorkerReportPart, WorkerReportWaitingItem } = schema.$defs;
  assert.equal(optional, true);
  assert.equal(field, "worker_reports");
  const covered = new Set<string>();
  const deliveries = new Set<string>();
  for (const event of samples.events) {
    const report = event[field];
    if (!report) {
      assert.equal(event.id, "message-without-delivery");
      continue;
    }
    assert.equal(event.kind, eventKind);
    assert.ok(!deliveries.has(report.reportId));
    deliveries.add(report.reportId);
    assert.ok(report.parts.length >= schema.properties.parts.minItems);
    assert.doesNotMatch(JSON.stringify(report), /\[AgentKib report(?:\]| ID:)|Use worker_read/);
    for (const part of report.parts) {
      covered.add(part.kind);
      for (const key of WorkerReportPart.required) assert.ok(key in part, `${event.id}.${key}`);
      assert.equal(typeof part.requiresUser, "boolean");
      assert.ok(Number.isFinite(Date.parse(part.occurredAt)));
      if (part.durationMs !== undefined)
        assert.ok(Number.isSafeInteger(part.durationMs) && part.durationMs >= 0);
      for (const item of part.waitingItems ?? [])
        assert.ok(WorkerReportWaitingItem.properties.kind.enum.includes(item.kind));
    }
  }
  assert.deepEqual([...covered].sort(), [...WorkerReportKind.enum].sort());
  const batch = samples.events.find(({ id }) => id === "batch-mixed")?.[field];
  assert.ok(batch?.omittedDetails);
  assert.ok(batch.parts.length > 1 && batch.parts.some(({ requiresUser }) => requiresUser));
  assert.ok(
    samples.events
      .find(({ id }) => id === "turn-ended-completed")
      ?.content.includes("[AgentKib report ID:"),
  );
  assert.ok(samples.events.some((event) => !Object.hasOwn(event, field)));
  const withRole = samples.events.find(({ id }) => id === "turn-ended-completed")?.[field]
    ?.parts[0];
  assert.equal(withRole?.workerRoleLabel, "Validation");
  assert.ok(!WorkerReportPart.required.some((key: string) => key === "workerRoleLabel"));
  assert.equal(WorkerReportPart.properties.workerRoleLabel.type, "string");
});

test("Worker role editing shares limits, authorship and activity fields across clients", () => {
  const { controlOperation, operation, input, view, change } = REMOTE_WORKER_ROLE_CONTRACT;
  assert.equal(controlOperation, "lead-worker-role");
  assert.equal(operation, "worker-role");
  assert.deepEqual(input.required, ["label", "description"]);
  assert.ok(!input.additionalProperties);
  assert.deepEqual(view.properties.updatedBy.enum, ["user", "project-agent"]);
  assert.deepEqual(change.properties.roleLabel.type, ["string", "null"]);
});

test("sent attachments add metadata and reuse image references without changing native images", () => {
  const pages = JSON.parse(
    readFileSync(new URL("./fixtures/conversation-sent-attachments.json", import.meta.url), "utf8"),
  ) as { current: ConversationEventPage; previous: ConversationEventPage };
  const { field, eventKind, optional, schema } = REMOTE_SENT_ATTACHMENT_CONTRACT;
  const item = schema.$defs.ConversationSentAttachment;
  assert.equal(field, "attachments");
  assert.equal(optional, true);

  const [sent, native] = pages.current.events;
  const [previous] = pages.previous.events;
  assert.ok(sent && native && previous);
  assert.equal(sent.kind, eventKind);
  assert.doesNotMatch(sent.content ?? "", /User attached file|file:\/\//);
  const attachments = sent[field];
  assert.ok(attachments && attachments.length >= schema.minItems);
  assert.equal(sent.attachment_count, attachments.length);
  assert.deepEqual(
    attachments.map(({ kind, available, imageId }) => [kind, available, Boolean(imageId)]),
    [
      ["image", true, true],
      ["file", true, false],
      ["image", false, false],
    ],
  );
  for (const attachment of attachments) {
    assert.ok(item.properties.kind.enum.includes(attachment.kind));
    assert.ok(Number.isSafeInteger(attachment.size));
    assert.ok(attachment.size >= item.properties.size.minimum);
    for (const key of item.required) assert.ok(Object.hasOwn(attachment, key), key);
    for (const key of Object.keys(attachment)) assert.ok(Object.hasOwn(item.properties, key), key);
  }
  assert.equal(native[field], undefined);
  assert.equal(native.attachment_count, native.images?.length);
  assert.equal(native.images?.[0]?.mimeType, "image/png");
  assert.equal(previous[field], undefined);
  assert.equal(previous.kind, eventKind);
  assert.match(previous.content ?? "", /User attached file/);
});

test("the shared question examples add preview and notes without requiring either", () => {
  const examples = JSON.parse(
    readFileSync(new URL("./fixtures/session-question-preview.json", import.meta.url), "utf8"),
  ) as {
    live: { supported: boolean; questions: SessionInteractionQuestion[] };
    answerWithNotes: SessionQuestionReplyFields;
    answerWithoutNotes: SessionQuestionReplyFields;
    history: ConversationQuestionnaire;
  };
  const { option, reply } = REMOTE_SESSION_QUESTION_CONTRACT;
  assert.deepEqual(option.required, ["label"]);
  assert.equal(option.properties.preview.type, "string");
  assert.deepEqual(reply.required, ["answers"]);
  assert.equal(reply.properties.answerNotes.additionalProperties.type, "string");
  assert.ok(examples.live.supported);

  const [question] = examples.live.questions;
  const [historicalQuestion] = examples.history.questions;
  assert.ok(question && historicalQuestion);
  assert.deepEqual(historicalQuestion.options, question.options);
  assert.equal(historicalQuestion.answer?.preview, question.options[0]?.preview);
  assert.equal(Object.hasOwn(question.options[1]!, "preview"), false);
  assert.deepEqual(examples.answerWithoutNotes.answers, examples.answerWithNotes.answers);
  assert.equal(examples.answerWithoutNotes.answerNotes, undefined);
  assert.deepEqual(
    examples.answerWithoutNotes.answers[question.id],
    historicalQuestion.answer?.selected,
  );
  assert.equal(
    examples.answerWithNotes.answerNotes?.[question.id],
    historicalQuestion.answer?.notes,
  );
});

test("the shared info and access responses negotiate current and legacy hosts", () => {
  assert.equal(fixture.contractVersion, REMOTE_CONTRACT_VERSION);
  assert.equal(PROTOCOL_VERSION, REMOTE_VERSIONS.runtime.minimum);
  assert.equal(CONVERSATION_PROTOCOL_VERSION, REMOTE_VERSIONS.conversation.minimum);
  for (const transport of ["local", "lan"]) {
    const info = fixture.info[transport];
    assert.equal(info.transport, transport);
    assert.equal(info.protocolVersion, REMOTE_VERSIONS.hostDiscovery.advertised);
    assert.ok(REMOTE_VERSIONS.hostDiscovery.accepted.includes(info.protocolVersion));
    assert.equal(info.conversationProtocolVersion, CONVERSATION_PROTOCOL_VERSION);
    assert.equal(info.capabilities[REMOTE_CAPABILITIES.info.read], true);
    assert.equal(typeof info.capabilities[REMOTE_CAPABILITIES.info.send], "boolean");
    assert.equal(typeof info.capabilities[REMOTE_CAPABILITIES.info.approve], "boolean");
  }
  for (const example of ["unpaired", "approved", "approvedWithAnswerNotes"]) {
    const access = fixture.access[example];
    assert.equal(access.status, example === "unpaired" ? "unpaired" : "approved");
    assert.ok(access.csrfToken);
    assert.ok(access.bootId);
    assert.equal(access.protocolVersion, CONVERSATION_PROTOCOL_VERSION);
    assert.equal(
      access[REMOTE_CAPABILITIES.access.readStateVersion],
      REMOTE_FEATURE_VERSIONS.readStateVersion,
    );
  }
  assert.equal(
    fixture.access.approved[REMOTE_CAPABILITIES.access.pendingInteractions].version,
    REMOTE_FEATURE_VERSIONS.pendingInteractions,
  );
  assert.equal(
    fixture.access.approved[REMOTE_CAPABILITIES.access.taskSummaryVersion],
    REMOTE_FEATURE_VERSIONS.taskSummaryVersion,
  );
  const notesCapability = REMOTE_CAPABILITIES.access.answerNotesVersion;
  assert.equal(
    fixture.access.approvedWithAnswerNotes[notesCapability],
    REMOTE_FEATURE_VERSIONS.answerNotesVersion,
  );
  assert.equal(fixture.access.approved[notesCapability], undefined);
  assert.equal(fixture.access.unpaired[notesCapability], undefined);
});

test("paired Worker assignment is an additive versioned operation on the existing route", () => {
  const key = REMOTE_CAPABILITIES.access.projectAgentAssignmentVersion;
  assert.equal(
    fixture.access.approvedWithProjectAgentAssignment[key],
    REMOTE_FEATURE_VERSIONS.projectAgentAssignmentVersion,
  );
  assert.equal(fixture.access.approved[key], undefined);
  assert.equal(fixture.access.unpaired[key], undefined);

  const { optionsOperation, assignOperation, assignSuccessOutcome } =
    REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT;
  const { optionsQuery, options, assignQuery, assign, assigned, refused, unconfirmed } =
    fixture.projectAgentAssignment as {
      optionsQuery: { operation: string; sessionId: string };
      options: ProjectAgentAssignmentOptions;
      assignQuery: { operation: string };
      assign: ProjectAgentAssignWorkersInput;
      assigned: { controlOutcome: string; lead: { workers: { sessionId: string }[] } };
      refused: { error: string; controlOutcome: string };
      unconfirmed: { error: string; controlOutcome: string };
    };
  assert.equal(REMOTE_ROUTE.managedProjectAgent, "/managed/project-agent");
  for (const method of ["GET", "POST"] as const)
    assert.deepEqual(REMOTE_ROUTE_SPECS[method][REMOTE_ROUTE.managedProjectAgent], {});
  assert.deepEqual(optionsQuery, { operation: optionsOperation, sessionId: assign.sessionId });
  assert.deepEqual(assignQuery, { operation: assignOperation });
  assert.equal(assign.operation, assignOperation);
  assert.equal(assigned.controlOutcome, assignSuccessOutcome);
  assert.deepEqual(
    assigned.lead.workers.map(({ sessionId }) => sessionId),
    assign.workers,
  );
  assert.deepEqual(refused, {
    error: REMOTE_ERROR_CODES.permissionDenied,
    controlOutcome: REMOTE_CONTROL_OUTCOMES.notDispatched,
  });
  assert.deepEqual(unconfirmed, {
    error: REMOTE_ERROR_CODES.accessChanged,
    controlOutcome: REMOTE_CONTROL_OUTCOMES.unknown,
  });
  assert.equal(options.capable, options.eligibility.availability.available);
  assert.ok(Number.isSafeInteger(options.remaining) && options.remaining >= assign.workers.length);
  const available = options.candidates.find((candidate) => candidate.reason === null);
  const disconnected = options.candidates.find(
    (candidate) => candidate.reason === REMOTE_ERROR_CODES.workerTerminalDisconnected,
  );
  assert.deepEqual(assign.workers, [available?.sessionId]);
  assert.equal(available?.eligibility?.actions.send, null);
  assert.deepEqual(disconnected?.eligibility?.availability, {
    available: false,
    reason: REMOTE_ERROR_CODES.workerTerminalDisconnected,
  });
  assert.ok(
    options.candidates.some(
      ({ assigned, reason }) => assigned && reason === REMOTE_ERROR_CODES.sessionIsAWorker,
    ),
  );
});

test("manual read-state updates are optional and only advertised to approved readers", () => {
  const capability = REMOTE_CAPABILITIES.access.readStateMarkVersion;
  const updates = fixture.readStateUpdates;
  const { properties, required } = REMOTE_READ_STATE_UPDATE_CONTRACT;
  assert.equal(fixture.access.unpaired[capability], undefined);
  assert.equal(fixture.access.approved[capability], REMOTE_FEATURE_VERSIONS.readStateMarkVersion);
  assert.deepEqual(Object.keys(updates.acknowledge), required);
  assert.deepEqual([updates.markRead.mark, updates.markUnread.mark], properties.mark.enum);
  for (const request of Object.values(updates) as object[]) {
    assert.ok(required.every((key) => Object.hasOwn(request, key)));
    assert.ok(Object.keys(request).every((key) => Object.hasOwn(properties, key)));
  }
  assert.equal(updates.markUnread.seenResultId, null);
});

test("an explicit version request adds Worker results while legacy notification settings remain available", () => {
  const { legacyVersion, requestVersionQuery, workerResults } = REMOTE_NOTIFICATION_POLICY_CONTRACT;
  const { pushPolicyVersion } = REMOTE_FEATURE_VERSIONS;
  const capability = REMOTE_CAPABILITIES.access.pushPolicyVersion;
  const { legacy, workerResults: current } = fixture.notificationPolicy;
  assert.equal(legacy.accessRequest, REMOTE_ROUTE.access);
  assert.equal(legacy.accessResponse[capability], legacyVersion);
  assert.equal(
    current.accessRequest,
    `${REMOTE_ROUTE.access}?${requestVersionQuery}=${pushPolicyVersion}`,
  );
  assert.equal(current.accessResponse[capability], pushPolicyVersion);
  assert.equal(Object.hasOwn(legacy.policyPatch, workerResults.field), false);
  assert.equal(current.policyPatch[workerResults.field], true);
  assert.equal(workerResults.default, false);
});

type IpcShape =
  | { kind: "none" | "transport" }
  | { kind: "rpc"; rpcCode: number; detail?: string }
  | { kind: "result"; field: string; reason: string; status?: number };

function assertIpc(shape: IpcShape, sample: unknown, code: string) {
  if (shape.kind === "none") {
    assert.equal(sample, undefined);
  } else if (shape.kind === "transport") {
    assert.deepEqual(sample, { error: code });
  } else {
    assert.ok(sample && typeof sample === "object");
    if (shape.kind === "rpc") {
      assert.ok("error" in sample && sample.error && typeof sample.error === "object");
      assert.ok("code" in sample.error);
      assert.equal(sample.error.code, shape.rpcCode);
      if (shape.detail) {
        assert.ok("data" in sample.error);
        assert.deepEqual(sample.error.data, { detail: shape.detail });
      }
    } else if (shape.kind === "result") {
      assert.ok("result" in sample);
      assert.deepEqual(sample.result, {
        [shape.field]: shape.reason,
        ...(shape.status === undefined ? {} : { status: shape.status }),
      });
    }
  }
}

test("every error has a shared response example for its HTTP and IPC representations", () => {
  const codes = Object.values(REMOTE_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(Object.keys(fixture.errors).sort(), Object.keys(REMOTE_ERROR_CONTRACT).sort());
  for (const key of Object.keys(REMOTE_ERROR_CONTRACT) as (keyof typeof REMOTE_ERROR_CONTRACT)[]) {
    const error = REMOTE_ERROR_CONTRACT[key];
    const sample = fixture.errors[key];
    assert.equal(error.code, REMOTE_ERROR_CODES[key]);
    if ("http" in error) {
      const primaryCode = "reasonFor" in error.http ? error.http.reasonFor : undefined;
      if (primaryCode) assert.ok(codes.includes(primaryCode), key);
      assert.deepEqual(
        sample.http,
        {
          status: error.http.status,
          body: primaryCode ? { error: primaryCode, reason: error.code } : { error: error.code },
        },
        key,
      );
      const overrides = "overrides" in error.http ? error.http.overrides : undefined;
      assert.deepEqual(sample.httpStatusOverrides, overrides, key);
      const additional = "additional" in error.http ? error.http.additional : {};
      assert.deepEqual(Object.keys(sample.additionalHttp ?? {}), Object.keys(additional), key);
      for (const [name, shape] of Object.entries(additional)) {
        assert.ok(codes.includes(shape.reasonFor), name);
        assert.deepEqual(sample.additionalHttp[name], {
          status: shape.status,
          body: {
            error: shape.reasonFor,
            reason: error.code,
            ...("readOnly" in shape ? {} : { controlOutcome: "not-dispatched" }),
          },
        });
      }
    } else {
      assert.equal(sample.http, undefined, key);
    }
    assertIpc(error.ipc, sample.ipc, error.code);
    if ("additional" in error.ipc) {
      assert.deepEqual(Object.keys(sample.additionalIpc), Object.keys(error.ipc.additional));
      for (const [name, shape] of Object.entries(error.ipc.additional)) {
        assertIpc(shape, sample.additionalIpc[name], error.code);
      }
    }
  }
});

test("shared retry examples exercise every policy without changing response bodies", () => {
  const examples = Object.entries(fixture.errorRetryExamples) as [
    keyof typeof REMOTE_ERROR_CONTRACT,
    RemoteErrorRetry,
  ][];
  assert.deepEqual(
    [...new Set(examples.map(([, retry]) => retry))].sort(),
    [...REMOTE_ERROR_RETRY_POLICIES].sort(),
  );
  for (const [name, retry] of examples) {
    const contract = REMOTE_ERROR_CONTRACT[name];
    const sample = fixture.errors[name];
    assert.equal(contract.retry, retry, name);
    if ("http" in contract) {
      const http = contract.http;
      assert.deepEqual(
        sample.http.body,
        "reasonFor" in http
          ? { error: http.reasonFor, reason: contract.code }
          : { error: contract.code },
      );
    } else {
      assert.equal(sample.http, undefined, name);
    }
    assertIpc(contract.ipc, sample.ipc, contract.code);
  }
});

const retryExample = {
  code: "example",
  http: { status: 409 },
  ipc: { kind: "none" },
};
const unclassifiedExample = { ...retryExample, retry: "unclassified" };
const classifiedExample = { ...retryExample, retry: "after-refresh" };

test("the retry gate requires a valid policy on every entry", () => {
  for (const entry of [retryExample, { ...retryExample, retry: "retry-later" }]) {
    assert.throws(
      () => checkRemoteErrorRetry(REMOTE_ERROR_RETRY_POLICIES, { example: entry }),
      /example must declare a valid retry policy/,
    );
  }
});

test("the retry gate allows unclassified only on unchanged legacy entries", () => {
  for (const base of [retryExample, unclassifiedExample]) {
    assert.doesNotThrow(() =>
      checkRemoteErrorRetry(
        REMOTE_ERROR_RETRY_POLICIES,
        { example: unclassifiedExample },
        { example: base },
      ),
    );
  }
  for (const entries of [
    { renamed: unclassifiedExample },
    { example: { ...unclassifiedExample, code: "renamed" } },
    { example: { ...unclassifiedExample, http: { status: 400 } } },
    { example: { ...unclassifiedExample, ipc: { kind: "transport" } } },
  ]) {
    assert.throws(
      () =>
        checkRemoteErrorRetry(REMOTE_ERROR_RETRY_POLICIES, entries, {
          example: unclassifiedExample,
        }),
      /cannot be unclassified/,
    );
  }
  assert.doesNotThrow(() =>
    checkRemoteErrorRetry(
      REMOTE_ERROR_RETRY_POLICIES,
      { example: classifiedExample },
      { example: unclassifiedExample },
    ),
  );
  assert.throws(
    () =>
      checkRemoteErrorRetry(
        REMOTE_ERROR_RETRY_POLICIES,
        { example: unclassifiedExample },
        { example: classifiedExample },
      ),
    /cannot be unclassified/,
  );
});

test("route declarations preserve LAN preflight and legacy Codex boundaries", () => {
  assert.equal(REMOTE_ROUTE_BASE, `/api/web/v${REMOTE_VERSIONS.remoteApi.major}`);
  for (const key of Object.keys(REMOTE_ROUTE) as (keyof typeof REMOTE_ROUTE)[]) {
    assert.equal("/" + REMOTE_REQUEST_PATH[key], REMOTE_ROUTE[key]);
  }
  assert.deepEqual(REMOTE_ROUTE_SPECS.GET[REMOTE_ROUTE.info], { lan: true });
  assert.deepEqual(REMOTE_ROUTE_SPECS.POST[REMOTE_ROUTE.managedAction], { control: true });
  assert.deepEqual(REMOTE_ROUTE_SPECS.POST[REMOTE_ROUTE.codexQueueDelete], {
    lan: true,
    control: true,
  });
  assert.deepEqual(REMOTE_ROUTE_SPECS.POST[REMOTE_ROUTE.abandonRequest], {
    lan: true,
    control: true,
  });
  assert.equal(REMOTE_RECEIPT_ROUTE.lan, true);
  assert.equal(REMOTE_LEGACY_CODEX.nonControlPath, REMOTE_ROUTE.codexInspect);
  assert.equal(REMOTE_LEGACY_CODEX.postTarget, REMOTE_ROUTE.managedAction);
  assert.ok(REMOTE_LEGACY_CODEX.postOperations.includes("queue-delete"));
  for (const path of Object.keys(REMOTE_LEGACY_CODEX.getAliases)) {
    assert.ok(REMOTE_ROUTE_SPECS.GET[path]);
    assert.ok(REMOTE_ROUTE_SPECS.GET[REMOTE_LEGACY_CODEX.getAliases[path]!]);
  }
  for (const operation of [
    "delete",
    "compact",
    "terminals-clean",
    "usage-limit-cancel",
    "usage-limit-continue",
  ]) {
    assert.ok(REMOTE_MANAGED_ACTION_OPERATIONS.includes(operation));
    assert.ok(!REMOTE_LEGACY_CODEX.postOperations.includes(operation));
  }
});

test("the compaction boundary examples use the generated timeline contract", () => {
  const examples = JSON.parse(
    readFileSync(
      new URL("./fixtures/conversation-compaction-boundaries.json", import.meta.url),
      "utf8",
    ),
  );
  const { kind, timestampField, triggerField, triggers } =
    REMOTE_CONVERSATION_EVENTS.compactionBoundary;
  const boundaries: unknown[] = [];
  for (const page of [examples.claudeCode, examples.codex]) {
    const events = page.events as Record<string, unknown>[];
    assert.ok(
      events.every((event) =>
        Object.values(REMOTE_CONVERSATION_EVENTS).some((declared) => declared.kind === event.kind),
      ),
    );
    for (const [index, event] of events.entries()) {
      if (event.kind !== kind) {
        assert.ok(!(triggerField in event));
        continue;
      }
      const at = Date.parse(String(event[timestampField]));
      assert.ok(Date.parse(String(events[index - 1]?.[timestampField])) < at);
      assert.ok(at < Date.parse(String(events[index + 1]?.[timestampField])));
      assert.equal(event.content, null);
      assert.equal(event.attachment_count, 0);
      assert.equal(event.truncated, false);
      boundaries.push(event[triggerField]);
    }
  }
  assert.deepEqual(boundaries, triggers);
});
