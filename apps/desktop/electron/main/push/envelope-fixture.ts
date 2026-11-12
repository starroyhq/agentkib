import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { PUSH_ENVELOPE_INFO } from "./envelope";

/**
 * Tests only: what the phone's notification service extension does with an envelope, written
 * out so the layout is checked independently of `sealPushEnvelope`.
 */
export function openPushEnvelope(
  envelope: string,
  privateKey: KeyObject,
  recipient: string,
  deviceId: string,
): unknown {
  const data = Buffer.from(envelope, "base64url");
  if (data[0] !== 1) throw new Error("unknown_envelope_version");
  const sender = data.subarray(1, 33);
  const secret = diffieHellman({
    privateKey,
    publicKey: createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: sender.toString("base64url") },
      format: "jwk",
    }),
  });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.concat([sender, Buffer.from(recipient, "base64url")]),
      PUSH_ENVELOPE_INFO,
      32,
    ),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(33, 45));
  decipher.setAAD(Buffer.from(deviceId, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(45, data.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
