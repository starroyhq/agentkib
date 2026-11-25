import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { acquirePortableFileLease, existingFileLeaseBusy } from "./managed-session-lock";
import { isReparseOrSymlink } from "./native-files";

export const LOCAL_RUNTIME_IDENTITY = "localRuntime.identity";
export const LOCAL_RUNTIME_PRESENCE = "localRuntime.presence";
export const LOCAL_RUNTIME_PRESENCE_CHANGED = "localRuntime.presenceChanged";
export type LocalRuntimeIdentity = { version: string };
export type LocalRuntimePresence = { peers: number; primary: boolean };

const AUTH_TIMEOUT_MS = 3000;
const TLS_IDENTITY = "agentkib-local-runtime-v1";
const TLS_OPTIONS = {
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256",
} as const;

export function localRuntimePaths(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Local runtime directory must be absolute");
  const normalized = path.resolve(root);
  const namespace = createHash("sha256").update(normalized.toLowerCase()).digest("hex");
  return {
    root: normalized,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\agentkib-runtime-v1-${namespace}`
        : path.join(normalized, "runtime-v1.sock"),
    key: path.join(normalized, "runtime-v1.key"),
    lock: path.join(normalized, "runtime-v1.lock"),
  };
}

export function localRuntimeLeaseBusy(root: string): boolean {
  return existingFileLeaseBusy(localRuntimePaths(root).lock);
}

/** Serializes desktop launches separately from the lease owned by the service itself. */
export function tryAcquireLocalRuntimeLaunchLease(root: string): (() => void) | undefined {
  const directory = localRuntimePaths(root).root;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateRuntimePath(directory, "directory");
  try {
    return acquirePortableFileLease(path.join(directory, "runtime-v1-launch.lock"));
  } catch (error) {
    if (error instanceof Error && error.message === "session-managed-by-another-runtime")
      return undefined;
    throw error;
  }
}

export function assertPrivateRuntimePath(
  file: string,
  kind: "directory" | "file" | "socket",
  requirePrivatePermissions = true,
) {
  const stat = lstatSync(file);
  const correctType =
    kind === "directory" ? stat.isDirectory() : kind === "file" ? stat.isFile() : stat.isSocket();
  if (
    !correctType ||
    isReparseOrSymlink(file, stat) ||
    (process.getuid &&
      (stat.uid !== process.getuid() || (requirePrivatePermissions && (stat.mode & 0o077) !== 0)))
  )
    throw new Error(`Invalid local runtime ${kind}`);
  return stat;
}

function keyGeneration(stat: ReturnType<typeof assertPrivateRuntimePath>): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`;
}

export function localRuntimeKeyGeneration(root: string): string | undefined {
  try {
    return keyGeneration(assertPrivateRuntimePath(localRuntimePaths(root).key, "file"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readKey(root: string, file: string) {
  assertPrivateRuntimePath(root, "directory");
  const stat = assertPrivateRuntimePath(file, "file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== 32
    )
      throw new Error("Invalid local runtime key");
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error("Invalid local runtime key");
    return { key, generation: keyGeneration(opened) };
  } finally {
    closeSync(fd);
  }
}

/** Private PSK authentication also protects the channel against named-pipe impersonation. */
export async function openLocalRuntime(root: string): Promise<{
  socket: TLSSocket;
  generation: string;
}> {
  const paths = localRuntimePaths(root);
  const { key, generation } = readKey(paths.root, paths.key);
  if (process.platform !== "win32") assertPrivateRuntimePath(paths.endpoint, "socket");
  const socket = connect({
    ...TLS_OPTIONS,
    path: paths.endpoint,
    // Only PSK ciphers are allowed. The shared key authenticates the peer without certificates.
    rejectUnauthorized: false,
    pskCallback: () => ({ psk: key, identity: TLS_IDENTITY }),
  });
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off("secureConnect", ready).off("error", finish).off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const closed = () => finish(new Error("Local runtime disconnected during authentication"));
      const timer = setTimeout(
        () => finish(new Error("Local runtime authentication timed out")),
        AUTH_TIMEOUT_MS,
      );
      socket.once("secureConnect", ready).once("error", finish).once("close", closed);
    });
    if (!socket.getCipher()?.name.includes("PSK")) throw new Error("Unverified local runtime host");
    return { socket, generation };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function connectLocalRuntime(root: string): Promise<TLSSocket> {
  return (await openLocalRuntime(root)).socket;
}

export function createLocalRuntimeServer(key: Buffer, accept: (socket: TLSSocket) => void) {
  return createServer(
    {
      ...TLS_OPTIONS,
      handshakeTimeout: AUTH_TIMEOUT_MS,
      pskCallback: (_socket, identity) => (identity === TLS_IDENTITY ? key : null),
    },
    accept,
  );
}
