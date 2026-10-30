import { NextResponse } from "next/server";

import { toCsv, toXlsx } from "@/lib/spreadsheet";
import { SUMMARY_COLUMNS, SUMMARY_MAX_ROWS, parseRange, summaryFileName, summaryRows } from "@/lib/integrations/xero/batch";
import { loadDocuments, loadSendRows } from "@/lib/integrations/xero/batch-server";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/** The accountant's summary may be read by the office as well as an admin (it holds the documents' totals, not a token or a secret). */
const SUMMARY_ROLES = ["admin", "office"];

/**
 * Admin or office: the Xero send summary for a date range as a CSV (or .xlsx with format=xlsx): each issued invoice and credit note of the
 * range with its Xero number and id, when it was sent, its status and any error, and a "Not sent" line for each one with no send row. The
 * file name carries the company and the range. Only the caller's own company (every read carries the organisation); a support session is
 * refused before any database call. It is a read: nothing is sent or changed.
 */
export async function GET(request: Request) {
  const auth = await requireProfile(SUMMARY_ROLES);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't read the Xero summary.", 403);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!range.ok) return jsonError(range.error, 400);
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const service = createSupabaseAdminClient();
  if (!service) return jsonError("Service unavailable", 503);
  const org = auth.profile.organization_id;
  try {
    const docs = await loadDocuments(service, org, range.range, SUMMARY_MAX_ROWS);
    if (docs.length >= SUMMARY_MAX_ROWS) return jsonError("That range holds too many documents for one file. Choose a shorter range.", 413);
    const sends = await loadSendRows(service, org, docs);
    const rows = summaryRows({ docs, sends, range: range.range });
    const { data: company } = await service.from("organizations").select("name").eq("id", org).maybeSingle();
    const name = summaryFileName((company as { name?: string } | null)?.name, range.range, format);
    const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "xlsx") {
      const bytes = await toXlsx("Xero summary", SUMMARY_COLUMNS, rows);
      return new NextResponse(bytes as BodyInit, { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    }
    return new NextResponse(toCsv(SUMMARY_COLUMNS, rows), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  } catch (err) {
    console.error("[integrations] summary failed:", err instanceof Error ? err.name : "error");
    return jsonError("Couldn't build the summary. Try again.", 500);
  }
}
