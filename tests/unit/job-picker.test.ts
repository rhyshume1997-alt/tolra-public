/**
 * The job pickers (lib/job-picker.ts): searched in the database by number or customer, newest first, one more than the limit asked for so the
 * page can say "showing the first N"; and what picking a job fills, and clears, on an invoice and a delivery note.
 */
import { describe, expect, it } from "vitest";

import { type JobClient, PICKER_LIMIT, findJobs, invoiceFieldsFromJob, jobSearchFilter, jobSurvivesCustomerChange, sanitiseTerm } from "@/lib/job-picker";

function fakeClient(rows: Record<string, unknown>[], error: { message: string } | null = null) {
  const calls: string[] = [];
  const query = {
    select: (c: string) => { calls.push(`select ${c}`); return query; },
    eq: (c: string, v: unknown) => { calls.push(`eq ${c} ${String(v)}`); return query; },
    or: (f: string) => { calls.push(`or ${f}`); return query; },
    order: (c: string, o: { ascending: boolean }) => { calls.push(`order ${c} ${o.ascending ? "asc" : "desc"}`); return query; },
    limit: async (n: number) => { calls.push(`limit ${n}`); return { data: error ? null : rows, error }; },
  };
  return { client: { from: () => query } as unknown as JobClient, calls };
}

const job = (n: number, extra: Record<string, unknown> = {}) => ({ id: `id-${n}`, job_no: `J-${n}`, customer: `Cust ${n}`, quote_ref: null, customer_po: null, is_internal: false, ...extra });

describe("search", () => {
  it("the term loses the characters that would change the filter", () => {
    expect(sanitiseTerm("  Acme, Ltd (old) 100% _x*  ")).toBe("Acme Ltd old 100 x");
    expect(jobSearchFilter("J-12")).toBe("job_no.ilike.%J-12%,customer.ilike.%J-12%");
    expect(jobSearchFilter("  ,() ")).toBeNull();
  });

  it("asks the database: newest first, this search, no internal jobs unless wanted, one more than the limit", async () => {
    const { client, calls } = fakeClient([job(1)]);
    await findJobs(client, "acme", { includeInternal: false });
    expect(calls).toEqual([
      "select id, job_no, customer, quote_ref, customer_po, is_internal", "eq is_internal false", "or job_no.ilike.%acme%,customer.ilike.%acme%", "order created_at desc", `limit ${PICKER_LIMIT + 1}`,
    ]);
    const all = fakeClient([]);
    await findJobs(all.client, "", { includeInternal: true });
    expect(all.calls).toEqual(["select id, job_no, customer, quote_ref, customer_po, is_internal", "order created_at desc", `limit ${PICKER_LIMIT + 1}`]);
  });

  it("says when there are more than it shows, so an older job is found by searching", async () => {
    const many = Array.from({ length: PICKER_LIMIT + 1 }, (_, i) => job(i));
    const found = await findJobs(fakeClient(many).client, "", { includeInternal: false });
    expect(found.jobs).toHaveLength(PICKER_LIMIT);
    expect(found.truncated).toBe(true);
    expect((await findJobs(fakeClient([job(1), job(2, { is_internal: true })]).client, "", { includeInternal: true })).jobs.map((j) => [j.job_no, j.internal, j.quote_ref])).toEqual([["J-1", false, ""], ["J-2", true, ""]]);
  });

  it("a failed search is reported, not shown as no jobs", async () => {
    expect(await findJobs(fakeClient([], { message: "x" }).client, "", { includeInternal: false })).toEqual({ jobs: [], truncated: false, failed: true });
  });
});

describe("what picking a job fills", () => {
  it("the customer, quote and PO of that job; a field the job lacks is cleared, never kept from the job before", () => {
    const first = { customer: "Acme Ltd", quote_ref: "QUO-1", customer_po: "PO-9" };
    const second = { customer: "Beta Ltd", quote_ref: "", customer_po: "" };
    expect(invoiceFieldsFromJob(first)).toEqual({ customer: "Acme Ltd", quoteRef: "QUO-1", customerPo: "PO-9" });
    expect(invoiceFieldsFromJob(second)).toEqual({ customer: "Beta Ltd", quoteRef: "", customerPo: "" });
  });

  it("changing the customer to another one drops the job link; the same customer (any case) or a job with no customer keeps it", () => {
    expect(jobSurvivesCustomerChange({ customer: "Acme Ltd" }, "Beta Ltd")).toBe(false);
    expect(jobSurvivesCustomerChange({ customer: "Acme Ltd" }, "acme ltd ")).toBe(true);
    expect(jobSurvivesCustomerChange({ customer: "" }, "Beta Ltd")).toBe(true);
    expect(jobSurvivesCustomerChange(null, "Beta Ltd")).toBe(false);
  });
});
