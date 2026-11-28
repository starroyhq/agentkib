import { assertPrivateRuntimePath } from "@agentkib/backend/local-runtime-ipc";
import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebDevice } from "./service";

/** Write revocations to the existing snapshot when staging or replacing it fails. */
export async function writeWebAccessSnapshot(
  directory: string,
  contents: string,
  revoking: boolean,
) {
  const file = join(directory, "web-access.json");
  try {
    await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return;
  } catch (error) {
    if (!revoking) throw error;
  }

  const parent = assertPrivateRuntimePath(directory, "directory", false);
  const existing = assertPrivateRuntimePath(file, "file", false);
  if ((process.getuid && (parent.mode & 0o022) !== 0) || existing.nlink !== 1)
    throw new Error("Unsafe Web access snapshot");
  const handle = await open(
    file,
    constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== existing.dev ||
      opened.ino !== existing.ino ||
      opened.uid !== existing.uid
    )
      throw new Error("Unsafe Web access snapshot");

    // An interrupted rewrite must leave invalid JSON instead of reviving a saved credential.
    await handle.truncate(0);
    await handle.sync();
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type Credential = {
  hash: string;
  expiresAt: number;
  device: WebDevice;
  binding?: string;
  /**
   * The account login of the phone, when it paired or later signed in on this computer's account.
   * The pairing ends with that login and is renewed while it lasts.
   */
  account?: AccountBinding;
  /** The phone asked this computer for notifications, sent to its account login. */
  push?: PushSubscription;
};
export type PushSubscription = {
  /** X25519, base64url: alerts are encrypted to it. */
  publicKey: string;
  /** The phone's own name for this computer, returned inside every alert. */
  ref: string;
  alerts: boolean;
  liveActivity: boolean;
  approvalActions?: 1;
  activityDetails?: 1;
  updatedAt: number;
};
export type AccountBinding = {
  accountId: string;
  sessionId: string;
  id?: string;
  expiresAt?: number;
  hostChallenge?: string;
};
export const SESSION_ID = /^[a-f0-9-]{36}$/;
const validAccountBinding = (value: unknown): value is AccountBinding => {
  const binding = value as AccountBinding;
  return (
    !!binding &&
    typeof binding.accountId === "string" &&
    binding.accountId.length > 0 &&
    binding.accountId.length <= 128 &&
    typeof binding.sessionId === "string" &&
    SESSION_ID.test(binding.sessionId) &&
    (binding.id === undefined ||
      (typeof binding.id === "string" &&
        /^[A-Za-z0-9_-]{32,128}$/.test(binding.id) &&
        Number.isSafeInteger(binding.expiresAt) &&
        binding.expiresAt! > 0 &&
        typeof binding.hostChallenge === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(binding.hostChallenge)))
  );
};

/** Keep authenticated record shape separate from expiry, which also stops its delegation. */
export function isStoredCredential(credential: Credential, lanBinding?: string): boolean {
  const { device } = credential;
  return (
    /^[a-f0-9]{64}$/.test(credential.hash) &&
    Number.isFinite(credential.expiresAt) &&
    (lanBinding === undefined || credential.binding === lanBinding) &&
    !!device &&
    typeof device.id === "string" &&
    typeof device.name === "string" &&
    typeof device.send === "boolean" &&
    typeof device.approve === "boolean" &&
    (device.accessMode === undefined ||
      (lanBinding === undefined && device.accessMode === "full")) &&
    (device.manage === undefined || typeof device.manage === "boolean") &&
    (device.files === undefined || typeof device.files === "boolean") &&
    // A pairing whose login cannot be read could never end with it: drop it.
    (credential.account === undefined || validAccountBinding(credential.account))
  );
}
