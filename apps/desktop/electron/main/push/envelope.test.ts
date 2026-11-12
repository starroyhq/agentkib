// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { pushPublicKey, sealPushEnvelope } from "./envelope";
import { openPushEnvelope as open } from "./envelope-fixture";

const DEVICE = "0123456789abcdef0123456789abcdef";

function phone() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey: publicKey.export({ format: "jwk" }).x! };
}

describe("push envelopes", () => {
  it("opens only with the phone's key and the sending computer's device id", () => {
    const recipient = phone();
    const message = { v: 1, kind: "completed", title: "修复登录" };
    const envelope = sealPushEnvelope(recipient.publicKey, DEVICE, message);
    expect(envelope).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(open(envelope, recipient.privateKey, recipient.publicKey, DEVICE)).toEqual(message);
    expect(() =>
      open(envelope, recipient.privateKey, recipient.publicKey, "f".repeat(32)),
    ).toThrow();
    const other = phone();
    expect(() => open(envelope, other.privateKey, recipient.publicKey, DEVICE)).toThrow();
    // A new key and nonce for every envelope.
    expect(sealPushEnvelope(recipient.publicKey, DEVICE, message)).not.toBe(envelope);
  });

  it("refuses anything but a 32-byte X25519 key", () => {
    expect(pushPublicKey(phone().publicKey)).toBeDefined();
    for (const value of [undefined, 7, "", "a".repeat(42), "a".repeat(44), "+".repeat(43)])
      expect(pushPublicKey(value)).toBeUndefined();
    expect(() => sealPushEnvelope("short", DEVICE, {})).toThrow("invalid_push_key");
  });

  // The phone's tests open the same envelope, so both ends agree on the layout.
  it("opens the shared test vector", () => {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const recipient = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";
    expect(createPublicKey(privateKey).export({ format: "jwk" }).x).toBe(recipient);
    const envelope =
      "AdAr8Mlrgf9Axh4LAjpYZJmUFwQO_jAxAlZQR25D49sOuX0dP9_OzjC19uQofzRerbwKG-_nezlJkP4NoDxeohdFi_6SDyxCK88j4o1fpdseivT3UxqB-2-WlcFMMUFDJq3h9J0Ry2INvBXTV4pxvhmtat6PaVpawqij8cefuvfMruHwIK534V_CS1ugomXKfHQ8XrO9S6-IY8cp15tQV2fQRCQ380ktt46hpOAXiiVUP40m_eiikWANry1O85uhHA_qkOQKkinlCEgFUeG-WsC96KYFWReyW7Udp4BmsGQZRTWiyvSywUvoYA";
    expect(open(envelope, privateKey, recipient, DEVICE)).toEqual({
      v: 1,
      ref: "phone-ref-1",
      kind: "approval",
      sessionId: "019a7c2e-0000-7000-8000-000000000001",
      agent: "codex",
      title: "修复登录",
      computer: "Studio",
      at: 1762900000000,
    });
  });
});
