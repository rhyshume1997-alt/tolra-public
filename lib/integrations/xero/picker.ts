import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";

// The Xero organisation picker's sealed offer. When one consent made several organisations, the callback keeps what the pick needs (the
// refresh token, the organisations offered, the company and admin the Connect belongs to, an expiry and a random nonce) in ONE cookie,
// sealed with AES-256-GCM under INTEGRATIONS_ENCRYPTION_KEY, bound to the company by the cipher's additional data (crypto.ts "picker").
// Nothing is in a URL, a log or the browser's readable storage: the cookie is HttpOnly, path-limited, 10 minutes, and cleared on use.
// One use is enforced by the route (the existing rate limiter, keyed on the nonce); nothing new is stored in the database.

export const PICKER_COOKIE = "tolra_xero_pick";
export const PICKER_PATH = "/api/integrations/xero";
/** Like the Connect state: 10 minutes. */
export const PICKER_TTL_SECONDS = 10 * 60;
const NAME_MAX = 60;

export type PickerPayload = {
  /** company */ o: string;
  /** the admin who started Connect */ u: string;
  /** expires at, epoch seconds */ e: number;
  /** nonce (the one-use key) */ n: string;
  /** Xero refresh token */ r: string;
  /** authentication event id of the consent */ v: string | null;
  /** organisations offered */ t: Array<{ i: string; t: string; n: string }>;
};

export type PickerOfferInput = { refreshToken: string; eventId: string | null; orgs: Array<{ id: string; tenantId: string; tenantName: string }> };

export function sealPicker(org: string, userId: string, offer: PickerOfferInput, key: Buffer, now: number = Date.now()): { cookie: string; payload: PickerPayload } {
  const payload: PickerPayload = {
    o: org, u: userId, e: Math.floor(now / 1000) + PICKER_TTL_SECONDS, n: randomBytes(16).toString("base64url"), r: offer.refreshToken, v: offer.eventId,
    t: offer.orgs.map((x) => ({ i: x.id, t: x.tenantId, n: x.tenantName.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NAME_MAX) })),
  };
  return { cookie: `${org}.${encryptSecret(JSON.stringify(payload), { organizationId: org, provider: "xero", purpose: "picker" }, key)}`, payload };
}

export type OpenResult = { ok: true; payload: PickerPayload } | { ok: false; reason: "malformed" | "expired" };

/** Opens a cookie value: the company prefix selects the cipher's additional data, so a value moved to another company's slot does not open. Does not use it up. */
export function openPicker(cookie: string | null | undefined, key: Buffer, now: number = Date.now()): OpenResult {
  if (!cookie || cookie.length > 3800) return { ok: false, reason: "malformed" };
  const dot = cookie.indexOf(".");
  const org = dot > 0 ? cookie.slice(0, dot) : "";
  if (!/^[0-9a-f-]{36}$/.test(org)) return { ok: false, reason: "malformed" };
  let payload: PickerPayload;
  try {
    payload = JSON.parse(decryptSecret(cookie.slice(dot + 1), { organizationId: org, provider: "xero", purpose: "picker" }, key)) as PickerPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || payload.o !== org || typeof payload.u !== "string" || typeof payload.n !== "string" || typeof payload.e !== "number" || typeof payload.r !== "string" || !Array.isArray(payload.t)
    || payload.t.some((x) => !x || typeof x.i !== "string" || typeof x.t !== "string" || typeof x.n !== "string")) return { ok: false, reason: "malformed" };
  if (Math.floor(now / 1000) >= payload.e) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

const csrfKey = (key: Buffer) => createHmac("sha256", key).update("tolra:xero-picker-csrf:v1").digest();

/** The anti-forgery value the picker page must send back (only a page that read the offer's GET can have it; it is not in the cookie). */
export function pickerCsrf(payload: Pick<PickerPayload, "n" | "o" | "u">, key: Buffer): string {
  return createHmac("sha256", csrfKey(key)).update(`${payload.o}:${payload.u}:${payload.n}`).digest("base64url");
}

export function csrfMatches(given: unknown, payload: Pick<PickerPayload, "n" | "o" | "u">, key: Buffer): boolean {
  if (typeof given !== "string") return false;
  const want = Buffer.from(pickerCsrf(payload, key));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function toOffer(payload: PickerPayload): PickerOfferInput {
  return { refreshToken: payload.r, eventId: payload.v, orgs: payload.t.map((x) => ({ id: x.i, tenantId: x.t, tenantName: x.n })) };
}
