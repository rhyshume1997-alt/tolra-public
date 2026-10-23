import { describe, expect, it } from "vitest";

import { type JobSignOff, legacySignOffText, signOffStatus } from "@/lib/job-signoff";

const row = (worksheet_version: number, created_at = "2026-10-12T10:00:00Z"): JobSignOff => ({
  id: `${worksheet_version}-${created_at}`, job_id: "job", worksheet_version, snapshot: {}, snapshot_sha256: "a".repeat(64), record_sha256: "b".repeat(64),
  initials: "AB", signer_name: "Alex Brown", signed_on: "2026-10-12", signature_kind: "typed", signature_data: "Alex Brown", signed_by: "u", kind: "primary", created_at,
});

describe("the old typed sign-off box next to hashed sign-offs (M4)", () => {
  const legacy = { name: " Old Name ", at: "09/10/2026 14:05" };
  it("is shown as an earlier typed record, without a signature or hash, when the job has no hashed sign-off", () => {
    expect(legacySignOffText(signOffStatus([], 0), legacy)).toBe("Signed off (earlier typed record): Old Name, 09/10/2026 14:05, no signature or hash");
  });
  it("is replaced by a hashed sign-off, signed or stale, and needs both a name and a time", () => {
    expect(legacySignOffText(signOffStatus([row(0)], 0), legacy)).toBeNull();
    expect(legacySignOffText(signOffStatus([row(0)], 1), legacy)).toBeNull();
    expect(legacySignOffText(signOffStatus([], 0), null)).toBeNull();
    expect(legacySignOffText(signOffStatus([], 0), { name: " ", at: "09/10/2026 14:05" })).toBeNull();
    expect(legacySignOffText(signOffStatus([], 0), { name: "Old Name", at: "" })).toBeNull();
  });
});
