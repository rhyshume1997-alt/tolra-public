/**
 * Legacy single-tenant import (audit B10: A1/A11, SEC13). supabase/import/import_legacy_tenant.sql still works after
 * every migration (000-026) is applied: a synthetic export of the OLD schema loads into ONE organisation with the
 * same-company link, issued-document and totals checks active, keeps money and links, writes nothing to another
 * company, is idempotent, leaves the read-only supabase/verify scripts clean, and the imported issued documents stay
 * protected through the API. Synthetic data only; the importer runs as the database owner, like the SQL editor.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildLegacyExport, legacyIds } from "../support/legacy-export";
import { owed } from "@/lib/receivables";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const SQL_DIR = path.resolve(__dirname, "../../supabase");
const read = (file: string) => readFileSync(path.join(SQL_DIR, file), "utf8");

let world: SyntheticWorld;
let alpha: string;
let beta: string;
let importerWasInstalled = false;
let exportJson: Record<string, unknown>;
let firstReport: Report;

type TableReport = { read: number; inserted: number; matched_existing: number; already_imported: number; skipped: number };
type Report = {
  ok: boolean;
  tables: Record<string, TableReport>;
  line_items: Record<string, number>;
  unmatched_profiles: { email: string; role: string; old_id: string }[];
  skipped: { table: string; old_id: string }[];
  notes: string[];
};

let RUN = "00000000";
let OFF = 0;
const uid = (n: number) => legacyIds(RUN).uid(n);

const runImport = (json: unknown) =>
  withDb(async (db) => (await db.query<{ r: Report }>("select public.import_legacy_tenant($1::jsonb, $2::uuid) as r", [JSON.stringify(json), alpha])).rows[0].r);

const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(sql, params)).rows);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  RUN = world.runId;
  OFF = legacyIds(world.runId).off;
  alpha = world.tenants.alpha.id;
  beta = world.tenants.beta.id;
  // The importer file is idempotent: it only creates two archive tables and the function. They are not part of the
  // reviewed catalogue (catalogue.test.ts), so a run that had to create them removes them again in afterAll.
  await withDb(async (db) => {
    importerWasInstalled = (await db.query("select to_regclass('public.legacy_import_map') as t")).rows[0].t !== null;
    await db.query(read("import/import_legacy_tenant.sql"));
  });
  exportJson = buildLegacyExport(world);
});

afterAll(async () => {
  if (!world) return;
  // Owner-only cleanup of the importer's own tables (the generic teardown knows the organisation-owned rows only).
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica"); // legacy_audit_log is append-only for everyone, owner included
    await db.query("delete from public.legacy_import_map where old_id like $1 or (old_id ~ '^[0-9]+$' and old_id::bigint between $2 and $3)", [`${RUN}-%`, OFF, OFF + 999]);
    await db.query("delete from public.legacy_audit_log where old_id::text like $1", [`${RUN}-%`]);
    if (!importerWasInstalled) {
      await db.query("drop function public.import_legacy_tenant(jsonb, uuid)");
      await db.query("drop table public.legacy_import_map, public.legacy_audit_log");
    }
    await db.query("commit");
  });
  await destroySyntheticWorld(world.runId);
});

describe("legacy import into one organisation", () => {
  it("imports the export and reports the expected counts", async () => {
    firstReport = await runImport(exportJson);
    expect(firstReport.ok).toBe(true);
    expect(firstReport.notes).toEqual([]);
    const t = firstReport.tables;
    for (const [table, n] of Object.entries({ customers: 2, suppliers: 2, stock: 1, rfqs: 1, quotes: 3, sales_orders: 2, jobs: 3, invoices: 3, purchase_orders: 1, delivery_notes: 1, email_history: 2 })) {
      expect(t[table], table).toMatchObject({ read: n, inserted: n, matched_existing: 0, already_imported: 0, skipped: 0 });
    }
    expect(t.audit_log_to_legacy_audit_log).toMatchObject({ read: 2, inserted: 2 });
    expect(firstReport.line_items).toEqual({ quote_line_items_created: 3, invoice_line_items_created: 3, delivery_note_items_created: 3 });
    // The two matched users already had profiles (created with the organisation), so they are matched, not re-inserted.
    expect(t.user_profiles).toMatchObject({ read: 3, skipped: 1 });
    expect(t.user_profiles.inserted + t.user_profiles.matched_existing).toBe(2);
    expect(firstReport.unmatched_profiles).toEqual([{ email: `nobody.${world.runId}@example.test`, role: "workshop", old_id: uid(3) }]);
    expect(firstReport.skipped.filter((s) => s.table !== "user_profiles")).toEqual([]);
  });

  it("keeps quotes and invoices consistent with their single line item", async () => {
    const quotes = await q<{ quote_ref: string; status: string; total_value: string; lines: string; line_sum: string; sent_at: string | null }>(
      `select q.quote_ref, q.status, q.total_value::text, count(l.id)::text as lines, coalesce(sum(round(l.quantity * l.unit_price, 2)), 0)::text as line_sum, q.sent_at::text
       from public.quotes q left join public.quote_line_items l on l.quote_id = q.id where q.organization_id = $1 group by q.id order by q.quote_ref`, [alpha]);
    expect(quotes.map((r) => [r.quote_ref, r.status, Number(r.total_value), r.lines, Number(r.line_sum)])).toEqual([
      ["QUO-7001", "sent", 300, "1", 250], ["QUO-7002", "accepted", 480, "1", 400], ["QUO-7003", "draft", 119.98, "1", 99.98],
    ]);
    expect(quotes[0].sent_at).not.toBeNull();
    const invoices = await q<{ invoice_ref: string; status: string; subtotal: string; vat: string; total: string; amount_paid: string; paid_at: string | null; lines: string; line_net: string }>(
      `select i.invoice_ref, i.status, i.subtotal::text, i.vat::text, i.total::text, i.amount_paid::text, i.paid_at::text, count(l.id)::text as lines,
              coalesce(sum(round(l.quantity * l.unit_price, 2)), 0)::text as line_net
       from public.invoices i left join public.invoice_line_items l on l.invoice_id = i.id where i.organization_id = $1 group by i.id order by i.invoice_ref`, [alpha]);
    expect(invoices.map((r) => [r.invoice_ref, r.status, Number(r.subtotal), Number(r.vat), Number(r.total), Number(r.amount_paid), r.lines, Number(r.line_net)])).toEqual([
      ["INV-7001", "paid", 500, 100, 600, 600, "1", 500], ["INV-7002", "part_paid", 501, 100.2, 601.2, 0, "1", 501], ["INV-7003", "sent", 99.99, 20, 119.99, 0, "1", 99.99],
    ]);
    expect(invoices[0].paid_at).not.toBeNull();
    expect(invoices[1].paid_at).toBeNull();
    // No payment amounts in the export: an invoice not marked paid is flagged "payment to confirm", not assumed unpaid
    // (migration 027), and nothing is owed on it until someone checks. No receipt is invented for the part-paid one.
    const flags = await q<{ invoice_ref: string; payment_unverified: boolean; status: string; total: string; amount_paid: string }>(
      "select invoice_ref, payment_unverified, status, total::text, amount_paid::text from public.invoices where organization_id = $1 order by invoice_ref", [alpha]);
    expect(flags.map((r) => [r.invoice_ref, r.payment_unverified])).toEqual([["INV-7001", false], ["INV-7002", true], ["INV-7003", true]]);
    expect(flags.map((r) => owed({ ...r, total: Number(r.total), amount_paid: Number(r.amount_paid) }))).toEqual([0, 0, 0]);
    // And, with part payments (migration 032), the paid one carries exactly one legacy payment row for its amount; the
    // flagged ones none, so amount_paid is the sum of the payments for every invoice that isn't flagged.
    const legacyRows = await q<{ invoice_ref: string; amount: string; source: string }>(
      "select i.invoice_ref, p.amount::text, p.source from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.organization_id = $1 order by i.invoice_ref", [alpha]);
    expect(legacyRows).toEqual([{ invoice_ref: "INV-7001", amount: "600.00", source: "legacy" }]);
  });

  it("maps renamed columns, job values, delivery note items and the order <-> job links", async () => {
    const jobs = await q<{ job_no: string; value: string | null; quote_ref: string | null; quote_id: string | null; finished_at: string | null }>(
      "select j.job_no, v.value::text, j.quote_ref, j.quote_id::text, j.finished_at::text from public.jobs j left join public.job_values v on v.job_id = j.id where j.organization_id = $1 order by j.job_no", [alpha]);
    expect(jobs.map((j) => [j.job_no, j.value === null ? null : Number(j.value)])).toEqual([["J-7001", 480], ["J-7002", null], ["J-7003", 1234.56]]);
    expect(jobs[0]).toMatchObject({ quote_ref: "QUO-7002" });
    expect(jobs[0].quote_id).not.toBeNull();
    expect(jobs[1].finished_at).not.toBeNull();

    const links = await q<{ so_number: string; order_org: string; job_no: string | null; job_org: string | null; back_so: string | null; quote_ref: string | null }>(
      `select so.so_number, so.organization_id::text as order_org, j.job_no, j.organization_id::text as job_org, j.converted_from_sales_order_id::text as back_so, so.quote_ref
       from public.sales_orders so left join public.jobs j on j.id = so.converted_to_job_id where so.organization_id = $1 order by so.so_number`, [alpha]);
    expect(links[0]).toMatchObject({ so_number: "SO-7001", job_no: "J-7001", order_org: alpha, job_org: alpha, quote_ref: "QUO-7002" });
    const so1 = await q<{ id: string }>("select id::text from public.sales_orders where organization_id = $1 and so_number = 'SO-7001'", [alpha]);
    expect(links[0].back_so).toBe(so1[0].id);
    expect(links[1]).toMatchObject({ so_number: "SO-7002", job_no: null, quote_ref: "QUO-7001" });

    const dn = await q<{ dn_number: string; job_ref: string; signed_by_name: string; items: string }>(
      `select d.dn_number, d.job_ref, d.signed_by_name, (select string_agg(i.position || ':' || i.description || ':' || i.quantity::float8, '|' order by i.position) from public.delivery_note_items i where i.delivery_note_id = d.id) as items
       from public.delivery_notes d where d.organization_id = $1`, [alpha]);
    expect(dn).toEqual([{ dn_number: "DLN-7001", job_ref: "J-7001", signed_by_name: "A. Receiver", items: "0:Bracket:10|1:Spacer:4|2:Loose fixings:1" }]);

    const po = await q<{ po_ref: string; po_number: string }>("select po_ref, po_number from public.purchase_orders where organization_id = $1", [alpha]);
    expect(po).toEqual([{ po_ref: "PO-7001", po_number: "PO-7001" }]);

    const mail = await q<{ related_to_type: string; related_to_id: string; target: string }>(
      "select e.related_to_type, e.related_to_id, coalesce(qq.quote_ref, ii.invoice_ref) as target from public.email_history e left join public.quotes qq on qq.id::text = e.related_to_id left join public.invoices ii on ii.id::text = e.related_to_id where e.organization_id = $1 order by e.subject", [alpha]);
    expect(mail.map((m) => m.target)).toEqual(["INV-7001", "QUO-7001"]);
    const inv = await q<{ job_no: string }>("select j.job_no from public.invoices i join public.jobs j on j.id = i.job_id where i.organization_id = $1 and i.invoice_ref = 'INV-7001'", [alpha]);
    expect(inv).toEqual([{ job_no: "J-7001" }]);
  });

  it("puts every imported row in the target organisation and nothing in the other company", async () => {
    const tables = ["customers", "suppliers", "stock", "rfqs", "quotes", "quote_line_items", "sales_orders", "jobs", "job_values", "invoices", "invoice_line_items", "purchase_orders", "delivery_notes", "delivery_note_items", "email_history"];
    const expected: Record<string, number> = { customers: 2, suppliers: 2, stock: 1, rfqs: 1, quotes: 3, quote_line_items: 3, sales_orders: 2, jobs: 3, job_values: 2, invoices: 3, invoice_line_items: 3, purchase_orders: 1, delivery_notes: 1, delivery_note_items: 3, email_history: 2 };
    for (const table of tables) {
      const [row] = await q<{ a: string; b: string; total_legacy: string }>(
        `select count(*) filter (where organization_id = $1)::text as a, count(*) filter (where organization_id = $2)::text as b, count(*) filter (where organization_id not in ($1, $2))::text as total_legacy
         from public.${table} where organization_id in (select id from public.organizations where slug like $3)`, [alpha, beta, `%${world.runId}%`]);
      expect({ table, alpha: Number(row.a), beta: Number(row.b), other: Number(row.total_legacy) }).toEqual({ table, alpha: expected[table], beta: 0, other: 0 });
    }
    // Nothing from the export points at the legacy organisation id, and the archive carries the target organisation.
    expect(await q("select 1 from public.organizations where id = $1", [uid(900)])).toEqual([]);
    expect(Number((await q<{ n: string }>("select count(*)::text as n from public.legacy_audit_log where organization_id = $1", [alpha]))[0].n)).toBe(1);
    expect(Number((await q<{ n: string }>("select count(*)::text as n from public.legacy_audit_log where old_id = any($1)", [[uid(301), uid(302)]]))[0].n)).toBe(2);
    // Matched users became members of alpha only.
    const members = await q<{ role: string }>("select role from public.organization_members where organization_id = $1 and user_id = any($2) order by role", [alpha, [world.tenants.alpha.users.admin.id, world.tenants.alpha.users.office.id]]);
    expect(members.map((m) => m.role)).toEqual(["admin", "office"]);
    // Document counters continue after the highest imported number.
    const counters = await q<{ prefix: string; last: string }>("select prefix, last::text from public.doc_counters where organization_id = $1 order by prefix", [alpha]);
    expect(Object.fromEntries(counters.map((c) => [c.prefix, Number(c.last)]))).toMatchObject({ "QUO": 7003, "INV": 7003, "J": 7003, "PO": 7001 });
  });

  it("leaves the read-only verify scripts clean for the organisation", async () => {
    const run = (file: string) => withDb(async (db) => (await db.query(read(`verify/${file}`))).rows as Record<string, unknown>[]);
    const mine = (rows: Record<string, unknown>[]) => rows.filter((r) => r.organization_id === alpha || r.child_org === alpha || r.parent_org === alpha);
    expect(mine(await run("cross_org_links.sql"))).toEqual([]);
    expect(mine(await run("document_totals.sql"))).toEqual([]);
    expect(mine(await run("duplicate_conversions.sql"))).toEqual([]);
    // unmarked_bans lists platform bans, not company data: none of this company's logins may be in it.
    const bans = await run("unmarked_bans.sql");
    const ours = new Set(Object.values(world.tenants.alpha.users).map((u) => u.email));
    expect(bans.filter((b) => ours.has(b.email as string))).toEqual([]);
  });

  it("is idempotent: importing the same export again adds nothing", async () => {
    const before = await q<{ source: string; n: string }>("select source, count(*)::text as n from public.legacy_import_map group by source order by source");
    const rowsBefore = await q<{ t: string; n: string }>(
      `select 'quotes' t, count(*)::text n from public.quotes where organization_id = $1 union all select 'invoices', count(*)::text from public.invoices where organization_id = $1
       union all select 'jobs', count(*)::text from public.jobs where organization_id = $1 union all select 'qli', count(*)::text from public.quote_line_items where organization_id = $1
       union all select 'dni', count(*)::text from public.delivery_note_items where organization_id = $1 union all select 'members', count(*)::text from public.organization_members where organization_id = $1`, [alpha]);
    const again = await runImport(exportJson);
    expect(again.ok).toBe(true);
    for (const [table, n] of Object.entries({ customers: 2, suppliers: 2, stock: 1, rfqs: 1, quotes: 3, sales_orders: 2, jobs: 3, invoices: 3, purchase_orders: 1, delivery_notes: 1, email_history: 2 })) {
      expect(again.tables[table], table).toMatchObject({ read: n, inserted: 0, matched_existing: 0, already_imported: n });
    }
    expect(again.tables.audit_log_to_legacy_audit_log).toMatchObject({ inserted: 0, already_imported: 2 });
    expect(again.line_items).toEqual({ quote_line_items_created: 0, invoice_line_items_created: 0, delivery_note_items_created: 0 });
    expect(again.tables.user_profiles.inserted).toBe(0);
    expect(again.unmatched_profiles).toHaveLength(1);
    expect(await q("select source, count(*)::text as n from public.legacy_import_map group by source order by source")).toEqual(before);
    expect(await q(
      `select 'quotes' t, count(*)::text n from public.quotes where organization_id = $1 union all select 'invoices', count(*)::text from public.invoices where organization_id = $1
       union all select 'jobs', count(*)::text from public.jobs where organization_id = $1 union all select 'qli', count(*)::text from public.quote_line_items where organization_id = $1
       union all select 'dni', count(*)::text from public.delivery_note_items where organization_id = $1 union all select 'members', count(*)::text from public.organization_members where organization_id = $1`, [alpha])).toEqual(rowsBefore);
  });
});

describe("imported records through the API", () => {
  let office: SupabaseClient;
  let admin: SupabaseClient;
  let betaAdmin: SupabaseClient;
  beforeAll(async () => {
    admin = await signedInClient(world.tenants.alpha.users.admin);
    office = await signedInClient(world.tenants.alpha.users.office);
    betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  });

  it("alpha office and admin can read the imported records", async () => {
    for (const [table, n] of Object.entries({ customers: 2, quotes: 3, invoices: 3, jobs: 3, sales_orders: 2, purchase_orders: 1, delivery_notes: 1, email_history: 2 })) {
      const { data, error } = await office.from(table).select("id");
      expect({ table, error: error?.message, n: data?.length }).toEqual({ table, error: undefined, n });
    }
  });

  it("an imported sent quote and issued invoice are protected by the issue lock", async () => {
    const { data: sent } = await office.from("quotes").select("id").eq("quote_ref", "QUO-7001").single();
    const edit = await office.from("quotes").update({ total_value: 1 }).eq("id", sent!.id).select("id");
    expect(edit.error, "total_value of a sent quote must be refused").not.toBeNull();
    const { data: after } = await office.from("quotes").select("total_value").eq("id", sent!.id).single();
    expect(Number(after!.total_value)).toBe(300);
    const { data: inv } = await admin.from("invoices").select("id").eq("invoice_ref", "INV-7003").single();
    const editInv = await admin.from("invoices").update({ total: 1 }).eq("id", inv!.id).select("id");
    expect(editInv.error, "total of a sent invoice must be refused").not.toBeNull();
  });

  it("the other company sees none of it", async () => {
    for (const table of ["customers", "suppliers", "stock", "rfqs", "quotes", "invoices", "jobs", "sales_orders", "purchase_orders", "delivery_notes", "email_history", "quote_line_items", "invoice_line_items", "delivery_note_items"]) {
      const { data, error } = await betaAdmin.from(table).select("id");
      expect({ table, error: error?.message, n: data?.length }).toEqual({ table, error: undefined, n: 0 });
    }
    const { data } = await betaAdmin.from("legacy_audit_log").select("old_id");
    expect(data ?? []).toEqual([]);
  });
});

describe("reconciliation script (supabase/verify/reconcile_legacy_target.sql)", () => {
  it("runs read-only and reports documents, counts and the payment-to-confirm amount kept out of owed", async () => {
    const slug = (await q<{ slug: string }>("select slug from public.organizations where id = $1", [alpha]))[0].slug;
    const text = read("verify/reconcile_legacy_target.sql").replace("'jnr-engineering'::TEXT AS slug", `'${slug}'::TEXT AS slug`);
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ kind: string; ref: string; total: string; to_confirm: boolean | null }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const money = (ref: string) => Number(rows.find((r) => r.kind === "money" && r.ref.trim() === ref)?.total);
    expect(rows.filter((r) => r.kind === "invoice").map((r) => [r.ref, r.to_confirm])).toEqual([["INV-7001", false], ["INV-7002", true], ["INV-7003", true]]);
    expect(money("of which payment to confirm: total (excluded from owed and chasers)")).toBe(720.19 + 1);
    expect(money("of which owed (confirmed): balance")).toBe(0);
    expect(rows.find((r) => r.kind === "count" && r.ref === "invoices")?.total).toBe("3");
  });
});

describe("known gap (documented behaviour, not a failure of the import)", () => {
  it("a legacy quote without a unit price gets a line of total_value / quantity, which document_totals.sql flags", async () => {
    // KNOWN GAP: with no unit_price the importer prices the single line at total_value / quantity as if total_value were
    // NET, but new quotes have VAT switched on, so lines (net + 20%) no longer add up to the stored face value.
    // Issued documents keep the face value they were sent with; document_totals.sql lists the row for a person to review.
    const legacy = buildLegacyExport(world) as Record<string, unknown>;
    const org = (legacy.organizations as { id: string }[])[0].id;
    const row = { id: legacyIds(world.runId).I(59), organization_id: org, quote_ref: "QUO-7099", rfq_id: null, customer: "Legacy Example Ltd", description: "Priceless line", material: null, quantity: 2, unit_price: null,
      total_value: 120, status: "sent", valid_until: null, sent_date: "2026-03-07T09:00:00+00:00", created_by: null, updated_by: null, created_at: "2026-03-03T09:00:00+00:00", updated_at: "2026-03-03T09:00:00+00:00" };
    const only = { format: legacy.format, exported_at: legacy.exported_at, counts: { quotes: 1 }, quotes: [row] };
    const report = await runImport(only);
    expect(report.tables.quotes).toMatchObject({ inserted: 1, skipped: 0 });
    const flagged = await withDb(async (db) => (await db.query<{ ref: string; stored_total: string; lines_subtotal: string; lines_vat: string }>(read("verify/document_totals.sql"))).rows);
    expect(flagged.filter((r) => (r as unknown as { organization_id: string }).organization_id === alpha).map((r) => [r.ref, Number(r.stored_total), Number(r.lines_subtotal), Number(r.lines_vat)])).toEqual([["QUO-7099", 120, 120, 24]]);
  });
});
