/**
 * A Problem on a job (migration 117), the app's side: the reasons, the flag's words, who sees which control (fail closed until the
 * database has 117), the read of the open problems against a PostgREST stand-in with and without the table, the report's retry key,
 * its failure words, the Needs attention read, and the "Problems reported" rule and filter. The database side is tests/db/job-problems-117.test.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { buildAttention, type AttentionInput, rulesForRole } from "@/lib/attention-items";
import { jobProblemsOf } from "@/lib/attention-load";
import { describeEntry } from "@/lib/activity";
import {
  NEEDS_CONNECTION, PROBLEM_REASONS, jobsWithProblems, loadOpenProblems, problemControls, problemFlag, problemsFor, reasonLabel, reportFailure,
  reportJobProblem, reportSignature, requestKeyFor, resolveJobProblem, type OpenProblem,
} from "@/lib/job-problems";
import { jobMatchesFilter, parseListFilter } from "@/lib/list-filter";

const problem = (over: Partial<OpenProblem> = {}): OpenProblem => ({ id: "p1", job_id: "j1", reason: "material", note: null, reported_by: "u1", reported_at: "2026-10-14T09:00:00Z", ...over });

describe("reasons and words", () => {
  it("offers the six reasons the database accepts, each with a word", () => {
    expect(PROBLEM_REASONS.map((r) => r.value)).toEqual(["material", "drawing", "machine", "quality", "tooling", "other"]);
    expect(PROBLEM_REASONS.map((r) => r.label)).toEqual(["Material", "Drawing", "Machine", "Quality", "Tooling", "Other"]);
    expect(reasonLabel("machine")).toBe("Machine");
    expect(reasonLabel("nonsense")).toBe("Other");
  });
  it("the flag says Problem, how many, why and who is waited for; nothing when there is none", () => {
    expect(problemFlag([])).toBeNull();
    expect(problemFlag([problem()])).toEqual({ word: "Problem", count: 1, detail: "Problem reported: Material. Waiting for the office." });
    expect(problemFlag([problem(), problem({ id: "p2", reason: "drawing" }), problem({ id: "p3", reason: "material" })])).toEqual({
      word: "Problem", count: 3, detail: "3 problems reported: Material, Drawing. Waiting for the office.",
    });
  });
  it("picks one job's problems, and the set of jobs that carry any", () => {
    const all = [problem(), problem({ id: "p2", job_id: "j2" }), problem({ id: "p3", job_id: "j1" })];
    expect(problemsFor(all, "j1").map((p) => p.id)).toEqual(["p1", "p3"]);
    expect([...jobsWithProblems(all)].sort()).toEqual(["j1", "j2"]);
  });
});

describe("who sees which Problem control (fail closed)", () => {
  const ask = (available: boolean | null, role: string | null, extra: { online?: boolean; readOnly?: boolean } = {}) => problemControls({ available, role, online: extra.online ?? true, readOnly: extra.readOnly });
  it("nothing shows until the database has 117 (missing or unknown)", () => {
    for (const available of [false, null]) {
      for (const role of ["admin", "office", "workshop", "viewer", null]) expect(ask(available, role), `${available} ${role}`).toEqual({ showReport: false, canResolve: false, note: null });
    }
  });
  it("admin, office and workshop can report; only admin and office can resolve; a viewer can do neither", () => {
    expect(ask(true, "workshop")).toEqual({ showReport: true, canResolve: false, note: null });
    expect(ask(true, "office")).toEqual({ showReport: true, canResolve: true, note: null });
    expect(ask(true, "admin")).toEqual({ showReport: true, canResolve: true, note: null });
    expect(ask(true, "viewer")).toEqual({ showReport: false, canResolve: false, note: null });
    expect(ask(true, null)).toEqual({ showReport: false, canResolve: false, note: null });
  });
  it("a read-only support session can do neither", () => {
    expect(ask(true, "admin", { readOnly: true })).toEqual({ showReport: false, canResolve: false, note: null });
  });
  it("offline the button says reporting needs a connection", () => {
    expect(ask(true, "workshop", { online: false })).toEqual({ showReport: true, canResolve: false, note: "Reporting a problem needs a connection" });
    expect(NEEDS_CONNECTION).toBe("Reporting a problem needs a connection");
  });
});

describe("reading the open problems", () => {
  const MISSING = { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.job_problems' in the schema cache" };
  /** A PostgREST stand-in: the table is there (rows), missing (404 PGRST205) or broken (400). */
  function client(mode: "present" | "missing" | "broken", seen: string[] = []) {
    const fetch = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      
      if (mode === "missing") return new Response(JSON.stringify(MISSING), { status: 404, headers: { "content-type": "application/json" } });
      if (mode === "broken") return new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 400, headers: { "content-type": "application/json" } });
      // A second page (offset above 0, as fetchAll asks) is empty: the one row is all there is.
      if (Number(new URL(String(input)).searchParams.get("offset") ?? 0) > 0) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify([{ id: "p1", job_id: "j1", reason: "tooling", note: "Insert snapped", reported_by: "u1", reported_at: "2026-10-14T09:00:00Z" }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    return createClient("http://localhost:54321", "anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  }

  it("with 117: the open problems of the asked jobs, newest first, nothing resolved", async () => {
    const seen: string[] = [];
    const answer = await loadOpenProblems(client("present", seen), ["j1", "j2"]);
    expect(answer).toEqual({ available: true, problems: [{ id: "p1", job_id: "j1", reason: "tooling", note: "Insert snapped", reported_by: "u1", reported_at: "2026-10-14T09:00:00Z" }] });
    expect(seen).toHaveLength(1);
    const url = decodeURIComponent(seen[0]);
    expect(url).toContain("/rest/v1/job_problems?");
    expect(url).toContain("status=eq.open");
    expect(url).toContain("job_id=in.(j1,j2)");
    expect(url).toContain("order=reported_at.desc");
  });
  it("without 117 (the table is missing): not available, no problems, no flag", async () => {
    expect(await loadOpenProblems(client("missing"))).toEqual({ available: false, problems: [] });
  });
  it("any other failure (a broken answer, the network down) is unknown, never available, and shows no flag", async () => {
    expect(await loadOpenProblems(client("broken"))).toEqual({ available: null, problems: [] });
    // The network down: the call itself rejects (a stand-in, as the real client retries a dropped connection for seconds).
    const down = { from: () => { throw new TypeError("Failed to fetch"); } };
    expect(await loadOpenProblems(down as never)).toEqual({ available: null, problems: [] });
  });
  it("asking about no jobs asks nothing", async () => {
    const seen: string[] = [];
    expect(await loadOpenProblems(client("present", seen), [])).toEqual({ available: null, problems: [] });
    expect(seen).toEqual([]);
  });
  it("the office's Needs attention read: rows with the job when 117 is there, nothing before it, null when the read failed", async () => {
    expect(await jobProblemsOf(client("present"))).toHaveLength(1);
    expect(await jobProblemsOf(client("missing"))).toEqual([]);
    expect(await jobProblemsOf(client("broken"))).toBeNull();
  });
});

describe("sending a report", () => {
  it("the same report keeps its key (a retry after a lost answer is one problem); a changed report gets a new one", () => {
    let made = 0;
    const make = () => `key-${++made}`;
    const first = requestKeyFor(null, reportSignature("j1", "material", "Wrong grade"), make);
    expect(first.key).toBe("key-1");
    expect(requestKeyFor(first, reportSignature("j1", "material", "  Wrong grade "), make)).toBe(first);
    expect(requestKeyFor(first, reportSignature("j1", "machine", "Wrong grade"), make).key).toBe("key-2");
    expect(requestKeyFor(first, reportSignature("j2", "material", "Wrong grade"), make).key).toBe("key-3");
    expect(made).toBe(3);
  });
  it("sends the job, reason, trimmed note (null when empty) and key to report_job_problem; clearing sends the trimmed note", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db = { rpc: async (name: string, args: Record<string, unknown>) => { calls.push([name, args]); return { data: name === "report_job_problem" ? "new-id" : null, error: null }; } };
    expect(await reportJobProblem(db as never, "j1", "drawing", "  Holes disagree ", "k1")).toBe("new-id");
    await reportJobProblem(db as never, "j1", "other", "   ", "k2");
    await resolveJobProblem(db as never, "p1", "  Revision D issued ");
    expect(calls).toEqual([
      ["report_job_problem", { p_job: "j1", p_reason: "drawing", p_note: "Holes disagree", p_request_id: "k1" }],
      ["report_job_problem", { p_job: "j1", p_reason: "other", p_note: null, p_request_id: "k2" }],
      ["resolve_job_problem", { p_problem: "p1", p_note: "Revision D issued" }],
    ]);
  });
  it("a refusal from the database is thrown, not swallowed (no false 'reported')", async () => {
    const db = { rpc: async () => ({ data: null, error: { code: "42501", message: "not authorised" } }) };
    await expect(reportJobProblem(db as never, "j1", "other", "", "k")).rejects.toMatchObject({ code: "42501" });
    await expect(resolveJobProblem(db as never, "p1", "Done it")).rejects.toMatchObject({ code: "42501" });
  });
  it("failures are said in words: a lost connection, a missing 117, a job that isn't theirs", () => {
    expect(reportFailure(new TypeError("Failed to fetch"))).toBe(NEEDS_CONNECTION);
    expect(reportFailure({ code: "PGRST202", message: "Could not find the function public.report_job_problem in the schema cache" })).toBe("Problem reports aren't available yet.");
    expect(reportFailure({ code: "42501", message: "That job is not assigned to you." })).toBe("You can only report a problem on a job assigned to you.");
    expect(reportFailure({ code: "P0002", message: "Job not found" })).toBe("That job couldn't be found.");
    expect(reportFailure({ code: "XX000", message: "boom" })).toBe("The problem wasn't reported. Try again.");
  });
});

describe("Problems reported on Needs attention (admin and office)", () => {
  const empty: AttentionInput = { quotes: [], rfqs: [], quotedRfqIds: [], purchaseOrders: [], lateJobs: [], finishedJobs: [], invoices: [], deliveryNotes: [] };
  const row = (over: Record<string, unknown>) => ({ id: "p", job_id: "j", reason: "material", note: null, reported_at: "2026-10-12T09:00:00Z", jobs: { job_no: "J-1", customer: "Acme" }, ...over });
  const section = (input: Partial<AttentionInput>, role: "admin" | "office" | "workshop" | "viewer" = "admin") => buildAttention({ ...empty, ...input }, role, "2026-10-15").find((s) => s.id === "jobs-problems");

  it("lists each open problem, oldest first, with the job, the reason and the note, linking to the job", () => {
    const s = section({ jobProblems: [row({ id: "new", job_id: "j2", reported_at: "2026-10-15T07:00:00Z", reason: "machine", note: "Spindle alarm", jobs: [{ job_no: "J-2", customer: null }] }), row({ id: "old", job_id: "j1" })] })!;
    expect(s).toMatchObject({ title: "Problems reported", href: "/jobs?filter=problems", count: 2, failed: false });
    expect(s.items.map((i) => i.key)).toEqual(["jp-old", "jp-new"]);
    expect(s.items[0]).toEqual({ key: "jp-old", title: "Job J-1 has a problem: Material", detail: "Acme (reported 3 days ago)", href: "/jobs?job=j1", ageDays: 3 });
    expect(s.items[1]).toMatchObject({ title: "Job J-2 has a problem: Machine: Spindle alarm", detail: "Internal (reported today)", href: "/jobs?job=j2" });
  });
  it("is for admin and office only; empty before 117 (no rows given); a failed read says so", () => {
    expect(rulesForRole("admin").map((r) => r.id)).toContain("jobs-problems");
    expect(rulesForRole("office").map((r) => r.id)).toContain("jobs-problems");
    expect(rulesForRole("workshop").map((r) => r.id)).not.toContain("jobs-problems");
    expect(rulesForRole("viewer").map((r) => r.id)).not.toContain("jobs-problems");
    expect(section({}, "workshop")).toBeUndefined();
    expect(section({})).toMatchObject({ count: 0, failed: false });
    expect(section({ jobProblems: null })).toMatchObject({ failed: true });
  });
  it("View all opens the Job Board filtered to the jobs with an open problem, none until they are known", () => {
    expect(parseListFilter("jobs", "?filter=problems")).toBe("problems");
    const open = new Set(["j1"]);
    expect(jobMatchesFilter("problems", { id: "j1" }, "2026-10-15", undefined, open)).toBe(true);
    expect(jobMatchesFilter("problems", { id: "j2" }, "2026-10-15", undefined, open)).toBe(false);
    expect(jobMatchesFilter("problems", { id: "j1" }, "2026-10-15")).toBe(false);
  });
});

describe("the job's history says it in words", () => {
  const entry = (action: string, metadata: Record<string, unknown>) => ({ id: "e", created_at: "2026-10-14T09:00:00Z", actor_name: "Lee", actor_email: null, action, entity_table: "jobs", entity_id: "j", changes: null, snapshot: null, metadata });
  it("a report shows the reason and note; a clearing shows what was done", () => {
    expect(describeEntry(entry("REPORT_JOB_PROBLEM", { reason: "drawing", note: "Holes disagree" }) as never)).toEqual({ title: "Problem reported", details: ["Reason: Drawing", "Note: Holes disagree"] });
    expect(describeEntry(entry("RESOLVE_JOB_PROBLEM", { reason: "drawing", resolution_note: "Revision D issued" }) as never)).toEqual({ title: "Problem resolved", details: ["Reason: Drawing", "What was done: Revision D issued"] });
  });
});
