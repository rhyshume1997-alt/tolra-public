import "server-only";
import { createHash, createHmac, randomBytes, randomInt } from "crypto";

/**
 * BOUNDARY: lib/portal/crypto.ts. Server-only. Secret: PORTAL_SIGNIN_HMAC_KEY (32 bytes, base64), its own key (not derived from
 * INTEGRATIONS_ENCRYPTION_KEY). Missing or wrong length => portalKey() is null and every caller fails closed.
 * Outputs: ref (16 random bytes, base64url, 22 chars), code (8 digits, randomInt), refHash = SHA-256 hex of the ref, codeHash = keyed
 * HMAC-SHA256 hex over `ref:code` (release 151 inviteCodeHash pattern), session token (32 random bytes, base64url) and its SHA-256 hex.
 * Only hashes ever go to the database. Must not log, return or store a key, ref, code or token anywhere but the e-mail and the cookie.
 */

export const PORTAL_SLOTS = 10;
const REF = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{8}$/;

/** The HMAC key, or null if PORTAL_SIGNIN_HMAC_KEY is unset or is not exactly 32 bytes of base64. */
export function portalKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.PORTAL_SIGNIN_HMAC_KEY?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export const newPortalRef = (): string => randomBytes(16).toString("base64url");
export const newPortalCode = (): string => String(randomInt(0, 100_000_000)).padStart(8, "0");
const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export const refHash = (ref: string): string => sha256Hex(ref);

/** HMAC-SHA256 over `ref:code` with a sub-key (release 151 pattern). Binding the ref means a code is useless with any other ref. */
export function codeHash(key: Buffer, ref: string, code: string): string {
  const subKey = createHmac("sha256", key).update("tolra:portal-signin-code:v1", "utf8").digest();
  return createHmac("sha256", subKey).update(`${ref}:${code}`, "utf8").digest("hex");
}

export function newPortalSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}
export const tokenHash = (token: string): string => sha256Hex(token);

/** Exactly 22 url-safe characters, else null. */
export const cleanPortalRef = (input: unknown): string | null => (typeof input === "string" && REF.test(input) ? input : null);
/** Exactly 43 url-safe characters (a 32-byte token), else null. */
export const cleanPortalToken = (input: unknown): string | null => (typeof input === "string" && TOKEN.test(input) ? input : null);
/** What a person typed ("1234 5678", "1234-5678"), made one code; null unless exactly 8 digits. */
export function cleanPortalCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.replace(/[\s-]/g, "");
  return CODE.test(code) ? code : null;
}

export type PortalSigninPair = { ref: string; code: string; refHash: string; codeHash: string };
/** Always PORTAL_SLOTS fresh pairs, whatever the e-mail is, so the work done never depends on it. */
export function newSigninPairs(key: Buffer): PortalSigninPair[] {
  return Array.from({ length: PORTAL_SLOTS }, () => {
    const ref = newPortalRef();
    const code = newPortalCode();
    return { ref, code, refHash: refHash(ref), codeHash: codeHash(key, ref, code) };
  });
}
