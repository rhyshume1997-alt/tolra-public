import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createSyntheticWorld, verifyBackendIdentity, withDb, signedInClient } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { preparePost144Backend } from "../support/post-144-release-fixture";
import { enrolTotp } from "../support/totp";

it("prepares a guarded, fake JNR company through 151 with linked paperwork and OFF providers", async () => {
  const backend = isolatedBackend();
  expect(new URL(backend.databaseUrl).port).toBe("55322");
  expect(backend.apiUrl).toBe("http://127.0.0.1:55321");
  expect(readFileSync("tests/pq/.runtime/PQ-ONLY", "utf8")).toBe("tolra-pq-synthetic");
  expect(existsSync("tests/pq/.runtime/accounts.json")).toBe(false);
  expect((await verifyBackendIdentity()).organizations).toBe(0);
  await preparePost144Backend();
  const world = await createSyntheticWorld();
  const a = world.tenants.alpha;
  const user = a.users.admin;
  const client = await signedInClient(user);
  const { secret } = await enrolTotp(client, "Synthetic PQ only");
  const machine = randomUUID();
  const rates = {
    materials: [{ id: randomUUID(), name: "FAKE 6082 aluminium", price_pence: 450, price_unit: "kg", scrap_pct: 5 }],
    machines: [{ id: machine, name: "FAKE CNC Mill", hourly_rate_pence: 4500, labour_rate_pence: 2600 }],
    defaults: { labour_rate_pence: 2000, programming_rate_pence: 3000, overhead_pct: 150, default_margin_pct: 20 },
  };
  const save = await client.rpc("save_costing_settings_atomic", { p_org: a.id, p_expected: { materials: [], machines: [], defaults: null }, p_value: rates });
  expect(save.error).toBeNull();
  expect((await client.rpc("set_job_costing_enabled", { p_organization: a.id, p_revision: 0, p_enabled: true })).error).toBeNull();
  const records = await withDb(async db => {
    await db.query("BEGIN");
    try {
      // Fixture load only, not a claim these records went through a real human's approval.
      await db.query("UPDATE public.organizations SET name='FAKE JNR Engineering PQ' WHERE id=$1", [a.id]);
      await db.query("UPDATE public.organization_settings SET company_profile=company_profile || $2::jsonb WHERE organization_id=$1", [a.id, JSON.stringify({ documentName: "FAKE JNR Engineering PQ — NOT REAL", loginTagline: "SYNTHETIC PQ ONLY", email: "office@fake-jnr.example.test" })]);
      const customer = (await db.query("INSERT INTO public.customers(organization_id,name,email,address,notes) VALUES($1,'FAKE Pump Customer Ltd','accounts@fake-pumps.example.test','1 Imaginary Lane, Testtown','SYNTHETIC PQ ONLY') RETURNING id", [a.id])).rows[0].id;
      await db.query("INSERT INTO public.customers(organization_id,name,email) VALUES($1,'FAKE Shaft Customer Ltd','orders@fake-shafts.example.test')", [a.id]);
      await db.query("INSERT INTO public.stock(organization_id,sku,material,current_stock,min_level,unit_price,auto_purchase) VALUES($1,'FAKE-PART-BRACKET','FAKE 6082 aluminium bracket',100,10,12.50,false),($1,'FAKE-PART-SPACER','FAKE steel spacer',50,5,5.00,false)", [a.id]);
      const mill = (await db.query("INSERT INTO public.machines(organization_id,name,type) VALUES($1,'FAKE CNC Mill','Milling') RETURNING id", [a.id])).rows[0].id;
      await db.query("INSERT INTO public.machines(organization_id,name,type) VALUES($1,'FAKE Manual Lathe','Turning')", [a.id]);
      const quote = (await db.query("INSERT INTO public.quotes(organization_id,quote_ref,customer,description,total_value,status,valid_until) VALUES($1,'QUO-PQ-0001','FAKE Pump Customer Ltd','FAKE-PART-BRACKET x10 — SYNTHETIC',150.00,'draft',current_date+14) RETURNING id", [a.id])).rows[0].id;
      await db.query("INSERT INTO public.quote_line_items(organization_id,quote_id,position,description,quantity,unit_price,source) VALUES($1,$2,0,'FAKE-PART-BRACKET',10,12.50,'manual')", [a.id, quote]);
      const order = (await db.query("INSERT INTO public.sales_orders(organization_id,so_number,customer,customer_id,customer_po,quote_id,quote_ref,total_value,delivery_date) VALUES($1,'SO-PQ-0001','FAKE Pump Customer Ltd',$2,'FAKE-CUSTOMER-PO-0001',$3,'QUO-PQ-0001',125.00,current_date+7) RETURNING id", [a.id, customer, quote])).rows[0].id;
      await db.query("INSERT INTO public.sales_order_lines(organization_id,sales_order_id,position,description,quantity,unit_price,vat_pct) VALUES($1,$2,0,'FAKE-PART-BRACKET',10,12.50,20)", [a.id, order]);
      const job = (await db.query("INSERT INTO public.jobs(organization_id,job_no,quote_id,customer,description,stage,due_date,converted_from_sales_order_id,started_at) VALUES($1,'J-PQ-0001',$2,'FAKE Pump Customer Ltd','FAKE-PART-BRACKET x10 — SYNTHETIC','machining',current_date+7,$3,now()-interval '2 hours') RETURNING id", [a.id, quote, order])).rows[0].id;
      await db.query("UPDATE public.sales_orders SET converted_to_job_id=$2,converted_at=now(),status='in_production' WHERE id=$1", [order, job]);
      await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,description,due_date) VALUES($1,'J-PQ-NO-COST','FAKE Shaft Customer Ltd','SYNTHETIC missing time/cost inputs',current_date+7)", [a.id]);
      await db.query("INSERT INTO public.operator_sessions(organization_id,user_id,job_id,started_at,ended_at,source,end_source) VALUES($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','manual','sheet')", [a.id, a.users.workshop.id, job]);
      const invoice = (await db.query("INSERT INTO public.invoices(organization_id,invoice_ref,job_id,customer,description,quantity,unit_price,subtotal,vat,total,status,invoice_date,due_date,customer_po) VALUES($1,'INV-PQ-0001',$2,'FAKE Pump Customer Ltd','FAKE-PART-BRACKET',10,12.50,125.00,25.00,150.00,'draft',current_date,current_date+30,'FAKE-CUSTOMER-PO-0001') RETURNING id", [a.id, job])).rows[0].id;
      await db.query("INSERT INTO public.invoice_line_items(organization_id,invoice_id,description,quantity,unit_price,vat_pct) VALUES($1,$2,'FAKE-PART-BRACKET',10,12.50,20)", [a.id, invoice]);
      // This note is deliberately pending: no invented inspection, customer signature or dispatch result.
      const delivery = (await db.query("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,customer_id,sales_order_id,job_id,job_ref,invoice_ref,status,delivery_date) VALUES($1,'DLN-PQ-0001','FAKE Pump Customer Ltd',$2,$3,$4,'J-PQ-0001','INV-PQ-0001','pending',current_date) RETURNING id", [a.id, customer, order, job])).rows[0].id;
      await db.query("INSERT INTO public.delivery_note_items(organization_id,delivery_note_id,description,quantity) VALUES($1,$2,'FAKE-PART-BRACKET',10)", [a.id, delivery]);
      await db.query("INSERT INTO public.email_history(organization_id,to_email,to_name,subject,body,status,related_to_type,related_to_id) VALUES($1,'accounts@fake-pumps.example.test','FAKE Pump Customer Ltd','SYNTHETIC PQ: invoice approval draft','FAKE draft only — do not send to a real address','drafted','invoice',$2)", [a.id, invoice]);
      await db.query("COMMIT");
      return { customer, mill, quote, order, job, invoice, delivery };
    } catch (e) { await db.query("ROLLBACK"); throw e; }
  });
  expect((await client.rpc("save_job_costing_machine_links", { p_organization: a.id, p_links: [{ machine_id: records.mill, costing_machine_id: machine }] })).error).toBeNull();
  expect((await client.rpc("save_job_cost_declarations", { p_job: records.job, p_no_labour: false, p_no_machines: true })).error).toBeNull();
  const actual = await client.rpc("job_profitability_actual_inputs", { p_job: records.job });
  expect(actual.error).toBeNull();
  expect(actual.data.live).toMatchObject({ state: "complete", labour_pence: 2000, machine_pence: 0, overhead_pence: 1000, supplier_pence: 0 });
  await withDb(async db => {
    const sums = (await db.query("SELECT (subtotal*100)::int net, (vat*100)::int vat, (total*100)::int gross FROM public.invoices WHERE id=$1", [records.invoice])).rows[0];
    expect(sums).toEqual({ net: 12500, vat: 2500, gross: 15000 });
    expect((await db.query("SELECT (total_value*100)::int gross FROM public.quotes WHERE id=$1", [records.quote])).rows[0].gross).toBe(15000);
    expect((await db.query("SELECT count(*)::int n FROM public.integration_connections")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM public.integration_sends")).rows[0].n).toBe(0);
  });
  // Passwords/MFA are generated for fake accounts and stay ignored locally, never in Actions artifacts.
  writeFileSync("tests/pq/.runtime/accounts.json", JSON.stringify({ syntheticOnly: true, world, totpSecret: secret, records, loadedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  writeFileSync("tests/pq/.runtime/receipt.json", JSON.stringify({ syntheticOnly: true, identity: await verifyBackendIdentity(), records, expected: { quoteNetPence: 12500, invoiceNetPence: 12500, invoiceVatPence: 2500, invoiceGrossPence: 15000, labourPence: 2000, overheadPence: 1000 }, releases: "145 through 151 verified; numbered migrations through 144", providers: "AI off; no Xero connections or sends; no mail provider configured" }, null, 2));
});
