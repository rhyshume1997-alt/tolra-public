import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** The shortest CRON_SECRET accepted. A shorter (or empty) one is treated as not configured, so the endpoint is never open by default. */
export const MIN_CRON_SECRET_LENGTH = 16;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * True only for a Vercel Cron call: `Authorization: Bearer <CRON_SECRET>` (Vercel sends exactly this when CRON_SECRET is set on the
 * project). Both sides are hashed first, so the comparison is constant-time whatever the lengths. A missing, empty or too short
 * CRON_SECRET refuses every call. Never logs or returns the secret or the header.
 */
export function isCronRequest(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(secret));
}
