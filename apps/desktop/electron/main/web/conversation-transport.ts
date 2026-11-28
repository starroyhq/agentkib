import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_LEGACY_CODEX,
  REMOTE_RECEIPT_ROUTE,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
  REMOTE_ROUTE_PREFIXES,
  REMOTE_ROUTE_SPECS,
} from "@agentkib/runtime-protocol";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import { snapshotField } from "./catalog-stream";
import type { ConversationDispatchControl } from "./managed-websocket";

export function unavailableLive(sessionId: string) {
  // A compatibility projection, with no values from the inaccessible session.
  return {
    sessionId,
    status: "unavailable",
    revision: 0,
    sendEnabled: false,
    stopEnabled: false,
    approvals: [],
    questions: [],
    reason: REMOTE_ERROR_CODES.workspaceNotAuthorized,
  };
}

export interface ConversationRequest extends AsyncIterable<Uint8Array> {
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
}

/** Minimal response contract shared by HTTP and trusted desktop IPC. */
export interface ConversationResponse extends EventEmitter {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  setHeader(name: string, value: string): unknown;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  write(data: string): boolean;
  end(data?: string | Buffer): unknown;
  destroy(): unknown;
}

export function responseControlOutcome(control: ConversationDispatchControl) {
  if (!control.request) return {};
  return {
    controlOutcome:
      control.dispatched || control.priorUncertain
        ? REMOTE_CONTROL_OUTCOMES.unknown
        : REMOTE_CONTROL_OUTCOMES.notDispatched,
  };
}

export class LocalConversationResponse extends EventEmitter implements ConversationResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  body: unknown;
  setHeader(_name: string, _value: string) {}
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
  }
  write(_data: string): boolean {
    throw new Error("stream_requires_subscription");
  }
  end(data?: string | Buffer) {
    this.body = data ? JSON.parse(data.toString()) : undefined;
    this.writableEnded = true;
    this.emit("finish");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

export function correlatedControlOutcome(
  ack: unknown,
  requestId: string,
  sessionId: string,
  runtimeBootId: unknown,
) {
  if (
    typeof runtimeBootId !== "string" ||
    !runtimeBootId ||
    snapshotField(ack, "requestId") !== requestId ||
    snapshotField(ack, "sessionId") !== sessionId ||
    snapshotField(ack, "runtimeBootId") !== runtimeBootId
  )
    return undefined;
  const accepted = snapshotField(ack, "accepted");
  const outcome = snapshotField(ack, "controlOutcome");
  if (accepted === true && (outcome === undefined || outcome === "accepted")) return "accepted";
  if (accepted === false && outcome === REMOTE_CONTROL_OUTCOMES.notDispatched)
    return REMOTE_CONTROL_OUTCOMES.notDispatched;
  return undefined;
}

export function relativeConversationPath(pathname: string): string {
  return pathname.startsWith(`${REMOTE_ROUTE_BASE}/`)
    ? pathname.slice(REMOTE_ROUTE_BASE.length)
    : pathname;
}

export function isConversationReceiptPath(pathname: string): boolean {
  const prefix = REMOTE_ROUTE_PREFIXES.requests;
  return (
    pathname.startsWith(prefix) && /^[A-Za-z0-9_-]{1,128}$/.test(pathname.slice(prefix.length))
  );
}

export function codexPostOperation(pathname: string): string | undefined {
  const { prefix, postOperations } = REMOTE_LEGACY_CODEX;
  if (!pathname.startsWith(prefix)) return;
  const operation = pathname.slice(prefix.length);
  if (postOperations.includes(operation)) return operation;
}

export function isLegacyCodexPostPath(pathname: string): boolean {
  return codexPostOperation(pathname) !== undefined;
}

function routeSpec(method: string | undefined, path: string) {
  if (method !== "GET" && method !== "POST") return undefined;
  const routes = REMOTE_ROUTE_SPECS[method];
  return Object.hasOwn(routes, path) ? routes[path] : undefined;
}

export function lanPreflightAllowed(method: string | undefined, path: string): boolean {
  const receiptPrefix = REMOTE_ROUTE_PREFIXES.requests;
  // Receipt IDs are dynamic. LAN clients also need to recover ambiguous control outcomes.
  return (
    routeSpec(method, path)?.lan === true ||
    (REMOTE_RECEIPT_ROUTE.lan &&
      method === REMOTE_RECEIPT_ROUTE.method &&
      path.startsWith(receiptPrefix) &&
      path.length > receiptPrefix.length &&
      !path.includes("/", receiptPrefix.length))
  );
}

export function isControlRequest(method: string | undefined, path: string): boolean {
  if (routeSpec(method, path)?.control) return true;
  // The remaining legacy POSTs are control requests. Inspect is a read-only probe.
  return (
    method === "POST" &&
    path.startsWith(REMOTE_LEGACY_CODEX.prefix) &&
    path !== REMOTE_LEGACY_CODEX.nonControlPath
  );
}

/** Only bounded history reads can be cancelled through the trusted desktop bridge. */
export function isHistoryReadConversationPath(path: string): boolean {
  if (path.includes("\\")) return false;
  if (!path.startsWith("/")) path = `/${path}`;
  const url = new URL(path, "http://local");
  if (url.origin !== "http://local" || url.search || url.hash) return false;
  const name = relativeConversationPath(url.pathname);
  return [
    REMOTE_ROUTE.historySearch,
    REMOTE_ROUTE.historyLocate,
    REMOTE_ROUTE.historyReferences,
    REMOTE_ROUTE.historyStatus,
  ].some((route) => route === name);
}

// This is a closed application API, never an arbitrary Runtime or HTTP proxy.
export function isConversationPath(path: string, post: boolean) {
  if (!path.startsWith("/") || path.includes("\\")) return false;
  const url = new URL(path, "http://local");
  if (url.origin !== "http://local") return false;
  const name = relativeConversationPath(url.pathname);
  return post
    ? [
        REMOTE_ROUTE.pushPolicy,
        REMOTE_ROUTE.approvalRulesRevoke,
        REMOTE_ROUTE.readState,
        REMOTE_ROUTE.sessionPin,
        REMOTE_ROUTE.historySearch,
        REMOTE_ROUTE.historyLocate,
        REMOTE_ROUTE.historyReferences,
        REMOTE_ROUTE.historyConfigure,
        REMOTE_ROUTE.historyClear,
        REMOTE_ROUTE.historyRebuild,
        REMOTE_ROUTE.send,
        REMOTE_ROUTE.stop,
        REMOTE_ROUTE.devinTerminal,
        REMOTE_ROUTE.approve,
        REMOTE_ROUTE.answer,
        REMOTE_ROUTE.abandonRequest,
        REMOTE_ROUTE.artifactTickets,
        REMOTE_ROUTE.attachments,
        REMOTE_ROUTE.attachmentsDelete,
        REMOTE_ROUTE.managedCreate,
        REMOTE_ROUTE.managedRelease,
        REMOTE_ROUTE.managedReconcile,
        REMOTE_ROUTE.managedAction,
        REMOTE_ROUTE.managedSettingsPrepare,
      ].some((route) => route === name) || isLegacyCodexPostPath(name)
    : [
        REMOTE_ROUTE.pushPolicy,
        REMOTE_ROUTE.pushActivity,
        REMOTE_ROUTE.approvalAudit,
        REMOTE_ROUTE.approvalRules,
        REMOTE_ROUTE.readState,
        REMOTE_ROUTE.historyStatus,
        REMOTE_ROUTE.access,
        REMOTE_ROUTE.info,
        REMOTE_ROUTE.catalog,
        REMOTE_ROUTE.events,
        REMOTE_ROUTE.subagentEvents,
        REMOTE_ROUTE.sessionImages,
        REMOTE_ROUTE.live,
        REMOTE_ROUTE.attachments,
        REMOTE_ROUTE.codexCapabilities,
        REMOTE_ROUTE.codexQueue,
        REMOTE_ROUTE.codexSessionSettings,
        REMOTE_ROUTE.codexGoals,
        REMOTE_ROUTE.codexContextOptions,
        REMOTE_ROUTE.managedOptions,
        REMOTE_ROUTE.managedCapabilities,
        REMOTE_ROUTE.managedInspect,
        REMOTE_ROUTE.managedContext,
        REMOTE_ROUTE.managedResumeCommand,
        REMOTE_ROUTE.managedSettings,
        REMOTE_ROUTE.managedQueue,
        REMOTE_ROUTE.managedGoals,
        REMOTE_ROUTE.managedResources,
        REMOTE_ROUTE.filesWorkspaces,
        REMOTE_ROUTE.filesList,
        REMOTE_ROUTE.filesText,
        REMOTE_ROUTE.artifacts,
        REMOTE_ROUTE.artifactsResolve,
        REMOTE_ROUTE.diff,
      ].some((route) => route === name) || isConversationReceiptPath(name);
}
