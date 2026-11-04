import { NextResponse } from "next/server";
import { accountingConnection, disconnectAccounting } from "@/lib/accounting/connections";
import { accountingId } from "@/lib/accounting/types";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ provider: string; action: string }> };
async function handle(request: Request, context: Context, method: "GET" | "POST") {
  if (method === "POST" && !sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  const { provider, action } = await context.params;
  const id = accountingId(provider);
  if (!id || !(method === "GET" ? ["status", "callback"] : ["connect", "disconnect", "check"]).includes(action)) return jsonError("Not found", 404);
  if (!auth.session || auth.session.support || auth.session.read_only) return jsonError("Only the company's own admin can manage accounting connections.", 403);
  const service = createSupabaseAdminClient();
  if (!service) return jsonError("Accounting is not set up yet.", 503);
  const org = auth.profile.organization_id;
  try {
    if (action === "disconnect") { await disconnectAccounting(id, { userClient: auth.supabase, service, org }); return NextResponse.json({ disconnected: true }); }
    const adapter = await accountingConnection(id, { userClient: auth.supabase, service, org, userId: auth.user.id });
    if (action === "status") {
      const { data, error } = await service.from("integration_connections").select("status,tenant_name").eq("organization_id", org).eq("provider", id).maybeSingle();
      return NextResponse.json({ configured: Boolean(adapter), status: error ? "unavailable" : data?.status ?? "not_connected", tenantName: data?.tenant_name ?? null }, { headers: { "cache-control": "no-store" } });
    }
    if (!adapter) return jsonError("This connection is not ready yet. Ask Tolra support to finish setting it up.", 503);
    if (action === "connect") return NextResponse.json({ url: await adapter.begin() });
    if (action === "callback") {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      let ok = false;
      if (!url.searchParams.has("error") && code && state && code.length <= 2000 && /^[A-Za-z0-9_-]{20,200}$/.test(state)) ok = await adapter.finish(state, code, url.searchParams.get("realmId"));
      return NextResponse.redirect(new URL(`/admin/integrations?accounting=${id}&result=${ok ? "connected" : "failed"}`, request.url), 303);
    }
    const body = await request.json().catch(() => null);
    if (typeof body?.invoiceId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.invoiceId)) return jsonError("Choose an invoice.", 400);
    // The caller cannot choose a tenant, company or arbitrary external invoice number.
    const { data, error } = await auth.supabase.from("invoices").select("invoice_ref").eq("organization_id", org).eq("id", body.invoiceId).maybeSingle();
    if (error || !data?.invoice_ref) return jsonError("Invoice not found in this company.", 404);
    return NextResponse.json({ evidence: await adapter.checkInvoice(data.invoice_ref), reviewOnly: true, message: "For review only. No Tolra invoice was marked paid." }, { headers: { "cache-control": "no-store" } });
  } catch {
    // Provider bodies may contain identifiers/tokens. Never return or log raw exceptions.
    if (action === "callback") return NextResponse.redirect(new URL(`/admin/integrations?accounting=${id}&result=failed`, request.url), 303);
    return jsonError("Could not complete the accounting check. Reconnect or try again.", 502);
  }
}
export const GET = (request: Request, context: Context) => handle(request, context, "GET");
export const POST = (request: Request, context: Context) => handle(request, context, "POST");
