import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type ClaudeRecord = {
  version: 1;
  id: string;
  workspaceId: string;
  workspace: string;
  registeredWorkspace: string | null;
  home: string;
  nativeId: string;
  title: string;
  createdAt: string;
  adopted: boolean;
  terminalHandover?: true;
  terminalHandoverLeaseId?: string;
  terminalAutoAdoptedAt?: string;
  released: boolean;
  fresh: boolean;
  fingerprint: string | null;
  snapshot: Record<string, unknown>;
  completedRequests: string[];
  forkSourceNativeId?: string;
  forkCutoff?: string;
  nativeTitle?: string;
};

/** Write the host snapshot atomically after the caller verifies the private directory. */
export function writeClaudeRecord(target: string, record: ClaudeRecord): void {
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid-Claude-metadata");
  }
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
