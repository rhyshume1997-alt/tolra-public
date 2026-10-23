import { describe, expect, it } from "vitest";

import { describeEntry, type ActivityEntry } from "@/lib/activity";
import { UNKNOWN, cleanName, lineText, peopleMap, personName, whoWhenLines } from "@/lib/people";

const people = peopleMap([
  { user_id: "u-admin", display_name: "Ada Admin" },
  { user_id: "u-shop", display_name: "  Sam Shop " },
  { user_id: "u-mail", display_name: "sam@example.test" },
  { user_id: "u-blank", display_name: null },
]);

describe("display names", () => {
  it("keeps real names, trims them, and refuses anything that looks like an e-mail address", () => {
    expect(cleanName("Ada Admin")).toBe("Ada Admin");
    expect(cleanName("  Sam Shop ")).toBe("Sam Shop");
    expect(cleanName("sam@example.test")).toBeNull();
    expect(cleanName("")).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName("x".repeat(200))?.length).toBe(80);
  });

  it("builds the people map from company_people rows and ignores anything else", () => {
    expect(people).toEqual({ "u-admin": "Ada Admin", "u-shop": "Sam Shop", "u-mail": null, "u-blank": null });
    expect(peopleMap(null)).toEqual({});
    expect(peopleMap([null, 3, { user_id: 5 }])).toEqual({});
  });

  it("shows a dash for anyone it can't name: no id, a stranger, no name on file, or a name that was an e-mail", () => {
    expect(personName(people, "u-admin")).toBe("Ada Admin");
    for (const id of [null, undefined, "", "someone-else", "u-blank", "u-mail", 7]) expect(personName(people, id)).toBe(UNKNOWN);
    expect(UNKNOWN).toBe("—");
  });
});

describe("who and when lines", () => {
  const at = "2026-10-12T09:30:00Z";

  it("a job: created, started, finished and inspected, each with its person and time; steps not yet taken have no line", () => {
    const lines = whoWhenLines("jobs", { created_by: "u-admin", created_at: at, started_by: "u-shop", started_at: at }, people);
    expect(lines.map((l) => l.key)).toEqual(["created", "started"]);
    const all = whoWhenLines("jobs", { created_by: "u-admin", created_at: at, started_by: "u-shop", started_at: at, finished_by: "u-shop", finished_at: at, inspected_by_user: "u-admin", inspected_at: at }, people);
    expect(all.map((l) => `${l.label} ${l.name}`)).toEqual(["Created by Ada Admin", "Started by Sam Shop", "Finished by Sam Shop", "Inspected by Ada Admin"]);
    expect(lineText(all[1])).toMatch(/^Started by Sam Shop · 12\/10\/2026, 10:30$/);
  });

  it("nothing is invented: an unrecorded person is a dash, an unrecorded time is left off", () => {
    const [created, started] = whoWhenLines("jobs", { created_by: null, created_at: null, started_by: null, started_at: at }, people);
    expect(lineText(created)).toBe("Created by —");
    expect(lineText(started)).toMatch(/^Started by — · /);
  });

  it("a job inspected before 035 uses the typed inspector name only when it is a name", () => {
    expect(whoWhenLines("jobs", { inspected_at: at, inspected_by: "Dave" }, people).at(-1)?.name).toBe("Dave");
    expect(whoWhenLines("jobs", { inspected_at: at, inspected_by: "dave@example.test" }, people).at(-1)?.name).toBe(UNKNOWN);
    expect(whoWhenLines("jobs", { inspected_at: at, inspected_by: "Inspector" }, people).at(-1)?.name).toBe(UNKNOWN); // the placeholder for no name
    expect(whoWhenLines("jobs", { inspected_at: at, inspected_by: "Dave", inspected_by_user: "u-admin" }, people).at(-1)?.name).toBe("Ada Admin");
  });

  it("a quote: created, sent, accepted", () => {
    const lines = whoWhenLines("quotes", { created_by: "u-admin", created_at: at, status: "accepted", sent_by: "u-admin", sent_at: at, accepted_by: null, accepted_at: at }, people);
    expect(lines.map((l) => l.label)).toEqual(["Created by", "Sent by", "Accepted by"]);
    expect(whoWhenLines("quotes", { status: "draft", created_by: "u-admin", created_at: at }, people)).toHaveLength(1);
  });

  it("a sales order, a purchase order and a credit note", () => {
    expect(whoWhenLines("sales_orders", { status: "open", created_by: "u-admin" }, people).map((l) => l.key)).toEqual(["created"]);
    expect(whoWhenLines("sales_orders", { status: "confirmed", confirmed_by: "u-shop", confirmed_at: at }, people).map((l) => l.key)).toEqual(["created", "confirmed"]);
    expect(whoWhenLines("purchase_orders", { received_by: "u-shop", received_at: at }, people).map((l) => l.label)).toEqual(["Created by", "Received by"]);
    expect(whoWhenLines("credit_notes", { status: "draft" }, people)).toHaveLength(1);
    expect(whoWhenLines("credit_notes", { status: "issued", issued_by: "u-admin", issued_at: at }, people).map((l) => l.label)).toEqual(["Created by", "Issued by"]);
  });

  it("an invoice: created, issued, each payment's recorder, and who cleared it; a draft has only its creation", () => {
    expect(whoWhenLines("invoices", { status: "draft", created_by: "u-admin" }, people).map((l) => l.key)).toEqual(["created"]);
    const lines = whoWhenLines(
      "invoices",
      { status: "paid", created_by: "u-admin", issued_by: "u-admin", issued_at: at, paid_by: "u-shop", paid_at: at },
      people,
      [{ created_by: "u-admin", created_at: at }, { created_by: "u-shop", created_at: at }, { created_by: "u-shop", created_at: at, reverses_payment_id: "p1" }],
    );
    expect(lines.map((l) => `${l.label} ${l.name}`)).toEqual(["Created by Ada Admin", "Issued by Ada Admin", "Payment recorded by Ada Admin", "Payment recorded by Sam Shop", "Paid (cleared) by Sam Shop"]);
    // An invoice issued before 035 still shows as issued, with no person and no time.
    expect(lineText(whoWhenLines("invoices", { status: "issued" }, people)[1])).toBe("Issued by —");
  });

  it("a delivery note keeps the customer's typed name apart from the staff member who recorded it", () => {
    const lines = whoWhenLines("delivery_notes", { status: "signed", created_by: "u-admin", despatched_by: "u-shop", despatched_at: at, signed_by_name: "J. Customer", signed_recorded_by: "u-admin", signed_at: at }, people);
    expect(lines.map((l) => l.label)).toEqual(["Created by", "Despatched by", "Signed by (customer)"]);
    expect(lineText(lines[2])).toMatch(/^Signed by \(customer\) J\. Customer \(recorded by Ada Admin\) · /);
    expect(lines[2].name).toBe("J. Customer");
    expect(whoWhenLines("delivery_notes", { status: "awaiting" }, people)).toHaveLength(1);
    expect(lineText(whoWhenLines("delivery_notes", { status: "signed", signed_at: at }, people)[1])).toMatch(/^Despatched by —/);
  });

  it("an unknown record type has only its creation", () => {
    expect(whoWhenLines("customers", { created_by: "u-admin" }, people)).toHaveLength(1);
  });
});

describe("the activity panel's named events", () => {
  const entry = (action: string, metadata: Record<string, unknown>): ActivityEntry => ({
    id: "e", created_at: "2026-10-12T09:30:00Z", actor_name: "Ada Admin", action, entity_table: "quotes", entity_id: "1", changes: null, snapshot: null, metadata,
  });

  it("labels the new events and names the earlier sender on a re-send", () => {
    expect(describeEntry(entry("ISSUE", {})).title).toBe("Issued");
    expect(describeEntry(entry("CONFIRM", {})).title).toBe("Confirmed");
    expect(describeEntry(entry("CONFIRM_STILL_OWED", {})).title).toBe("Confirmed as still owed");
    expect(describeEntry(entry("MARK_PAID", {})).title).toBe("Marked as paid");
    expect(describeEntry(entry("RESEND", { previous_by: "u-shop", previous_at: "2026-10-01T09:00:00Z" }), people)).toEqual({ title: "Sent again", details: ["Previously sent by Sam Shop on 01/10/2026, 10:00"] });
    expect(describeEntry(entry("RESEND", { previous_by: "gone" }), people).details).toEqual(["Previously sent by —"]);
    expect(describeEntry(entry("REOPEN", { previous_finished_by: "u-admin", sign_off_withdrawn: true }), people)).toEqual({ title: "Reopened", details: ["Had been finished by Ada Admin", "Inspection sign-off withdrawn"] });
  });
});

describe("who and when lines: failed inspection and rework (migration 037)", () => {
  const t = (hour: string) => `2026-10-12T${hour}:00:00Z`;

  it("lists who failed the job, who started and finished the rework, and who scrapped what, in the order it happened", () => {
    const lines = whoWhenLines("jobs", { created_by: "u-admin", created_at: t("07"), started_by: "u-shop", started_at: t("08"), finished_by: "u-shop", finished_at: t("09"), inspected_by_user: "u-admin", inspected_at: t("15") }, people, [], {
      reworks: [{ id: "r1", raised_by: "u-admin", raised_at: t("10"), started_by: "u-shop", started_at: t("11"), finished_by: "u-shop", finished_at: t("14") }],
      scrap: [{ id: "s1", created_by: "u-shop", created_at: t("12"), quantity: 2 }],
    });
    expect(lines.map((l) => `${l.label} ${l.name}`)).toEqual([
      "Created by Ada Admin", "Started by Sam Shop", "Finished by Sam Shop", "Failed inspection by Ada Admin", "Rework started by Sam Shop",
      "Scrapped 2 by Sam Shop", "Rework finished by Sam Shop", "Inspected by Ada Admin",
    ]);
    expect(lineText(lines[5])).toMatch(/^Scrapped 2 by Sam Shop · 12\/10\/2026, 13:00$/);
  });

  it("an open rework has no finished line, and a job that never failed has none of these lines", () => {
    const open = whoWhenLines("jobs", { created_by: "u-admin", created_at: t("07") }, people, [], { reworks: [{ id: "r1", raised_by: "u-shop", raised_at: t("10") }] });
    expect(open.map((l) => l.key)).toEqual(["created", "failed-r1"]);
    expect(whoWhenLines("jobs", { created_by: "u-admin", created_at: t("07") }, people).map((l) => l.key)).toEqual(["created"]);
    // Nobody is invented: an unrecorded person is a dash.
    expect(lineText(whoWhenLines("jobs", {}, people, [], { reworks: [{ id: "r2", raised_by: null, raised_at: t("10") }] })[1])).toMatch(/^Failed inspection by — · /);
  });

  it("one failed inspection of two order lines is one line; a rework reopened for replacements says so", () => {
    const lines = whoWhenLines("jobs", { created_by: "u-admin", created_at: t("07") }, people, [], {
      reworks: [
        { id: "ra", inspection_id: "i1", raised_by: "u-admin", raised_at: t("10") },
        { id: "rb", inspection_id: "i1", raised_by: "u-admin", raised_at: t("10") },
        { id: "rc", inspection_id: "i2", follow_up_of: "ra", raised_by: "u-admin", raised_at: t("12") },
      ],
    });
    expect(lines.map((l) => `${l.label} ${l.name}`)).toEqual(["Created by Ada Admin", "Failed inspection by Ada Admin", "Replacements reopened by Ada Admin"]);
  });
});
