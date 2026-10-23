/**
 * An authenticator app for tests: the 6-digit code (RFC 6238, SHA-1, 30 s) for a base32 secret, and enrolment of a signed-in
 * synthetic user through the real Auth API of the local stack. Synthetic users only.
 */
import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string) {
  let bits = "";
  for (const char of secret.replace(/[\s=-]/g, "").toUpperCase()) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error("not base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** Enrols and verifies a TOTP factor for the client's user; the client's session becomes aal2. Returns what an app would hold. */
export async function enrolTotp(client: SupabaseClient, friendlyName = "Test authenticator") {
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName });
  if (enrolled.error) throw new Error(`mfa enroll: ${enrolled.error.message}`);
  const secret = enrolled.data.totp.secret;
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: totpCode(secret) });
  if (verified.error) throw new Error(`mfa verify: ${verified.error.message}`);
  return { factorId: enrolled.data.id, secret };
}

/** A fresh code for a factor on a client that signed in with the password only (aal1): the second step. */
export async function passSecondStep(client: SupabaseClient, factorId: string, secret: string) {
  const result = await client.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  if (result.error) throw new Error(`mfa verify: ${result.error.message}`);
}
