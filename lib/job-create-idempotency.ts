/**
 * Inputs: Supabase RPC client, per-attempt requestId UUID, and manual job creation parameters.
 * Outputs: created (or replayed) `{ job_id, job_no }`; falls back cleanly to create_job before Release 174 is applied.
 * Boundary: Module 2 (Jobs) only; does not modify database migrations or other modules.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { missingDbObject } from "@/lib/db-features";

export type JobCreateAttemptKey = { signature: string; requestId: string };

/** Keeps the same request_id UUID across retries of the same job form payload; rotates when the payload changes. */
export function jobRequestIdForAttempt(
  current: JobCreateAttemptKey | null,
  signature: string,
  makeId: () => string = () => crypto.randomUUID(),
): JobCreateAttemptKey {
  if (current && current.signature === signature) return current;
  return { signature, requestId: makeId() };
}

export type CreateJobPayload = {
  p_customer: string | null;
  p_description: string;
  p_internal: boolean;
  p_related: string | null;
  p_required: string | null;
  p_machines: unknown;
  p_clash_override: boolean;
  p_clashes: unknown;
  p_override_reason: string | null;
};

export async function createJobWithIdempotency(
  client: Pick<SupabaseClient, "rpc">,
  requestId: string,
  payload: CreateJobPayload,
): Promise<{ job_id: string; job_no: string; replayed?: boolean }> {
  const { data, error } = await client.rpc("create_job_idempotent", {
    p_request_id: requestId,
    ...payload,
  });
  if (!error) return data as { job_id: string; job_no: string; replayed?: boolean };
  if (!missingDbObject(error)) throw error;

  const fallback = await client.rpc("create_job", payload);
  if (fallback.error) throw fallback.error;
  return fallback.data as { job_id: string; job_no: string };
}
