import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dryRun, writeRun } from "../../scripts/sliq-import/cli.mjs";
import { prepareRehearsal } from "../../scripts/sliq-import/write.mjs";
import { createSyntheticWorld, verifyBackendIdentity, withDb, signedInClient, type SyntheticWorld } from "../support/fixtures";
import { isolatedBackend, gitSha } from "../support/isolation";
import { preparePost144Backend } from "../support/post-144-release-fixture";
import { enrolTotp } from "../support/totp";
import { readOnlySnapshot, sourceHashes, writeScopedReport } from "./reconcile.mjs";

const original = path.resolve(__dirname, "fixtures");
const scratch = mkdtempSync(path.join(tmpdir(), "synthetic-sliq-rehearsal-"));
const folder = path.join(scratch, "copy");
const out = path.resolve(__dirname, "results");
const originalHashes = sourceHashes(original);
let w: SyntheticWorld;
let url: string;
let plan: Awaited<ReturnType<typeof dryRun>>["plan"];
let dry: Awaited<ReturnType<typeof dryRun>>["report"];
const a = () => w.tenants.alpha.id;
const b = () => w.tenants.beta.id;
const snapshot = (org: string) => withDb(db => readOnlySnapshot(db, org));
let beforeBeta: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  const backend = isolatedBackend();
  expect(new URL(backend.databaseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(backend.databaseUrl).port).toBe("54322");
  expect((await verifyBackendIdentity()).organizations).toBe(0);
  url = backend.databaseUrl;
  await preparePost144Backend();
  w = await createSyntheticWorld();
  cpSync(original, folder, { recursive: true });
  mkdirSync(out, { recursive: true });
  await prepareRehearsal(url);
  await withDb(async db => {
    await db.query(readFileSync(path.resolve(__dirname, "../../supabase/import/import_legacy_tenant.sql"), "utf8"));
    await db.query("INSERT INTO public.customers(organization_id,name,email) VALUES($1,'FAKE PUMP ENGINEERING LTD','existing@example.test')", [a()]);
    await db.query("INSERT INTO public.invoices(organization_id,invoice_ref,customer,total,status) VALUES($1,'INV-9999','FAKE Other Company',1.00,'draft')", [b()]);
    await db.query("INSERT INTO public.doc_counters(organization_id,prefix,last) VALUES($1,'INV',7),($1,'QUO',3)", [b()]);
  });
  beforeBeta = await snapshot(b());
});

describe.sequential("copied synthetic SliQ export to a real disposable Supabase through 151", () => {
  it("dry run reads only, binds the rehearsal and flags similar customers without merging", async () => {
    const before = await snapshot(a());
    const result = await dryRun({ folder, outDir: path.join(out, "dry-run"), mapping: "synthetic", databaseUrl: url, organizationId: a() });
    plan = result.plan; dry = result.report;
    expect(dry.writable).toBe(true);
    expect(dry.errors).toEqual([]);
    expect(dry.held).toEqual([]);
    expect(dry.rehearsal.id).toEqual(expect.any(String));
    expect(dry.collisions.customerReview).toHaveLength(1);
    expect(dry.collisions.customerReview[0].note).toContain("separate record");
    expect(await snapshot(a())).toEqual(before);
    expect(await snapshot(b())).toEqual(beforeBeta);
  });

  it("imports exactly 3 invoices, 3 lines and 2 evidenced payments, preserving source references", async () => {
    const result = await writeRun({ folder, reportPath: path.join(out, "dry-run/report.json"), mapping: "synthetic", databaseUrl: url, organizationId: a(), write: true });
    expect(result.created).toMatchObject({ invoices: 3, lines: 3, payments: 2, paymentToConfirm: 1 });
    const s = await snapshot(a());
    expect(s.invoices.map(i => i.invoice_ref)).toEqual(["INV-9002", "S-FAKE-1001", "S-FAKE-1003"]);
    expect(s.customers).toHaveLength(3);
    expect(s.customers.map(c => c.name).sort()).toEqual(["FAKE PUMP ENGINEERING LTD", "FAKE Pump Engineering Ltd", "FAKE Valve Engineering Ltd"].sort());
    expect(s.invoices.find(i => i.invoice_ref === "INV-9002")?.customer).toBe("FAKE Valve Engineering Ltd");
    expect(s.invoices.find(i => i.invoice_ref === "S-FAKE-1001")?.customer).toBe("FAKE Pump Engineering Ltd");
    expect(s.quotes).toMatchObject([{ quote_ref: "QUO-9001", total_value: "150.00" }]);
    expect(await snapshot(b())).toEqual(beforeBeta);
  });

  it("money totals tie exactly in integer pence and Paid without evidence is never fabricated", async () => {
    const s = await snapshot(a());
    expect(s.invoices.find(i => i.invoice_ref === "S-FAKE-1001")).toMatchObject({ subtotal: "125.00", vat: "25.00", total: "150.00", amount_paid: "150.00", status: "paid", payment_unverified: false });
    expect(s.invoices.find(i => i.invoice_ref === "INV-9002")).toMatchObject({ subtotal: "80.00", vat: "16.00", total: "96.00", amount_paid: "24.00", status: "partial", payment_unverified: false });
    expect(s.invoices.find(i => i.invoice_ref === "S-FAKE-1003")).toMatchObject({ amount_paid: "0.00", status: "sent", payment_unverified: true });
    expect(s.payments).toHaveLength(2);
    expect(s.payments.every(p => p.source === "legacy")).toBe(true);
  });

  it("a repeat write is idempotent, including customer matching and payment rows", async () => {
    const before = await snapshot(a());
    const result = await writeRun({ folder, reportPath: path.join(out, "dry-run/report.json"), mapping: "synthetic", databaseUrl: url, organizationId: a(), write: true });
    expect(result.created).toMatchObject({ invoices: 0, lines: 0, payments: 0 });
    expect(await snapshot(a())).toEqual(before);
    expect(await snapshot(b())).toEqual(beforeBeta);
  });

  it("stale files and another company's report refuse before any write", async () => {
    const changed = path.join(scratch, "changed"); cpSync(folder, changed, { recursive: true });
    writeFileSync(path.join(changed, "payments.csv"), readFileSync(path.join(changed, "payments.csv"), "utf8").replace("24.00", "25.00"));
    const before = await snapshot(a());
    await expect(writeRun({ folder: changed, reportPath: path.join(out, "dry-run/report.json"), mapping: "synthetic", databaseUrl: url, organizationId: a(), write: true })).rejects.toThrow(/stale/);
    await expect(writeRun({ folder, reportPath: path.join(out, "dry-run/report.json"), mapping: "synthetic", databaseUrl: url, organizationId: b(), write: true })).rejects.toThrow(/different organisation/);
    expect(await snapshot(a())).toEqual(before);
    expect(await snapshot(b())).toEqual(beforeBeta);
  });

  it("new native numbers continue after imported native refs in this company only", async () => {
    const client = await signedInClient(w.tenants.alpha.users.admin);
    await enrolTotp(client, "Synthetic import numbering");
    const invoice = await client.rpc("next_doc_number", { p_prefix: "INV" });
    const quote = await client.rpc("next_doc_number", { p_prefix: "QUO" });
    expect(invoice.error).toBeNull(); expect(invoice.data).toBe("INV-9003");
    expect(quote.error).toBeNull(); expect(quote.data).toBe("QUO-9002");
    expect(await snapshot(b())).toEqual(beforeBeta);
  });

  it("read-only SQL refuses a write with SQLSTATE 25006", async () => {
    await withDb(async db => {
      await db.query("BEGIN READ ONLY");
      try { await expect(db.query("UPDATE public.customers SET notes='must not write' WHERE organization_id=$1", [a()])).rejects.toMatchObject({ code: "25006" }); }
      finally { await db.query("ROLLBACK"); }
    });
  });

  it("a one-penny target discrepancy fails reconciliation without repairing the target", async () => {
    const before = await snapshot(a());
    const damaged = structuredClone(before);
    damaged.invoices[0].total = "96.01";
    const result = writeScopedReport({ snapshot: damaged, plan, folder, out: path.join(out, "negative-penny"), organizationId: a(), subjectSha: gitSha() });
    expect(result.scopedFinancialResult).toBe("FAIL");
    expect(await snapshot(a())).toEqual(before);
  });

  it("writes an honest read-only reconciliation report and leaves both inputs and tenants untouched", async () => {
    const before = await snapshot(a());
    const result = writeScopedReport({ snapshot: before, plan, folder, out, organizationId: a(), subjectSha: gitSha() });
    expect(result.scopedFinancialResult).toBe("PASS");
    expect(result.totals).toEqual({ expectedNetPence: 25500, actualNetPence: 25500, expectedVatPence: 5100, actualVatPence: 5100, expectedGrossPence: 30600, actualGrossPence: 30600, expectedPaidPence: 17400, actualPaymentRowsPence: 17400 });
    expect(result.customerReview).toHaveLength(1);
    expect(result.overallSignOff).toContain("NOT SIGNED OFF");
    expect(sourceHashes(folder)).toEqual(originalHashes);
    expect(sourceHashes(original)).toEqual(originalHashes);
    expect(await snapshot(a())).toEqual(before);
    expect(await snapshot(b())).toEqual(beforeBeta);
  });
});
