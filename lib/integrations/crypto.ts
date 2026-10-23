import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Tokens and the PKCE verifier are encrypted at rest by the server, never by the database (G22, Lot B §2.6): AES-256-GCM with a 32-byte
// key held only in INTEGRATIONS_ENCRYPTION_KEY (base64; Rhys sets it in Vercel, a different value in Preview and Production). The stored
// form is "v<version>.<iv>.<tag>.<data>" (base64url), which migration 084's CHECK constraints insist on, so a plain token can never be
// stored by mistake. The additional data binds each ciphertext to its company, provider and purpose: a value copied to another company's
// row, or from the refresh slot to the access slot, does not decrypt. Errors never carry the key, the plaintext or the ciphertext.

export const KEY_VERSION = 1;
const FORMAT = /^v(\d{1,3})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export type SecretPurpose = "refresh" | "access" | "pkce";

export class IntegrationCryptoError extends Error {
  constructor(message: string, readonly code: "key_missing" | "key_invalid" | "format" | "version" | "decrypt") {
    super(message);
    this.name = "IntegrationCryptoError";
  }
}

/** The encryption key from the environment (32 bytes, base64), or an error naming what is wrong (never the value). */
export function encryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (!raw) throw new IntegrationCryptoError("INTEGRATIONS_ENCRYPTION_KEY is not set", "key_missing");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new IntegrationCryptoError("INTEGRATIONS_ENCRYPTION_KEY must be 32 random bytes, base64 encoded", "key_invalid");
  return key;
}

const aad = (organizationId: string, provider: string, purpose: SecretPurpose) => Buffer.from(`tolra:${organizationId}:${provider}:${purpose}`, "utf8");

export function encryptSecret(plaintext: string, ctx: { organizationId: string; provider: string; purpose: SecretPurpose }, key: Buffer = encryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ctx.organizationId, ctx.provider, ctx.purpose));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v${KEY_VERSION}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptSecret(stored: string, ctx: { organizationId: string; provider: string; purpose: SecretPurpose }, key: Buffer = encryptionKey()): string {
  const m = FORMAT.exec(stored ?? "");
  if (!m) throw new IntegrationCryptoError("Stored secret is not in the expected form", "format");
  if (Number(m[1]) !== KEY_VERSION) throw new IntegrationCryptoError(`Stored secret uses key version ${m[1]}, this server has ${KEY_VERSION}`, "version");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m[2], "base64url"));
    decipher.setAAD(aad(ctx.organizationId, ctx.provider, ctx.purpose));
    decipher.setAuthTag(Buffer.from(m[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(m[4], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new IntegrationCryptoError("Stored secret could not be decrypted (wrong key, company or slot)", "decrypt");
  }
}
