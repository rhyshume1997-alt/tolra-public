/** tests/unit/document-customer-links.test.ts. lib/customers/document-links.ts (153 v2): call shapes, refusals before any call, hint mapping. */
import { describe, expect, it } from "vitest";
import {
  DocumentLinkError, PENDING_LINK_COLUMNS, READ_CHUNK, VERIFIED_LINK_COLUMNS, VERIFY_BATCH_MAX, checkReason, customerPortalStatus, linkDocumentCustomer,
  linkDocumentCustomerNameOverride, linkErrorFrom, readPendingBackfillLinks, readVerifiedLinks, retireDocumentCustomerLinks, setCustomerPortalEnabled,
  unlinkDocumentCustomer, verifyDocumentCustomerLinks, type DocumentKind, type PendingLinksClient, type RetireTargetKind, type RpcClient, type VerifiedLinksClient,
} from "@/lib/customers/document-links";

function rpc(answer: { data?: unknown; error?: { message: string; hint?: string } | null } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client: RpcClient = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: answer.data ?? null, error: answer.error ?? null }; } };
  return { client, calls };
}
function view(rows: Record<string, unknown>[]) {
  const reads: Array<{ columns: string; kind: DocumentKind; ids: readonly string[] }> = [];
  const client: VerifiedLinksClient = { from: () => ({ select: columns => ({ eq: (_c, kind) => ({ in: async (_d, ids) => {
    reads.push({ columns, kind, ids });
    return { data: rows.filter(r => ids.includes(String(r.document_id))), error: null };
  } }) }) }) };
  return { client, reads };
}
const MONEY = /total|cost|margin|balance|price|status|approv/;

describe("document customer links (153 v2)", () => {
  it("links with the exact RPC name and arguments, the reason trimmed, and never a company id", async () => {
    const { client, calls } = rpc({ data: { link_id: "L", doc_kind: "job", document_id: "J", customer_id: "C", source: "manual" } });
    expect(await linkDocumentCustomer(client, { kind: "job", documentId: "J", customerId: "C", reason: "  checked with the office  " }))
      .toEqual({ linkId: "L", docKind: "job", documentId: "J", customerId: "C", source: "manual" });
    expect(calls).toEqual([["link_document_customer", { p_kind: "job", p_document: "J", p_customer: "C", p_reason: "checked with the office" }]]);
  });
  it("name override: refused before any call unless identity is confirmed; then sends p_identity_confirmed true", async () => {
    const { client, calls } = rpc({ data: { link_id: "L", doc_kind: "quote", document_id: "Q", customer_id: "C", source: "name_override" } });
    await expect(linkDocumentCustomerNameOverride(client, { kind: "quote", documentId: "Q", customerId: "C", reason: "typo on sent quote", identityConfirmed: false }))
      .rejects.toMatchObject({ code: "identity_not_confirmed" });
    expect(calls).toEqual([]);
    expect((await linkDocumentCustomerNameOverride(client, { kind: "quote", documentId: "Q", customerId: "C", reason: "typo on sent quote", identityConfirmed: true })).source)
      .toBe("name_override");
    expect(calls).toEqual([["link_document_customer_name_override", { p_kind: "quote", p_document: "Q", p_customer: "C", p_reason: "typo on sent quote", p_identity_confirmed: true }]]);
  });
  it("verify: de-duplicates, sends ids and the reason, and refuses an empty or oversized batch before any call", async () => {
    const { client, calls } = rpc({ data: { verified: 2, verified_at: "t" } });
    expect(await verifyDocumentCustomerLinks(client, { linkIds: ["A", "B", "A", ""], reason: " checked " })).toEqual({ verified: 2, verifiedAt: "t" });
    expect(calls).toEqual([["verify_document_customer_links", { p_links: ["A", "B"], p_reason: "checked" }]]);
    const empty = rpc();
    await expect(verifyDocumentCustomerLinks(empty.client, { linkIds: [], reason: "r" })).rejects.toMatchObject({ code: "invalid_batch" });
    const big = Array.from({ length: VERIFY_BATCH_MAX + 1 }, (_, i) => `L${i}`);
    await expect(verifyDocumentCustomerLinks(empty.client, { linkIds: big, reason: "r" })).rejects.toMatchObject({ code: "invalid_batch" });
    expect(empty.calls).toEqual([]);
  });
  it("unlinks with the exact RPC name and arguments", async () => {
    const { client, calls } = rpc({ data: { link_id: "L", unlinked_at: "2026-11-11T10:00:00Z" } });
    expect(await unlinkDocumentCustomer(client, { kind: "quote", documentId: "Q", reason: "wrong customer" })).toEqual({ linkId: "L", unlinkedAt: "2026-11-11T10:00:00Z" });
    expect(calls).toEqual([["unlink_document_customer", { p_kind: "quote", p_document: "Q", p_reason: "wrong customer" }]]);
  });
  it("retire: job, quote or customer only, exact arguments", async () => {
    const { client, calls } = rpc({ data: { retired: 3, target_kind: "customer", target_id: "C" } });
    expect(await retireDocumentCustomerLinks(client, { targetKind: "customer", targetId: "C", reason: "customer erased on request" }))
      .toEqual({ retired: 3, targetKind: "customer", targetId: "C" });
    expect(calls).toEqual([["retire_document_customer_links", { p_target_kind: "customer", p_target: "C", p_reason: "customer erased on request" }]]);
    await expect(retireDocumentCustomerLinks(rpc().client, { targetKind: "invoice" as RetireTargetKind, targetId: "I", reason: "r" })).rejects.toMatchObject({ code: "invalid_kind" });
  });
  it.each(["", "   ", "x".repeat(501)])("refuses a missing or oversized reason before any call (%#)", async reason => {
    const { client, calls } = rpc();
    await expect(linkDocumentCustomer(client, { kind: "job", documentId: "J", customerId: "C", reason })).rejects.toMatchObject({ code: "reason_required" });
    await expect(linkDocumentCustomerNameOverride(client, { kind: "job", documentId: "J", customerId: "C", reason, identityConfirmed: true })).rejects.toMatchObject({ code: "reason_required" });
    await expect(verifyDocumentCustomerLinks(client, { linkIds: ["L"], reason })).rejects.toMatchObject({ code: "reason_required" });
    await expect(unlinkDocumentCustomer(client, { kind: "job", documentId: "J", reason })).rejects.toMatchObject({ code: "reason_required" });
    await expect(retireDocumentCustomerLinks(client, { targetKind: "job", targetId: "J", reason })).rejects.toMatchObject({ code: "reason_required" });
    await expect(setCustomerPortalEnabled(client, { enabled: true, reason })).rejects.toMatchObject({ code: "reason_required" });
    expect(calls).toEqual([]);
  });
  it.each(["invoice", "credit_note", "JOB", ""])("refuses kind %s before any call: jobs and quotes only", async kind => {
    const { client, calls } = rpc();
    await expect(linkDocumentCustomer(client, { kind: kind as DocumentKind, documentId: "J", customerId: "C", reason: "r" })).rejects.toMatchObject({ code: "invalid_kind" });
    await expect(unlinkDocumentCustomer(client, { kind: kind as DocumentKind, documentId: "J", reason: "r" })).rejects.toMatchObject({ code: "invalid_kind" });
    await expect(readVerifiedLinks(view([]).client, kind as DocumentKind, ["J"])).rejects.toMatchObject({ code: "invalid_kind" });
    expect(calls).toEqual([]);
  });
  it.each(["admin_required", "admin_or_office_required", "mfa_required", "mfa_recent_required", "customer_mismatch", "names_match", "already_linked",
           "not_linked", "internal_job", "not_pending", "link_stale", "link_not_found", "no_customer_text", "link_immutable", "link_other_company", "customer_not_found", "document_not_found", "identity_not_confirmed", "invalid_batch", "invalid_kind", "reason_required", "invalid_enabled"] as const)(
    "maps the database hint %s to the same code", async hint => {
      const { client } = rpc({ error: { message: "refused", hint } });
      await expect(linkDocumentCustomer(client, { kind: "job", documentId: "J", customerId: "C", reason: "r" })).rejects.toMatchObject({ code: hint, message: "refused" });
    });
  it("an unknown hint is 'unknown', never a silent success", () => {
    expect(linkErrorFrom({ message: "boom", hint: "something_else" })).toMatchObject({ code: "unknown" });
    expect(linkErrorFrom({ message: "boom" })).toBeInstanceOf(DocumentLinkError);
  });
  it("reads only the verified view's seven columns, by kind, in chunks, de-duplicated", async () => {
    const ids = Array.from({ length: READ_CHUNK + 5 }, (_, i) => `D${i}`);
    const { client, reads } = view([{ id: "L1", organization_id: "O", doc_kind: "quote", document_id: "D3", customer_id: "C", source: "backfill", verified_at: "t" }]);
    const links = await readVerifiedLinks(client, "quote", [...ids, "D3"]);
    expect(reads.map(r => r.ids.length)).toEqual([READ_CHUNK, 5]);
    expect(reads.every(r => r.columns === VERIFIED_LINK_COLUMNS && r.kind === "quote")).toBe(true);
    expect([...links.keys()]).toEqual(["D3"]);
    expect(links.get("D3")?.verifiedAt).toBe("t");
    expect(VERIFIED_LINK_COLUMNS).not.toMatch(MONEY);
  });
  it("pending backfill links: only unverified, live backfill rows, oldest first, no money columns", async () => {
    const seen: string[] = [];
    const client: PendingLinksClient = { from: rel => ({ select: cols => { seen.push(rel, cols); return { eq: (c, v) => { seen.push(`${c}=${v}`); return {
      is: (a, x) => { seen.push(`${a} is ${x}`); return { is: (b, y) => { seen.push(`${b} is ${y}`); return { order: (o, opt) => { seen.push(`${o} asc=${opt.ascending}`); return {
        limit: async n => { seen.push(`limit ${n}`); return { data: [{ id: "L", doc_kind: "job", job_id: "J", quote_id: null, customer_id: "C",
          document_customer_text: "Acme", customer_name_at_link: "ACME", linked_at: "t" }], error: null }; } }; } }; } }; } }; } }; } }) };
    expect(await readPendingBackfillLinks(client)).toEqual([{ id: "L", docKind: "job", documentId: "J", customerId: "C", documentCustomerText: "Acme", customerNameAtLink: "ACME", linkedAt: "t" }]);
    expect(seen).toEqual(["document_customer_links", PENDING_LINK_COLUMNS, "source=backfill", "verified_at is null", "unlinked_at is null", "linked_at asc=true", "limit 200"]);
    expect(PENDING_LINK_COLUMNS).not.toMatch(MONEY);
  });
  it("portal switch: status off by default; ON and OFF send exactly enabled and reason", async () => {
    expect(await customerPortalStatus(rpc({ data: { enabled: false, changed_at: null } }).client)).toEqual({ enabled: false, changedAt: null });
    const { client, calls } = rpc({ data: { enabled: true, changed_at: "t" } });
    await setCustomerPortalEnabled(client, { enabled: true, reason: "pilot customer" });
    expect(calls).toEqual([["customer_portal_set_enabled", { p_enabled: true, p_reason: "pilot customer" }]]);
  });
  it("checkReason trims and keeps 500 characters", () => {
    expect(checkReason(` ${"a".repeat(500)} `)).toHaveLength(500);
  });
});
