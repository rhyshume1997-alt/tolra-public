import { NextResponse } from "next/server";
import { z } from "zod";

import { type CompanyEmailResult, EMAIL_SEND_ROLES, IDEMPOTENCY_KEY, cleanAddress, onRecipientAllowlist, sendCompanyEmail } from "@/lib/email/send-company-email";
import { MAX_PDF_BYTES, fileNameMatches } from "@/lib/email/attachment-check";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * POST /api/email/send: one-click send of a document e-mail (quote, invoice, purchase order, delivery note) through the company mailer
 * (lib/email/send-company-email.ts: Microsoft 365, else Resend, else a draft for Approvals).
 *
 * Office and admin of the company only (requireProfile: an admin also needs the second step when required); a support session is
 * refused. The document is read through the caller's own session (row level security) and must be this company's. Recipients may
 * only be the document's customer (supplier for a purchase order) address on file, the company's own people, or EMAIL_RECIPIENT_DOMAINS.
 * The send is reserved in 106's ledger through the caller's own session (one e-mail per idempotency key, whatever the provider).
 *
 * THE PDF IS BUILT IN THE BROWSER AND UPLOADED, not built here: the documents' PDFs are made by @react-pdf in the page code from data
 * the page loads through the browser client (lib/download-pdf.tsx, the pages' build*Pdf functions), and there is no server-side
 * renderer for them yet. So the upload is checked: at most 5 MB, it must start with %PDF-, and its file name must carry this
 * document's own number (quote-Q-1042.pdf for quote Q-1042). It is the caller's own document only in that sense: an office user could
 * still attach a different PDF they made themselves. (On Vercel a request body is limited to 4.5 MB, so about 3.3 MB of PDF in
 * practice; Microsoft 365 takes 3 MB.)
 */

const MAX_BODY_BYTES = 7_200_000;

const schema = z.object({
  kind: z.enum(["quote", "invoice", "purchase_order", "delivery_note"]),
  record_id: z.string().uuid(),
  to: z.array(z.string().trim().max(254)).min(1).max(5),
  cc: z.array(z.string().trim().max(254)).max(5).optional(),
  subject: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(20_000),
  attachment: z.object({ filename: z.string().trim().min(1).max(120).regex(/\.pdf$/i), content_base64: z.string().min(8).max(7_000_000) }).optional(),
  idempotency_key: z.string().regex(IDEMPOTENCY_KEY).optional(),
});

type Kind = z.infer<typeof schema>["kind"];
const RECORD: Record<Kind, { table: string; columns: string; party: "customer" | "supplier"; numbers: string[] }> = {
  quote: { table: "quotes", columns: "id, organization_id, customer, quote_ref", party: "customer", numbers: ["quote_ref"] },
  invoice: { table: "invoices", columns: "id, organization_id, customer, invoice_ref", party: "customer", numbers: ["invoice_ref"] },
  purchase_order: { table: "purchase_orders", columns: "id, organization_id, supplier, po_ref, po_number", party: "supplier", numbers: ["po_ref", "po_number"] },
  delivery_note: { table: "delivery_notes", columns: "id, organization_id, customer, customer_id, customer_email, dn_number", party: "customer", numbers: ["dn_number"] },
};

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const STATUS: Record<Extract<CompanyEmailResult, { ok: false }>["code"], number> = {
  invalid: 400, recipient_refused: 403, rate_limited: 429, no_provider: 503, provider_error: 502,
};

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...EMAIL_SEND_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // A support session (the platform owner inside a company) never sends the company's e-mail.
  if (auth.session?.support) return jsonError("Support access can't send e-mail.", 403);
  const { supabase, profile, user } = auth;

  const json = await readJson(request, MAX_BODY_BYTES);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const input = parsed.data;

  const to = input.to.map(cleanAddress);
  const cc = (input.cc ?? []).map(cleanAddress);
  if (to.includes(null) || cc.includes(null)) return jsonError("One of the e-mail addresses isn't valid.", 400);
  const recipients = [...to, ...cc] as string[];

  const spec = RECORD[input.kind];
  const { data: record, error: recordError } = await supabase.from(spec.table).select(spec.columns).eq("id", input.record_id).maybeSingle();
  const row = record as Record<string, unknown> | null;
  if (recordError || !row || row.organization_id !== profile.organization_id) return jsonError("Document not found", 404);

  // Who this document may be sent to: its customer's (supplier's) address on file, the company's own people, or the allowlist.
  const allowed = new Set<string>();
  if (lower(row.customer_email)) allowed.add(lower(row.customer_email));
  const partyName = String(row[spec.party] ?? "").trim();
  const partyTable = spec.party === "customer" ? "customers" : "suppliers";
  const party = row.customer_id
    ? supabase.from(partyTable).select("email").eq("organization_id", profile.organization_id).eq("id", String(row.customer_id)).limit(1)
    : supabase.from(partyTable).select("email").eq("organization_id", profile.organization_id).eq("name", partyName || "\u0000none").limit(5);
  const { data: parties } = await party;
  for (const p of (parties ?? []) as Array<{ email?: unknown }>) if (lower(p.email)) allowed.add(lower(p.email));
  const outside = () => recipients.filter((address) => !allowed.has(address) && !onRecipientAllowlist(address, process.env.EMAIL_RECIPIENT_DOMAINS));
  if (outside().length) {
    const { data: people } = await supabase.from("user_profiles").select("email, workshop_email").eq("organization_id", profile.organization_id);
    for (const p of (people ?? []) as Array<{ email?: unknown; workshop_email?: unknown }>) {
      if (lower(p.email)) allowed.add(lower(p.email));
      if (lower(p.workshop_email)) allowed.add(lower(p.workshop_email));
    }
  }
  if (outside().length) {
    const who = spec.party === "customer" ? "customer" : "supplier";
    return jsonError(`This can only be sent to the ${who}'s e-mail address on file or to your own team. Update the ${who}'s e-mail first.`, 403);
  }

  let attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (input.attachment) {
    const content = Buffer.from(input.attachment.content_base64, "base64");
    if (content.length > MAX_PDF_BYTES) return jsonError("The PDF is larger than 5 MB, too large to attach.", 413);
    if (content.subarray(0, 5).toString("latin1") !== "%PDF-") return jsonError("The attachment isn't a PDF.", 400);
    if (!fileNameMatches(input.attachment.filename, spec.numbers.map((column) => row[column]))) return jsonError("The attachment isn't this document's PDF.", 400);
    attachments = [{ filename: input.attachment.filename, content, contentType: "application/pdf" }];
  }

  const result = await sendCompanyEmail(
    {
      organizationId: profile.organization_id, userId: user.id, kind: input.kind, to: to as string[], cc: cc as string[],
      subject: input.subject, text: input.text, recordType: input.kind, recordId: input.record_id, attachments, idempotencyKey: input.idempotency_key,
    },
    { db: supabase },
  );
  if (!result.ok) return NextResponse.json({ status: "failed", error: result.error, code: result.code }, { status: STATUS[result.code] });
  return NextResponse.json({ status: result.mode, provider: result.provider, history_id: result.historyId ?? null });
}
