import { REMOTE_ERROR_CODES, type RemoteErrorCode } from "./generated/remote-contract";

const registered = new Map<string, RemoteErrorCode>(
  Object.values(REMOTE_ERROR_CODES).map((code) => [code, code]),
);

/** Untrusted runtime values and HTTP bodies may contain text instead of a code. */
export function parseRemoteErrorCode(value: unknown): RemoteErrorCode | undefined {
  return typeof value === "string" ? registered.get(value) : undefined;
}
