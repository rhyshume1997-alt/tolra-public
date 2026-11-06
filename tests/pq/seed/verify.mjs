/**
 * The database-side PQ checks: the loaded database must reproduce the dataset's counts and money to the penny, and its own
 * stored figures must be internally consistent. Read-only. Browser/UI checks are listed in tests/pq/README.md (not automated here).
 */
const pence = (v) => Math.round(Number(v) * 100);

export async function verifyLoaded(db, dataset) {
  const results = [];
  const check = (name, expected, actual) => results.push({ name, ok: JSON.stringify(expected) === JSON.stringify(actual), expected, actual });
  for (const company of dataset.companies) {
    const exp = dataset.expected[company.kind];
    const org = (await db.query("select id from public.organizations where slug = $1", [company.slug])).rows[0];
    if (!org) { check(`${company.kind}: organisation present`, true, false); continue; }
    const id = org.id;
    const one = async (sql, params = [id]) => (await db.query(sql, params)).rows[0];
    const n = async (table, where = "") => Number((await one(`select count(*)::int as n from public.${table} where organization_id = $1 ${where}`)).n);
    const p = (label) => `${company.kind}: ${label}`;

    check(p("users"), exp.users, Number((await one("select count(*)::int as n from public.organization_members where organization_id = $1")).n));
    check(p("customers"), exp.customers, await n("customers"));
    check(p("parts"), exp.parts, await n("stock"));
    check(p("machines"), exp.machines, await n("machines"));
    check(p("quotes"), exp.quotes, await n("quotes"));
    const byStatus = Object.fromEntries((await db.query("select status, count(*)::int as n from public.quotes where organization_id = $1 group by 1 order by 1", [id])).rows.map((r) => [r.status, r.n]));
    check(p("quotes by status"), exp.quotesByStatus, byStatus);
    check(p("jobs"), exp.jobs, await n("jobs"));
    check(p("machine bookings"), exp.bookings, await n("machine_bookings"));
    check(p("delivery notes"), exp.deliveryNotes, await n("delivery_notes"));
    check(p("invoices"), exp.invoices, await n("invoices"));
    check(p("invoices issued"), exp.invoicesIssued, await n("invoices", "and coalesce(status,'draft') <> 'draft'"));
    check(p("credit notes issued"), exp.creditNotes, await n("credit_notes", "and coalesce(status,'draft') <> 'draft'"));
    check(p("payments"), exp.payments, await n("invoice_payments", "and amount > 0"));
    check(p("attendance events"), exp.attendanceEvents, await n("attendance_events"));
    check(p("labour sessions"), exp.labourSessions, await n("operator_sessions"));

    const money = await one(`select coalesce(sum(total),0) as total, coalesce(sum(amount_paid),0) as paid, coalesce(sum(credited_amount),0) as credited
                              from public.invoices where organization_id = $1 and coalesce(status,'draft') <> 'draft'`);
    check(p("invoiced total pence"), exp.invoicedTotalPence, pence(money.total));
    check(p("paid pence"), exp.paidPence, pence(money.paid));
    check(p("credited pence"), exp.creditedPence, pence(money.credited));
    check(p("outstanding pence"), exp.outstandingPence, pence(money.total) - pence(money.paid) - pence(money.credited));
    const overdue = await one(`select count(*)::int as n, coalesce(sum(round(total*100) - round(amount_paid*100) - round(credited_amount*100)),0)::bigint as owed
                                from public.invoices where organization_id = $1 and coalesce(status,'draft') <> 'draft' and due_date < $2::date
                                  and round(total*100) - round(amount_paid*100) - round(credited_amount*100) > 0`, [id, dataset.meta.baseDate]);
    check(p("overdue invoices"), exp.overdueInvoices, Number(overdue.n));
    check(p("overdue pence"), exp.overduePence, Number(overdue.owed));

    // internal consistency, from the database's own rows
    const badTotals = await one(`select count(*)::int as n from public.invoices i where i.organization_id = $1 and (
        i.subtotal <> (select coalesce(sum(round(l.quantity * l.unit_price, 2)),0) from public.invoice_line_items l where l.invoice_id = i.id)
        or i.total <> i.subtotal + coalesce(i.carriage,0) + i.vat)`);
    check(p("every invoice: lines add to subtotal and subtotal+carriage+VAT = total"), 0, Number(badTotals.n));
    const badPaid = await one(`select count(*)::int as n from public.invoices i where i.organization_id = $1
        and i.amount_paid <> (select coalesce(sum(p.amount),0) from public.invoice_payments p where p.invoice_id = i.id)`);
    check(p("every invoice: amount_paid = sum of its payments"), 0, Number(badPaid.n));
    const badQuotes = await one(`select count(*)::int as n from public.quotes q where q.organization_id = $1
        and q.total_value <> (select coalesce(sum(round(l.quantity*l.unit_price,2)),0) + case when q.vat_enabled then coalesce(sum(case when l.vat_exempt then 0 else round(round(l.quantity*l.unit_price,2)*l.vat_pct/100,2) end),0) else 0 end
                              from public.quote_line_items l where l.quote_id = q.id)`);
    check(p("every quote: stored total = lines + VAT"), 0, Number(badQuotes.n));
    const over = await one("select count(*)::int as n from public.invoices where organization_id = $1 and coalesce(status,'draft') <> 'draft' and amount_paid + credited_amount > total", [id]);
    check(p("no invoice paid/credited beyond its total"), 0, Number(over.n));
    const dup = await one("select count(*)::int as n from (select invoice_ref from public.invoices where organization_id = $1 and invoice_ref is not null group by 1 having count(*) > 1) d");
    check(p("invoice numbers unique"), 0, Number(dup.n));
  }
  // company separation: nobody in one PQ company is a member of the other
  const cross = await db.query(`select count(*)::int as n from public.organization_members a join public.organization_members b on a.user_id = b.user_id and a.organization_id <> b.organization_id
                                where a.organization_id = any($1::uuid[]) and b.organization_id = any($1::uuid[])`,
    [(await db.query("select id from public.organizations where slug = any($1)", [dataset.companies.map((c) => c.slug)])).rows.map((r) => r.id)]);
  check("no user belongs to both PQ companies", 0, Number(cross.rows[0].n));
  return { ok: results.every((r) => r.ok), results };
}
