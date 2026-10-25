/**
 * Migration 094: the Activity page (public.org_activity) shows one row per change. Read time only: every audit row stays stored.
 *
 *   (a) the app's own CREATE / UPDATE / DELETE note (write_audit) on a table the database already records row by row
 *       (security_audit.log_row_change) is not listed; on a table it doesn't (email_history) it is still the only record and is listed;
 *   (b) the row change of an UPDATE its own stamp trigger named (035 actor_stamp: ISSUE, RESEND, ...) is not listed when it changed only
 *       the columns that event accounts for; the named event is; if the same UPDATE changed any other field, both are listed;
 *   any other row change is listed once; another company's rows are never listed; "Load more" (created_at, id) pages as before.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), so it runs on the local stack and on a plain Postgres rebuild
 * with Supabase stand-ins.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

type Row = { id: string; created_at: Date; action: string; entity_table: string; entity_id: string; record_table: string; record_id: string;
  changes: Record<string, unknown> | null; metadata: Record<string, unknown> | null };

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `094 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-094-${label}-${counter}`]);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const writeAudit = (db: Client, action: string, table: string, id: string, oldData: unknown = null, newData: unknown = null) =>
  db.query("select public.write_audit($1, $2, $3, $4, $5, '{}'::jsonb, null, null)", [action, table, id, oldData, newData]);

const activity = (p: Person, args: { before?: Date | null; beforeId?: string | null; limit?: number } = {}) =>
  as(p, async (db) => (await db.query<Row>("select * from public.org_activity(null, null, null, null, $1, $2, $3)",
    [args.before ?? null, args.beforeId ?? null, args.limit ?? 500])).rows);

const stored = (entityIds: string[]) => withDb(async (db) => (await db.query<{ action: string; entity_table: string; source: string }>(
  "select action, entity_table, metadata ->> 'source' as source from security_audit.audit_log where entity_id = any($1) order by created_at, id", [entityIds])).rows);

const W = { A: "", B: "", adminA: person("admin-a"), officeA: person("office-a"), adminB: person("admin-b"), customer: "", invoice: "", customerB: "" };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    W.A = await makeOrg(db, "a");
    W.B = await makeOrg(db, "b");
    await member(db, W.A, W.adminA, "admin");
    await member(db, W.A, W.officeA, "office");
    await member(db, W.B, W.adminB, "admin");
  });
  // Office staff in A: a customer and a draft invoice with one line (the page's save), then the page's own CREATE note.
  await as(W.officeA, async (db) => {
    W.customer = (await db.query<{ id: string }>("insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.A, `Acme ${run}`])).rows[0].id;
    W.invoice = (await db.query<{ id: string }>(
      "insert into public.invoices (organization_id, customer, status, subtotal, vat, total) values ($1, $2, 'draft', 100, 20, 120) returning id", [W.A, `Acme ${run}`])).rows[0].id;
    await db.query(
      "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Flange', 1, 100, 20, false)",
      [W.A, W.invoice]);
  });
  await as(W.officeA, (db) => writeAudit(db, "CREATE", "invoices", W.invoice));
  // Issue it (one request: issue_invoice; the stamp trigger names it ISSUE, the row trigger records the UPDATE).
  await as(W.officeA, (db) => db.query("select public.issue_invoice($1)", [W.invoice]));
  // A real edit of the customer, with the page's own UPDATE note after it (customers/page.tsx).
  await as(W.officeA, async (db) => {
    await db.query("update public.customers set phone = '0123 456' where id = $1", [W.customer]);
  });
  await as(W.officeA, (db) => writeAudit(db, "UPDATE", "customers", W.customer, { phone: null }, { phone: "0123 456" }));
  // An admin renames a person (app/api/admin/users/route.ts: the update as the admin, then its UPDATE note on user_profiles).
  await as(W.adminA, (db) => db.query("update public.user_profiles set full_name = 'Olive Office' where id = $1", [W.officeA.id]));
  await as(W.adminA, (db) => writeAudit(db, "UPDATE", "user_profiles", W.officeA.id, { full_name: "x" }, { full_name: "Olive Office" }));
  // The invoice is e-mailed (first sent_date: a plain row change), then sent again (the stamp trigger's RESEND).
  await as(W.officeA, (db) => db.query("update public.invoices set sent_date = now() - interval '1 hour' where id = $1", [W.invoice]));
  await as(W.officeA, (db) => db.query("update public.invoices set sent_date = now() where id = $1", [W.invoice]));
  // An admin settles an unknown send outcome (mail/resolve): email_history has no row trigger, so this note is its only record.
  await as(W.adminA, (db) => writeAudit(db, "UPDATE", "email_history", W.invoice, { outcome: "unknown" }, { outcome: "failed" }));
  // Company B: its own customer and edit, with the app's notes.
  await as(W.adminB, async (db) => {
    W.customerB = (await db.query<{ id: string }>("insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.B, `Beta ${run}`])).rows[0].id;
  });
  await as(W.adminB, (db) => writeAudit(db, "CREATE", "customers", W.customerB));
});

afterAll(async () => {
  await destroySyntheticWorld(run);
});

const summary = (rows: Row[]) => rows.slice().reverse().map((r) => `${r.action} ${r.entity_table}`);

describe("org_activity: one row per change (094)", () => {
  it("issuing an invoice shows its creation and Issued once each, never 'Status changed to issued' or the app's CREATE beside them", async () => {
    const rows = (await activity(W.adminA)).filter((r) => r.record_table === "invoices" && r.record_id === W.invoice);
    expect(summary(rows)).toEqual([
      "INSERT invoices", "INSERT invoice_line_items", "ISSUE invoices",
      "UPDATE invoices", // the first e-mail: sent_date set (a plain row change, listed once)
      "RESEND invoices",
    ]);
    expect(rows.find((r) => r.action === "ISSUE")?.metadata).toMatchObject({ invoice_ref: expect.stringMatching(/^INV-/) });
    expect(rows.filter((r) => r.action === "UPDATE").map((r) => Object.keys(r.changes ?? {}))).toEqual([["sent_date"]]);
    // Nothing was removed from the audit log: the app's CREATE and both stamped row changes are still stored.
    expect((await stored([W.invoice])).filter((r) => r.entity_table === "invoices").map((r) => `${r.action} ${r.source}`)).toEqual([
      "INSERT database_trigger", "CREATE write_audit", "ISSUE write_audit", "UPDATE database_trigger",
      "UPDATE database_trigger", "RESEND write_audit", "UPDATE database_trigger",
    ]);
  });

  it("a real field change shows once, as the database's row change with what changed; the app's own note of it is hidden", async () => {
    const rows = await activity(W.adminA);
    const customer = rows.filter((r) => r.entity_table === "customers" && r.entity_id === W.customer);
    expect(summary(customer)).toEqual(["INSERT customers", "UPDATE customers"]);
    expect(customer[0].changes).toEqual({ phone: { from: null, to: "0123 456" } });
    const profile = rows.filter((r) => r.entity_table === "user_profiles" && r.entity_id === W.officeA.id);
    expect(summary(profile)).toEqual(["INSERT user_profiles", "UPDATE user_profiles"]);
    expect(Object.keys(profile[0].changes ?? {})).toEqual(["full_name"]);
    expect(rows.some((r) => r.action === "CREATE")).toBe(false);
    expect((await stored([W.customer, W.officeA.id])).filter((r) => r.source === "write_audit").map((r) => `${r.action} ${r.entity_table}`))
      .toEqual(["UPDATE customers", "UPDATE user_profiles"]);
  });

  it("named events still show, and an app note on a table without row changes (email_history) is still listed", async () => {
    const rows = await activity(W.adminA);
    expect(rows.filter((r) => r.entity_id === W.invoice && ["ISSUE", "RESEND"].includes(r.action)).map((r) => r.action)).toEqual(["RESEND", "ISSUE"]);
    expect(rows.filter((r) => r.entity_table === "email_history").map((r) => r.action)).toEqual(["UPDATE"]);
  });

  it("another company's rows are never listed, either way round", async () => {
    const a = await activity(W.adminA);
    const b = await activity(W.adminB);
    expect(a.some((r) => r.entity_id === W.customerB || r.entity_id === W.adminB.id)).toBe(false);
    expect(b.some((r) => [W.customer, W.invoice, W.adminA.id, W.officeA.id].includes(r.entity_id))).toBe(false);
    expect(summary(b.filter((r) => r.entity_table === "customers"))).toEqual(["INSERT customers"]);
    // Office staff still can't read the log at all.
    await expect(activity(W.officeA)).rejects.toMatchObject({ code: "42501" });
  });

  it("'Load more' pages exactly as before: page after page of 2 gives the whole list once, in order", async () => {
    const all = await activity(W.adminA);
    expect(all.length).toBeGreaterThan(6);
    const paged: Row[] = [];
    for (let page = await activity(W.adminA, { limit: 2 }); page.length; ) {
      paged.push(...page);
      const last = page[page.length - 1];
      page = await activity(W.adminA, { before: last.created_at, beforeId: last.id, limit: 2 });
    }
    expect(paged.map((r) => r.id)).toEqual(all.map((r) => r.id));
  });
});

/** Every audit row as stored: how many, and an md5 over each row's id and chain hash (any write, change or removal moves it). */
const auditFingerprint = () => withDb(async (db) => (await db.query<{ n: string; h: string }>(
  "select count(*)::text as n, md5(coalesce(string_agg(id::text || ':' || coalesce(hash, ''), ',' order by id), '')) as h from security_audit.audit_log")).rows[0]);

/**
 * One change, made the way the app makes it (`steps`, each its own request): the Activity entries it adds for `entityId`, how many audit
 * rows it stored, and proof that reading the Activity log wrote, changed and removed no audit row.
 */
async function once(steps: (() => Promise<unknown>)[], entityId: string) {
  const before = new Set((await activity(W.adminA)).map((r) => r.id));
  const storedBefore = (await stored([entityId])).length;
  for (const step of steps) await step();
  const audit = await auditFingerprint();
  const added = (await activity(W.adminA)).filter((r) => !before.has(r.id) && (r.entity_id === entityId || r.record_id === entityId));
  await activity(W.adminA, { limit: 3 });
  expect(await auditFingerprint(), "org_activity wrote, changed or removed no audit row").toEqual(audit);
  return { added, storedRows: (await stored([entityId])).length - storedBefore };
}

describe("exactly one Activity entry per change (094)", () => {
  it("issuing an invoice: the Issued entry only (its row change and nothing else listed)", async () => {
    const invoice = await as(W.officeA, async (db) => {
      const id = (await db.query<{ id: string }>(
        "insert into public.invoices (organization_id, customer, status, subtotal, vat, total) values ($1, $2, 'draft', 50, 10, 60) returning id", [W.A, `Acme ${run}`])).rows[0].id;
      await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Bush', 1, 50, 20, false)", [W.A, id]);
      return id;
    });
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("select public.issue_invoice($1)", [invoice]))], invoice);
    expect(added.map((r) => r.action)).toEqual(["ISSUE"]);
    expect(storedRows).toBe(2); // ISSUE and the row change: both kept
  });

  it("updating a customer: one entry, the row change with what changed (the page's own UPDATE note hidden)", async () => {
    const customer = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.customers (organization_id, name) values ($1, $2) returning id", [W.A, `Once Co ${run}`])).rows[0].id);
    const { added, storedRows } = await once([
      () => as(W.officeA, (db) => db.query("update public.customers set email = 'accounts@once.example.test' where id = $1", [customer])),
      () => as(W.officeA, (db) => writeAudit(db, "UPDATE", "customers", customer, { email: null }, { email: "accounts@once.example.test" })),
    ], customer);
    expect(added.map((r) => `${r.action} ${Object.keys(r.changes ?? {}).join(",")}`)).toEqual(["UPDATE email"]);
    expect(storedRows).toBe(2);
  });

  it("renaming a user (the admin route: the update as the admin, then its write_audit UPDATE on user_profiles): one entry", async () => {
    const { added, storedRows } = await once([
      () => as(W.adminA, (db) => db.query("update public.user_profiles set full_name = 'Olive O. Office' where id = $1", [W.officeA.id])),
      () => as(W.adminA, (db) => writeAudit(db, "UPDATE", "user_profiles", W.officeA.id, { full_name: "Olive Office" }, { full_name: "Olive O. Office" })),
    ], W.officeA.id);
    expect(added.map((r) => `${r.action} ${Object.keys(r.changes ?? {}).join(",")}`)).toEqual(["UPDATE full_name"]);
    expect(storedRows).toBe(2);
  });

  it("changing a status: a sales order confirmed (the stamp trigger's CONFIRM) is one entry, Confirmed", async () => {
    const order = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.sales_orders (organization_id, so_number, customer, status) values ($1, $2, $3, 'open') returning id", [W.A, `SO-${run}`, `Acme ${run}`])).rows[0].id);
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("update public.sales_orders set status = 'confirmed' where id = $1", [order]))], order);
    expect(added.map((r) => r.action)).toEqual(["CONFIRM"]);
    expect(storedRows).toBe(2);
  });

  it("changing a status with no named event (a draft quote sent, as the Quotes page does): one entry, the row change", async () => {
    const quote = await as(W.officeA, async (db) => (await db.query<{ id: string }>(
      "insert into public.quotes (organization_id, quote_ref, customer, status, total_value) values ($1, $2, $3, 'draft', 0) returning id", [W.A, `QUO-${run}`, `Acme ${run}`])).rows[0].id);
    const { added, storedRows } = await once([() => as(W.officeA, (db) => db.query("update public.quotes set status = 'sent', sent_at = now() where id = $1", [quote]))], quote);
    expect(added.map((r) => `${r.action} ${(r.changes?.status as { to?: string } | undefined)?.to}`)).toEqual(["UPDATE sent"]);
    expect(storedRows).toBe(1);
  });
});

/**
 * A company's audit chain written directly, with created_at chosen by the test. HOW EQUALITY IS FORCED: production's
 * security_audit.set_audit_hash (BEFORE INSERT) always sets created_at := clock_timestamp() and computes the hash, so no ordinary write
 * can give two rows the same time. Here the superuser test connection (postgres, the owner) writes the rows in one transaction with
 * `set local session_replication_role = replica` (the same switch destroySyntheticWorld uses), which skips that trigger for this
 * transaction only, and computes each row's previous_hash and hash itself with set_audit_hash's own formula (sha256 over the previous
 * hash and the row's fields, created_at::text last). The result is a correctly chained run of rows, some with identical created_at.
 * No guard, trigger, function or setting is changed; production writes are untouched. The rows go with the company at teardown.
 */
type ChainRow = { action: string; table: string; entity: string; source: "write_audit" | "database_trigger"; at: string;
  old?: Record<string, unknown> | null; new?: Record<string, unknown> | null; meta?: Record<string, unknown> };
async function writeChain(org: string, actor: string, chain: ChainRow[]) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      let previous: string | null = (await db.query<{ h: string | null }>(
        "select hash as h from security_audit.audit_log where organization_id = $1 order by organization_id, created_at desc limit 1", [org])).rows[0]?.h ?? null;
      const ids: string[] = [];
      for (const r of chain) {
        const row = (await db.query<{ id: string; hash: string }>(
          `insert into security_audit.audit_log (organization_id, actor_user_id, action, entity_table, entity_id, old_data, new_data, metadata, created_at, previous_hash, hash)
           select $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::text,
                  encode(extensions.digest(coalesce($10::text, '') || $1::uuid::text || coalesce($2::uuid::text, '') || $3 || $4 || coalesce($5, '')
                    || coalesce($6::jsonb::text, '') || coalesce($7::jsonb::text, '') || coalesce($8::jsonb::text, '') || $9::timestamptz::text, 'sha256'), 'hex')
           returning id, hash`,
          [org, actor, r.action, r.table, r.entity, r.old ?? null, r.new ?? null, JSON.stringify({ source: r.source, ...(r.meta ?? {}) }), r.at, previous])).rows[0];
        previous = row.hash;
        ids.push(row.id);
      }
      await db.query("commit");
      return ids;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

describe("matching never depends on timestamp order (094)", () => {
  const C = { org: "", admin: person("admin-c") };

  beforeAll(async () => {
    await withDb(async (db) => {
      C.org = await makeOrg(db, "c");
      await member(db, C.org, C.admin, "admin");
    });
  });

  it("an ISSUE and its row change with the SAME created_at: only Issued is listed; two unrelated rows sharing a time are both listed; an event stamped LATER than its row change still hides it", async () => {
    const [inv1, inv2, inv3, cust] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const t = "2026-10-20 10:00:00.123456+00";
    const t2 = "2026-10-20 10:05:00.5+00";
    const issued = { old: { status: "draft" }, new: { status: "issued" } };
    const [issueId, rowChangeId, otherA, otherB, laterRowChange, laterIssue, laterChangeId] = await writeChain(C.org, C.admin.id, [
      // 1. the stamp trigger's ISSUE, then its row change: identical created_at, linked by previous_hash
      { action: "ISSUE", table: "invoices", entity: inv1, source: "write_audit", at: t, meta: { invoice_ref: "INV-EQ1" } },
      { action: "UPDATE", table: "invoices", entity: inv1, source: "database_trigger", at: t, ...issued },
      // 2. two unrelated changes at one identical time (another invoice's edit, then a customer's): both stay
      { action: "UPDATE", table: "invoices", entity: inv2, source: "database_trigger", at: t2, old: { notes: null }, new: { notes: "Deliver to rear" } },
      { action: "UPDATE", table: "customers", entity: cust, source: "database_trigger", at: t2, old: { phone: null }, new: { phone: "0700" } },
      // 3. times the wrong way round: a plain edit of inv3, then an ISSUE of inv3 stamped 11:00, then its row change stamped 08:00
      //    (three hours EARLIER than the event it is chained to)
      { action: "UPDATE", table: "invoices", entity: inv3, source: "database_trigger", at: "2026-10-20 09:00:00+00", old: { notes: "x" }, new: { notes: "y" } },
      { action: "ISSUE", table: "invoices", entity: inv3, source: "write_audit", at: "2026-10-20 11:00:00+00", meta: { invoice_ref: "INV-EQ3" } },
      { action: "UPDATE", table: "invoices", entity: inv3, source: "database_trigger", at: "2026-10-20 08:00:00+00", ...issued },
    ]);
    const stamps = await withDb(async (db) => (await db.query<{ id: string; at: string }>(
      "select id, created_at::text as at from security_audit.audit_log where id = any($1)", [[issueId, rowChangeId, otherA, otherB]])).rows);
    const at = Object.fromEntries(stamps.map((s) => [s.id, s.at]));
    expect(at[issueId]).toBe(at[rowChangeId]); // the pair shares one created_at
    expect(at[otherA]).toBe(at[otherB]);
    const listed = new Set((await activity(C.admin)).map((r) => r.id));
    expect(listed.has(issueId)).toBe(true);
    expect(listed.has(rowChangeId)).toBe(false);
    expect(listed.has(otherA) && listed.has(otherB)).toBe(true);
    expect(listed.has(laterRowChange)).toBe(true); // its predecessor is a plain row change, not an ISSUE: listed
    expect(listed.has(laterIssue)).toBe(true);
    expect(listed.has(laterChangeId)).toBe(false); // chained to an ISSUE stamped three hours LATER than itself: still hidden
    // The rows are all stored: nothing hidden is gone.
    expect((await withDb((db) => db.query("select count(*)::int as n from security_audit.audit_log where id = any($1)",
      [[issueId, rowChangeId, otherA, otherB, laterRowChange, laterIssue, laterChangeId]]))).rows[0].n).toBe(7);
  });
});

/**
 * A stamped update that ALSO changed other fields (Astra's must-fix): the row change is hidden only when every field it shows is one
 * the named event accounts for (094's fixed list per event and table). Otherwise it is listed beside the named event, with all its changes.
 */
describe("a stamped update that also changed other fields (094)", () => {
  const D = { org: "", admin: person("admin-d") };

  beforeAll(async () => {
    await withDb(async (db) => {
      D.org = await makeOrg(db, "d");
      await member(db, D.org, D.admin, "admin");
    });
  });

  it("ISSUE (the forged chain: issue_invoice sets only its own columns and a direct issue is refused): issued with its due date changed lists Issued AND the row change showing due_date; issued alone lists Issued only", async () => {
    const [mixed, alone] = [randomUUID(), randomUUID()];
    const [mixedIssue, mixedChange, aloneIssue, aloneChange] = await writeChain(D.org, D.admin.id, [
      { action: "ISSUE", table: "invoices", entity: mixed, source: "write_audit", at: "2026-10-21 09:00:00+00", meta: { invoice_ref: "INV-MX1" } },
      { action: "UPDATE", table: "invoices", entity: mixed, source: "database_trigger", at: "2026-10-21 09:00:00.001+00",
        old: { status: "draft", invoice_ref: null, issued_at: null, due_date: "2026-11-20" },
        new: { status: "issued", invoice_ref: "INV-MX1", issued_at: "2026-10-21T09:00:00+00:00", due_date: "2026-12-20" } },
      { action: "ISSUE", table: "invoices", entity: alone, source: "write_audit", at: "2026-10-21 09:10:00+00", meta: { invoice_ref: "INV-MX2" } },
      { action: "UPDATE", table: "invoices", entity: alone, source: "database_trigger", at: "2026-10-21 09:10:00.001+00",
        old: { status: "draft", invoice_ref: null, issued_at: null, issuer_snapshot: null, customer_snapshot: null },
        new: { status: "issued", invoice_ref: "INV-MX2", issued_at: "2026-10-21T09:10:00+00:00", issuer_snapshot: { name: "D" }, customer_snapshot: { name: "Acme" } } },
    ]);
    const rows = await activity(D.admin);
    const listed = new Set(rows.map((r) => r.id));
    expect(listed.has(mixedIssue) && listed.has(mixedChange)).toBe(true);
    expect(Object.keys(rows.find((r) => r.id === mixedChange)?.changes ?? {}).sort()).toEqual(["due_date", "invoice_ref", "issued_at", "status"]);
    expect(listed.has(aloneIssue)).toBe(true);
    expect(listed.has(aloneChange)).toBe(false);
  });

  it("every event's own columns alone stay hidden, and one more field lists the row change (ISSUE credit note, MARK_PAID, RESEND, CONFIRM, REOPEN)", async () => {
    const cases: { action: string; table: string; own: [Record<string, unknown>, Record<string, unknown>]; extra: string }[] = [
      { action: "ISSUE", table: "credit_notes", extra: "reason",
        own: [{ status: "draft", credit_ref: null, issued_at: null, issuer_snapshot: null, customer_snapshot: null },
              { status: "issued", credit_ref: "CRD-0001", issued_at: "2026-10-21T10:00:00+00:00", issuer_snapshot: { name: "D" }, customer_snapshot: { name: "Acme" } }] },
      { action: "MARK_PAID", table: "invoices", extra: "payment_unverified",
        own: [{ status: "partial", paid_at: null, amount_paid: 50, credited_amount: 0 }, { status: "paid", paid_at: "2026-10-21T12:00:00+00:00", amount_paid: 100, credited_amount: 20 }] },
      { action: "RESEND", table: "invoices", extra: "job_id", own: [{ sent_date: "2026-10-20T09:00:00+00:00" }, { sent_date: "2026-10-21T09:00:00+00:00" }] },
      { action: "RESEND", table: "quotes", extra: "internal_notes", own: [{ sent_at: "2026-10-20T09:00:00+00:00" }, { sent_at: "2026-10-21T09:00:00+00:00" }] },
      { action: "CONFIRM", table: "sales_orders", extra: "delivery_date",
        own: [{ status: "open", confirmed_at: null }, { status: "confirmed", confirmed_at: "2026-10-21T10:00:00+00:00" }] },
      { action: "REOPEN", table: "jobs", extra: "notes",
        own: [{ finished_at: "2026-10-20T15:00:00+00:00", inspected_at: "2026-10-20T16:00:00+00:00", inspected_by: "QA", stage: "complete" },
              { finished_at: null, inspected_at: null, inspected_by: null, stage: "machining" }] },
    ];
    const chain: ChainRow[] = [];
    cases.forEach((c, i) => {
      for (const [k, withExtra] of [[0, false], [1, true]] as const) {
        const entity = randomUUID();
        const at = `2026-10-21 1${i}:0${k}:00+00`;
        chain.push({ action: c.action, table: c.table, entity, source: "write_audit", at });
        chain.push({ action: "UPDATE", table: c.table, entity, source: "database_trigger", at: `2026-10-21 1${i}:0${k}:00.001+00`,
          old: { ...c.own[0], ...(withExtra ? { [c.extra]: "before" } : {}) }, new: { ...c.own[1], ...(withExtra ? { [c.extra]: "after" } : {}) } });
      }
    });
    const ids = await writeChain(D.org, D.admin.id, chain);
    const rows = await activity(D.admin);
    const byId = new Map(rows.map((r) => [r.id, r]));
    cases.forEach((c, i) => {
      const [aloneEvent, aloneChange, mixedEvent, mixedChange] = ids.slice(i * 4, i * 4 + 4);
      const label = `${c.action} ${c.table}`;
      expect(byId.has(aloneEvent) && byId.has(mixedEvent), `${label}: the named event is listed`).toBe(true);
      expect(byId.has(aloneChange), `${label}: its own columns only: row change hidden`).toBe(false);
      expect(byId.has(mixedChange), `${label}: plus ${c.extra}: row change listed`).toBe(true);
      expect(Object.keys(byId.get(mixedChange)?.changes ?? {}), `${label}: the row change shows ${c.extra}`).toContain(c.extra);
    });
  });

  it("RESEND, the way the app can do it: an invoice e-mailed again with its job linked in the same update lists Resent AND the row change (sent_date, job_id)", async () => {
    const { invoice, job } = await as(W.officeA, async (db) => {
      const id = (await db.query<{ id: string }>(
        "insert into public.invoices (organization_id, customer, status, subtotal, vat, total) values ($1, $2, 'draft', 40, 8, 48) returning id", [W.A, `Acme ${run}`])).rows[0].id;
      await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Pin', 1, 40, 20, false)", [W.A, id]);
      const jobId = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, $3) returning id",
        [W.A, `J-${run}-mx`, `Acme ${run}`])).rows[0].id;
      return { invoice: id, job: jobId };
    });
    await as(W.officeA, (db) => db.query("select public.issue_invoice($1)", [invoice]));
    await as(W.officeA, (db) => db.query("update public.invoices set sent_date = now() - interval '1 hour' where id = $1", [invoice]));
    const { added, storedRows } = await once([
      () => as(W.officeA, (db) => db.query("update public.invoices set sent_date = now(), job_id = $2 where id = $1", [invoice, job])),
    ], invoice);
    expect(added.map((r) => r.action).sort()).toEqual(["RESEND", "UPDATE"]);
    expect(Object.keys(added.find((r) => r.action === "UPDATE")?.changes ?? {}).sort()).toEqual(["job_id", "sent_date"]);
    expect(storedRows).toBe(2);
  });

  it("RESEND of a quote with its internal note edited, and CONFIRM of a sales order with its delivery date changed (one API update each): the named event AND the row change", async () => {
    const { quote, order } = await as(W.officeA, async (db) => ({
      quote: (await db.query<{ id: string }>(
        "insert into public.quotes (organization_id, quote_ref, customer, status, total_value) values ($1, $2, $3, 'draft', 0) returning id", [W.A, `QUO-${run}-mx`, `Acme ${run}`])).rows[0].id,
      order: (await db.query<{ id: string }>(
        "insert into public.sales_orders (organization_id, so_number, customer, status) values ($1, $2, $3, 'open') returning id", [W.A, `SO-${run}-mx`, `Acme ${run}`])).rows[0].id,
    }));
    await as(W.officeA, (db) => db.query("update public.quotes set status = 'sent', sent_at = now() - interval '1 hour' where id = $1", [quote]));
    const resent = await once([
      () => as(W.officeA, (db) => db.query("update public.quotes set sent_at = now(), internal_notes = 'Chased by phone' where id = $1 and status = 'sent'", [quote])),
    ], quote);
    expect(resent.added.map((r) => r.action).sort()).toEqual(["RESEND", "UPDATE"]);
    expect(Object.keys(resent.added.find((r) => r.action === "UPDATE")?.changes ?? {}).sort()).toEqual(["internal_notes", "sent_at"]);
    const confirmed = await once([
      () => as(W.officeA, (db) => db.query("update public.sales_orders set status = 'confirmed', delivery_date = current_date + 14 where id = $1", [order])),
    ], order);
    expect(confirmed.added.map((r) => r.action).sort()).toEqual(["CONFIRM", "UPDATE"]);
    expect(Object.keys(confirmed.added.find((r) => r.action === "UPDATE")?.changes ?? {}).sort()).toEqual(["confirmed_at", "delivery_date", "status"]);
  });
});

describe("who may read the Activity log (unchanged by 094)", () => {
  const R = { workshop: person("workshop-a"), viewer: person("viewer-a"), support: person("support-a"), ended: person("ended-a") };

  beforeAll(async () => {
    await withDb(async (db) => {
      await member(db, W.A, R.workshop, "workshop");
      await member(db, W.A, R.viewer, "viewer");
      // Support access (036): a platform owner's expiring admin membership, chosen for the session under its grant. One live, one ended.
      for (const [p, live] of [[R.support, true], [R.ended, false]] as const) {
        await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
        await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
                        values ($1, $2, 'Tolra Support', 'admin', $3, true, false)`, [p.id, p.email, W.A]);
        await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
        const grant = randomUUID();
        await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
                        values ($1, $2, 'admin', true, true, now() + case when $3 then interval '2 hours' else interval '-1 hour' end, $4)`, [p.id, W.A, live, grant]);
        p.session = randomUUID();
        await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
        await db.query("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [p.session, p.id, W.A, grant]);
      }
    });
  });

  afterAll(async () => {
    await withDb((db) => db.query("delete from security_audit.platform_admins where user_id = any($1)", [[R.support.id, R.ended.id]]));
  });

  it("office, workshop and viewer are refused (42501 Only admins can view the activity log); anon has no EXECUTE; an ended support window is refused", async () => {
    for (const p of [W.officeA, R.workshop, R.viewer, R.ended]) {
      await expect(activity(p)).rejects.toMatchObject({ code: "42501", message: "Only admins can view the activity log" });
    }
    const anon = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set local role anon");
        await db.query("select * from public.org_activity()");
        return null;
      } catch (error) {
        return error as { code?: string; message: string };
      } finally {
        await db.query("rollback");
      }
    });
    expect(anon).toMatchObject({ code: "42501", message: expect.stringContaining("permission denied for function org_activity") });
    expect(await withDb(async (db) => (await db.query<{ v: boolean }>(
      "select has_function_privilege('anon', 'public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)', 'EXECUTE') as v")).rows[0].v)).toBe(false);
  });

  it("a live support session (036: admin role, read-only) reads A's log exactly as A's admin does, nothing of B's; B's admin sees nothing of A's", async () => {
    const support = (await activity(R.support)).map((r) => r.id);
    expect(support).toEqual((await activity(W.adminA)).map((r) => r.id));
    expect((await activity(W.adminB)).some((r) => [W.customer, W.invoice, W.adminA.id, W.officeA.id].includes(r.entity_id))).toBe(false);
  });
});
