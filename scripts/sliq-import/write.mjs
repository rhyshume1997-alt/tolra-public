// Reads the target (read only) for the collision check, and writes the import. The write goes through the existing
// importer: the SliQ records are turned into the JSON that supabase/import/export_legacy.sql produces
// ("quoteflow-legacy-export/1") and handed to public.import_legacy_tenant(), which keys every row in
// public.legacy_import_map. What that format cannot carry (several invoice lines, payments, part-paid state) is added in the
// SAME transaction, only for invoices this run created. Everything commits together or not at all.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { checkDatabaseUrl, checkOrganisationId, GuardError } from "./guard.mjs";
import { prepareJobsWrite } from "./jobs-write.mjs";
import { legacyId, normNumber, normaliseName } from "./ids.mjs";
import { penceToPounds } from "./parse.mjs";
import { analyse } from "./reconcile.mjs";

const IMPORTER_SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/import/import_legacy_tenant.sql");
const money = (p) => Number(penceToPounds(p));
const noon = (d) => `${d}T12:00:00+00:00`;

async function connect(databaseUrl) {
  checkDatabaseUrl(databaseUrl);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const { rows } = await db.query("select current_database() as name");
  try {
    checkDatabaseUrl(`postgresql://x@127.0.0.1/${rows[0].name}`); // the name the server reports gets the same screening
  } catch (e) {
    await db.end();
    throw e;
  }
  return db;
}

/**
 * The "prepare rehearsal copy" step. Run once on a DISPOSABLE copy (a restore of a backup, or the local stack) before a
 * rehearsal: it adds public.rehearsal_identity with one random id. The report records that id and a write refuses unless the
 * target database holds exactly that id. The table is not a migration and is never created in production, so production can
 * never pass. Passes the same URL screening as a write.
 */
export async function prepareRehearsal(databaseUrl) {
  const db = await connect(databaseUrl);
  try {
    await db.query("begin");
    await db.query(
      `create table if not exists public.rehearsal_identity (
         singleton  boolean primary key default true check (singleton),
         id         uuid not null default gen_random_uuid(),
         created_at timestamptz not null default now()
       )`,
    );
    await db.query("alter table public.rehearsal_identity enable row level security");
    await db.query("revoke all on public.rehearsal_identity from public, anon, authenticated");
    await db.query("insert into public.rehearsal_identity (singleton) values (true) on conflict do nothing");
    const id = (await db.query("select id from public.rehearsal_identity")).rows[0].id;
    await db.query("commit");
    return id;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

async function readRehearsalId(db) {
  const has = (await db.query("select to_regclass('public.rehearsal_identity') is not null as ok")).rows[0].ok;
  return has ? ((await db.query("select id from public.rehearsal_identity")).rows[0]?.id ?? null) : null;
}

/** The target organisation's existing numbers and customer names, plus which of them an earlier SliQ run created. */
export async function readTarget(db, organizationId, loaded) {
  const org = checkOrganisationId(organizationId);
  const exists = (await db.query("select to_regclass('public.legacy_import_map') is not null as ok")).rows[0].ok;
  const orgRow = await db.query("select 1 from public.organizations where id = $1", [org]);
  if (orgRow.rowCount === 0) throw new GuardError(`Refusing: organisation ${org} does not exist in the target.`);
  const refs = async (table, col) => new Map((await db.query(`select ${col} as ref, id from public.${table} where organization_id = $1 and ${col} is not null`, [org])).rows.map((r) => [r.ref, r.id]));
  const target = {
    invoices: await refs("invoices", "invoice_ref"), quotes: await refs("quotes", "quote_ref"), purchaseOrders: await refs("purchase_orders", "po_ref"), stock: await refs("stock", "sku"),
    customerNames: new Map(), supplierNames: new Map(), rehearsalId: await readRehearsalId(db),
    mapped: { invoices: new Map(), quotes: new Map(), purchaseOrders: new Map(), stock: new Map() },
  };
  for (const [table, key] of [["customers", "customerNames"], ["suppliers", "supplierNames"]]) {
    for (const r of (await db.query(`select name from public.${table} where organization_id = $1`, [org])).rows) {
      const k = normaliseName(r.name);
      target[key].set(k, [...(target[key].get(k) ?? []), r.name]);
    }
  }
  if (exists) {
    const sets = [["invoices", "invoices", loaded.records.invoices, "number"], ["quotes", "quotes", loaded.records.quotes, "number"], ["purchase_orders", "purchaseOrders", loaded.records.purchaseOrders, "number"], ["stock", "stock", loaded.records.products, "code"]];
    for (const [source, kind, rows, field] of sets) {
      const ids = [...new Set(rows.filter((r) => r[field]).map((r) => String(legacyId(org, source, normNumber(r[field])))))];
      if (ids.length === 0) continue;
      const m = await db.query("select old_id, new_id from public.legacy_import_map where source = $1 and old_id = any($2::text[])", [source, ids]);
      for (const r of m.rows) target.mapped[kind].set(r.old_id, r.new_id);
    }
  }
  return target;
}

/** Dry run with a target: one read-only transaction, rolled back. */
export async function readTargetReadOnly(databaseUrl, organizationId, loaded) {
  const db = await connect(databaseUrl);
  try {
    await db.query("begin read only");
    const t = await readTarget(db, organizationId, loaded);
    await db.query("rollback");
    return t;
  } finally {
    await db.end();
  }
}

export function buildLegacyExport(plan, organizationId) {
  const stamp = (d) => (d ? noon(d) : undefined);
  const join = (...xs) => xs.filter(Boolean).join("\n") || null;
  const customers = plan.customers.map((c) => ({
    id: c.oldId, organization_id: organizationId, name: c.name, email: c.email, phone: c.phone,
    address: [c.address, c.postcode].filter(Boolean).join(", ") || null,
    notes: join(c.notes, c.vatNumber ? `VAT number: ${c.vatNumber}` : null), status: "active",
  }));
  // Suppliers have no address column: it is kept in the notes. The rating columns take the table's own defaults.
  const suppliers = plan.suppliers.map((c) => ({
    id: c.oldId, organization_id: organizationId, name: c.name, email: c.email, phone: c.phone, on_time_rate: 100, reliability_status: "good",
  }));
  const stock = plan.stock.map((p) => ({
    id: p.oldId, organization_id: organizationId, sku: p.code, material: p.description, current_stock: p.stock, min_level: 0, reorder_quantity: 0,
    preferred_supplier: null, unit_price: p.unitPrice === null ? null : money(p.unitPrice), lead_time_days: null, auto_purchase: false,
  }));
  const purchase_orders = plan.purchaseOrders.map((p) => ({
    id: p.oldId, organization_id: organizationId, po_ref: p.number, supplier: p.supplierName, order_date: p.orderDate, expected_delivery: p.deliveryDate,
    items: [], total_value: p.total === null ? null : money(p.total), status: p.status, notes: null, created_at: stamp(p.orderDate), updated_at: stamp(p.orderDate),
  }));
  const quotes = plan.quotes.map((q) => ({
    id: q.oldId, organization_id: organizationId, quote_ref: q.number, customer: q.customerName, description: null, total_value: money(q.gross),
    status: q.status, valid_until: q.validUntil, sent_date: null, rfq_id: null, created_at: stamp(q.date), updated_at: stamp(q.date),
  }));
  const invoices = plan.invoices.map((i) => ({
    id: i.oldId, organization_id: organizationId, invoice_ref: i.number, job_id: null, customer: i.customerName, description: null, quantity: null, unit_price: null,
    subtotal: money(i.net), vat: money(i.vat), total: money(i.gross), // issued invoices go in as 'sent'; the real state is set below, only for new ones
    status: i.status === "sent" ? "sent" : i.status, sent_date: null, due_date: i.dueDate, paid_date: null, created_at: stamp(i.date), updated_at: stamp(i.date),
  }));
  return {
    format: "quoteflow-legacy-export/1",
    exported_at: new Date().toISOString(),
    counts: { customers: customers.length, suppliers: suppliers.length, stock: stock.length, purchase_orders: purchase_orders.length, quotes: quotes.length, invoices: invoices.length },
    organizations: [], user_profiles: [], customers, suppliers, stock, rfqs: [], quotes, jobs: [], sales_orders: [], invoices, purchase_orders, delivery_notes: [], email_history: [], audit_log: [],
  };
}

/**
 * @param opts { databaseUrl, organizationId, loaded, excludeNumbers, installImporter }
 * The caller has already passed assertWriteAllowed. The target is screened again here, and the collision check is repeated
 * inside the transaction (that one is the authoritative one).
 */
export async function writeImport(opts) {
  const { databaseUrl, loaded, excludeNumbers = [], installImporter = false, expectedRehearsalId = null, resolutions = null } = opts;
  const org = checkOrganisationId(opts.organizationId);
  const db = await connect(databaseUrl);
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext('import_legacy_tenant'))");
    // The target must be the prepared rehearsal copy the report was made against.
    const identity = await readRehearsalId(db);
    if (!expectedRehearsalId || identity !== expectedRehearsalId) {
      throw new GuardError(`Refusing: the target database is not the rehearsal copy the report was made for (report: ${expectedRehearsalId ?? "none"}, target: ${identity ?? "no rehearsal identity"}).`);
    }
    // The installed importer must be the version that reseeds counters for the target organisation only.
    const fn = (await db.query("select coalesce((select prosrc like '%sliq-scoped-reseed%' from pg_proc where oid = to_regprocedure('public.import_legacy_tenant(jsonb,uuid)')), false) as ok")).rows[0].ok;
    if (!fn) {
      if (!installImporter) throw new GuardError("The importer in the target (supabase/import/import_legacy_tenant.sql) is missing or is an older version that reseeds every company's counters. Install the current file, or pass --install-importer.");
      await db.query(readFileSync(IMPORTER_SQL, "utf8"));
    }
    const target = await readTarget(db, org, loaded);
    const { report, plan } = analyse(loaded, { organizationId: org, target, excludeNumbers, resolutions });
    if (!report.writable) throw new GuardError("Refusing: the source has unreadable rows or unknown excluded numbers.");
    if (report.unresolvedCreditNoteCount > 0) throw new GuardError("Refusing: credit notes or allocations are unresolved.");
    if (report.unresolvedReviewCount > 0) throw new GuardError("Refusing: documents flagged for reverse charge or discounts are unresolved.");
    // Jobs, sales orders, PO job links and opening WIP (jobs-write.mjs), in this same transaction.
    const jobsRun = opts.jobsLoaded?.profile ? await prepareJobsWrite(db, org, { loaded, jobsLoaded: opts.jobsLoaded, plan, coreReport: report }) : null;

    // Which of this run's records the map already knows (a repeat run): only the others are new.
    const known = async (source, ids) => new Set((await db.query("select old_id from public.legacy_import_map where source = $1 and old_id = any($2::text[])", [source, ids.map(String)])).rows.map((r) => r.old_id));
    const knownInvoices = await known("invoices", plan.invoices.map((i) => i.oldId));
    const knownCustomers = await known("customers", plan.customers.map((c) => c.oldId));
    const knownSuppliers = await known("suppliers", plan.suppliers.map((c) => c.oldId));
    const knownQuotes = await known("quotes", plan.quotes.map((c) => c.oldId));

    const json = buildLegacyExport(plan, org);
    jobsRun?.addToExport(json);
    const imported = (await db.query("select public.import_legacy_tenant($1::jsonb, $2::uuid) as r", [JSON.stringify(json), org])).rows[0].r;
    if (!imported.ok) throw new Error("the importer did not report ok");

    // Contact names and notes (the importer has no columns for them) for customers and suppliers created now.
    for (const c of plan.customers) {
      if (knownCustomers.has(String(c.oldId)) || !c.contact) continue;
      await db.query("update public.customers set contact_name = $3 where organization_id = $1 and id = (select new_id from public.legacy_import_map where source = 'customers' and old_id = $2)", [org, String(c.oldId), c.contact]);
    }
    for (const c of plan.suppliers) {
      if (knownSuppliers.has(String(c.oldId))) continue;
      const address = [c.address, c.postcode].filter(Boolean).join(", ");
      const notes = [address ? `Address: ${address}` : null, c.vatNumber ? `VAT number: ${c.vatNumber}` : null, c.notes].filter(Boolean).join("\n") || null;
      await db.query("update public.suppliers set contact_name = $3, notes = $4 where organization_id = $1 and id = (select new_id from public.legacy_import_map where source = 'suppliers' and old_id = $2)", [org, String(c.oldId), c.contact, notes]);
    }
    // Quote lines for quotes created now (the importer made none: the quote header carries no line).
    let quoteLines = 0;
    for (const qt of plan.quotes) {
      if (knownQuotes.has(String(qt.oldId)) || qt.lines.length === 0) continue;
      const id = (await db.query("select new_id from public.legacy_import_map where source = 'quotes' and old_id = $1", [String(qt.oldId)])).rows[0]?.new_id;
      for (const l of qt.lines) {
        await db.query(
          "insert into public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct) values ($1,$2,$3,$4,$5,$6,$7)",
          [org, id, l.position, l.description, l.quantityMilli / 1000, money(l.unitPence), l.vatCenti / 100],
        );
        quoteLines++;
      }
    }

    const created = { invoices: 0, lines: 0, payments: 0, paymentToConfirm: 0, quoteLines };
    const newIds = [];
    for (const inv of plan.invoices) {
      if (knownInvoices.has(String(inv.oldId))) continue;
      const id = (await db.query("select new_id from public.legacy_import_map where source = 'invoices' and old_id = $1", [String(inv.oldId)])).rows[0]?.new_id;
      if (!id) throw new Error(`invoice ${inv.number} was not mapped by the importer`);
      newIds.push(id);
      created.invoices++;
      // The importer makes one line from the header totals. A SliQ invoice has its real lines, or none: no line is invented.
      await db.query("delete from public.invoice_line_items where invoice_id = $1 and organization_id = $2", [id, org]);
      for (const l of inv.lines) {
        await db.query(
          "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1,$2,$3,$4,$5,$6,$7)",
          [org, id, l.position, l.description, l.quantityMilli / 1000, money(l.unitPence), l.vatCenti / 100],
        );
        created.lines++;
      }
      for (const p of inv.payments) {
        const ins = await db.query(
          "insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source) values ($1,$2,$3,$4,$5,$6,'legacy') returning id",
          [org, id, money(p.amountPence), p.date, p.method, p.reference],
        );
        await db.query("insert into public.legacy_import_map (source, old_id, new_id) values ('sliq_payments', $1, $2) on conflict do nothing", [String(p.oldId), ins.rows[0].id]);
        created.payments++;
      }
      await db.query(
        "update public.invoices set invoice_date = $2, status = $3, amount_paid = $4, paid_at = $5, payment_unverified = $6 where id = $1 and organization_id = $7",
        [id, inv.date, inv.final.status, money(inv.final.amountPaid), inv.final.paidAt ? noon(inv.final.paidAt) : null, inv.final.unverified, org],
      );
      if (inv.final.unverified) created.paymentToConfirm++;
    }
    if (newIds.length) {
      const bad = await db.query(
        `select i.invoice_ref from public.invoices i where i.id = any($1::uuid[]) and not i.payment_unverified
           and i.amount_paid <> coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id), 0)`,
        [newIds],
      );
      if (bad.rowCount) throw new Error(`amount paid differs from the payments on ${bad.rows.map((r) => r.invoice_ref).join(", ")}: rolled back`);
    }
    const jobs = jobsRun ? await jobsRun.finish() : null;
    await db.query("commit");
    return { importer: imported, created, report, jobs };
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}
