/** One disposable company with the whole synthetic export imported through the real importer: the starting point of most test files. */
import { createRehearsalDb, makeOrg, runImport, type ImportRun, type Rehearsal } from "./db";
import { buildScenario, type Scenario } from "./synthetic";
import type { SourceSnapshot } from "../reconcile";

export type World = { db: Rehearsal; orgId: string; userId: string; scenario: Scenario; run: ImportRun; snapshot: SourceSnapshot; expectedImported: Set<string> };

/** The generator's own figures as a SourceSnapshot (independent of the importer's parser). */
export function snapshotFromScenario(s: Scenario): SourceSnapshot {
  return {
    customers: s.customers.map((c) => ({ name: c.name })),
    invoices: s.invoices.map((i) => ({ number: i.number, customerRef: i.customerRef, netP: i.netP, vatP: i.vatP, grossP: i.grossP, status: i.status })),
    lines: s.lines.map((l) => ({ doc: l.doc, netP: l.netP })),
    payments: s.payments.map((p) => ({ invoice: p.invoice, amountP: p.amountP, date: p.date || null })),
    quotes: s.quotes.map((q) => ({ number: q.number, grossP: q.grossP })),
  };
}

/** Invoice numbers the importer is designed to write: everything except duplicate numbers, unknown customers and operator exclusions. */
export function expectedImported(s: Scenario): Set<string> {
  const not = new Set([...s.facts.duplicateInvoiceNumbers, ...s.facts.unknownCustomerInvoices, ...s.facts.operatorExcluded]);
  return new Set(s.invoices.map((i) => i.number).filter((n) => !not.has(n)));
}

export async function buildWorld(label: string): Promise<World> {
  const db = await createRehearsalDb(label);
  const { orgId, userId } = await makeOrg(db.url, `t-${label}`);
  const scenario = buildScenario();
  const run = await runImport({ url: db.url, orgId, scenario });
  return { db, orgId, userId, scenario, run, snapshot: snapshotFromScenario(scenario), expectedImported: expectedImported(scenario) };
}
