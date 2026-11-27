/**
 * Regression tests for CR-020 (Module 2 UI wiring):
 * Retries of the same manual job creation reuse the same request_id UUID and call Release 174's
 * create_job_idempotent RPC, falling back cleanly to create_job before 174 is applied.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createJobWithIdempotency, jobRequestIdForAttempt } from "@/lib/job-create-idempotency";

const payload = {
  p_customer: "Acme Ltd",
  p_description: "Shaft turning",
  p_internal: false,
  p_related: null,
  p_required: "2026-12-01",
  p_machines: [],
  p_clash_override: false,
  p_clashes: [],
  p_override_reason: null,
};

describe("CR-020 (Module 2): manual job request_id idempotency wiring", () => {
  it("reuses the same request_id across retries of identical job form payloads", () => {
    let n = 0;
    const make = () => `job-req-${++n}`;
    const first = jobRequestIdForAttempt(null, "job-sig-1", make);
    expect(jobRequestIdForAttempt(first, "job-sig-1", make)).toBe(first);
    expect(jobRequestIdForAttempt(first, "job-sig-2", make)).toEqual({ signature: "job-sig-2", requestId: "job-req-2" });
  });

  it("calls create_job_idempotent with p_request_id and falls back to create_job before Release 174", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { job_id: "j-1", job_no: "J-0042", replayed: true }, error: null });
    const res = await createJobWithIdempotency({ rpc }, "job-req-1", payload);
    expect(res).toEqual({ job_id: "j-1", job_no: "J-0042", replayed: true });
    expect(rpc).toHaveBeenCalledWith("create_job_idempotent", { p_request_id: "job-req-1", ...payload });

    const rpcMissing = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: { job_id: "j-2", job_no: "J-0043" }, error: null });
    const fb = await createJobWithIdempotency({ rpc: rpcMissing }, "job-req-2", payload);
    expect(fb).toEqual({ job_id: "j-2", job_no: "J-0043" });
    expect(rpcMissing).toHaveBeenLastCalledWith("create_job", payload);
  });

  it("wires createJobWithIdempotency into components/new-job-dialog.tsx", () => {
    expect(readFileSync("components/new-job-dialog.tsx", "utf8")).toContain("createJobWithIdempotency(");
  });
});
