/**
 * Signing off offline (M4, migration 045; Rhys: "sign and save offline but uploads when back"). The signature is a durable outbox entry
 * bound to the person who captured it and to the revision (version + snapshot hash) they saw; it uploads through sign_off_job under its
 * client key, so a lost answer and a retry give one record; only its signer uploads it (a shared tablet never sends it as someone
 * else); a revision that changed meanwhile is a visible conflict, never re-bound; the co-sign rules come back from the server as refusals.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type JobSignOff, expectedSnapshotSha, pendingSignOffsFor, signOffOp, signOffStatus } from "@/lib/job-signoff";
import { conflictEntries, enqueue, pendingEntries, rejectedEntries, replayOutbox, retryHeld, type SignOffOp } from "@/lib/offline/outbox";
import { setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession, unsyncedSummary } from "@/lib/offline/store";
import { executeSignOffOp, SIGNOFF_OTHER_USER_REASON } from "@/lib/offline/sync";

const alice = { userId: "user-a", orgId: "org-1" };
const bob = { userId: "user-b", orgId: "org-1" };
const SHA0 = "a".repeat(64);
const SHA1 = "b".repeat(64);

const input = { jobId: "job-1", jobNo: "J-0001", expectedVersion: 0, expectedSha256: SHA0, initials: " ab ", signerName: " Alex Brown ", signedOn: "2026-10-13", kind: "typed" as const, data: " Alex Brown " };

type Call = Record<string, unknown>;
/** A stand-in for sign_off_job: one record per client key (a replay answers the first), the revision check, and scripted refusals. */
function server(options: { revision?: { v: number; sha: string }; refuse?: { code: string; hint: string; message: string }; loseAnswers?: number } = {}) {
  const records = new Map<string, Call>();
  const calls: Call[] = [];
  let lose = options.loseAnswers ?? 0;
  const revision = options.revision ?? { v: 0, sha: SHA0 };
  return {
    records, calls,
    rpc: async (fn: string, args: Call) => {
      expect(fn).toBe("sign_off_job");
      calls.push(args);
      const key = String(args.p_client_op_id);
      const prior = records.get(key);
      if (prior) return { data: { id: key, replayed: true }, error: null };
      if (options.refuse) return { data: null, error: options.refuse };
      if (args.p_expected_version !== revision.v || args.p_expected_snapshot_sha256 !== revision.sha) {
        return { data: null, error: { code: "22023", hint: "stale_revision", message: "The worksheet changed since you opened it: reload and check before signing (J-0001 is now revision 1)." } };
      }
      records.set(key, args);
      if (lose > 0) {
        lose -= 1;
        throw new TypeError("Failed to fetch"); // stored, but the answer never reached the device
      }
      return { data: { id: key, replayed: false }, error: null };
    },
  };
}

let data: Map<string, unknown>;
beforeEach(() => { data = new Map(); setOfflineBackend(memoryBackend(data)); setSupportSession(false); });
afterEach(() => { setOfflineScope(null); setOfflineBackend(null); setSupportSession(false); });

describe("capture", () => {
  it("binds the signature to the signer, the revision and its snapshot hash, under a fresh client key", () => {
    const op = signOffOp({ ...input, role: "inspector" }, "user-a", new Date("2026-10-13T09:00:00Z"));
    expect(op).toEqual({
      kind: "signoff", clientOpId: expect.stringMatching(/^[0-9a-f-]{36}$/), jobId: "job-1", jobNo: "J-0001", expectedVersion: 0, expectedSha256: SHA0,
      initials: "AB", signerName: "Alex Brown", signedOn: "2026-10-13", signatureKind: "typed", signatureData: "Alex Brown", role: "inspector",
      capturedBy: "user-a", capturedAt: "2026-10-13T09:00:00.000Z",
    });
    expect(signOffOp(input, "user-a").clientOpId).not.toBe(signOffOp(input, "user-a").clientOpId);
  });

  it("is a durable outbox entry; the same signature queued twice stays one; a sign-out counts it and names the job", async () => {
    const op = signOffOp(input, "user-a");
    await enqueue(alice, op);
    await enqueue(alice, op);
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([op]);
    expect(await unsyncedSummary()).toMatchObject({ changes: 1, signatures: 1, jobNos: ["J-0001"] });
  });

  it("is shown for its job as waiting, and as failed with the reason once held", async () => {
    setOfflineScope(alice);
    const op = signOffOp(input, "user-a");
    await enqueue(alice, op);
    await enqueue(alice, signOffOp({ ...input, jobId: "job-2", jobNo: "J-0002" }, "user-a"));
    expect(await pendingSignOffsFor("job-1")).toEqual([expect.objectContaining({ op, status: "waiting" })]);
    const api = server({ revision: { v: 1, sha: SHA1 } });
    await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-a"));
    expect(await pendingSignOffsFor("job-1")).toEqual([expect.objectContaining({ op, status: "failed", reason: expect.stringContaining("changed after this signature was captured") })]);
  });

  it("a primary takes the revision the server described only for the version on screen; a co-signature takes the primary's own hash", () => {
    const primary: JobSignOff = { id: "p", job_id: "job-1", worksheet_version: 3, snapshot: {}, snapshot_sha256: SHA1, record_sha256: SHA0, initials: "AB", signer_name: "A", signed_on: "2026-10-13", signature_kind: "typed", signature_data: "A", signed_by: "user-a", kind: "primary", created_at: "2026-10-13T09:00:00Z" };
    const revision = { job_id: "job-1", worksheet_version: 3, snapshot_sha256: SHA0 };
    expect(expectedSnapshotSha(signOffStatus([], 3), revision, 3, "primary")).toBe(SHA0);
    expect(expectedSnapshotSha(signOffStatus([], 4), revision, 4, "primary")).toBeNull();
    expect(expectedSnapshotSha(signOffStatus([], 3), null, 3, "primary")).toBeNull();
    expect(expectedSnapshotSha(signOffStatus([primary], 3), revision, 3, "inspector")).toBe(SHA1);
    expect(expectedSnapshotSha(signOffStatus([primary], 4), revision, 4, "inspector")).toBeNull();
  });
});

describe("upload when back online", () => {
  it("applies once; a lost answer leaves it queued and the retry (same key) gets the first record, not a second", async () => {
    const op = signOffOp(input, "user-a");
    await enqueue(alice, op);
    const api = server({ loseAnswers: 1 });
    const run = () => replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-a"));
    expect(await run()).toMatchObject({ applied: 0, remaining: 1 });
    expect(api.records.size).toBe(1);
    expect(await run()).toMatchObject({ applied: 1, remaining: 0 });
    expect(api.records.size).toBe(1);
    expect(api.calls.map((c) => c.p_client_op_id)).toEqual([op.clientOpId, op.clientOpId]);
    expect(api.calls[1]).toEqual({
      p_job_id: "job-1", p_expected_version: 0, p_expected_snapshot_sha256: SHA0, p_initials: "AB", p_signer_name: "Alex Brown", p_signed_on: "2026-10-13",
      p_signature_kind: "typed", p_signature_data: "Alex Brown", p_kind: "primary", p_client_op_id: op.clientOpId,
    });
    expect(await pendingEntries(alice)).toEqual([]);
  });

  it("only its signer uploads it: under anyone else it is held unsent; on a shared tablet the next person's replay never sees it", async () => {
    await enqueue(alice, signOffOp(input, "user-a"));
    const api = server();
    // Bob signs in on the same tablet: his scope has nothing to send, Alice's entry stays hers.
    expect(await replayOutbox(bob, (o) => executeSignOffOp(o as SignOffOp, api, "user-b"))).toMatchObject({ applied: 0, remaining: 0 });
    expect(await pendingEntries(alice)).toHaveLength(1);
    // Even if her entry were replayed in his session, it is not sent as him.
    expect(await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-b"))).toMatchObject({ rejected: 1 });
    expect(api.calls).toEqual([]);
    expect(await rejectedEntries(alice)).toEqual([expect.objectContaining({ code: "signoff_other_user", reason: SIGNOFF_OTHER_USER_REASON })]);
    expect(await executeSignOffOp(signOffOp(input, "user-a"), api, null)).toMatchObject({ status: "rejected", code: "signoff_other_user" });
  });

  it("a revision that changed meanwhile is a conflict with the reason; the request still carried the captured revision (never re-bound)", async () => {
    await enqueue(alice, signOffOp(input, "user-a"));
    const api = server({ revision: { v: 1, sha: SHA1 } });
    expect(await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-a"))).toMatchObject({ conflicts: 1 });
    expect(api.calls[0]).toMatchObject({ p_expected_version: 0, p_expected_snapshot_sha256: SHA0 });
    expect(api.records.size).toBe(0);
    expect(await conflictEntries(alice)).toEqual([expect.objectContaining({ reason: "J-0001 changed after this signature was captured (it signed revision 0), so it was not attached to the new revision. Open the job, check it and sign again." })]);
  });

  it.each([
    ["needs_primary", "22023", "Revision 0 of J-0001 has no sign-off yet: the operator signs first, then the inspector co-signs."],
    ["same_signer", "22023", "You signed revision 0 of J-0001 yourself: a co-signature is from someone else."],
    ["not_inspector", "42501", "An admin has to make you an inspector before you can co-sign as the inspector."],
    ["client_op_reused", "22023", "This signature's key was already used for a different signature. Sign again."],
  ])("a queued co-signature refused on upload (%s) is held with the server's message; Retry sends the same key and revision again", async (hint, code, message) => {
    const op = signOffOp({ ...input, role: "inspector" }, "user-a");
    await enqueue(alice, op);
    const api = server({ refuse: { code, hint, message } });
    expect(await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-a"))).toMatchObject({ rejected: 1 });
    const [held] = await rejectedEntries(alice);
    expect(held).toMatchObject({ reason: message, code: hint });
    expect(await retryHeld(alice, held.id)).toBe(true);
    expect((await pendingEntries(alice)).map((e) => e.op)).toEqual([op]);
  });

  it("someone else signed the revision first: a conflict, nothing added", async () => {
    await enqueue(alice, signOffOp(input, "user-a"));
    const api = server({ refuse: { code: "23505", hint: "already_signed", message: "Revision 0 of J-0001 is already signed off. Edit the worksheet to make a new revision, or add a co-signature." } });
    expect(await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, api, "user-a"))).toMatchObject({ conflicts: 1 });
    expect((await conflictEntries(alice))[0].reason).toContain("Your signature was not added.");
  });

  it("no connection: stays queued in order", async () => {
    await enqueue(alice, signOffOp(input, "user-a"));
    const down = { rpc: async () => ({ data: null, error: { message: "TypeError: Failed to fetch" } }) };
    expect(await replayOutbox(alice, (o) => executeSignOffOp(o as SignOffOp, down, "user-a"))).toMatchObject({ applied: 0, remaining: 1 });
  });
});
