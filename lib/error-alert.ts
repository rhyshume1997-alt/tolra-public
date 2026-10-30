/**
 * Pure parts of production error alerts (no Node or browser APIs): what may leave the app in an alert e-mail, and the
 * in-memory fallback for the sending budget. Used by lib/server/error-alert.ts and the tests.
 *
 * An alert says WHAT broke and WHERE, never WHO or with what data: no request bodies, cookies, tokens, headers or e-mail
 * addresses. The message is passed through redact() first.
 */

/** At most one e-mail per fingerprint per hour, and this many a day (the database enforces the same: claim_error_alert). */
export const ALERT_PER_FINGERPRINT_MS = 60 * 60 * 1000;
export const ALERT_MAX_PER_DAY = 20;
/** Browser-reported errors have their own, smaller budget (migration 115: 5 a day per person, 10 per company, 20 in all). This is the in-memory stand-in, per instance. */
export const ALERT_BROWSER_MAX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_MESSAGE = 300;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE = /\b(?:password|passwd|secret|token|apikey|api_key|authorization|cookie|key)\s*[:=]\s*\S+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const PHONE = /(?<![\w.])\+?\d[\d\s()-]{9,}\d(?![\w.])/g;

/** The message with UUIDs, e-mail addresses, tokens, keys and long numbers replaced, and cut to a safe length. */
export function redact(message: unknown): string {
  let text = typeof message === "string" ? message : message instanceof Error ? message.message : "";
  text = text
    .replace(JWT, "[token]")
    .replace(BEARER, "[token]")
    .replace(KEY_VALUE, "[secret]")
    .replace(EMAIL, "[email]")
    .replace(UUID, "[id]")
    .replace(LONG_TOKEN, "[token]")
    .replace(PHONE, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

/** A route path with ids and query removed (/jobs/<uuid>/print?x=1 -> /jobs/[id]/print), for the alert and the fingerprint. */
export function safeRoute(path: unknown): string {
  const raw = typeof path === "string" ? path.split(/[?#]/)[0] : "";
  const cleaned = raw
    .replace(UUID, "[id]")
    .replace(EMAIL, "[email]")
    .replace(/\/\d{4,}(?=\/|$)/g, "/[n]")
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/[token]")
    .slice(0, 120);
  return cleaned || "unknown";
}

/** A short stable id for "the same error": the route and the redacted message with digits collapsed. */
export async function fingerprint(route: string, message: string): Promise<string> {
  const normalised = `${safeRoute(route)}|${redact(message).replace(/\d+/g, "#")}`;
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The same budget kept in memory: used only when the database can't be asked, so a database outage doesn't silence the
 * alert about it. One instance of the app only (serverless instances don't share it), so the real limit is the database's.
 */
export function createAlertBudget(perFingerprintMs = ALERT_PER_FINGERPRINT_MS, perDay = ALERT_MAX_PER_DAY) {
  const sent: Array<{ fingerprint: string; at: number }> = [];
  return {
    /** True (and recorded) when an e-mail may go now. */
    claim(fp: string, now = Date.now()): boolean {
      while (sent.length && sent[0].at < now - DAY_MS) sent.shift();
      if (sent.some((entry) => entry.fingerprint === fp && entry.at > now - perFingerprintMs)) return false;
      if (sent.length >= perDay) return false;
      sent.push({ fingerprint: fp, at: now });
      return true;
    },
    size: () => sent.length,
  };
}

export type AlertFields = { route: string; message: string; fingerprint: string; commit: string; environment: string; at: string; source: string };

/** The alert e-mail: subject and plain-text body. Only the fields above go in; nothing else is added. */
export function alertEmail(fields: AlertFields) {
  return {
    subject: `[Tolra alert] ${fields.route} (${fields.fingerprint})`.slice(0, 150),
    text: [
      "An error happened in the live app.",
      "",
      `Route:       ${fields.route}`,
      `Message:     ${fields.message}`,
      `Source:      ${fields.source}`,
      `Time (UTC):  ${fields.at}`,
      `Deployed:    ${fields.commit}`,
      `Environment: ${fields.environment}`,
      `Fingerprint: ${fields.fingerprint}`,
      "",
      "No request data, cookies, tokens or e-mail addresses are included. At most one e-mail per fingerprint per hour, and 20 a day.",
    ].join("\n"),
  };
}
