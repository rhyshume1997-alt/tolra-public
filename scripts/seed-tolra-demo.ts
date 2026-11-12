/** Explicit opt-in fixture writer. --plan never loads pg or opens a connection. No migrations or external services. */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEMO_ACK = "SEED TOLRA DEMO LOCAL ONLY";
export const DEMO_DATABASE = "tolra_demo_throwaway";
export const DEMO_OWNER = "demo-owner@example.test";
export function assertDemoTarget(value: string | undefined) {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("A dedicated local demo database URL is required."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || decodeURIComponent(url.pathname) !== `/${DEMO_DATABASE}` || url.search || url.hash || decodeURIComponent(url.username) !== "postgres") {
    throw new Error("Only the dedicated loopback postgres demo database is allowed.");
  }
  return value!;
}
const day = (now: Date, offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
export function demoPlan(now = new Date()) {
  return {
    company: "Tolra Demo", slug: "tolra-demo", owner: DEMO_OWNER, warning: "FAKE SCREENSHOT DATA — no real customers or prices",
    customers: ["Example Customer A", "Example Customer B", "Example Customer C"],
    jobs: ["DEMO-J-001", "DEMO-J-002", "DEMO-J-003"], machines: ["Example Machine A", "Example Machine B"],
    invoices: [
      { reference: "DEMO-INV-PAID", customer: 0, totalPence: 12345, paidPence: 12345, dueDate: day(now, -2), status: "paid" },
      { reference: "DEMO-INV-DUE", customer: 1, totalPence: 23456, paidPence: 0, dueDate: day(now, 7), status: "sent" },
      { reference: "DEMO-INV-OVERDUE", customer: 2, totalPence: 34567, paidPence: 0, dueDate: day(now, -14), status: "sent" },
    ],
  };
}
export type DemoClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const pounds = (pence: number) => `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
/** Call only after the URL gate. The database independently proves its name/address and must contain NO organisations. */
export async function seedDemo(client: DemoClient, now = new Date()) {
  const identity = (await client.query("SELECT current_database() AS name, inet_server_addr()::text AS address, current_user AS role")).rows[0];
  if (identity?.name !== DEMO_DATABASE || identity.role !== "postgres" || ![null, "127.0.0.1", "::1"].includes(identity.address as string | null)) throw new Error("Database identity is not the dedicated local demo database.");
  const plan = demoPlan(now);
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("LOCK TABLE public.organizations IN EXCLUSIVE MODE");
    if (Number((await client.query("SELECT count(*) AS count FROM public.organizations")).rows[0]?.count) !== 0) throw new Error("Demo database must be empty of companies; nothing will be overwritten.");
    const owner = (await client.query("SELECT id FROM auth.users WHERE lower(email) = $1 AND raw_user_meta_data ->> 'full_name' = 'Demo Owner'", [DEMO_OWNER])).rows[0]?.id;
    if (typeof owner !== "string") throw new Error("Create the fake Demo Owner login in the local auth fixture first.");
    const profile = { name: plan.company, documentName: plan.company, addressLines: ["Example Workshop", "Example Town", "DEMO ONLY"], email: DEMO_OWNER, vatRegistered: false,
      defaultVatRate: 0, defaultQuoteTerms: "FAKE SCREENSHOT DATA", defaultInvoiceTerms: "FAKE SCREENSHOT DATA", brandedLogin: false, workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5] };
    const org = (await client.query("SELECT public.create_organization($1,$2,$3,$4::jsonb) AS id", [plan.company, plan.slug, DEMO_OWNER, JSON.stringify(profile)])).rows[0]?.id;
    if (typeof org !== "string") throw new Error("Demo company was not created.");
    for (const [index, name] of plan.customers.entries()) await client.query("INSERT INTO public.customers (organization_id,name,email) VALUES ($1,$2,$3)", [org, name, `example-customer-${index + 1}@example.test`]);
    await client.query("INSERT INTO public.time_settings (organization_id,breaks_paid) VALUES ($1,false)", [org]);
    const jobs: string[] = [];
    for (const [index, number] of plan.jobs.entries()) {
      const row = (await client.query("INSERT INTO public.jobs (organization_id,job_no,customer,description,due_date,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id", [org, number, plan.customers[index], `FAKE SCREENSHOT DATA: Example part ${index + 1}`, day(now, index === 2 ? -2 : index + 1), owner])).rows[0];
      jobs.push(String(row.id));
    }
    const machines: string[] = [];
    for (const name of plan.machines) machines.push(String((await client.query("INSERT INTO public.machines (organization_id,name,type,created_by,updated_by) VALUES ($1,$2,'Demo machine',$3,$3) RETURNING id", [org, name, owner])).rows[0].id));
    for (const [index, number] of plan.jobs.entries()) {
      const started = new Date(now.getTime() - (index + 2) * 3600_000).toISOString();
      const ended = new Date(now.getTime() - (index + 1) * 3600_000).toISOString();
      await client.query("INSERT INTO public.machine_runs (organization_id,job_id,machine_id,operator_id,started_at,ended_at,end_reason,ended_by,created_by) VALUES ($1,$2,$3,$4,$5,$6,'finished',$4,$4)", [org, jobs[index], machines[index % 2], owner, started, ended]);
      const invoice = plan.invoices[index];
      const amount = pounds(invoice.totalPence);
      const id = String((await client.query("INSERT INTO public.invoices (organization_id,invoice_ref,job_id,customer,description,quantity,unit_price,subtotal,vat,total,status,due_date,amount_paid,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,1,$6,$6,0,$6,'sent',$7,0,$8,$8) RETURNING id", [org, invoice.reference, jobs[index], plan.customers[index], `FAKE SCREENSHOT DATA: ${number}`, amount, invoice.dueDate, owner])).rows[0].id);
      if (invoice.paidPence) {
        await client.query("INSERT INTO public.invoice_payments (organization_id,invoice_id,amount,paid_on,method,reference,created_by) VALUES ($1,$2,$3,$4,'other','FAKE SCREENSHOT PAYMENT',$5)", [org, id, pounds(invoice.paidPence), day(now, -1), owner]);
        await client.query("UPDATE public.invoices SET amount_paid=$3,status='paid',paid_at=$4 WHERE organization_id=$1 AND id=$2", [org, id, pounds(invoice.paidPence), now.toISOString()]);
      }
    }
    const audit = Number((await client.query("SELECT count(*) AS count FROM security_audit.audit_log WHERE organization_id=$1", [org])).rows[0]?.count);
    if (!Number.isFinite(audit) || audit < 1) throw new Error("No demo activity rows were recorded; refusing an incomplete seed.");
    await client.query("COMMIT");
    return { company: plan.company, customers: 3, jobs: 3, invoices: 3, machines: 2, machineTimes: 3, auditRows: audit };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function main() {
  const { values } = parseArgs({ options: { plan: { type: "boolean" }, write: { type: "boolean" }, confirm: { type: "string" } } });
  if (!values.write) { process.stdout.write(`${JSON.stringify(demoPlan(), null, 2)}\n`); return; }
  if (values.plan || values.confirm !== DEMO_ACK) throw new Error("Explicit demo confirmation is required.");
  const connectionString = assertDemoTarget(process.env.DEMO_DATABASE_URL);
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  try { await client.connect(); console.log(await seedDemo(client)); } finally { await client.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main().catch(() => {
  console.error("Demo seed refused or failed. No partial seed was kept. Check the dedicated local database and fake-owner prerequisites; credentials are never printed."); process.exitCode = 1;
});
