// Idempotency keys for the mailer (lib/email/send-company-email.ts accepts [A-Za-z0-9_-], 8 to 100 characters). The natural identity of a
// scheduled e-mail (schedule, period, invoice or person) holds characters the mailer refuses (a "once" period key is an ISO time with ":" and
// ".") and can be longer than 100, so the key is a fixed-length hash of it: same input, same key; different input, different key.
import { createHash } from "node:crypto";

export function scheduleEmailKey(kind: "invoice_reminder" | "timesheet", ...parts: string[]): string {
  const digest = createHash("sha256").update([kind, ...parts].join("\u001f"), "utf8").digest("hex").slice(0, 48);
  return `${kind}-${digest}`;
}
