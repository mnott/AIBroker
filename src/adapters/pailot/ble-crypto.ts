/**
 * adapters/pailot/ble-crypto.ts — BLE v2 application-level crypto (node:crypto only).
 * sealed body = nonce(12) || AES-256-GCM ciphertext || tag(16), no AAD.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const NONCE_LEN = 12;
const TAG_LEN = 16;

export class AuthError extends Error {
  constructor() {
    super("BLE frame authentication failed");
    this.name = "AuthError";
  }
}

function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), 32));
}

export function deriveK0(token: string): Buffer {
  return hkdf(Buffer.from(token, "utf8"), Buffer.from("pailot-ble-v1-salt", "utf8"), "pailot-ble-v1");
}

export function deriveKs(k0: Buffer, clientNonce: Buffer, serverNonce: Buffer): Buffer {
  return hkdf(k0, Buffer.concat([clientNonce, serverNonce]), "pailot-ble-v1/session");
}

export function readyMac(ks: Buffer, clientNonce: Buffer, serverNonce: Buffer): string {
  return createHmac("sha256", ks)
    .update(Buffer.concat([Buffer.from("pailot-ble-v1/ready", "utf8"), clientNonce, serverNonce]))
    .digest("hex");
}

export function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function seal(key: Buffer, plaintext: Buffer, nonce: Buffer = randomBytes(NONCE_LEN)): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

/** Throws AuthError on any failure (short body, bad tag, wrong key). */
export function open(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new AuthError();
  try {
    const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_LEN));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    return Buffer.concat([d.update(sealed.subarray(NONCE_LEN, sealed.length - TAG_LEN)), d.final()]);
  } catch {
    throw new AuthError();
  }
}

/** Key for APNs push payload sealing and push audio (same token as BLE v2). */
export function deriveKPush(token: string): Buffer {
  return hkdf(Buffer.from(token, "utf8"), Buffer.from("pailot-push-v1-salt", "utf8"), "pailot-push-v1");
}

/** Hex HMAC-SHA256(pushKey, "pailot-push-audio/" + msgId): X-PAILot-Auth header value. */
export function pushAudioAuth(pushKey: Buffer, msgId: string): string {
  return createHmac("sha256", pushKey).update(Buffer.from(`pailot-push-audio/${msgId}`, "utf8")).digest("hex");
}
