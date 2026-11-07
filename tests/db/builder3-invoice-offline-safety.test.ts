/** PM independent real-database safety cases. Synthetic fixtures; authenticated RPCs, no providers. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { q, refusal } from "./time-support";
let world: SyntheticWorld;
const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => withDb(async db => (await db.query<T>(sql, params)).rows);
const alpha = () => world.tenants.alpha;
const admin = () => ({ id: alpha().users.admin.id });
beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });
const replaySql = "SELECT public.record_attendance_event_in_company($1,'out',$2,'FAKE offline phone',$3) AS r";
describe("revoked offline authority in real PostgreSQL", () => {
  it("revoked company access refuses queued writes, restored access records and replays the same key once", async () => {
    const worker = { id: alpha().users.workshop.id }, key = randomUUID(), at = new Date().toISOString();
    await owner("UPDATE public.organization_members SET active=false WHERE organization_id=$1 AND user_id=$2", [alpha().id, worker.id]);
    try {
      expect(await refusal(worker, replaySql, [key, at, alpha().id])).toMatchObject({ code: "42501", hint: "wrong_company" });
      expect(await owner("SELECT id FROM public.attendance_events WHERE client_op_id=$1", [key])).toEqual([]);
    } finally { await owner("UPDATE public.organization_members SET active=true WHERE organization_id=$1 AND user_id=$2", [alpha().id, worker.id]); }
    const [{ r: first }] = await q<{ r: { event_id: string; replayed: boolean } }>(worker, replaySql, [key, at, alpha().id]);
    const [{ r: again }] = await q<{ r: { event_id: string; replayed: boolean } }>(worker, replaySql, [key, at, alpha().id]);
    expect(first.replayed).toBe(false); expect(again).toMatchObject({ event_id: first.event_id, replayed: true });
    expect(await owner("SELECT organization_id,user_id FROM public.attendance_events WHERE client_op_id=$1", [key])).toEqual([{ organization_id: alpha().id, user_id: worker.id }]);
  });
  it("a revoked Auth login cannot replay an existing key or create a new record", async () => {
    const worker = { id: alpha().users.office.id }, key = randomUUID(), later = randomUUID(), at = new Date().toISOString();
    await q(worker, replaySql, [key, at, alpha().id]);
    const api = await signedInClient(alpha().users.office);
    const replay = (request: string) => api.rpc("record_attendance_event_in_company", { p_client_op_id: request, p_action: "out", p_at: at, p_device: "FAKE offline phone", p_expected_org: alpha().id });
    const before = await owner("SELECT * FROM public.attendance_events WHERE client_op_id=$1", [key]);
    await owner("UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1", [worker.id]);
    try {
      expect((await replay(key)).error).toMatchObject({ code: "28000" });
      expect((await replay(later)).error).toMatchObject({ code: "28000" });
      expect(await owner("SELECT * FROM public.attendance_events WHERE client_op_id=$1", [key])).toEqual(before);
      expect(await owner("SELECT id FROM public.attendance_events WHERE client_op_id=$1", [later])).toEqual([]);
    } finally { await owner("UPDATE auth.users SET banned_until=NULL WHERE id=$1", [worker.id]); }
  });
});
describe("invoice and partial-despatch duplicate requests", () => {
  it("two simultaneous void requests make one void audit and leave the issued amounts unchanged", async () => {
    const [{ id }] = await q<{ id: string }>(admin(), "SELECT public.create_with_lines('invoices',$1::jsonb,'invoice_line_items','invoice_id',$2::jsonb) AS id", [JSON.stringify({ customer: "FAKE Void Co", status: "draft", subtotal: 1.99, vat: 0.40, total: 2.39, vat_enabled: true, due_date: "2099-01-31" }), JSON.stringify([{ position: 0, description: "FAKE bush", quantity: 1, unit_price: 1.99, vat_pct: 20, vat_exempt: false }])]);
    await q(admin(), "SELECT public.issue_invoice($1)", [id]);
    const amounts = await owner("SELECT subtotal,vat,total,invoice_ref,issuer_snapshot FROM public.invoices WHERE id=$1", [id]);
    const answers = await Promise.all([refusal(admin(), "SELECT public.void_invoice($1,'FAKE duplicate request')", [id]), refusal(admin(), "SELECT public.void_invoice($1,'FAKE duplicate request')", [id])]);
    expect(answers.filter(x => x === null)).toHaveLength(1);
    expect(answers.filter(x => x !== null)).toEqual([expect.objectContaining({ code: "22023", hint: "invoice_already_void" })]);
    expect(await owner("SELECT subtotal,vat,total,invoice_ref,issuer_snapshot FROM public.invoices WHERE id=$1", [id])).toEqual(amounts);
    expect(await owner("SELECT id FROM security_audit.audit_log WHERE action='VOID_INVOICE' AND entity_id=$1", [id])).toHaveLength(1);
  });
  it("two requests for the same part-despatch produce one penny-exact draft and bill only the quantity sent", async () => {
    const [{ id: order }] = await owner<{ id: string }>("INSERT INTO public.sales_orders(organization_id,so_number,customer,status,total_value,vat_enabled,vat_pct,vat_exempt) VALUES($1,$2,'FAKE Parts Co','confirmed',19.90,true,20,false) RETURNING id", [alpha().id, `SO-FAKE-${world.runId}`]);
    const [{ id: line }] = await owner<{ id: string }>("INSERT INTO public.sales_order_lines(organization_id,sales_order_id,position,description,quantity,unit_price,vat_pct,vat_exempt) VALUES($1,$2,0,'FAKE bush',10,1.99,20,false) RETURNING id", [alpha().id, order]);
    const [{ id: note }] = await owner<{ id: string }>("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,sales_order_id,status) VALUES($1,$2,'FAKE Parts Co',$3,'despatched') RETURNING id", [alpha().id, `DLN-FAKE-${world.runId}`, order]);
    await owner("INSERT INTO public.delivery_note_items(organization_id,delivery_note_id,position,description,quantity,sales_order_line_id) VALUES($1,$2,0,'FAKE bush',4,$3)", [alpha().id, note, line]);
    const sql = "SELECT public.create_invoice_from_delivery_notes($1::uuid[],current_date,current_date+30,'30 days') AS r";
    const answers = await Promise.allSettled([q(admin(), sql, [[note]]), q(admin(), sql, [[note]])]);
    expect(answers.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(answers.filter(x => x.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "22023" }) })]);
    const [{ invoice_id: invoice }] = await owner<{ invoice_id: string }>("SELECT invoice_id FROM public.delivery_notes WHERE id=$1", [note]);
    expect(await owner("SELECT subtotal::text,vat::text,total::text FROM public.invoices WHERE id=$1", [invoice])).toEqual([{ subtotal: "7.96", vat: "1.59", total: "9.55" }]);
    expect((await owner<{ quantity: string }>("SELECT quantity FROM public.invoice_line_items WHERE invoice_id=$1 AND sales_order_line_id=$2", [invoice, line])).map(r => Number(r.quantity))).toEqual([4]);
    const [billing] = await owner<{ invoiced: string; despatched: string; ordered: string }>("SELECT * FROM public.order_line_billing($1,NULL)", [line]);
    expect([Number(billing.ordered), Number(billing.despatched), Number(billing.invoiced)]).toEqual([10, 4, 4]);
    expect(await refusal({ id: world.tenants.beta.users.admin.id }, sql, [[note]])).toMatchObject({ code: "P0002" });
  });
});
