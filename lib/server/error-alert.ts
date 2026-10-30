import "server-only";

import { ALERT_BROWSER_MAX_PER_DAY, ALERT_PER_FINGERPRINT_MS, type AlertFields, alertEmail, createAlertBudget, fingerprint, redact, safeRoute } from "@/lib/error-alert";
import { resend } from "@/lib/resend";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Production error alerts: one e-mail to the owner through the existing Resend set-up, free tier only.
 *
 *  - Off unless ALERT_EMAIL_TO is set. Set it in Vercel for the Production environment only. As a second guard, a deployment
 *    that says it is not production (VERCEL_ENV set to anything but "production") never sends.
 *  - Sanitised (lib/error-alert.ts): the message with ids, e-mail addresses and tokens removed, the route, the deployed
 *    commit, the time and a fingerprint. Never a request body, cookie, header or user.
 *  - Rate limited: at most one e-mail per fingerprint per hour and 20 a day, counted in the database (claim_error_alert, so
 *    every instance shares it), and in memory if the database can't be asked.
 *  - Errors reported by a signed-in browser (source "browser") have their own, smaller budget so they can never use up the day's
 *    server and cron alerts: claim_browser_error_alert (migration 115), 5 a day per person, 10 per company, 20 in all. Until 115 is
 *    applied the old shared claim_error_alert is used.
 *  - Never throws and never waits long: a failing alert must not make the failure worse.
 */

const SEND_TIMEOUT_MS = 8000;
const memoryBudget = createAlertBudget();

export type AlertResult = { sent: boolean; reason: "sent" | "disabled" | "not-production" | "rate-limited" | "no-provider" | "no-sender" | "send-failed" };

/** True when alerts are switched on for this deployment. */
export function alertsEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!env.ALERT_EMAIL_TO?.trim()) return false;
  return !env.VERCEL_ENV || env.VERCEL_ENV === "production";
}

/** Who reported a browser error: counted against their own per-person and per-company budget. */
export type AlertReporter = { userId: string; companyId: string | null };

const memoryBrowserBudget = createAlertBudget(ALERT_PER_FINGERPRINT_MS, ALERT_BROWSER_MAX_PER_DAY);

/** True when the database says migration 115's function does not exist (yet): PostgREST PGRST202 or Postgres 42883. */
function functionMissing(error: { code?: string } | null | undefined) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

async function claim(fp: string, source: string, reporter?: AlertReporter): Promise<boolean> {
  const browser = source === "browser";
  const admin = createSupabaseAdminClient();
  if (admin) {
    try {
      if (browser && reporter) {
        const { data, error } = await admin.rpc("claim_browser_error_alert", { p_fingerprint: fp, p_user_id: reporter.userId, p_company_id: reporter.companyId });
        if (!error && typeof data === "boolean") return data;
        // 115 not applied yet: the old shared budget, so alerts keep working while the release is pending.
        if (!functionMissing(error)) console.error("[error-alert] browser budget check failed", error?.code);
        else {
          const old = await admin.rpc("claim_error_alert", { p_fingerprint: fp });
          if (!old.error && typeof old.data === "boolean") return old.data;
          console.error("[error-alert] budget check failed", old.error?.code);
        }
      } else {
        const { data, error } = await admin.rpc("claim_error_alert", { p_fingerprint: fp });
        if (!error && typeof data === "boolean") return data;
        console.error("[error-alert] budget check failed", error?.code);
      }
    } catch (err) {
      console.error("[error-alert] budget check failed", err instanceof Error ? err.name : "threw");
    }
  }
  return browser ? memoryBrowserBudget.claim(fp) : memoryBudget.claim(fp);
}

export async function reportServerError(input: { route: unknown; error: unknown; source?: string; reporter?: AlertReporter }): Promise<AlertResult> {
  try {
    const to = process.env.ALERT_EMAIL_TO?.trim();
    if (!to) return { sent: false, reason: "disabled" };
    if (!alertsEnabled()) return { sent: false, reason: "not-production" };
    if (!resend) return { sent: false, reason: "no-provider" };
    const from = process.env.EMAIL_FROM;
    if (!from) return { sent: false, reason: "no-sender" };

    const route = safeRoute(input.route);
    const message = redact(input.error) || "(no message)";
    const fp = await fingerprint(route, message);
    if (!(await claim(fp, input.source ?? "server", input.reporter))) return { sent: false, reason: "rate-limited" };

    const fields: AlertFields = {
      route,
      message,
      fingerprint: fp,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || "unknown").slice(0, 12),
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
      at: new Date().toISOString(),
      source: input.source ?? "server",
    };
    const mail = alertEmail(fields);
    const provider = resend;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        provider.emails.send({ from, to: to.split(",").map((address) => address.trim()).filter(Boolean), subject: mail.subject, text: mail.text }, { idempotencyKey: `error-alert/${fp}/${fields.at.slice(0, 13)}` }),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS); }),
      ]);
      if (outcome === "timeout" || outcome.error) {
        console.error("[error-alert] send failed", outcome === "timeout" ? "timeout" : outcome.error?.name);
        return { sent: false, reason: "send-failed" };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { sent: true, reason: "sent" };
  } catch (err) {
    console.error("[error-alert] failed", err instanceof Error ? err.name : "threw");
    return { sent: false, reason: "send-failed" };
  }
}
