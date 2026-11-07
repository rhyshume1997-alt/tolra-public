/**
 * Loads a generated PQ dataset into a DISPOSABLE database using only the product's own tables and public functions:
 * create_organization / add_member, next_doc_number, create_with_lines, accept_quote, create_job, save_machine_booking, inspect_job,
 * create_delivery_note (despatch drafts the invoice), issue_invoice, record_invoice_payment, create_credit_note / issue_credit_note,
 * set_archive_state. Acting steps run as the company's own users (SET LOCAL ROLE authenticated + JWT claims), exactly as the app's
 * requests do, so the database's own rules (roles, totals checks, locks, audit) apply. Plain table inserts (service_role) are used
 * only where the product has no function for them: customers, stock, machines, attendance events, labour sessions, and the
 * "finished" stamp the importer path uses for completed jobs.
 *
 * It does NOT check the guard itself: callers (cli.mjs) run verifyDisposableIdentity first. It never touches auth over HTTP: users
 * are created through the `createUser` callback (cli.mjs supplies SQL-insert or Auth-admin-API).
 */

export const poundsOf = (pence) => {
  if (!Number.isInteger(pence) || pence < 0) throw new Error(`not a non-negative whole number of pence: ${pence}`);
  return `${Math.trunc(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
};

class Session {
  constructor(db) {
    this.db = db;
  }
  async as(userId, fn) {
    await this.db.query("begin");
    try {
      await this.db.query("set local role authenticated");
      await this.db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)", [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
      const out = await fn((text, params) => this.db.query(text, params));
      await this.db.query("commit");
      return out;
    } catch (error) {
      await this.db.query("rollback");
      throw error;
    }
  }
  async service(fn) {
    await this.db.query("begin");
    try {
      await this.db.query("set local role service_role");
      const out = await fn((text, params) => this.db.query(text, params));
      await this.db.query("commit");
      return out;
    } catch (error) {
      await this.db.query("rollback");
      throw error;
    }
  }
}

const step = async (what, fn) => {
  try {
    return await fn();
  } catch (error) {
    error.message = `${what}: ${error.message}`;
    throw error;
  }
};

const lineJson = (l, withPart = false) => ({ description: l.description, quantity: l.quantity, unit_price: poundsOf(l.unitPence), vat_pct: l.vatPct, vat_exempt: l.vatExempt, ...(withPart && l.partNumber ? { part_number: l.partNumber } : {}) });

export async function loadPqDataset(db, dataset, { createUser, log = () => {} } = {}) {
  if (typeof createUser !== "function") throw new Error("loadPqDataset needs a createUser({ email, fullName, role }) callback");
  const session = new Session(db);
  const result = { companies: [], notes: [] };
  for (const company of dataset.companies) result.companies.push(await loadCompany(session, company, createUser, log, result.notes));
  return result;
}

async function loadCompany(session, company, createUser, log, notes) {
  const ctx = { kind: company.kind, slug: company.slug, users: {}, customers: {}, quotes: {}, jobs: {}, machines: {}, deliveryNotes: {}, invoices: {} };
  log(`[${company.kind}] users and company`);
  for (const u of company.users) ctx.users[u.key] = { id: await step(`createUser ${u.email}`, () => createUser({ email: u.email, fullName: u.fullName, role: u.role })), ...u };
  const admin = ctx.users.admin1.id;
  const office = ctx.users.office1.id;
  ctx.orgId = await step("create_organization", () => session.service(async (q) =>
    (await q("select public.create_organization($1, $2, $3, $4::jsonb) as id", [company.name, company.slug, ctx.users.admin1.email, JSON.stringify(company.profile)])).rows[0].id));
  await session.service(async (q) => {
    for (const u of company.users.filter((x) => x.role !== "admin")) {
      const r = (await q("select public.add_member($1, $2, $3) as r", [ctx.orgId, u.email, u.role])).rows[0].r;
      if (r !== "member") throw new Error(`add_member ${u.email}: ${r}`);
    }
    // as createSyntheticWorld: the admin is an authorised inspector; Sales Orders is switched on (Settings > Menu)
    await q("update public.organization_members set can_inspect = true where organization_id = $1 and user_id = $2", [ctx.orgId, admin]);
    const done = await q("update public.organization_settings set hidden_nav = array_append(array_remove(array_remove(hidden_nav, 'sales-orders'), 'sales-orders:on'), 'sales-orders:on') where organization_id = $1", [ctx.orgId]);
    if (done.rowCount !== 1) throw new Error("no organization_settings row");
  });

  log(`[${company.kind}] customers, parts, machines`);
  await session.service(async (q) => {
    for (const c of company.customers) {
      const { rows } = await q("insert into public.customers (organization_id, name, contact_name, email, phone, mobile, address, notes) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
        [ctx.orgId, c.name, c.contactName, c.email, c.phone, c.mobile, c.address, c.notes]);
      ctx.customers[c.key] = { id: rows[0].id, name: c.name };
    }
    for (const p of company.parts) {
      await q("insert into public.stock (organization_id, sku, material, current_stock, min_level, reorder_quantity, preferred_supplier, unit_price, lead_time_days, auto_purchase) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)",
        [ctx.orgId, p.sku, p.material, p.currentStock, p.minLevel, p.reorderQuantity, p.preferredSupplier, poundsOf(p.unitPricePence), p.leadTimeDays]);
    }
    for (const m of company.machines) {
      const { rows } = await q("insert into public.machines (organization_id, name, type, hours_per_day, working_days, active) values ($1,$2,$3,$4,$5,$6) returning id", [ctx.orgId, m.name, m.type, m.hoursPerDay, m.workingDays, m.active]);
      ctx.machines[m.key] = rows[0].id;
    }
  });
  for (const c of company.customers.filter((x) => x.archived)) {
    await step(`archive ${c.name}`, () => session.as(admin, (q) => q("select public.set_archive_state('customers', $1, 'archived')", [ctx.customers[c.key].id])));
  }

  log(`[${company.kind}] quotes, orders and jobs`);
  const jobByQuote = new Map(company.jobs.filter((j) => j.quoteKey).map((j) => [j.quoteKey, j]));
  for (const qt of company.quotes) {
    await step(`quote ${qt.key}`, async () => {
      const cust = ctx.customers[qt.customerKey];
      const id = await session.as(office, async (q) => {
        const ref = (await q("select public.next_doc_number('QUO') as r")).rows[0].r;
        const header = { quote_ref: ref, customer: cust.name, description: qt.description, total_value: poundsOf(qt.totalPence), status: qt.shape === "accepted" ? "sent" : qt.status, valid_until: qt.validUntil, vat_enabled: qt.vatEnabled, customer_notes: "SYNTHETIC PQ DATA" };
        return (await q("select public.create_with_lines('quotes', $1::jsonb, 'quote_line_items', 'quote_id', $2::jsonb) as id", [JSON.stringify(header), JSON.stringify(qt.lines.map((l) => lineJson(l, true)))])).rows[0].id;
      });
      ctx.quotes[qt.key] = { id };
      if (qt.shape === "accepted") {
        const r = await session.as(office, async (q) => (await q("select public.accept_quote($1, $2, $3, null) as r", [id, qt.customerPo, qt.deliveryOn])).rows[0].r);
        if (!r.so_id || !r.job_id) throw new Error(`accept_quote returned no order/job: ${JSON.stringify(r)}`);
        const job = jobByQuote.get(qt.key);
        ctx.jobs[job.key] = { id: r.job_id, jobNo: r.job_no, soId: r.so_id, quoteKey: qt.key };
      }
    });
  }
  for (const job of company.jobs.filter((j) => !j.quoteKey)) {
    await step(`job ${job.key}`, async () => {
      const r = await session.as(office, async (q) => (await q("select public.create_job($1, $2, $3, null, $4, '[]'::jsonb, false, '[]'::jsonb, null) as r",
        [job.kind === "internal" ? null : ctx.customers[job.customerKey].name, job.description, job.kind === "internal", job.requiredOn])).rows[0].r);
      ctx.jobs[job.key] = { id: r.job_id, jobNo: r.job_no };
    });
  }
  // progress stamps: the importer path (service role), then the product's own inspection
  await session.service(async (q) => {
    for (const job of company.jobs) {
      const got = ctx.jobs[job.key];
      if (job.progress === "in_progress") await q("update public.jobs set stage = 'machining', started_at = $2, quantity_required = $3 where id = $1", [got.id, startOf(company, job), job.quantityRequired]);
      if (job.progress === "complete") await q("update public.jobs set stage = 'inspection', started_at = $2, finished_at = $3, quantity_required = $4 where id = $1", [got.id, startOf(company, job), finishOf(company, job), job.quantityRequired]);
    }
  });

  log(`[${company.kind}] machine bookings`);
  for (const b of company.bookings) {
    await step(`booking ${b.key}`, async () => {
      const args = (override) => [null, ctx.machines[b.machineKey], ctx.jobs[b.jobKey].id, null, `SYNTHETIC PQ ${b.key}`, b.startAt, b.hours, b.hoursDone, b.status, b.notes, null, false, override, override ? "PQ seed: a started booking is drawn from now, so it overlaps planned work seeded relative to the base date" : null];
      const sql = "select public.save_machine_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)";
      try {
        await session.as(office, (q) => q(sql, args(false)));
      } catch (error) {
        if (!/clash/i.test(`${error.message} ${error.hint ?? ""}`)) throw error;
        await session.as(admin, (q) => q(sql, args(true)));
        notes.push(`${company.kind}: booking ${b.key} saved with an admin clash override (load date later than base date)`);
      }
    });
  }

  log(`[${company.kind}] inspection, delivery notes and invoices`);
  for (const dn of company.deliveryNotes) {
    await step(`delivery note ${dn.key}`, async () => {
      const job = ctx.jobs[dn.jobKey];
      await session.as(admin, (q) => q("select public.inspect_job(p_job := $1, p_result := 'pass', p_criteria := $2, p_measured := $3, p_expected_version := (select worksheet_version from public.jobs where id = $1))",
        [job.id, "Drawing rev A: as per customer drawing (synthetic)", "Measured within tolerance (synthetic PQ data)"]));
      const made = await session.as(office, async (q) => {
        const lines = (await q("select line_id, remaining from public.despatch_lines($1, null) where remaining > 0", [job.soId])).rows;
        const r = (await q("select public.create_delivery_note($1, $2, $3, $3, $4, $5, $6::jsonb) as r", [job.soId, job.id, dn.shipDate, dn.shipVia, dn.notes, JSON.stringify(lines.map((l) => ({ line_id: l.line_id, quantity: Number(l.remaining) })))])).rows[0].r;
        await q("update public.delivery_notes set status = 'despatched' where id = $1", [r.id]);
        if (dn.signed) await q("update public.delivery_notes set status = 'signed', signed_by_name = 'A. Receiver (synthetic)', signed_at = $2, signature_notes = 'SYNTHETIC PQ DATA' where id = $1", [r.id, `${dn.shipDate}T10:00:00Z`]);
        return r.id;
      });
      const invoiceId = (await session.service((q) => q("select invoice_id from public.delivery_notes where id = $1", [made]))).rows[0].invoice_id;
      if (!invoiceId) throw new Error("despatching the note drafted no invoice");
      ctx.deliveryNotes[dn.key] = { id: made, invoiceId };
    });
  }
  for (const inv of company.invoices) {
    await step(`invoice ${inv.key}`, async () => {
      const customerName = ctx.customers[inv.customerKey].name;
      let id;
      if (inv.source === "delivery_note") {
        id = ctx.deliveryNotes[inv.deliveryNoteKey].invoiceId;
        await session.as(office, (q) => q("update public.invoices set invoice_date = $2, due_date = $3, terms = $4, customer_po = $5 where id = $1 and status = 'draft'", [id, inv.invoiceDate, inv.dueDate, inv.terms, inv.customerPo]));
      } else {
        id = await session.as(office, async (q) => {
          const header = { customer: customerName, description: "SYNTHETIC PQ DATA", subtotal: poundsOf(inv.netPence), carriage: poundsOf(inv.carriagePence), vat: poundsOf(inv.vatPence), total: poundsOf(inv.totalPence), vat_enabled: inv.vatEnabled, carriage_vat: inv.carriageVat, status: "draft", amount_paid: 0, invoice_date: inv.invoiceDate, due_date: inv.dueDate, terms: inv.terms, customer_po: inv.customerPo };
          return (await q("select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id", [JSON.stringify(header), JSON.stringify(inv.lines.map((l, i) => ({ ...lineJson(l), position: i })))])).rows[0].id;
        });
      }
      ctx.invoices[inv.key] = { id };
      if (!inv.issue) return;
      await session.as(office, (q) => q("select public.issue_invoice($1)", [id]));
      for (const p of inv.payments) {
        await session.as(admin, (q) => q("select public.record_invoice_payment(p_request_id := gen_random_uuid(), p_invoice := $1, p_amount := $2, p_paid_on := $3, p_method := $4, p_reference := $5)", [id, poundsOf(p.amountPence), p.paidOn, p.method, p.reference]));
      }
      if (inv.credit) {
        await session.as(admin, async (q) => {
          const lineId = (await q("select id from public.invoice_line_items where invoice_id = $1 order by position limit 1 offset $2", [id, inv.credit.lineIndex])).rows[0].id;
          const cid = (await q("select public.create_credit_note($1, $2, $3, $4::jsonb) as id", [id, inv.credit.reason, inv.credit.creditDate, JSON.stringify([{ invoice_line_id: lineId, quantity: inv.credit.quantity }])])).rows[0].id;
          await q("select public.issue_credit_note($1)", [cid]);
        });
      }
    });
  }

  log(`[${company.kind}] time sheets and labour`);
  await session.service(async (q) => {
    for (const day of company.attendance) {
      const u = ctx.users[day.userKey];
      for (const e of day.events) {
        await q("insert into public.attendance_events (organization_id, user_id, client_op_id, action, at, device_at, source, recorded_by) values ($1,$2,$3,$4,$5,$5,'clock',$2)", [ctx.orgId, u.id, e.opId, e.action, e.at]);
      }
    }
    for (const l of company.labour) {
      await q("insert into public.operator_sessions (organization_id, user_id, job_id, started_at, ended_at, source, end_source, created_by) values ($1,$2,$3,$4,$5,'sheet','sheet',$2)", [ctx.orgId, ctx.users[l.userKey].id, ctx.jobs[l.jobKey].id, l.startedAt, l.endedAt]);
    }
  });
  return { kind: company.kind, orgId: ctx.orgId, slug: company.slug, users: Object.fromEntries(Object.entries(ctx.users).map(([k, v]) => [k, { id: v.id, email: v.email, role: v.role }])) };
}

function startOf(company, job) {
  const q = company.quotes.find((x) => x.key === job.quoteKey);
  return `${q ? q.acceptedOn : "2000-01-01"}T08:00:00Z`;
}
function finishOf(company, job) {
  const dn = company.deliveryNotes.find((d) => d.jobKey === job.key);
  return `${dn ? dn.finishedOn : startOf(company, job).slice(0, 10)}T16:00:00Z`;
}
