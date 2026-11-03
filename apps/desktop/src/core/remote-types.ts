import type { ConversationReadState } from "@agentkib/runtime-protocol";
import type { ConversationEventPage, ConversationSessionSummary, WorkspaceSummary } from "./types";

export type RemoteRequest =
  | { operation: "status" | "discover" | "generate-code" }
  | { operation: "configure"; enabled: boolean; address: string; name: string }
  | { operation: "pair"; address: string; code: string }
  | { operation: "approve" | "reject" | "connect" | "disconnect" | "remove" | "revoke"; id: string }
  | { operation: "catalog"; id: string }
  | { operation: "read-state"; id: string; sessionId: string }
  | {
      operation: "read-state-update";
      id: string;
      sessionId: string;
      expectedVersion: string;
      seenResultId: string | null;
    }
  | { operation: "events"; id: string; sessionId: string; cursor?: string | null; limit?: number };

export interface RemoteConnection {
  id: string;
  name: string;
  address: string;
  status:
    | "pending"
    | "online"
    | "offline"
    | "disconnected"
    | "revoked"
    | "sharing-disabled"
    | "index-disabled"
    | "identity-changed"
    | "expired"
    | "rejected";
  last_seen: number | null;
  error: string | null;
}

export interface RemoteStatus {
  local: { id: string; name: string; enabled: boolean; address: string | null };
  interfaces: Array<{ address: string; name: string }>;
  discovered: Array<{ id: string; name: string; address: string }>;
  pending: Array<{
    id: string;
    device_id: string;
    name: string;
    verification: string;
    expires_at: number;
  }>;
  authorized: Array<{ id: string; name: string; approved_at: number; last_seen: number | null }>;
  connections: RemoteConnection[];
  pairing_code: string | null;
  pairing_expires_at: number | null;
}

export interface RemotePairingResult {
  id: string;
  verification: string;
  status: "pending";
  expires_at: number;
}

export interface RemoteCatalog {
  workspaces: WorkspaceSummary[];
  sessions: ConversationSessionSummary[];
}

export type RemoteResponse<T extends RemoteRequest> = T extends { operation: "pair" }
  ? RemotePairingResult
  : T extends { operation: "catalog" }
    ? RemoteCatalog
    : T extends { operation: "read-state" | "read-state-update" }
      ? { readState: ConversationReadState }
      : T extends { operation: "events" }
        ? ConversationEventPage
        : RemoteStatus;
