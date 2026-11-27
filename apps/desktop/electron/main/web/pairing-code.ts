import { randomInt } from "node:crypto";
import type { WebAccessLevel } from "./service";

const PAIRING_CODE_TTL_MS = 300_000;
const PAIRING_FAILURES_PER_BROWSER = 5;
// The global pairing rate caps a single code at about 100 attempts in five minutes.
const PAIRING_FAILURES_PER_CODE = 100;

export type PairingCode = {
  value: string;
  expiresAt: number;
  access: WebAccessLevel;
  failures: number;
  failuresByBrowser: Map<string, number>;
};

export function newPairingCode(access: WebAccessLevel = "full"): PairingCode {
  return {
    value: randomInt(0, 100_000_000).toString().padStart(8, "0"),
    expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
    access,
    failures: 0,
    failuresByBrowser: new Map(),
  };
}

export function tryPairingCode(
  code: PairingCode | undefined,
  browser: string,
  value: unknown,
): code is PairingCode {
  if (!code || code.expiresAt <= Date.now()) return false;
  const failures = code.failuresByBrowser.get(browser) ?? 0;
  if (
    failures >= PAIRING_FAILURES_PER_BROWSER ||
    code.failures >= PAIRING_FAILURES_PER_CODE ||
    value !== code.value
  ) {
    code.failuresByBrowser.set(browser, failures + 1);
    code.failures++;
    return false;
  }
  return true;
}
