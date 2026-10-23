/**
 * Customer sign-off (migration 072; Marpet: "customers sign off the job on site"). The fitter captures it on their phone; it is an outbox
 * entry of kind "signoff" with role "customer", bound to the fitter, with the phone's time and the revision on screen, uploaded once
 * through sign_off_job_customer under its client key. It never counts as (or against) the internal sign-off of a revision.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { customerSignOffError } from "@/components/customer-signoff";
import {
  CUSTOMER_SIGNOFF_STATEMENT, type JobSignOff, customerInitials, customerLine, customerSignOffOp, customerSignOffs, formatSignedAt, kindLabel, openCosignRoles,
  pendingSignOffsFor, recordSha256, signOffOp, signOffStatus, signOffsByRevision,
} from "@/lib/job-signoff";
import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, type SignOffOp } from "@/lib/offline/outbox";
import { setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession, unsyncedSummary } from "@/lib/offline/store";
import { CUSTOMER_SIGNOFF_UPGRADE_REASON, executeCustomerSignOffOp, executeSignOffOp, SIGNOFF_OTHER_USER_REASON } from "@/lib/offline/sync";
import { canonicalJson, sha256Hex } from "@/lib/snapshot-hash";

const fitter = { userId: "fitter-1", orgId: "org-marpet" };
const SHA0 = "a".repeat(64);
const PATH = "M10 10L60 40L120 20L200 80";
const AT = new Date("2026-10-17T13:03:00.123Z");
const input = { jobId: "job-1", jobNo: "J-0001", signerName: "  Jane Smith ", position: " Site Manager ", company: "", comment: "  ", kind: "drawn" as const, data: PATH, shownVersion: 2, shownSha256: SHA0, signedAt: AT };

type Call = Record<string, unknown>;
/** A stand-in for sign_off_job_customer: one record per client key (a replay answers the first), one customer row per job, scripted refusals. */
function server(options: { refuse?: { code: string; hint?: string; message: string }; loseAnswers?: number; missing?: boolean } = {}) {
  const records = new Map<string, Call>();
  const perJob = new Set<string>();
  const calls: Call[] = [];
  let lose = options.loseAnswers ?? 0;
  return {
    records, calls,
    rpc: async (fn: string, args: Call) => {
      if (options.missing) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.sign_off_job_customer" } };
      expect(fn).toBe("sign_off_job_customer");
      calls.push(args);
      const key = String(args.p_client_op_id);
      if (records.has(key)) {
        const same = JSON.stringify(records.get(key)) === JSON.stringify(args);
        return same ? { data: { id: key, replayed: true }, error: null } : { data: null, error: { code: "22023", hint: "client_op_reused", message: "This signature's key was already used for a different signature. Capture it again." } };
      }
      if (options.refuse) return { data: null, error: options.refuse };
      if (perJob.has(String(args.p_job_id))) return { data: null, error: { code: "23505", hint: "already_signed", message: "Revision 2 of J-0001 already has a customer sign-off." } };
      records.set(key, args);
      perJob.add(String(args.p_job_id));
      if (lose > 0) {
        lose -= 1;
        throw new TypeError("Failed to fetch"); // stored, but the answer never reached the phone
      }
      return { data: { id: key, replayed: false }, error: null };
    },
  };
}

const row = (extra: Partial<JobSignOff>): JobSignOff => ({
  id: "r", job_id: "job-1", worksheet_version: 2, snapshot: {}, snapshot_sha256: SHA0, record_sha256: "0".repeat(64), initials: "AB", signer_name: "Alex Brown",
  signed_on: "2026-10-17", signature_kind: "drawn", signature_data: PATH, signed_by: "u-1", kind: "primary", created_at: "2026-10-17T13:00:00Z", ...extra,
});

let data: Map<string, unknown>;
beforeEach(() => { data = new Map(); setOfflineBackend(memoryBackend(data)); setSupportSession(false); });
afterEach(() => { setOfflineScope(null); setOfflineBackend(null); setSupportSession(false); });

describe("capture", () => {
  it("binds the customer's details, the statement, the phone's time and the revision on screen to the fitter, under a fresh key", () => {
    const op = customerSignOffOp(input, "fitter-1", new Date("2026-10-17T13:04:00Z"));
    expect(op).toEqual({
      kind: "signoff", role: "customer", clientOpId: expect.stringMatching(/^[0-9a-f-]{36}$/), jobId: "job-1", jobNo: "J-0001", expectedVersion: 2, expectedSha256: SHA0,
      initials: "JS", signerName: "Jane Smith", signedOn: "2026-10-17", signatureKind: "drawn", signatureData: PATH, capturedBy: "fitter-1", capturedAt: "2026-10-17T13:04:00.000Z",
      customer: { position: "Site Manager", company: null, statement: CUSTOMER_SIGNOFF_STATEMENT, comment: null, deviceSignedAt: "2026-10-17T13:03:00.123Z" },
    });
    expect(customerSignOffOp(input, "f").clientOpId).not.toBe(customerSignOffOp(input, "f").clientOpId);
  });

  it("records no revision when the phone has none, a typed signature trimmed, and the UK date of the phone's time", () => {
    const op = customerSignOffOp({ ...input, shownSha256: null, kind: "typed", data: "  Jane Smith ", signedAt: new Date("2026-06-30T23:30:00Z") }, "f");
    expect([op.expectedVersion, op.expectedSha256, op.signatureData, op.signedOn]).toEqual([null, null, "Jane Smith", "2026-07-01"]);
  });

  it("takes initials from the printed name as the database does, or C", () => {
    expect(["Jane Smith", "jean-luc picard", "Zoë O'Brien", "Łukasz", "李", "a b c d e"].map(customerInitials)).toEqual(["JS", "JLP", "ZO", "U", "C", "ABCD"]);
  });

  it("keeps the statement in one place, worded for the customer", () => {
    expect(CUSTOMER_SIGNOFF_STATEMENT).toMatch(/completed to my satisfaction/);
  });
});

describe("apart from the internal sign-off", () => {
  const customer = row({ id: "c", kind: "customer", signed_by: "fitter-1", signer_name: "Jane Smith", statement: CUSTOMER_SIGNOFF_STATEMENT, device_signed_at: AT.toISOString() });

  it("a customer row alone never makes a revision signed, and is never a co-signature or in the internal history", () => {
    expect(signOffStatus([customer], 2)).toEqual({ status: "none" });
    const primary = row({ id: "p" });
    const status = signOffStatus([primary, customer], 2);
    expect(status).toMatchObject({ status: "signed", latest: { id: "p" }, cosigns: [] });
    expect(openCosignRoles(status)).toEqual(["inspector"]);
    expect(signOffsByRevision([primary, customer]).flatMap((group) => group.rows.map((r) => r.id))).toEqual(["p"]);
    expect(customerSignOffs([primary, customer]).map((r) => r.id)).toEqual(["c"]);
    expect(kindLabel("customer")).toBe("Customer");
  });

  it("names the customer with the parts given, and shows times in the UK", () => {
    expect(customerLine({ signer_name: "Jane Smith", signer_position: "Site Manager", signer_company: null })).toBe("Jane Smith, Site Manager");
    expect(customerLine({ signer_name: "Jane Smith", signer_position: " ", signer_company: "Acme Ltd" })).toBe("Jane Smith, Acme Ltd");
    expect(formatSignedAt("2026-10-17T13:03:00Z")).toBe("17 Oct 2026, 14:03");
    expect(formatSignedAt(null)).toBe("");
  });

  it("the record hash of an internal row is unchanged by 072; a customer row's covers every customer field and the capturer", async () => {
    const primary = row({});
    const base = { snapshot_sha256: SHA0, initials: "AB", signer_name: "Alex Brown", signed_on: "2026-10-17", signature_kind: "drawn", signature_data: PATH, worksheet_version: "2", job_id: "job-1", kind: "primary" };
    expect(await recordSha256(primary)).toBe(await sha256Hex(canonicalJson(base)));
    const hash = await recordSha256(customer);
    for (const change of [{ signer_position: "Boss" }, { signer_company: "Acme" }, { statement: "Other" }, { customer_comment: "Fine" }, { device_signed_at: "2026-10-17T13:03:01.123Z" },
      { shown_worksheet_version: 1 }, { shown_snapshot_sha256: SHA0 }, { signed_by: "someone-else" }]) {
      expect(await recordSha256({ ...customer, ...change }), JSON.stringify(change)).not.toBe(hash);
    }
    // The server's time format (+00:00, microseconds trimmed to milliseconds by 072) hashes as the phone's ISO time.
    expect(await recordSha256({ ...customer, device_signed_at: "2026-10-17T13:03:00.123+00:00" })).toBe(hash);
    // A time that can't be parsed (072 never stores one: finite, inside its window) is hashed as text, never thrown on.
    for (const odd of ["infinity", "-infinity", "not a time"]) await expect(recordSha256({ ...customer, device_signed_at: odd })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the database's messages for the person, and a friendly one otherwise", () => {
    expect(customerSignOffError({ code: "42501", hint: "customer_signoff_off", message: "Customer sign-off on jobs is turned off for this company." })).toMatch(/turned off/);
    expect(customerSignOffError({ code: "23505", hint: "already_signed", message: "Revision 2 of J-0001 already has a customer sign-off." })).toMatch(/already has/);
    expect(customerSignOffError(new Error("boom"))).not.toBe("");
  });
});

describe("offline: captured once, uploaded once", () => {
  it("is a durable outbox entry; queued twice it stays one; counted as a signature; listed for its job", async () => {
    setOfflineScope(fitter);
    const op = customerSignOffOp(input, "fitter-1");
    await enqueue(fitter, op);
    await enqueue(fitter, op);
    expect((await pendingEntries(fitter)).map((e) => e.op)).toEqual([op]);
    expect(await unsyncedSummary()).toMatchObject({ changes: 1, signatures: 1, jobNos: ["J-0001"] });
    expect(await pendingSignOffsFor("job-1")).toEqual([expect.objectContaining({ op, status: "waiting" })]);
  });

  it("uploads with every field; a lost answer then a second pass replay the same key: one record, nothing left queued", async () => {
    const op = customerSignOffOp({ ...input, company: "Acme Ltd", comment: "All good" }, "fitter-1");
    await enqueue(fitter, op);
    const api = server({ loseAnswers: 1 });
    const run = () => replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, api, "fitter-1"));
    expect(await run()).toMatchObject({ applied: 0, remaining: 1 });
    expect(await run()).toMatchObject({ applied: 1, remaining: 0 });
    expect(await run()).toMatchObject({ applied: 0, remaining: 0 });
    expect(api.records.size).toBe(1);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]).toEqual({
      p_job_id: "job-1", p_signer_name: "Jane Smith", p_signer_position: "Site Manager", p_signer_company: "Acme Ltd", p_statement: CUSTOMER_SIGNOFF_STATEMENT, p_comment: "All good",
      p_signature_kind: "drawn", p_signature_data: PATH, p_device_signed_at: AT.toISOString(), p_client_op_id: op.clientOpId, p_shown_version: 2, p_shown_snapshot_sha256: SHA0,
    });
  });

  it("the same entry replayed again after it applied (a second tab, a restored backup) is a replay, never a second record", async () => {
    const op = customerSignOffOp(input, "fitter-1");
    const api = server();
    expect(await executeCustomerSignOffOp(op, api)).toEqual({ status: "applied" });
    expect(await executeCustomerSignOffOp(op, api)).toEqual({ status: "applied" });
    expect(api.records.size).toBe(1);
  });

  it("two customers' signatures for one job, in either order: the first is recorded, the second held as a conflict with the reason", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      data.clear();
      const ops = [customerSignOffOp(input, "fitter-1"), customerSignOffOp({ ...input, signerName: "Bob Jones" }, "fitter-1")];
      for (const i of order) await enqueue(fitter, ops[i]);
      const api = server();
      expect(await replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, api, "fitter-1"))).toMatchObject({ applied: 1, conflicts: 1, remaining: 0 });
      expect([...api.records.values()].map((r) => r.p_signer_name)).toEqual([ops[order[0]].signerName]);
      expect((await conflictEntries(fitter))[0]).toMatchObject({ op: ops[order[1]], reason: expect.stringContaining("already has a customer sign-off") });
    }
  });

  it("a customer signature and the operator's own sign-off queued in reverse order both upload, each through its own function", async () => {
    const internal = signOffOp({ jobId: "job-1", jobNo: "J-0001", expectedVersion: 2, expectedSha256: SHA0, initials: "FT", signerName: "Fitter", signedOn: "2026-10-17", kind: "typed", data: "Fitter" }, "fitter-1");
    await enqueue(fitter, customerSignOffOp(input, "fitter-1"));
    await enqueue(fitter, internal);
    const seen: string[] = [];
    const api = { rpc: async (fn: string) => { seen.push(fn); return { data: {}, error: null }; } };
    expect(await replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, api, "fitter-1"))).toMatchObject({ applied: 2, remaining: 0 });
    expect(seen).toEqual(["sign_off_job_customer", "sign_off_job"]);
  });

  it("is only uploaded while the fitter who captured it is signed in", async () => {
    const api = server();
    expect(await executeSignOffOp(customerSignOffOp(input, "fitter-1"), api, "someone-else")).toEqual({ status: "rejected", code: "signoff_other_user", reason: SIGNOFF_OTHER_USER_REASON });
    expect(await executeSignOffOp(customerSignOffOp(input, "fitter-1"), api, null)).toMatchObject({ status: "rejected" });
    expect(api.calls).toHaveLength(0);
  });

  it("waits, unchanged, while the database doesn't have 072; refusals are held with the server's message; the network keeps it queued", async () => {
    const op = customerSignOffOp(input, "fitter-1");
    await enqueue(fitter, op);
    expect(await replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, server({ missing: true }), "fitter-1"))).toMatchObject({ blocked: 1, remaining: 1 });
    expect((await pendingEntries(fitter))[0]).toMatchObject({ op, blocked: { reason: CUSTOMER_SIGNOFF_UPGRADE_REASON } });
    const down = { rpc: async () => { throw new TypeError("Failed to fetch"); } };
    expect(await replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, down, "fitter-1"))).toMatchObject({ applied: 0, remaining: 1 });
    const off = server({ refuse: { code: "42501", hint: "customer_signoff_off", message: "Customer sign-off on jobs is turned off for this company. An admin can turn it on in Settings." } });
    expect(await replayOutbox(fitter, (o) => executeSignOffOp(o as SignOffOp, off, "fitter-1"))).toMatchObject({ rejected: 1, remaining: 0 });
    expect((await rejectedEntries(fitter))[0]).toMatchObject({ op, code: "customer_signoff_off", reason: expect.stringContaining("turned off") });
    expect(await executeCustomerSignOffOp(op, server({ refuse: { code: "P0002", message: "Job not found" } }))).toMatchObject({ status: "rejected", reason: expect.stringContaining("no longer exists") });
    // A phone clock outside 072's window: held with the server's message (set the clock, capture again), never retried as is.
    const clock = server({ refuse: { code: "22023", hint: "device_time_out_of_range", message: "This phone's date and time (01 Jan 1970 00:00) is wrong or the signature is more than 30 days old." } });
    expect(await executeCustomerSignOffOp(op, clock)).toMatchObject({ status: "rejected", code: "device_time_out_of_range", reason: expect.stringContaining("date and time") });
    expect(customerSignOffError({ code: "22023", hint: "device_time_out_of_range", message: "This phone's date and time is wrong." })).toBe("This phone's date and time is wrong.");
  });
});
