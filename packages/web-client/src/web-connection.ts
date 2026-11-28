import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";

export type WebConnection = { type: "same-origin" } | { type: "lan-http"; origin: string };

/** An origin string selects private LAN HTTP. */
export function resolveWebConnection(connection: WebConnection | string = ""): WebConnection {
  const value =
    typeof connection === "string"
      ? connection
        ? { type: "lan-http" as const, origin: connection }
        : { type: "same-origin" as const }
      : connection;
  if (value.type === "lan-http") {
    if (parseLanOrigin(value.origin) !== value.origin)
      throw new Error(REMOTE_ERROR_CODES.invalidLanAddress);
    return { type: "lan-http", origin: value.origin };
  }
  return { type: "same-origin" };
}

/** Reject alternate numeric spellings before URL normalization can hide them. */
export function parseLanOrigin(value: string): string {
  const match = /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (!match) throw new Error(REMOTE_ERROR_CODES.invalidLanAddress);
  const octets = match[1].split(".").map(Number);
  if (octets.some((n, i) => n > 255 || String(n) !== match[1].split(".")[i]))
    throw new Error(REMOTE_ERROR_CODES.invalidLanAddress);
  const [a, b] = octets,
    port = Number(match[2]);
  if (
    !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== match[2]
  )
    throw new Error(REMOTE_ERROR_CODES.invalidLanAddress);
  return `http://${match[1]}:${port}`;
}
