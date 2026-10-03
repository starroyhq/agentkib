import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isIPv4 } from "node:net";
import tls, { type ConnectionOptions, type TlsOptions, type TLSSocket } from "node:tls";
import { nativeBindings } from "./native-files";

const IDENTITY_LIMIT = 32_768;
const CERTIFICATE_LIMIT = 8192;
const PRIVATE_KEY_LIMIT = 4096;
const HOSTNAME = "agentkib.local";
const PROTOCOL_VERSION = 1;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_REQUEST = 16 * 1024;
const PAIRING_EXPORTER_LABEL = "agentkib-pairing-v1";

type StoredIdentity = { certificate: number[]; private_key: number[] };

export type RemoteTlsIdentity = {
  id: string;
  certificate: Buffer;
  privateKey: Buffer;
  serverOptions: TlsOptions;
  clientOptions: ConnectionOptions;
};

export type RemoteExchange = { result: unknown; peerId: string; verification: string };
export type RemoteTlsRequestHandler = (
  peerId: string,
  verification: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
export type RemoteTlsListener = {
  address: string;
  close(): Promise<void>;
  disconnectPeer(peerId: string): void;
};

/** Load or create the long-lived P-256 identity shared with the native mTLS implementation. */
export function loadRemoteTlsIdentity(dataDirectory: string): RemoteTlsIdentity {
  const directory = path.join(dataDirectory, "remote");
  ensurePrivateDirectory(directory);
  const file = path.join(directory, "identity.json");
  let value: StoredIdentity;
  if (existsSync(file)) {
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size >= IDENTITY_LIMIT)
      throw new Error("invalid-remote-identity");
    restrictRemotePath(file);
    value = parseStoredIdentity(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } else {
    value = generateIdentity();
    writePrivateIdentity(file, value);
  }

  const certificate = Buffer.from(value.certificate);
  const privateKey = Buffer.from(value.private_key);
  if (certificate.length === 0 || certificate.length > CERTIFICATE_LIMIT)
    throw new Error("invalid-remote-identity");
  if (privateKey.length === 0 || privateKey.length > PRIVATE_KEY_LIMIT)
    throw new Error("invalid-remote-identity");
  const key = parsePrivateKey(privateKey);
  const cert = parseCertificate(certificate);
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" });
  const certificatePublicKey = cert.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.from(publicKey).equals(Buffer.from(certificatePublicKey)))
    throw new Error("remote-identity-key-mismatch");
  if (!cert.verify(cert.publicKey) || !cert.checkHost(HOSTNAME))
    throw new Error("invalid-remote-certificate");

  const certificatePem = pem("CERTIFICATE", certificate);
  const privateKeyPem = pem("PRIVATE KEY", privateKey);
  const id = createHash("sha256").update(certificate).digest("hex");
  return {
    id,
    certificate,
    privateKey,
    serverOptions: {
      cert: certificatePem,
      key: privateKeyPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      // Unknown device certificates are allowed only for TLS proof-of-possession.
      // The service must pin the peer certificate before processing its request.
      rejectUnauthorized: false,
    },
    clientOptions: {
      cert: certificatePem,
      key: privateKeyPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: false,
    },
  };
}

/** Perform the versioned, length-prefixed TLS 1.3 request used by paired AgentKib devices. */
export async function exchangeRemotePeer(
  identity: RemoteTlsIdentity,
  address: string,
  pin: string | null,
  body: Record<string, unknown>,
  options: { allowLoopback?: boolean; signal?: AbortSignal } = {},
): Promise<RemoteExchange> {
  const target = parsePrivateAddress(address, options.allowLoopback === true);
  if (options.signal?.aborted) throw new Error("REMOTE_DISCONNECTED");
  const socket = tls.connect({
    ...identity.clientOptions,
    host: target.host,
    port: target.port,
    servername: HOSTNAME,
  });
  const cancel = () => socket.destroy(new Error("REMOTE_DISCONNECTED"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  socket.setTimeout(10_000, () => socket.destroy(new Error("REMOTE_OFFLINE")));
  try {
    await waitForSecureConnection(socket);
    const peerCertificate = socket.getPeerCertificate(true).raw;
    if (!peerCertificate || peerCertificate.length > CERTIFICATE_LIMIT)
      throw new Error("missing device certificate");
    const peerId = createHash("sha256").update(peerCertificate).digest("hex");
    if (pin !== null && pin !== peerId) throw new Error("REMOTE_IDENTITY_CHANGED");
    const exporter = socket.exportKeyingMaterial(32, PAIRING_EXPORTER_LABEL, Buffer.alloc(0));
    const verification = pairingVerification(exporter, identity.id, peerId);
    await writeFrame(socket, { version: PROTOCOL_VERSION, request: body }, MAX_REQUEST);
    const response = await readFrame(socket, MAX_FRAME);
    if (!isObject(response) || response.version !== PROTOCOL_VERSION)
      throw new Error("REMOTE_PROTOCOL_MISMATCH");
    if (typeof response.error === "string") throw new Error(safeRemoteError(response.error));
    if (!("result" in response)) throw new Error("REMOTE_REQUEST_FAILED");
    return { result: response.result, peerId, verification };
  } catch (error) {
    if (error instanceof Error && /^(REMOTE_|TRANSCRIPT_)/.test(error.message)) throw error;
    throw new Error("REMOTE_OFFLINE");
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    socket.destroy();
  }
}

/** Bind the matching TLS 1.3 endpoint; the handler owns pairing, grants and request policy. */
export async function listenRemoteAgent(
  identity: RemoteTlsIdentity,
  address: string,
  handle: RemoteTlsRequestHandler,
  options: { allowLoopback?: boolean } = {},
): Promise<RemoteTlsListener> {
  const allowLoopback = options.allowLoopback === true;
  const target = parsePrivateAddress(address, allowLoopback, allowLoopback);
  const active = new Map<TLSSocket, { peerId: string; abort: AbortController }>();
  const server = tls.createServer(identity.serverOptions);
  server.on("secureConnection", (socket) => {
    const remoteAddress = socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!remoteAddress || !isPrivateIPv4(remoteAddress, allowLoopback) || active.size >= 16) {
      socket.destroy();
      return;
    }
    const certificate = socket.getPeerCertificate(true).raw;
    if (!certificate || certificate.length > CERTIFICATE_LIMIT) {
      socket.destroy();
      return;
    }
    const peerId = createHash("sha256").update(certificate).digest("hex");
    const exporter = socket.exportKeyingMaterial(32, PAIRING_EXPORTER_LABEL, Buffer.alloc(0));
    const verification = pairingVerification(exporter, peerId, identity.id);
    const abort = new AbortController();
    active.set(socket, { peerId, abort });
    socket.setTimeout(10_000, () => socket.destroy(new Error("request timed out")));
    socket.once("close", () => {
      abort.abort();
      active.delete(socket);
    });
    void (async () => {
      let response: Record<string, unknown>;
      try {
        const frame = await readFrame(socket, MAX_REQUEST);
        if (!isObject(frame) || frame.version !== PROTOCOL_VERSION || !isObject(frame.request))
          throw new Error("unsupported protocol");
        const result = await handle(peerId, verification, frame.request, abort.signal);
        response = { version: PROTOCOL_VERSION, result };
      } catch (error) {
        response = { version: PROTOCOL_VERSION, error: wireError(error) };
      }
      try {
        await writeFrame(socket, response, MAX_FRAME);
        socket.end();
      } catch {
        socket.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target.port, target.host);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("remote-listener-unavailable");
  }
  return {
    address: `${target.host}:${bound.port}`,
    disconnectPeer(peerId) {
      for (const [socket, entry] of active) {
        if (entry.peerId === peerId) {
          entry.abort.abort();
          socket.destroy(new Error("revoked"));
        }
      }
    },
    async close() {
      for (const [socket, entry] of active) {
        entry.abort.abort();
        socket.destroy(new Error("sharing disabled"));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseStoredIdentity(value: unknown): StoredIdentity {
  if (!isObject(value)) throw new Error("invalid-remote-identity");
  const certificate = value.certificate;
  const privateKey = value.private_key;
  if (
    !validByteArray(certificate, CERTIFICATE_LIMIT) ||
    !validByteArray(privateKey, PRIVATE_KEY_LIMIT)
  )
    throw new Error("invalid-remote-identity");
  return { certificate, private_key: privateKey };
}

function validByteArray(value: unknown, limit: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= limit &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function generateIdentity(): StoredIdentity {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  const privateKey = Buffer.from(pair.privateKey);
  const key = createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" });
  const certificate = createSelfSignedCertificate(key, Buffer.from(pair.publicKey));
  return { certificate: [...certificate], private_key: [...privateKey] };
}

function parsePrivateKey(value: Buffer): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: value, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("invalid-remote-identity");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("invalid-remote-identity");
  return key;
}

function parseCertificate(value: Buffer): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(value);
  } catch {
    throw new Error("invalid-remote-certificate");
  }
  return certificate;
}

function createSelfSignedCertificate(key: KeyObject, subjectPublicKeyInfo: Buffer): Buffer {
  const extension = (oid: string, contents: Buffer, critical = false) =>
    sequence([
      objectIdentifier(oid),
      ...(critical ? [derValue(0x01, Buffer.from([0xff]))] : []),
      derValue(0x04, contents),
    ]);
  const subjectAltName = sequence([derValue(0x82, Buffer.from(HOSTNAME, "ascii"))]);
  const basicConstraints = sequence([]);
  const keyUsage = derValue(0x03, Buffer.from([7, 0x80]));
  const extendedKeyUsage = sequence([
    objectIdentifier("1.3.6.1.5.5.7.3.1"),
    objectIdentifier("1.3.6.1.5.5.7.3.2"),
  ]);
  const extensions = sequence([
    extension("2.5.29.19", basicConstraints, true),
    extension("2.5.29.15", keyUsage, true),
    extension("2.5.29.37", extendedKeyUsage),
    extension("2.5.29.17", subjectAltName),
  ]);
  const algorithm = sequence([objectIdentifier("1.2.840.10045.4.3.2")]);
  const tbs = sequence([
    derValue(0xa0, derValue(0x02, Buffer.from([2]))),
    derValue(0x02, positiveInteger(randomBytes(20))),
    algorithm,
    sequence([]),
    sequence([utcTime(Date.now() - 86_400_000), utcTime(Date.now() + 10 * 365 * 86_400_000)]),
    sequence([]),
    subjectPublicKeyInfo,
    derValue(0xa3, extensions),
  ]);
  const signature = sign("sha256", tbs, key);
  return sequence([tbs, algorithm, derValue(0x03, Buffer.concat([Buffer.from([0]), signature]))]);
}

function ensurePrivateDirectory(directory: string): void {
  const parent = path.dirname(directory);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
    throw new Error("remote-identity-parent-symlink");
  if (existsSync(directory)) {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error("invalid-remote-identity-directory");
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  restrictRemotePath(directory, true);
}

function writePrivateIdentity(file: string, identity: StoredIdentity): void {
  const parent = path.dirname(file);
  const temp = path.join(parent, `.identity-${randomUUID()}.tmp`);
  const value = Buffer.from(JSON.stringify(identity));
  if (value.length >= IDENTITY_LIMIT) throw new Error("invalid-remote-identity");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    restrictRemotePath(temp);
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error("remote-identity-symlink");
    renameSync(temp, file);
    restrictRemotePath(file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch {
      // The temporary identity may already have been renamed or removed.
    }
    throw error;
  }
}

export function restrictRemotePath(file: string, directory = false): void {
  if (process.platform !== "win32") {
    chmodSync(file, directory ? 0o700 : 0o600);
    return;
  }
  const ffi = nativeBindings();
  const advapi = ffi.load("advapi32.dll");
  const kernel = ffi.load("kernel32.dll");
  const convert = advapi.func(
    "__stdcall",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "int",
    ["str16", "uint", ffi.out(ffi.pointer("void", 2)), "void *"],
  );
  const set = advapi.func("__stdcall", "SetFileSecurityW", "int", ["str16", "uint", "void *"]);
  const free = kernel.func("__stdcall", "LocalFree", "void *", ["void *"]);
  const error = kernel.func("__stdcall", "GetLastError", "uint", []);
  const descriptor: [unknown] = [null];
  const security = directory ? "D:P(A;OICI;FA;;;OW)" : "D:P(A;;FA;;;OW)";
  if (!convert(security, 1, descriptor, null) || !descriptor[0])
    throw new Error(`Cannot create private remote ACL (${error()})`);
  const result = set(file, 0x00000004 | 0x80000000, descriptor[0]);
  free(descriptor[0]);
  if (!result) throw new Error(`Cannot protect remote identity (${error()})`);
}

function pem(label: string, value: Buffer): string {
  const encoded =
    value
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----\n`;
}

function utcTime(timestamp: number): Buffer {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear() % 100;
  const text = `${String(year).padStart(2, "0")}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
  return derValue(0x17, Buffer.from(text, "ascii"));
}

function positiveInteger(value: Buffer): Buffer {
  const normalized = Buffer.from(value);
  normalized[0] = normalized[0]! & 0x7f;
  if (normalized.every((byte) => byte === 0)) normalized[normalized.length - 1] = 1;
  let first = 0;
  while (first < normalized.length - 1 && normalized[first] === 0) first += 1;
  const magnitude = normalized.subarray(first);
  return magnitude[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), magnitude]) : magnitude;
}

function sequence(values: Buffer[]): Buffer {
  return derValue(0x30, Buffer.concat(values));
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length < 2 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0) ||
    parts[0]! > 2 ||
    (parts[0]! < 2 && parts[1]! > 39)
  )
    throw new Error("invalid-object-identifier");
  const encoded = encodeArc(parts[0]! * 40 + parts[1]!);
  for (const part of parts.slice(2)) encoded.push(...encodeArc(part));
  return derValue(0x06, Buffer.from(encoded));
}

function encodeArc(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return bytes;
}

function derValue(tag: number, value: Buffer): Buffer {
  const length = value.length;
  let encodedLength: Buffer;
  if (length < 0x80) encodedLength = Buffer.from([length]);
  else {
    const bytes: number[] = [];
    let rest = length;
    while (rest > 0) {
      bytes.unshift(rest & 0xff);
      rest >>>= 8;
    }
    encodedLength = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), encodedLength, value]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrivateAddress(
  value: string,
  allowLoopback: boolean,
  allowPortZero = false,
): { host: string; port: number } {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value);
  if (!match || !isIPv4(match[1]!)) throw new Error("private IPv4 address required");
  const octets = match[1]!.split(".").map(Number);
  const [first, second] = octets;
  const privateAddress =
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168);
  const loopback = first === 127;
  if (!privateAddress && !(allowLoopback && loopback))
    throw new Error("private IPv4 address required");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < (allowPortZero ? 0 : 1) || port > 65_535)
    throw new Error("private IPv4 address and port required");
  return { host: match[1]!, port };
}

function isPrivateIPv4(host: string, allowLoopback: boolean): boolean {
  if (!isIPv4(host)) return false;
  const [first, second] = host.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (allowLoopback && first === 127)
  );
}

function pairingVerification(exporter: Buffer, client: string, server: string): string {
  const digest = createHash("sha256").update(exporter).update(client).update(server).digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return `${String(Math.floor(value / 1000)).padStart(3, "0")} ${String(value % 1000).padStart(3, "0")}`;
}

function waitForSecureConnection(socket: TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("secureConnect", onSecure);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("REMOTE_OFFLINE"));
    };
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function writeFrame(socket: TLSSocket, value: unknown, limit: number): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length === 0 || body.length > limit) throw new Error("limit");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const frame = Buffer.concat([header, body]);
  if (!socket.write(frame))
    await new Promise<void>((resolve, reject) => {
      socket.once("drain", resolve);
      socket.once("error", reject);
    });
}

async function readFrame(socket: TLSSocket, limit: number): Promise<unknown> {
  const reader = socket[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const read = async (length: number): Promise<Buffer> => {
    while (buffered.length < length) {
      const next = await reader.next();
      if (next.done) throw new Error("REMOTE_OFFLINE");
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    }
    const value = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return value;
  };
  const header = await read(4);
  const length = header.readUInt32BE(0);
  if (length === 0 || length > limit) throw new Error("limit");
  try {
    return JSON.parse((await read(length)).toString("utf8")) as unknown;
  } catch {
    throw new Error("REMOTE_REQUEST_FAILED");
  }
}

function safeRemoteError(value: string): string {
  if (value === "index-disabled") return "REMOTE_INDEX_DISABLED";
  if (value === "sharing-disabled") return "REMOTE_SHARING_DISABLED";
  if (value === "revoked") return "REMOTE_REVOKED";
  if (value === "pairing-invalid") return "REMOTE_PAIRING_INVALID";
  if (value === "TRANSCRIPT_CURSOR_INVALID") return value;
  if (value === "TRANSCRIPT_CURSOR_STALE") return value;
  if (value === "TRANSCRIPT_UNREADABLE") return value;
  if (value === "TRANSCRIPT_SCAN_STATE_LIMIT") return value;
  if (value === "limit") return "REMOTE_LIMIT";
  return "REMOTE_REQUEST_FAILED";
}

function wireError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("index-disabled") || message.includes("INDEX_DISABLED"))
    return "index-disabled";
  if (message.includes("sharing-disabled")) return "sharing-disabled";
  if (message.includes("revoked")) return "revoked";
  if (message.includes("pairing-invalid")) return "pairing-invalid";
  for (const code of [
    "TRANSCRIPT_CURSOR_INVALID",
    "TRANSCRIPT_CURSOR_STALE",
    "TRANSCRIPT_UNREADABLE",
    "TRANSCRIPT_SCAN_STATE_LIMIT",
  ])
    if (message.includes(code)) return code;
  if (message.includes("limit") || message.includes("response-too-large")) return "limit";
  return "request-failed";
}
