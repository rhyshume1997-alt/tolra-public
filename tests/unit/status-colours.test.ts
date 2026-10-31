import { describe, expect, it } from "vitest";

import {
  COLOUR_CLASSES, COLOUR_TOKENS, STATUS_MAP, type StatusColour, type StatusKey,
  deliveryNoteStatusKey, emailStatusKey, invoiceStatusKey, purchaseOrderStatusKey, quoteStatusKey, salesOrderStatusKey, statusColourClasses,
} from "@/lib/status-colours";

/** The agreed system, written out independently of the map: status -> [colour, word]. */
const AGREED: Record<StatusKey, [StatusColour, string]> = {
  complete: ["green", "Complete"], accepted: ["green", "Accepted"], passed: ["green", "Passed"], paid: ["green", "Paid"], on_track: ["green", "On time"], delivered: ["green", "Delivered"],
  at_risk: ["yellow", "At risk"], awaiting_inspection: ["yellow", "Waiting for inspection"], part_paid: ["yellow", "Part paid"],
  conditional_supplier: ["yellow", "Conditional supplier"], waiting_on_supplier: ["yellow", "Waiting on supplier"], waiting_on_customer: ["yellow", "Waiting on customer"],
  overdue: ["red", "Overdue"], blocked_supplier: ["red", "Blocked supplier"], sync_failed: ["red", "Sync failed"], failed_inspection: ["red", "Failed inspection"],
  // 117: a problem an operator reported on a job (My jobs, the Job Board).
  problem: ["red", "Problem"],
  active: ["blue", "Active"], in_progress: ["blue", "Running"], sent: ["blue", "Sent"], issued: ["blue", "Issued"], sync_pending: ["blue", "Sync pending"],
  rework: ["purple", "Rework"],
  draft: ["grey", "Draft"], not_started: ["grey", "Not started"], no_due_date: ["grey", "No due date"], archived: ["grey", "Archived"], void: ["grey", "Void"], cancelled: ["grey", "Cancelled"],
};

const TOKENS: Record<StatusColour, [string, string]> = {
  green: ["#16A34A", "#4ADE80"], yellow: ["#CA8A04", "#FACC15"], red: ["#DC2626", "#F87171"],
  blue: ["#2563EB", "#60A5FA"], purple: ["#7C3AED", "#C4B5FD"], grey: ["#6B7280", "#9CA3AF"],
};

describe("status colour map", () => {
  it("holds exactly the agreed statuses, each with its colour and word", () => {
    expect(Object.keys(STATUS_MAP).sort()).toEqual(Object.keys(AGREED).sort());
    for (const [status, [colour, label]] of Object.entries(AGREED)) {
      expect(STATUS_MAP[status as StatusKey], status).toEqual({ colour, label });
    }
  });

  it("uses the exact light and dark colour tokens, and puts both in the badge and dot classes", () => {
    for (const [colour, [light, dark]] of Object.entries(TOKENS) as [StatusColour, [string, string]][]) {
      expect(COLOUR_TOKENS[colour]).toEqual({ light, dark });
      expect(COLOUR_CLASSES[colour].badge).toContain(`bg-[${light}]`);
      expect(COLOUR_CLASSES[colour].badge).toContain(`dark:bg-[${dark}]`);
      expect(COLOUR_CLASSES[colour].dot).toContain(`bg-[${light}]`);
      expect(COLOUR_CLASSES[colour].dot).toContain(`dark:bg-[${dark}]`);
    }
  });

  it("gives yellow a yellow fill with dark text in both modes, never yellow text", () => {
    const { badge } = COLOUR_CLASSES.yellow;
    expect(badge).toContain("text-slate-950");
    expect(badge).toContain("dark:text-slate-950");
    expect(badge).not.toMatch(/text-white|text-\[#|text-yellow/);
  });

  it("keeps rework purple only: no other status is purple, and rework is not red", () => {
    expect(Object.entries(STATUS_MAP).filter(([, v]) => v.colour === "purple").map(([k]) => k)).toEqual(["rework"]);
    expect(statusColourClasses("rework").badge).not.toBe(statusColourClasses("overdue").badge);
  });

  it("maps every status to a non-empty word, so a badge is never colour alone", () => {
    for (const entry of Object.values(STATUS_MAP)) expect(entry.label.trim().length).toBeGreaterThan(0);
  });
});

describe("page status words land on the map", () => {
  it("quotes: draft grey, sent blue, accepted green; rejected, expired, superseded are not agreed statuses", () => {
    expect(quoteStatusKey("draft")).toBe("draft");
    expect(quoteStatusKey("sent")).toBe("sent");
    expect(quoteStatusKey("accepted")).toBe("accepted");
    for (const other of ["rejected", "expired", "superseded", "", null]) expect(quoteStatusKey(other)).toBeNull();
  });

  it("sales orders, purchase orders, delivery notes and email", () => {
    expect([salesOrderStatusKey("open"), salesOrderStatusKey("confirmed"), salesOrderStatusKey("despatched"), salesOrderStatusKey("converted")]).toEqual(["active", "accepted", "sent", null]);
    expect([purchaseOrderStatusKey("draft"), purchaseOrderStatusKey("issued"), purchaseOrderStatusKey("sent"), purchaseOrderStatusKey("received"), purchaseOrderStatusKey("cancelled")]).toEqual(["draft", "issued", "sent", "delivered", "cancelled"]);
    expect([deliveryNoteStatusKey("draft"), deliveryNoteStatusKey("pending"), deliveryNoteStatusKey("despatched"), deliveryNoteStatusKey("delivered"), deliveryNoteStatusKey("signed")]).toEqual(["draft", "not_started", "sent", "delivered", "delivered"]);
    expect([emailStatusKey("drafted"), emailStatusKey("sent_manually"), emailStatusKey("sent_via_system"), emailStatusKey("failed")]).toEqual(["draft", "sent", "sent", null]);
  });

  it("invoices: paid green, part paid yellow, past due red, otherwise issued blue, closed ones grey", () => {
    const base = { status: "outstanding", rawStatus: "issued", partPaid: false, daysOverdue: -3 };
    expect(invoiceStatusKey({ ...base, status: "paid" })).toBe("paid");
    expect(invoiceStatusKey({ ...base, partPaid: true })).toBe("part_paid");
    expect(invoiceStatusKey({ ...base, status: "overdue", daysOverdue: 12 })).toBe("overdue");
    expect(invoiceStatusKey(base)).toBe("issued");
    expect(invoiceStatusKey({ ...base, status: "closed", rawStatus: "draft" })).toBe("draft");
    expect(invoiceStatusKey({ ...base, status: "closed", rawStatus: "void" })).toBe("void");
    expect(invoiceStatusKey({ ...base, status: "closed", rawStatus: "cancelled" })).toBe("cancelled");
    expect(invoiceStatusKey({ ...base, status: "closed", rawStatus: "credited" })).toBeNull();
    expect(invoiceStatusKey({ ...base, status: "unverified" })).toBeNull();
  });
});

describe("the sync chip (top bar)", () => {
  it("changes waiting to upload are blue, the map's sync pending colour; the words stay '1 to upload'", async () => {
    const { SYNC_TONE } = await import("@/components/sync-status");
    const { syncIndicator } = await import("@/lib/sync-status");
    const state = syncIndicator({ offline: false, browserOnline: true, pending: 1, held: 0 });
    expect(state.short).toBe("1 to upload");
    expect(STATUS_MAP.sync_pending.colour).toBe("blue");
    expect(SYNC_TONE[state.tone]).toBe(`text-[${COLOUR_TOKENS.blue.light}] dark:text-[${COLOUR_TOKENS.blue.dark}]`);
  });
});
