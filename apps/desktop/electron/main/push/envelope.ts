import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/** HKDF info, and the version byte that starts every envelope. */
export const PUSH_ENVELOPE_INFO = "agentkib-push-v1";
const VERSION = 1;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** The phone's X25519 public key (32 bytes, base64url), or undefined when the text is not one. */
export function pushPublicKey(value: unknown): KeyObject | undefined {
  if (typeof value !== "string" || !PUBLIC_KEY.test(value)) return undefined;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: value }, format: "jwk" });
  } catch {
    return undefined;
  }
}

/**
 * Encrypts an alert for one phone, so the relay and Apple carry it without reading it. Each
 * envelope uses a new X25519 key: the shared secret with the phone's key goes through
 * HKDF-SHA256 (salt: the new public key followed by the phone's, info: `agentkib-push-v1`) to an
 * AES-256-GCM key. The computer's relay device id is the associated data, so the relay cannot
 * present one computer's envelope as another's.
 *
 * Layout, base64url: version (1 byte) | new public key (32) | nonce (12) | ciphertext | tag (16).
 */
export function sealPushEnvelope(recipient: string, deviceId: string, message: unknown): string {
  const phone = pushPublicKey(recipient);
  if (!phone) throw new Error("invalid_push_key");
  const ephemeral = generateKeyPairSync("x25519");
  const sender = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: phone });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.concat([sender, Buffer.from(recipient, "base64url")]),
      PUSH_ENVELOPE_INFO,
      32,
    ),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(deviceId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    sender,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64url");
}
