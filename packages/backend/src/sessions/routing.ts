import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { z } from "zod";
import {
  sessionResultProjectors,
  type SessionProviderOperation,
  type SessionProviderRequest,
  type SessionProviderResponse,
} from "../session-provider";

export type SessionMethod =
  | typeof RUNTIME_METHODS.codexManaged
  | typeof RUNTIME_METHODS.claudeManaged
  | typeof RUNTIME_METHODS.webRequest
  | typeof RUNTIME_METHODS.sessionRequest;

const sessionMethods: ReadonlySet<string> = new Set<SessionMethod>([
  RUNTIME_METHODS.codexManaged,
  RUNTIME_METHODS.claudeManaged,
  RUNTIME_METHODS.webRequest,
  RUNTIME_METHODS.sessionRequest,
]);

export function isSessionMethod(method: string): method is SessionMethod {
  return sessionMethods.has(method);
}

const sessionId = z.string().min(1).max(256);
const deviceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:-]+$/);

export const sessionQuerySchema = z.strictObject({
  operation: z.enum(["capabilities", "inspect"]),
  sessionId,
  deviceId: deviceId.optional(),
  experimentalEnabled: z.boolean().optional(),
});

export function isSessionOperation(operation: unknown): operation is SessionProviderOperation {
  return typeof operation === "string" && Object.hasOwn(sessionResultProjectors, operation);
}

export function readSessionRequest(value: Record<string, unknown>): {
  agent: unknown;
  request: SessionProviderRequest;
} {
  const { operation, agent, ...fields } = value;
  if (!isSessionOperation(operation)) throw new Error("unsupported-session-provider-operation");
  if (operation === "create") {
    sessionId.parse(fields.workspaceId);
    z.string().uuid().parse(fields.requestId);
    deviceId.parse(fields.deviceId);
  } else {
    sessionId.parse(fields.sessionId);
    if (agent !== undefined) throw new Error("invalid-request");
    deviceId.optional().parse(fields.deviceId);
    z.boolean().optional().parse(fields.experimentalEnabled);
  }
  // Native validators handle the operation payload and fingerprint the original field values.
  return { agent, request: { operation, ...fields } as SessionProviderRequest };
}

export function restrictSessionCommands(
  request: SessionProviderRequest,
  response: SessionProviderResponse,
): SessionProviderResponse {
  // Stage 10 will apply the host's device grants. A device ID alone cannot authorize a catalog.
  if (response.operation !== "capabilities" || !("deviceId" in request) || !request.deviceId)
    return response;
  const { commands: _commands, commandMenu: _menu, ...result } = response.result;
  return { operation: response.operation, result };
}

export function legacySessionFields(request: SessionProviderRequest): Record<string, unknown> {
  // Existing readers validate the fields they have always accepted, even though the new
  // read envelope also carries the host's device identity.
  if (request.operation === "live") {
    const { operation, sessionId, experimentalEnabled } = request;
    return { operation, sessionId, experimentalEnabled };
  }
  if (request.operation === "queue-list") {
    const { operation, sessionId, limit } = request;
    return { operation, sessionId, limit };
  }
  return request;
}
