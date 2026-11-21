import type { LiveSessionAgent } from "@agentkib/runtime-protocol";

export type ProviderValidationRequest = {
  operation: string;
  legacyCodex: boolean;
  settings?: { body: Record<string, unknown>; state: unknown };
};

export type ProviderValidationContext = {
  executionMode?: string;
  verifiedClaudeManaged: boolean;
  verifiedSerialQueue: boolean;
  requireFullAccess: () => void;
};

export type ProviderValidation = {
  available: boolean;
  publicReceipt?: boolean;
  queueItem?: "pending" | "pending-or-unknown";
  requiresSend?: boolean;
  requiresFullAccess?: boolean;
  textOnlyQueue?: boolean;
  useCommandAccess?: boolean;
  inputFormat?: "codex" | "claude" | "dsh";
  idleExecutionMode?: string;
  settings?: Record<string, unknown>;
};

export type ProviderControlValidator = (
  request: ProviderValidationRequest,
  context: ProviderValidationContext,
) => ProviderValidation;

export type HostControlValidationCall = {
  sessionId: string;
  request: ProviderValidationRequest;
  executionMode?: string;
  verified: Partial<Record<LiveSessionAgent, boolean>>;
  fullAccess: boolean;
};

export type HostControlValidationResult =
  | { result: ProviderValidation }
  | { error: string; status: 400 | 403 | 409 };
