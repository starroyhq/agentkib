// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { RelayManager, type RemoteAccountBinding } from "./relay/manager";
import type { Access } from "@agentkib/web-client";
import { NotificationPolicyStore } from "../push/policy";
import type { PushInteractionProjection } from "../push/actions";
import { ConversationHub } from "../conversation-hub";

let directory: string, service: WebAccessService, relay: RelayManager, origin: string;
let conversationHub: ConversationHub;
let cookie = "",
  csrf = "";
const binding: RemoteAccountBinding = {
  id: "c".repeat(32),
  accountId: "owner",
  sessionId: "a".repeat(36),
  expiresAt: Date.now() + 86_400_000,
};
const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x!;
const subscription = { publicKey, ref: "phone-ref-1", alerts: true, liveActivity: true };
type NativeRequest = { operation: string; requestId?: string; experimentalEnabled?: boolean };
const nativeCalls = vi.fn<(value: NativeRequest) => Promise<unknown>>();
const receipts = vi.fn<(value: { requestId: string; deviceId: string }) => Promise<unknown>>();
const waitingSession = {
  id: "fake-session",
  agent: "codex",
  workspace_id: "fake-workspace",
  availability: "readable",
  title: "Synthetic waiting session",
  updated_at: "2026-11-24T00:00:00.000Z",
  continuation: { status: "awaiting-approval" },
};

async function request<T = Record<string, unknown>>(path: string, body?: unknown) {
  const response = await fetch(origin + "/api/web/v1/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-AgentKib-Protocol": "2",
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { status: response.status, data: (await response.json()) as T };
}
async function access() {
  const result = await request<Access>("access");
  csrf = result.data.csrfToken;
  return result;
}
function useRelay(accountContext: boolean) {
  const state = service as unknown as {
    config: { relay?: { enabled: boolean; brokerUrl: string } };
    relay: RelayManager;
  };
  state.config.relay = { enabled: true, brokerUrl: "https://relay.example.test" };
  state.relay = relay;
  vi.spyOn(relay, "accountLoginContext", "get").mockReturnValue(
    accountContext ? { accountId: "owner", deviceId: "d".repeat(32) } : undefined,
  );
}
/** A phone paired with a code and bound to its account login, as the phone app does. */
async function pairBoundPhone(
  level: "read" | "full" = "read",
  phoneBinding: RemoteAccountBinding = binding,
) {
  useRelay(true);
  const initial = await access();
  vi.spyOn(relay, "redeemAccountLogin").mockResolvedValue(phoneBinding);
  vi.spyOn(relay, "verifyAccountLogins").mockResolvedValue([
    { id: phoneBinding.id, active: true, expiresAt: phoneBinding.expiresAt },
  ]);
  expect(
    (
      await request("account-binding", {
        code: "p".repeat(43),
        codeVerifier: "v".repeat(43),
        hostChallenge: initial.data.accountLogin!.challenge,
        redemptionId: "r".repeat(43),
      })
    ).data,
  ).toEqual({ bound: true });
  const code = (await service.request({ operation: "generate-code", access: level })).code!.value;
  expect((await request("pair", { name: "Synthetic phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentkib-push-subscription-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("fixture_port");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  nativeCalls.mockReset().mockResolvedValue({ workspaces: [], sessions: [] });
  receipts.mockReset().mockImplementation(async ({ requestId }) => ({ found: false, requestId }));
  conversationHub = new ConversationHub(async () => {
    throw new Error("fixture_unexpected_subscription");
  });
  service = new WebAccessService({
    dataDir: directory,
    staticDir: directory,
    runtimeRequest: (value) => nativeCalls(value as NativeRequest),
    receiptRequest: receipts,
    notificationPolicy: new NotificationPolicyStore(directory),
    verifiedExperimental: true,
    conversationHub,
  });
  await service.initialize();
  await service.request({
    operation: "configure",
    enabled: true,
    port,
    externalOrigin: "",
    experimentalEnabled: true,
  });
  relay = new RelayManager({
    stateDirectory: directory,
    brokerUrl: "https://relay.example.test",
    frpcPath: "/synthetic/frpc",
    target: { host: "127.0.0.1", port },
    preview: { host: "127.0.0.1", port },
  });
  cookie = "";
  csrf = "";
});
afterEach(async () => {
  await service.shutdown();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("projects only registered workspaces and primary sessions for a legacy activity subscriber", async () => {
  await pairBoundPhone();
  expect((await request("push/subscribe", subscription)).status).toBe(200);
  nativeCalls.mockResolvedValue({
    workspaces: [{ id: "fake-workspace", name: "Registered", path: directory }],
    sessions: [],
  });
  const [target] = service.pushTargets();
  expect(target?.activityDetails).toBeUndefined();
  const activity = await service.notificationActivityForTarget(target!, [
    waitingSession,
    { ...waitingSession, id: "unregistered", workspace_id: "private" },
    { ...waitingSession, id: "auxiliary", sidechain: true },
  ]);
  expect(activity?.snapshot).toMatchObject({
    running: 0,
    waiting: 1,
    priority: { sessionId: waitingSession.id },
  });
  expect([...activity!.work.keys()]).toEqual([waitingSession.id]);
});

it("lets an account-bound phone subscribe, keeps it with the pairing, and lets it stop", async () => {
  await pairBoundPhone();
  expect((await access()).data.push).toEqual({
    version: 1,
    subscribed: false,
    approvalActionsVersion: 1,
  });
  expect(service.pushTargets()).toEqual([]);
  const changed = vi.fn();
  service.onPushChanged(changed);

  for (const body of [
    { ...subscription, publicKey: "short" },
    { ...subscription, ref: "bad ref" },
    { ...subscription, alerts: "yes" },
    { ...subscription, approvalActions: 2 },
    { ...subscription, extra: true },
  ])
    expect((await request("push/subscribe", body)).data).toEqual({
      error: "invalid_push_subscription",
    });
  expect((await request("push/subscribe", subscription)).data).toEqual({ subscribed: true });
  expect(changed).toHaveBeenCalledOnce();
  expect((await access()).data.push).toEqual({
    version: 1,
    subscribed: true,
    approvalActionsVersion: 1,
    alerts: true,
    liveActivity: true,
  });
  const [target] = service.pushTargets();
  expect(target).toEqual({
    session: binding.sessionId,
    ...subscription,
    updatedAt: expect.any(Number),
  });
  const saved = JSON.parse(await readFile(join(directory, "web-access.json"), "utf8"));
  expect(saved.credentials[0].push).toMatchObject(subscription);

  // The app subscribes on every launch; the same choices change nothing.
  expect((await request("push/subscribe", subscription)).status).toBe(200);
  expect(changed).toHaveBeenCalledOnce();
  expect(service.pushTargets()[0].updatedAt).toBe(target.updatedAt);
  expect((await request("push/subscribe", { ...subscription, liveActivity: false })).status).toBe(
    200,
  );
  expect(changed).toHaveBeenCalledTimes(2);
  expect(service.pushTargets()[0].liveActivity).toBe(false);

  expect((await request("push/unsubscribe", {})).data).toEqual({ subscribed: false });
  expect(changed).toHaveBeenCalledTimes(3);
  expect(service.pushTargets()).toEqual([]);
  expect((await access()).data.push).toEqual({
    version: 1,
    subscribed: false,
    approvalActionsVersion: 1,
  });
});

it("sends through the relay as this computer, and never from the LAN service", async () => {
  await pairBoundPhone();
  expect(service.pushDeviceId()).toBe("d".repeat(32));
  const send = vi.spyOn(relay, "pushSend").mockResolvedValue({ delivered: true });
  const input = { session: binding.sessionId, kind: "alert" as const, envelope: "e".repeat(64) };
  expect(await service.pushSend(input)).toEqual({ delivered: true });
  expect(send).toHaveBeenCalledExactlyOnceWith(input);

  const lan = new WebAccessService({
    dataDir: join(directory, "lan"),
    staticDir: "",
    mode: "lan",
    runtimeRequest: async () => ({ workspaces: [], sessions: [] }),
  });
  expect(lan.pushDeviceId()).toBeUndefined();
  expect(await lan.pushSend(input)).toEqual({ delivered: false, error: "relay_unavailable" });
  expect(lan.pushTargets()).toEqual([]);
});

it("offers nothing to a pairing that is not bound to the computer's account", async () => {
  useRelay(false);
  await access();
  const code = (await service.request({ operation: "generate-code", access: "full" })).code!.value;
  expect((await request("pair", { name: "Independent phone", code })).status).toBe(200);
  expect((await access()).data.status).toBe("approved");
  expect((await access()).data.push).toBeUndefined();
  expect((await request("push/subscribe", subscription)).data).toEqual({
    error: "push_unavailable",
  });
  expect(service.pushTargets()).toEqual([]);
});

it("stops notifying a phone whose account login ended", async () => {
  await pairBoundPhone();
  await request("push/subscribe", subscription);
  expect(service.pushTargets()).toHaveLength(1);
  vi.spyOn(relay, "verifyAccountLogins").mockResolvedValue([{ id: binding.id, active: false }]);
  await service.checkAccountBindings();
  expect(service.pushTargets()).toEqual([]);
});

function waitingApproval() {
  const workspace = { id: waitingSession.workspace_id, name: "Fake workspace", path: directory };
  const snapshot = {
    sessionId: waitingSession.id,
    workspaceId: workspace.id,
    executionMode: "codex-managed",
    runtimeBootId: "test-runtime",
    revision: 4,
    turnId: "test-turn",
    status: "awaiting-approval",
    approvals: [
      {
        requestId: 7,
        turnId: "test-turn",
        supported: true,
        method: "item/commandExecution/requestApproval",
        agentDescription: "Publish the sample change",
        command: "git push",
        cwd: directory,
        availableDecisions: ["accept", "decline"],
        decisionOptions: [
          {
            id: "session",
            label: "acceptForSession",
            scope: "session",
            decision: "acceptForSession",
          },
        ],
      },
    ],
  };
  nativeCalls.mockImplementation(async ({ operation, requestId, experimentalEnabled }) => {
    if (operation === "catalog") return { workspaces: [workspace], sessions: [waitingSession] };
    if (operation === "live")
      return {
        ...snapshot,
        approvals:
          experimentalEnabled === true
            ? snapshot.approvals
            : snapshot.approvals.map((approval) => ({ ...approval, supported: false })),
      };
    return { accepted: true, requestId, runtimeBootId: snapshot.runtimeBootId };
  });
  return snapshot;
}

const optedIn = { ...subscription, approvalActions: 1 as const };

async function subscribedApproval() {
  expect((await request("push/subscribe", optedIn)).status).toBe(200);
  const [target] = service.pushTargets().filter((target) => target.session === binding.sessionId);
  expect(target?.approvalActions).toBe(1);
  if (!target) throw new Error("fixture_missing_push_target");
  const notification = (await service.notificationAlertContext(
    target,
    waitingSession,
    "approval",
  )) as PushInteractionProjection | undefined;
  expect(notification?.action).toBeDefined();
  if (!notification?.action) throw new Error("fixture_missing_notification_action");
  return notification as PushInteractionProjection &
    Required<Pick<PushInteractionProjection, "action">>;
}

function actionBody(
  notification: Awaited<ReturnType<typeof subscribedApproval>>,
  choice = "choice:accept",
) {
  const { binding } = notification.interaction;
  const { action } = notification;
  return {
    bootId: action.bootId,
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    approvalId: binding.requestId,
    interactionRuntimeBootId: binding.runtimeBootId,
    expectedRevision: binding.revision,
    requestId: action.requestId,
    interactionDecisionId: choice,
    pushActionToken: action.choices[choice],
  };
}

const approvalsSent = () =>
  nativeCalls.mock.calls.flatMap(([input]) => (input.operation === "approve" ? [input] : []));

describe("notification approval action admission", () => {
  it("keeps legacy subscriptions and grants distinct from high-risk extended choices", async () => {
    waitingApproval();
    await pairBoundPhone("full");
    const legacy = await request("push/subscribe", subscription);
    expect(legacy.data).toEqual({ subscribed: true });
    const legacyContext = await service.notificationAlertContext(
      service.pushTargets()[0]!,
      waitingSession,
      "approval",
    );
    expect(legacyContext?.isCurrent?.()).toBe(true);
    expect(legacyContext).not.toHaveProperty("interaction");
    expect(legacyContext).not.toHaveProperty("action");

    const notification = await subscribedApproval();
    expect(nativeCalls).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "live", experimentalEnabled: true }),
    );
    expect(notification.interaction.risk).toEqual({ level: "high", reason: "git-push" });
    const body = actionBody(notification, "native:session");
    expect(body.pushActionToken).toBeTruthy();
    expect((await request("approve", body)).status).toBe(200);
    expect(approvalsSent()).toEqual([
      expect.objectContaining({
        requestId: body.requestId,
        nativeDecision: "acceptForSession",
        operation: "approve",
      }),
    ]);
  });

  it("invalidates a notification recipient context when its workspace scope changes", async () => {
    waitingApproval();
    await pairBoundPhone("full");
    expect((await request("push/subscribe", optedIn)).status).toBe(200);
    const [target] = service.pushTargets();
    const context = await service.notificationAlertContext(target!, waitingSession, "approval");
    expect(context?.action).toBeDefined();
    expect(context?.isCurrent?.()).toBe(true);

    nativeCalls.mockResolvedValue({ workspaces: [], sessions: [] });
    conversationHub.scopesChanged();
    expect(service.pushTargets()).toEqual([target]);
    expect(context?.isCurrent?.()).toBe(false);
    expect(
      await service.notificationAlertContext(target!, waitingSession, "approval"),
    ).toBeUndefined();
  });

  it("rejects changed payloads, another paired device, and actions from an ended subscription", async () => {
    waitingApproval();
    await pairBoundPhone("full");
    const original = await subscribedApproval();
    const firstPhone = { cookie, csrf };
    const body = actionBody(original);
    expect((await request("approve", { ...body, expectedRevision: 5 })).data).toMatchObject({
      error: "push_action_unavailable",
    });
    expect(receipts).not.toHaveBeenCalled();

    cookie = "";
    csrf = "";
    await pairBoundPhone("full", { ...binding, id: "b".repeat(32), sessionId: "b".repeat(36) });
    expect((await request("push/subscribe", optedIn)).status).toBe(200);
    expect((await request("approve", body)).status).toBe(403);
    expect(receipts).not.toHaveBeenCalled();

    ({ cookie, csrf } = firstPhone);
    expect((await request("push/subscribe", { ...optedIn, liveActivity: false })).status).toBe(200);
    expect((await request("approve", body)).status).toBe(403);
    const current = await subscribedApproval();
    expect(current.action.requestId).toBe(original.action.requestId);
    expect((await request("push/unsubscribe", {})).status).toBe(200);
    expect((await request("approve", actionBody(current))).status).toBe(403);
    expect(approvalsSent()).toEqual([]);
  });

  it("retains read-only descriptions and rejects actions after approval access is removed", async () => {
    waitingApproval();
    await pairBoundPhone("full");
    const notification = await subscribedApproval();
    const device = (await access()).data.device!;
    await service.request({ operation: "set-access", id: device.id, access: "read" });
    const readOnly = await service.notificationAlertContext(
      service.pushTargets()[0]!,
      waitingSession,
      "approval",
    );
    expect(readOnly).toMatchObject({ interaction: { kind: "approval", decisions: [] } });
    expect(readOnly).not.toHaveProperty("action");
    expect((await request("approve", actionBody(notification))).status).toBe(403);
    expect(approvalsSent()).toEqual([]);
  });

  it("does not revive old actions after unsubscribe and resubscribe in the same clock tick", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    waitingApproval();
    await pairBoundPhone("full");
    const first = await subscribedApproval();
    expect((await request("push/unsubscribe", {})).status).toBe(200);
    const restarted = await subscribedApproval();
    expect(restarted.action.requestId).toBe(first.action.requestId);
    expect((await request("approve", actionBody(first))).data).toMatchObject({
      error: "push_action_unavailable",
      controlOutcome: "not-dispatched",
    });
    expect((await request("approve", actionBody(restarted))).status).toBe(200);
    expect(approvalsSent()).toHaveLength(1);
  });

  it("refuses a stale runtime revision or an expired deadline before dispatch", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const snapshot = waitingApproval();
    await pairBoundPhone("full");
    const notification = await subscribedApproval();
    const body = actionBody(notification);
    snapshot.revision++;
    expect((await request("approve", body)).data).toMatchObject({
      error: "interaction_expired",
      controlOutcome: "not-dispatched",
    });
    snapshot.revision--;
    clock.mockReturnValue(notification.action.expiresAt);
    expect((await request("approve", body)).data).toMatchObject({
      error: "interaction_expired",
      controlOutcome: "not-dispatched",
    });
    expect(approvalsSent()).toEqual([]);
  });

  it("rechecks expiry after async state verification and before dispatch", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    waitingApproval();
    await pairBoundPhone("full");
    const notification = await subscribedApproval();
    clock.mockReturnValue(notification.action.expiresAt - 1);
    const runtime = nativeCalls.getMockImplementation()!;
    nativeCalls.mockImplementation((input) => {
      if (input.operation === "live") clock.mockReturnValue(notification.action.expiresAt);
      return runtime(input);
    });
    expect((await request("approve", actionBody(notification))).data).toMatchObject({
      error: "interaction_expired",
      controlOutcome: "not-dispatched",
    });
    expect(approvalsSent()).toEqual([]);
  });

  it("keeps an uncertain first choice in its original receipt and never sends a second choice", async () => {
    waitingApproval();
    await pairBoundPhone("full");
    const notification = await subscribedApproval();
    const accept = actionBody(notification);
    const decline = actionBody(notification, "choice:decline");
    expect(decline.requestId).toBe(accept.requestId);
    const runtime = nativeCalls.getMockImplementation()!;
    nativeCalls.mockImplementation((input) =>
      input.operation === "approve" ? Promise.resolve({ accepted: false }) : runtime(input),
    );
    expect((await request("approve", accept)).data).toMatchObject({
      error: "outcome_unknown",
      controlOutcome: "unknown",
    });
    const receipt = {
      found: true,
      requestId: accept.requestId,
      sessionId: waitingSession.id,
      workspaceId: waitingSession.workspace_id,
      operation: "approve",
      executionMode: "codex-managed",
    };
    receipts.mockResolvedValue({ ...receipt, status: "unknown" });
    const repeated = await request("approve", accept);
    const otherChoice = await request("approve", decline);
    for (const result of [repeated, otherChoice])
      expect(result.data).toMatchObject({ error: "outcome_unknown", controlOutcome: "unknown" });

    const device = (await access()).data.device!;
    const ack = { accepted: true, requestId: accept.requestId, runtimeBootId: "test-runtime" };
    receipts.mockResolvedValue({ ...receipt, status: "accepted", ack });
    expect((await request(`requests/${accept.requestId}`)).data).toMatchObject({
      found: true,
      status: "accepted",
      ack,
    });
    expect(receipts).toHaveBeenLastCalledWith({ requestId: accept.requestId, deviceId: device.id });
    expect((await request("approve", decline)).data).toMatchObject({ error: "duplicate_request" });
    expect(approvalsSent()).toHaveLength(1);
  });
});
