import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { friendlyError } from "@/lib/friendly-error";
import { logRfqClarification, rfqClarificationToast } from "@/lib/rfq-clarification";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const client = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  return { rpc, db: { rpc } };
};

describe("logRfqClarification (migration 110)", () => {
  it("makes exactly one call, to log_rfq_clarification with the RFQ, subject and body", async () => {
    const { rpc, db } = client({ data: { rfq: { id: "r1", status: "clarification" }, moved: true, email_history_id: "h1" }, error: null });
    await expect(logRfqClarification(db, "r1", "Drawing", "Which revision?")).resolves.toEqual({ status: "clarification", moved: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("log_rfq_clarification", { p_rfq_id: "r1", p_subject: "Drawing", p_body: "Which revision?" });
  });

  it("reports an RFQ that was logged but not moved (quoted, or already awaiting clarification)", async () => {
    const { db } = client({ data: { rfq: { id: "r2", status: "ready" }, moved: false }, error: null });
    await expect(logRfqClarification(db, "r2", "s", "b")).resolves.toEqual({ status: "ready", moved: false });
    expect(rfqClarificationToast(false)).toBe("Logged as sent manually");
    expect(rfqClarificationToast(true)).toBe("Logged as sent manually. The RFQ is now awaiting clarification.");
  });

  it("throws the database refusal, which reads as the database's sentence (the rfq_* hints)", async () => {
    const refusal = { code: "P0002", message: "That RFQ couldn't be found. Refresh the page and try again.", hint: "rfq_not_found" };
    const { db } = client({ data: null, error: refusal });
    const err = await logRfqClarification(db, "other-company", "s", "b").catch((e: unknown) => e);
    expect(err).toBe(refusal);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(friendlyError(err, "Couldn't log the email. Try again.")).toBe("That RFQ couldn't be found. Refresh the page and try again.");
    expect(friendlyError({ code: "42501", message: "permission denied for function log_rfq_clarification", hint: "rfq_not_allowed" }))
      .toBe("Only admin and office staff can log RFQ e-mails.");
    expect(friendlyError({ code: "22023", message: "", hint: "rfq_no_email" })).toBe("This RFQ has no email address. Add one before sending.");
  });

  it("RFQ Control logs the e-mail through the one call, never the two writes it used to make", () => {
    const page = read("app/(dashboard)/rfq/page.tsx");
    expect(page).toContain("logRfqClarification(supabase, rfq.id, subject, body)");
    expect(page).not.toMatch(/from\("email_history"\)\.insert/);
    expect(page).not.toMatch(/from\("rfqs"\)\.update/);
  });

  it("every hint 110 raises has a fixed message in lib/friendly-error.ts", () => {
    const hints = [...read("supabase/migrations/110_rfq_clarification_atomic.sql").matchAll(/HINT = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(hints.sort()).toEqual(["rfq_email_subject", "rfq_no_email", "rfq_not_allowed", "rfq_not_found"]);
    for (const hint of hints) expect(friendlyError({ code: "XX000", message: "relation rfqs", hint })).not.toBe("Something went wrong. Try again.");
  });
});
