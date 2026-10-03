import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const requestSchema = z
  .object({
    privateKeyDer: z.string().min(1).max(8192),
    hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
  })
  .strict();

/** Generate the same empty-subject, DNS-SAN P-256 CSR used by the native relay helper. */
export function createRelayCsr(value: unknown): { csrPem: string } {
  const request = requestSchema.parse(value);
  const der = Buffer.from(request.privateKeyDer, "base64");
  if (der.toString("base64") !== request.privateKeyDer) throw new Error("invalid-csr-key");
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("invalid-csr-key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("invalid-csr-key");

  const distinct = new Set<string>();
  for (const host of request.hosts) {
    if (
      [...host].some((character) => character.charCodeAt(0) > 0x7f) ||
      !host.includes(".") ||
      host.endsWith(".") ||
      isIP(host) !== 0 ||
      host
        .split(".")
        .some(
          (part) =>
            !part ||
            part.length > 63 ||
            part.startsWith("-") ||
            part.endsWith("-") ||
            !/^[A-Za-z0-9-]+$/.test(part),
        ) ||
      distinct.has(host)
    )
      throw new Error("invalid-csr-hosts");
    distinct.add(host);
  }

  const subjectPublicKeyInfo = createPublicKey(key).export({ format: "der", type: "spki" });
  const names = sequence(request.hosts.map((host) => derValue(0x82, Buffer.from(host, "ascii"))));
  const extension = sequence([objectIdentifier("2.5.29.17"), derValue(0x04, names)]);
  const extensionRequest = sequence([
    objectIdentifier("1.2.840.113549.1.9.14"),
    derValue(0x31, sequence([extension])),
  ]);
  const info = sequence([
    derValue(0x02, Buffer.from([0])),
    sequence([]),
    Buffer.from(subjectPublicKeyInfo),
    derValue(0xa0, extensionRequest),
  ]);
  const signatureAlgorithm = sequence([objectIdentifier("1.2.840.10045.4.3.2")]);
  let signature: Buffer;
  try {
    signature = sign("sha256", info, key);
  } catch {
    throw new Error("csr-signing-failed");
  }
  const csr = sequence([
    info,
    signatureAlgorithm,
    derValue(0x03, Buffer.concat([Buffer.from([0]), signature])),
  ]);
  const encoded = csr.toString("base64");
  const lines = encoded.match(/.{1,64}/g)?.join("\n") ?? "";
  return {
    csrPem: `-----BEGIN CERTIFICATE REQUEST-----\n${lines}\n-----END CERTIFICATE REQUEST-----\n`,
  };
}

function sequence(values: Buffer[]): Buffer {
  return derValue(0x30, Buffer.concat(values));
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

function objectIdentifier(value: string): Buffer {
  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length < 2 ||
    parts.some(
      (part, index) => !Number.isSafeInteger(part) || part < 0 || (index === 0 && part > 2),
    ) ||
    parts[1]! > 39
  )
    throw new Error("invalid-object-identifier");
  const encoded = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const bytes = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      bytes.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    encoded.push(...bytes);
  }
  return derValue(0x06, Buffer.from(encoded));
}
