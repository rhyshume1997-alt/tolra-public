/**
 * Recording an inspection in the API tests (migration 081). A pass or a concession now records its acceptance criteria and the measured
 * result (inspect_job: the older record_job_inspection refuses a pass without criteria, criteria_required); a fail sent the old way
 * (record_job_inspection) is still recorded as before. Takes record_job_inspection's arguments, so the tests read as they did.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const TEST_CRITERIA = "Drawing rev A: bore 25.00 +0.02/-0, length 60.00 +/-0.1";

export type InspectionArgs = {
  p_job: string; p_result: string; p_notes: string | null; p_expected_version: number | null;
  p_attachment_path?: string | null; p_attachment_name?: string | null; p_concession_reason?: string | null;
  /** inspect_job only: an admin who finished the job records it anyway, with a reason (10+ characters). */
  p_override_reason?: string | null;
};

export function recordInspection(client: SupabaseClient, args: InspectionArgs) {
  if (args.p_result === "fail") {
    const { p_override_reason: _override, ...old } = args;
    return client.rpc("record_job_inspection", { p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, ...old });
  }
  const { p_notes, ...rest } = args;
  return client.rpc("inspect_job", { ...rest, p_measured: p_notes, p_criteria: TEST_CRITERIA });
}
