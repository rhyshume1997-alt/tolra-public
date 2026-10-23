import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { toDateInput } from "@/lib/dates";
import { AUDIT_ACTIONS, AUDIT_TABLES } from "@/lib/audit-contract";
import { expiredQuoteAuditEvent, expiredQuoteCheck, expiredQuoteWarning } from "@/lib/quote-expiry";

const TODAY = "2026-10-20";

describe("expiredQuoteWarning: the wording", () => {
  it("Send names the expiry date and how long ago", () => {
    expect(expiredQuoteWarning("sent", "2026-10-10", TODAY, "send")).toBe("This quote expired on 10/10/2026 (10 days ago). Prices may be out of date. Send anyway?");
  });

  it("Mark accepted asks 'Mark accepted anyway?'", () => {
    expect(expiredQuoteWarning("sent", "2026-10-10", TODAY, "accept")).toBe("This quote expired on 10/10/2026 (10 days ago). Prices may be out of date. Mark accepted anyway?");
  });

  it("says '1 day ago' for yesterday", () => {
    expect(expiredQuoteWarning("sent", "2026-10-19", TODAY, "send")).toBe("This quote expired on 19/10/2026 (1 day ago). Prices may be out of date. Send anyway?");
  });

  it("accepts a timestamp-shaped valid-until (the date part counts)", () => {
    expect(expiredQuoteWarning("sent", "2026-10-10T00:00:00+00:00", TODAY, "send")).toContain("expired on 10/10/2026 (10 days ago)");
  });
});

describe("expiredQuoteWarning: when it applies (the app's own expired definition)", () => {
  it.each([
    ["sent, valid until yesterday", "sent", "2026-10-19", true],
    ["sent, valid until today (valid on its last day)", "sent", TODAY, false],
    ["sent, valid until tomorrow", "sent", "2026-10-21", false],
    ["sent, no valid-until date", "sent", null, false],
    ["draft past its date", "draft", "2026-10-01", true],
    ["accepted past its date never expires", "accepted", "2026-10-01", false],
    ["rejected past its date never expires", "rejected", "2026-10-01", false],
    ["superseded past its date", "superseded", "2026-10-01", false],
  ] as const)("%s", (_name, status, validUntil, warns) => {
    expect(expiredQuoteWarning(status, validUntil, TODAY, "send") !== null).toBe(warns);
    expect(expiredQuoteWarning(status, validUntil, TODAY, "accept") !== null).toBe(warns);
  });

  it("uses the Europe/London date, as the page does: 23:30 UTC on 1 July is already 2 July in London", () => {
    const today = toDateInput(new Date("2026-07-01T23:30:00Z"));
    expect(today).toBe("2026-07-02");
    expect(expiredQuoteWarning("sent", "2026-07-01", today, "send")).toContain("expired on 01/07/2026 (1 day ago)");
  });
});

describe("the audit event for a confirmed expired quote", () => {
  const check = expiredQuoteCheck("sent", "2026-10-10", TODAY, "send")!;

  it("carries the action, the valid-until date and the days expired", () => {
    expect(check).toMatchObject({ validUntil: "2026-10-10", daysExpired: 10 });
    expect(expiredQuoteAuditEvent("QUO-0007", "send", check)).toEqual({ action: "SEND", entityTable: "quotes", entityId: "QUO-0007", metadata: { event: "EXPIRED_QUOTE_CONFIRMED", action: "send", validUntil: "2026-10-10", daysExpired: 10 } });
    expect(expiredQuoteAuditEvent("QUO-0007", "accept", check)).toMatchObject({ action: "ACCEPT", metadata: { event: "EXPIRED_QUOTE_CONFIRMED", action: "accept", validUntil: "2026-10-10", daysExpired: 10 } });
  });

  it("uses only an action and a table the audit log already accepts (no SQL needed)", () => {
    for (const action of ["send", "accept"] as const) {
      const event = expiredQuoteAuditEvent("QUO-0007", action, check);
      expect(AUDIT_ACTIONS).toContain(event.action);
      expect(AUDIT_TABLES).toContain(event.entityTable);
    }
  });

  it("a quote that has not expired has no check, so no event", () => {
    expect(expiredQuoteCheck("sent", TODAY, TODAY, "send")).toBeNull();
  });
});

describe("the Quotes page asks before Send and Mark accepted on an expired quote", () => {
  const page = readFileSync("app/(dashboard)/quotes/page.tsx", "utf8");

  it("every Send path goes through askToSend, which asks first", () => {
    expect(page).toMatch(/async function askToSend\(quote: QuoteRow, expiryConfirmed = false\)/);
    expect(page).toContain('expiredQuoteCheck(quote.rawStatus, quote.validUntil, toDateInput(new Date()), "send")');
  });

  it("Mark Accepted goes through askToAccept, which asks first", () => {
    expect(page).toContain("onClick={() => askToAccept(viewingQuote)}>Mark Accepted");
    expect(page).toContain('expiredQuoteCheck(quote.rawStatus, quote.validUntil, toDateInput(new Date()), "accept")');
  });

  it("confirming writes the audit event before carrying on; Cancel writes nothing", () => {
    expect(page).toContain("void auditEvent(expiredQuoteAuditEvent(ask.quote.ref, ask.action, ask.check));");
    expect(page).not.toMatch(/Cancel[^\n]*auditEvent/);
  });

  it("Cancel closes the question and does nothing else; the other button carries on", () => {
    expect(page).toContain("<Button variant=\"outline\" onClick={() => setExpiredAsk(null)}>Cancel</Button>");
    expect(page).toContain("void askToSend(ask.quote, true); else askToAccept(ask.quote, true);");
  });

  it("a draft past its date is still blocked with its own message", () => {
    expect(page).toContain("Edit the quote and set a new date before sending.");
  });
});
