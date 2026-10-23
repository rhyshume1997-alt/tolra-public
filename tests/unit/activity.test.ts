import { describe, expect, it } from "vitest";

import { actorLabel, describeChanges, describeEntry, describeGroup, groupEntries, isHiddenField, recordLabel, type ActivityEntry } from "@/lib/activity";
import { memberLabel } from "@/lib/people";

const base = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: Math.random().toString(36), created_at: "2026-10-09T07:00:00Z", actor_name: "Alice", actor_email: "a@x", action: "UPDATE",
  entity_table: "quotes", entity_id: "1", changes: null, snapshot: null, metadata: null, ...over,
});

describe("activity descriptions", () => {
  it("names status changes", () => {
    const entry = base({ changes: { status: { from: "draft", to: "sent" }, sent_at: { from: null, to: "2026-10-09T07:00:00+00:00" } } });
    const { title, details } = describeEntry(entry);
    expect(title).toBe("Status changed to sent");
    expect(details[0]).toMatch(/^Sent \(/);
  });
  it("describes drawings, checklist and sign-off on a job", () => {
    const lines = describeChanges({
      drawings: { added: ["org/job/part-12.pdf"], removed: [] },
      checklist: { changed: true, keys: ["deburr"] },
      signed_off_by: { from: null, to: "Dave" },
      finished_at: { from: null, to: "2026-10-09T08:00:00+00:00" },
    });
    expect(lines).toContain("Drawing added: part-12.pdf");
    expect(lines).toContain("Checklist updated: Deburr");
    expect(lines).toContain("Signed off by Dave");
    expect(lines.some((l) => l.startsWith("Job completed"))).toBe(true);
  });
  it("labels field edits with before and after", () => {
    expect(describeChanges({ due_date: { from: "2026-10-01", to: "2026-10-15" } })).toEqual(["Due date: 01/10/2026 → 15/10/2026"]);
    expect(describeChanges({ customer_notes: { from: null, to: "Thanks" } })).toEqual(["Notes to customer: Thanks"]);
    expect(describeEntry(base({ changes: { total_value: { from: 100, to: 120 } } })).title).toBe("Value: 100 → 120");
  });
  it("reads a booking's day plan as dates with start and end times", () => {
    const plan = [{ date: "2026-10-10", start: "05:00", end: "13:00" }, { date: "2026-10-12", start: "22:00", end: "24:00" }];
    expect(describeChanges({ day_plan: { from: null, to: plan } })).toEqual(["Split by day: 10/10/2026 05:00-13:00, 12/10/2026 22:00-24:00"]);
    expect(describeChanges({ day_plan: { added: [plan[0]], removed: [] } })).toEqual(["Split by day added: 10/10/2026 05:00-13:00"]);
    expect(describeChanges({ day_plan: { added: ['{"date": "2026-10-10", "start": "05:00", "end": "13:00"}'], removed: [] } })).toEqual(["Split by day added: 10/10/2026 05:00-13:00"]);
    expect(describeChanges({ day_plan: { from: null, to: JSON.stringify(plan) } })).toEqual(["Split by day: 10/10/2026 05:00-13:00, 12/10/2026 22:00-24:00"]);
  });

  it("reads a booking's day plan as hours on dates, not as objects", () => {
    const plan = [{ date: "2026-10-10", hours: 6 }, { date: "2026-10-11", hours: 2 }];
    expect(describeChanges({ day_plan: { from: null, to: plan } })).toEqual(["Split by day: 6h on 10/10/2026, 2h on 11/10/2026"]);
    expect(describeChanges({ day_plan: { added: [plan[1]], removed: [] } })).toEqual(["Split by day added: 2h on 11/10/2026"]);
  });
  it("reads day plan elements that come from the database as JSON text", () => {
    const text = ['{"date": "2026-10-10", "hours": 3.5}', '{"date": "2026-10-11", "hours": 2}'];
    expect(describeChanges({ day_plan: { added: [text[0]], removed: [] } })).toEqual(["Split by day added: 3.5h on 10/10/2026"]);
    expect(describeChanges({ day_plan: { from: null, to: text } })).toEqual(["Split by day: 3.5h on 10/10/2026, 2h on 11/10/2026"]);
    expect(describeChanges({ day_plan: { from: null, to: JSON.stringify([{ date: "2026-10-10", hours: 3.5 }]) } })).toEqual(["Split by day: 3.5h on 10/10/2026"]);
    expect(describeChanges({ day_plan: { added: ["{not json"], removed: [] } })).toEqual(["Split by day added: {not json"]);
  });
  it("describes creation, files and app events", () => {
    expect(describeEntry(base({ action: "INSERT", snapshot: { quote_ref: "Q-1", customer: "Acme" } })).title).toBe("Quote created");
    expect(describeEntry(base({ action: "INSERT", entity_table: "quote_attachments", snapshot: { file_name: "drawing.pdf" } })).title).toBe("File added: drawing.pdf");
    expect(describeEntry(base({ action: "SEND_TO_WORKSHOP", entity_table: "jobs", metadata: { recipient: "shop@x" } }))).toEqual({ title: "Sent to the workshop", details: ["To shop@x"] });
  });
  it("groups the line rows of one save into a single entry", () => {
    const at = "2026-10-09T09:00:00Z";
    const rows = [
      base({ action: "INSERT", entity_table: "quote_line_items", created_at: at, snapshot: { description: "Bracket", quantity: 2, unit_price: 10 } }),
      base({ action: "INSERT", entity_table: "quote_line_items", created_at: at, snapshot: { description: "Plate", quantity: 1, unit_price: 5 } }),
      base({ action: "DELETE", entity_table: "quote_line_items", created_at: at, snapshot: { description: "Old" } }),
      base({ action: "UPDATE", created_at: at, changes: { status: { from: "draft", to: "sent" } } }),
    ];
    const groups = groupEntries(rows);
    expect(groups).toHaveLength(2);
    expect(describeGroup(groups[0]).title).toBe("Lines updated (2 added, 1 removed)");
    expect(describeGroup(groups[0]).details).toEqual(["Line added: Bracket", "Line added: Plate"]);
  });
});

describe("rework events (migration 037)", () => {
  const job = (action: string, metadata: Record<string, unknown>) => describeEntry(base({ action, entity_table: "jobs", metadata }));

  it("names a failed inspection with its reason, quantity and instructions", () => {
    expect(job("FAIL_INSPECTION", { reason: "Bore oversize", quantity: 4, all_of_job: false, instructions: "Re-bore 4 off" })).toEqual({
      title: "Failed inspection: sent to rework",
      details: ["Reason: Bore oversize", "Quantity: 4 affected", "Instructions: Re-bore 4 off", "Assigned to the workshop"],
    });
    expect(job("FAIL_INSPECTION", { reason: "Burr", quantity: 10, all_of_job: true }).details).toContain("Quantity: All of the job (10)");
  });

  it("names the order lines and batches that failed, and a rework reopened for the replacements still to make", () => {
    expect(job("FAIL_INSPECTION", { reason: "Bore oversize", quantity: 5, all_of_job: false, instructions: "Re-bore", batch: null,
      lines: [{ line: "Part A", quantity: 3, batch: "B-12" }, { line: "Part B", quantity: 2, batch: null }] }).details).toEqual([
      "Reason: Bore oversize", "Quantity: 5 affected", "Failed: Part A: 3 (batch B-12)", "Failed: Part B: 2", "Instructions: Re-bore", "Assigned to the workshop"]);
    expect(job("FAIL_INSPECTION", { reason: "Burr", quantity: 4, all_of_job: false, batch: "Heat 4471" }).details).toContain("Batch: Heat 4471");
    expect(job("REOPEN_REWORK", { quantity: 2, line: "Part A", batch: "B-7", instructions: "Make 2 off" })).toEqual({
      title: "Rework reopened for the replacements still to make",
      details: ["To make: 2 of Part A (batch B-7)", "Instructions: Make 2 off", "Assigned to the workshop; released only after they pass inspection"],
    });
  });

  it("names the rework steps, scrap and the remaining quantity; money is only shown when the history carries it", () => {
    expect(job("START_REWORK", { quantity: 4 })).toEqual({ title: "Rework started", details: ["Quantity: 4"] });
    expect(job("SCRAP", { quantity: 2, reason: "Cracked", remaining_to_make: 2 })).toEqual({ title: "Parts scrapped", details: ["Scrapped 2: Cracked", "Remaining to make: 2"] });
    expect(job("RECORD_REWORK_COST", { hours: 1.5, material: "EN8 bar", material_cost: 12.5 }).details).toEqual(["1.5 h worked", "Material: EN8 bar", "Material cost £12.50"]);
    expect(job("RECORD_REWORK_COST", { hours: 1.5, material: "EN8 bar" }).details).toEqual(["1.5 h worked", "Material: EN8 bar"]);
    expect(job("FINISH_REWORK", { rework_hours: 3.5, quantity_scrapped: 2 })).toEqual({ title: "Rework finished: awaiting re-inspection", details: ["3.5 h of rework in all", "2 scrapped and remade"] });
    expect(job("INSPECT_JOB", { result: "pass", release_decision: "released", after_rework: true }).details).toContain("Inspected again after rework");
  });
});

describe("operator sign-off (migration 045)", () => {
  it("names the revision signed, without the worksheet hash", () => {
    const entry = base({ action: "JOB_SIGN_OFF", entity_table: "jobs", metadata: { source: "write_audit", job_no: "J-1", worksheet_version: 2, snapshot_sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" } });
    // The hash stays on the sign-off itself; the history never shows hashes (go-live polish item 16).
    expect(describeEntry(entry)).toEqual({ title: "Signed off (revision 2)", details: [] });
    expect(describeEntry(base({ action: "JOB_SIGN_OFF", entity_table: "jobs", metadata: {} })).title).toBe("Signed off");
    expect(describeGroup([entry]).title).toBe("Signed off (revision 2)");
  });
});

describe("readable history (go-live polish item 16)", () => {
  const dave = "cabd4289-1111-4222-8333-944455556666";
  const nameless = "0b0b0b0b-1111-4222-8333-944455556666";
  const people = { [dave]: "Dave", [nameless]: null };

  it("a run ending reads as words: who by name, why in words, no op id", () => {
    const entry = base({ entity_table: "machine_runs", changes: {
      ended_at: { from: null, to: "2026-10-09T10:00:00+00:00" },
      end_reason: { from: null, to: "paused" },
      ended_by: { from: null, to: dave },
      ended_op_id: { from: null, to: "9f9f9f9f-1111-4222-8333-944455556666" },
    } });
    const { title, details } = describeEntry(entry, people);
    expect(title).toBe("Machine run ended: Paused");
    expect(details).toContain("Ended by Dave");
    expect(details.some((line) => /op id|Ended op|cabd4289|9f9f9f9f|empty/i.test(line))).toBe(false);
    expect(describeEntry(base({ entity_table: "bench_runs", changes: { end_reason: { from: null, to: "to_machine" } } })).title).toBe("Bench run ended: Moved onto a machine");
    expect(describeChanges({ end_reason: { from: "paused", to: "finished" } })).toEqual(["Ended because: Paused → Finished"]);
  });

  it("people are named from the company list, '—' without a usable name, never an id", () => {
    expect(describeChanges({ assigned_to: { from: null, to: nameless } }, people)).toEqual(["Assigned to —"]);
    expect(describeChanges({ operator_id: { from: dave, to: nameless } }, people)).toEqual(["Operator: Dave → —"]);
    expect(describeChanges({ assigned_to: { from: dave, to: null } }, people)).toEqual(["Assigned to: cleared"]);
    // Someone outside the list (or the list not loaded): "—", not the id.
    expect(describeChanges({ ended_by: { from: null, to: "77777777-1111-4222-8333-944455556666" } })).toEqual(["Ended by —"]);
  });

  it("internal ids, op ids and hashes are left out; links to other records too", () => {
    for (const key of ["ended_op_id", "client_op_id", "booking_id", "machine_id", "snapshot_sha256", "record_sha256", "organization_id", "id"]) expect(isHiddenField(key), key).toBe(true);
    for (const key of ["ended_by", "operator_id", "status", "end_reason"]) expect(isHiddenField(key), key).toBe(false);
    expect(describeChanges({ override_of: { from: null, to: dave }, booking_id: { from: null, to: dave }, record_sha256: { from: null, to: "ab".repeat(32) } })).toEqual([]);
  });

  it("the actor is the display name, else a usable trail name, else '—'; never an e-mail, never 'Someone'", () => {
    expect(actorLabel({ actor_user_id: dave, actor_name: null }, people)).toBe("Dave");
    expect(actorLabel({ actor_user_id: nameless, actor_name: null }, people)).toBe("—");
    expect(actorLabel({ actor_user_id: nameless, actor_name: "dave@example.test" }, people)).toBe("—");
    expect(actorLabel({ actor_user_id: null, actor_name: "System" }, people)).toBe("System");
    expect(actorLabel({ actor_name: "Alice" })).toBe("Alice");
    expect(actorLabel({ actor_name: null })).toBe("—");
  });

  it("the person filter names members by name or username, never by e-mail", () => {
    expect(memberLabel({ full_name: "Dave Smith", username: "dave" })).toBe("Dave Smith");
    expect(memberLabel({ full_name: "", username: "dave" })).toBe("dave");
    expect(memberLabel({ full_name: "dave@example.test", username: null })).toBe("—");
  });
});

describe("recordLabel (the number shown on an Activity line)", () => {
  it("keeps the database's label when there is one", () => {
    expect(recordLabel(base({ entity_table: "jobs", record_table: "jobs", record_label: "J-0010", metadata: { quote_ref: "QUO-0009" } }))).toBe("J-0010");
  });
  it("names a quote's Accept (a named event, no row data) by the quote's own number, not the order or job it made", () => {
    const accept = base({ action: "ACCEPT", entity_table: "quotes", record_table: "quotes", record_label: null,
      metadata: { quote_ref: "QUO-0009", so_number: "SO-0002", job_no: "J-0010", so_created: true } });
    expect(recordLabel(accept)).toBe("QUO-0009");
  });
  it("uses only the record's own kind of number from the metadata", () => {
    expect(recordLabel(base({ action: "CONFIRM", entity_table: "sales_orders", record_label: null, metadata: { so_number: "SO-0002", quote_ref: "QUO-0009" } }))).toBe("SO-0002");
    expect(recordLabel(base({ action: "REOPEN", entity_table: "jobs", record_label: null, metadata: { quote_ref: "QUO-0009" } }))).toBeNull();
    expect(recordLabel(base({ action: "ISSUE", entity_table: "credit_notes", record_label: null, metadata: { credit_ref: " CRD-0001 " } }))).toBe("CRD-0001");
    expect(recordLabel(base({ action: "SEND", entity_table: "customers", record_label: null, metadata: { quote_ref: "QUO-0009" } }))).toBeNull();
    expect(recordLabel(base({ action: "ACCEPT", entity_table: "quotes", record_label: null, metadata: null }))).toBeNull();
  });
});
