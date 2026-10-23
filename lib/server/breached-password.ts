import "server-only";
import { createHash } from "crypto";

/**
 * Has this password appeared in a known data breach? Uses the Have I Been Pwned range API (k-anonymity): only the first five
 * characters of the password's SHA-1 are sent, never the password or the whole hash, and the answer is matched here, on the
 * server. Padded responses (Add-Padding) hide how many suffixes match.
 *
 * FAILS OPEN: if the service is slow, unreachable or answers anything but 200, the password is accepted (the length and
 * character rules still apply). A third-party outage must never stop someone choosing a password.
 *
 * On when BREACHED_PASSWORD_CHECK=on; off when it is "off"; unset means on in Vercel Production only. Off in tests and local
 * development, where the app server is not allowed to reach the internet.
 */
const ENDPOINT = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 2500;

export function breachedCheckEnabled(env: Record<string, string | undefined> = process.env) {
  const setting = env.BREACHED_PASSWORD_CHECK?.trim().toLowerCase();
  if (setting === "on" || setting === "true") return true;
  if (setting === "off" || setting === "false") return false;
  return env.VERCEL_ENV === "production";
}

export async function isBreachedPassword(password: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<boolean> {
  if (!breachedCheckEnabled(options.env)) return false;
  const fetchImpl = options.fetchImpl ?? fetch;
  const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ENDPOINT}${prefix}`, { headers: { "Add-Padding": "true", "User-Agent": "tolra-password-check" }, signal: controller.signal, cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.text();
    for (const line of body.split(/\r?\n/)) {
      const [candidate, count] = line.trim().split(":");
      if (candidate === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
