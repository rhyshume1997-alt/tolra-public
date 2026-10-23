/**
 * Plain-English result line for the Admin "Send test alert" button (POST /api/admin/alert-test).
 * The reasons come from AlertResult in lib/server/error-alert.ts plus the route's own "not-production" / "disabled" answers.
 * Pure on purpose: it never shows the raw response, only fixed sentences (and the route's short hint for unknown reasons).
 */

export type AlertTestOutcome = { tone: "success" | "warning" | "error"; text: string };

const SENT_TEXT = "Sent. Check the inbox for ALERT_EMAIL_TO (and spam).";

const REASON_TEXT: Record<string, string> = {
  disabled: "Not sent: alerts are switched off. ALERT_EMAIL_TO is not set in this deployment.",
  "not-production": "Not sent: this is not the Production deployment, so alerts are held back.",
  "rate-limited": "Not sent: rate limited. Only one test is allowed per hour, so look for the earlier e-mail (and spam).",
  "no-provider": "Not sent: no e-mail provider key (RESEND_API_KEY) in this deployment.",
  "no-sender": "Not sent: no sender address (EMAIL_FROM) in this deployment.",
  "send-failed": "Not sent: the e-mail provider did not accept the message or took too long. Try again in a minute.",
};

const MAX_REASON = 80;
const MAX_HINT = 160;

function short(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Maps an HTTP status and parsed JSON body (or null) to the line shown to the admin. */
export function describeAlertTest(status: number, body: unknown): AlertTestOutcome {
  if (status === 401 || status === 403) return { tone: "error", text: "Not allowed: admins only." };
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (status < 200 || status >= 300 || !data) {
    return { tone: "error", text: `The test could not run (the server answered ${status || "with an error"}). Try again, and tell support if it keeps happening.` };
  }
  const reason = typeof data.reason === "string" ? data.reason : "";
  if (data.sent === true && (reason === "sent" || reason === "")) return { tone: "success", text: SENT_TEXT };
  const hint = short(data.hint, MAX_HINT);
  const known = Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason] : null;
  if (known) return { tone: "warning", text: hint ? `${known} ${hint}` : known };
  const label = short(reason, MAX_REASON) || "unknown reason";
  return { tone: "warning", text: `Not sent: ${label}.${hint ? ` ${hint}` : ""}` };
}

export const ALERT_TEST_NETWORK_ERROR: AlertTestOutcome = {
  tone: "error",
  text: "Could not reach the server. Check your connection and try again.",
};
