import type { SupabaseClient } from "@supabase/supabase-js";

import { type AccountantOutcome, type OpenAccountantInvite, accountantConfirmPage, accountantOutcomePage, peekAccountantInvite, redeemOutcome, xeroOfferFor } from "@/lib/integrations/accountant-invite";
import { siteOrigin } from "@/lib/integrations/app-credentials";
import { INVITE_TOKEN, hashInviteToken, inviteRateOk } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { createSupabaseServerClient, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The accountant opens their invite (C3, migration 129): PUBLIC, rate limited per IP with the Xero link's routes (fails closed).
 * GET: "Join <company> on Tolra as a viewer" for an open invite only (accountant_invite_peek). NOTHING is used up (mail scanners, chat
 *   previews). With ?xero=<the company's Xero connect link>, and only while Xero is set up here, the company's Xero is not connected and
 *   that link is open, it also offers "Also connect Xero for this company" (the existing 107 link page, which does its own Continue).
 * POST (the page's own buttons, same origin), action=
 *   join: the browser's Tolra session, signed in with the invite's e-mail, calls redeem_accountant_invite (once; viewer only; an existing
 *         member's access is never changed). Signed out: "Sign in first".
 *   new:  Supabase Auth e-mails the invite's address a link to choose a password; creating that login runs the sign-up trigger (129), which
 *         makes them a viewer and marks the invite used. An address that already has a login: "Sign in, then open this link again".
 */
type Context = { fail: Response } | { fail?: undefined; service: SupabaseClient; invite: OpenAccountantInvite | null; xeroUrl: string | null };

async function context(request: Request, token: string): Promise<Context> {
  const service = createSupabaseAdminClient();
  if (!service) return { fail: accountantOutcomePage("not_configured", 503) };
  if (!(await inviteRateOk(service, request))) return { fail: accountantOutcomePage("busy", 429) };
  const invite = await peekAccountantInvite(service, token);
  const xeroToken = new URL(request.url).searchParams.get("xero");
  const ready = xeroToken ? (await xeroReady(process.env, service)) !== null : false;
  const xeroUrl = await xeroOfferFor(service, xeroToken, invite, ready);
  return { service, invite, xeroUrl };
}

function logFailure(where: string, err: unknown) {
  console.error(`[integrations] accountant invite ${where} failed:`, (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!INVITE_TOKEN.test(token)) return accountantOutcomePage("invalid", 404);
  try {
    const ctx = await context(request, token);
    if (ctx.fail) return ctx.fail;
    return ctx.invite ? accountantConfirmPage(ctx.invite, ctx.xeroUrl) : accountantOutcomePage("invalid", 404);
  } catch (err) {
    logFailure("page", err);
    return accountantOutcomePage("failed", 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(request)) return accountantOutcomePage("invalid", 403);
  const { token } = await params;
  if (!INVITE_TOKEN.test(token)) return accountantOutcomePage("invalid", 404);
  const form = await request.formData().catch(() => null);
  const action = form?.get("action");
  try {
    const ctx = await context(request, token);
    if (ctx.fail) return ctx.fail;
    if (!ctx.invite) return accountantOutcomePage("invalid", 404);

    if (action === "join") {
      const supabase = await createSupabaseServerClient();
      if (!supabase) return accountantOutcomePage("not_configured", 503);
      const { data: userData } = await supabase.auth.getUser();
      if (!userData?.user) return accountantOutcomePage("sign_in_first", 401, ctx.xeroUrl);
      const { data, error } = await supabase.rpc("redeem_accountant_invite", { p_token_hash: hashInviteToken(token) });
      if (error) {
        const outcome = redeemOutcome(error as { code?: string; hint?: string });
        if (outcome === "failed") logFailure("redeem", error);
        return accountantOutcomePage(outcome, outcome === "failed" ? 500 : 403, ctx.xeroUrl);
      }
      const status = (data as { status?: string } | null)?.status === "already_member" ? "already_member" : "joined";
      return accountantOutcomePage(status, 200, ctx.xeroUrl);
    }

    if (action === "new") {
      const origin = siteOrigin();
      if (!origin) return accountantOutcomePage("not_configured", 503);
      const { error } = await ctx.service.auth.admin.inviteUserByEmail(ctx.invite.email, { redirectTo: `${origin}/auth/set-password` });
      if (error) {
        const status = (error as { status?: number }).status;
        const code = (error as { code?: string }).code;
        if (code === "email_exists" || status === 422) return accountantOutcomePage("has_login", 409, ctx.xeroUrl);
        logFailure("sign-up e-mail", error);
        return accountantOutcomePage("failed", 500);
      }
      const outcome: AccountantOutcome = "check_email";
      return accountantOutcomePage(outcome, 200, ctx.xeroUrl);
    }
    return accountantOutcomePage("invalid", 400);
  } catch (err) {
    logFailure("open", err);
    return accountantOutcomePage("failed", 500);
  }
}
