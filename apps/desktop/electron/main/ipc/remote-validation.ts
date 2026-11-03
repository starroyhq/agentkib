import { isIPv4 } from "node:net";
import type { RemoteRequest } from "../../../src/core/remote-types";
import { requireObject } from "./validation";

export function requireRemoteRequest(value: unknown): RemoteRequest {
  const input = requireObject(value, "remote request");
  const text = (key: string, max: number): string => {
    const value = input[key];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      /[\u0000-\u001f]/u.test(value)
    ) {
      throw new TypeError(`Invalid remote ${key}`);
    }
    return value;
  };
  const only = (...keys: string[]) => {
    if (Object.keys(input).some((key) => !["operation", ...keys].includes(key))) {
      throw new TypeError("Unexpected remote request field");
    }
  };
  const address = (withPort: boolean): string => {
    const value = text("address", 32);
    const [host, port, extra] = value.split(":");
    if (
      !isIPv4(host) ||
      extra !== undefined ||
      (withPort && port === undefined) ||
      (port !== undefined && (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535))
    ) {
      throw new TypeError("Remote address must be an IPv4 address with a valid port");
    }
    return value;
  };
  switch (input.operation) {
    case "status":
    case "discover":
    case "generate-code":
      only();
      return { operation: input.operation };
    case "configure": {
      only("enabled", "address", "name");
      if (typeof input.enabled !== "boolean") throw new TypeError("Invalid remote enabled");
      return {
        operation: "configure",
        enabled: input.enabled,
        address: input.address === "" && !input.enabled ? "" : address(true),
        name: text("name", 80),
      };
    }
    case "pair":
      only("address", "code");
      if (typeof input.code !== "string" || !/^\d{8}$/u.test(input.code))
        throw new TypeError("Invalid pairing code");
      return { operation: "pair", address: address(true), code: input.code };
    case "approve":
    case "reject":
    case "connect":
    case "disconnect":
    case "remove":
    case "revoke":
    case "catalog":
      only("id");
      return { operation: input.operation, id: text("id", 256) };
    case "read-state":
      only("id", "sessionId");
      return { operation: "read-state", id: text("id", 256), sessionId: text("sessionId", 256) };
    case "read-state-update":
      only("id", "sessionId", "expectedVersion", "seenResultId");
      if (!(input.seenResultId === null || typeof input.seenResultId === "string"))
        throw new TypeError("Invalid remote seenResultId");
      return {
        operation: "read-state-update",
        id: text("id", 256),
        sessionId: text("sessionId", 256),
        expectedVersion: text("expectedVersion", 4096),
        seenResultId: input.seenResultId === null ? null : text("seenResultId", 4096),
      };
    case "events": {
      only("id", "sessionId", "cursor", "limit");
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
      ) {
        throw new TypeError("Invalid remote event limit");
      }
      const cursor = input.cursor == null ? undefined : text("cursor", 1024);
      return {
        operation: "events",
        id: text("id", 256),
        sessionId: text("sessionId", 256),
        cursor,
        limit: input.limit as number | undefined,
      };
    }
    default:
      throw new TypeError("Unsupported remote operation");
  }
}
