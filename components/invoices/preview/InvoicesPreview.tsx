"use client";

/**
 * BOUNDARY (Invoices module 4, PREVIEW ONLY, v2 = shared UI v4 plus the owner-approved structural items 1, 2, 4, 7, 9, 10, 11). Inputs: none from the server. Everything
 * shown is fictional sample data (26 invoices, as of 20/11/2026) held in this file, plus the person's clicks. Outputs: an Invoicing list look-and-feel prototype (money
 * dashboard with one primary figure and quiet ageing, late payer patterns, invoicing trends, a one-row toolbar with Show, a Filters (n) popover, Export, Columns, Compact list
 * and Cards / List / Table, removable active-filter chips, the sticky selection bar with Export and Pay Selected in Full once a row is ticked, one primary action plus More per
 * row, the invoice sheet and every confirmation the real page has) whose only state is LOCAL UI state. It never reads or writes Supabase,
 * calls no server action, API route, payment, Xero or accounting integration, and no action ever reports success: every action that would issue,
 * send, record a payment, reverse, void, write off, archive, chase, save or export answers with the neutral "Preview only" toast and nothing changes.
 * Run-time imports from lib/ are PURE modules only (money, receivables, payments, dates, invoice-ref, invoice-phase-filters, range-label,
 * document-integrity, vat, status-colours, empty-hints): none of them reaches Supabase. Logic that lives in a module that does (archive phaseOf,
 * list-filter, invoice-void, invoice-write-off, invoice-list-totals) is mirrored here and pinned to the real function by tests/unit/invoicesPreview.test.ts.
 * MUST NOT CHANGE: wording, defaults, column order, filter semantics, money rules and the role gate mirror today's Invoicing page
 * (app/(dashboard)/invoices/page.tsx: admin and office only; workshop and viewer see "Access Denied"). Every real control stays reachable (rowActionPlan proves the row
 * ones). Do not wire this file to real data or real actions, add no control the real page lacks (no search box, no sort), and keep row controls at a 48 px hit area.
 * No !important and no override of a shared component's own classes: tune by token or prop only.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Button, Callout, Checkbox, ChipGroup, DateRangeGroup, Dialog, Disclosure, EmptyState, ErrorSummary, FailedState, Field, FilterChip, Input, List, ListRow, LoadingState, Menu, PageHeader, Panel,
  Popover, PreviewBar, ScrollTable, SegmentedControl, Select, SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, cx, premiumTokens, rowClickIsForRow, srOnly,
  tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate } from "@/lib/dates";
import { totalsMismatch } from "@/lib/document-integrity";
import { invoicesEmptyHint } from "@/lib/empty-hints";
import { isFinalInvoice, chipsForPhase } from "@/lib/invoice-phase-filters";
import { INVOICE_SHOW_NOTE, raisedCaption } from "@/lib/range-label";
import { draftKey, shownInvoiceRef } from "@/lib/invoice-ref";
import { documentTotals, fromPence, gbp, toPence, vatRowLabel } from "@/lib/money";
import type { DocumentTotals } from "@/lib/money";
import { PAYMENT_METHODS, netPaid, paymentAmountProblem, paymentDateProblem, paymentsEmptyText } from "@/lib/payments";
import {
  DRAFT_PAYMENT_REASON, balanceDue, customerCredit, daysPastDue, invoiceDetailStatusLabel, invoiceLifecycle, invoiceStatus, isPartPaid, isRaised, paidOnTime,
  paidOnTimeNote, paymentBlockedReason,
} from "@/lib/receivables";
import { invoiceStatusKey } from "@/lib/status-colours";
import { VAT_CHOICES, VAT_CHOICE_LABELS, fromVatChoice } from "@/lib/vat";
import type { VatChoice } from "@/lib/vat";

import s from "./InvoicesPreview.module.css";

/* ================================================================== */
/* 1. Types and constants                                              */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type PhaseValue = "open" | "done" | "archived" | "all";
export type Phase = "open" | "done" | "archived";
export type Screen = "ready" | "loading" | "error" | "empty";
export type ListFilterKey = "overdue" | "draft-old";
export type ColumnKey = "invoice" | "customer" | "status" | "amount";
export type ChipKey = "all" | "overdue" | "outstanding" | "partial" | "paid" | "closed";
export type ShownStatus = "overdue" | "outstanding" | "paid" | "closed" | "unverified";

/** The sample's "today" (kept fixed so the figures never drift): due dates, ageing and the archive rule are worked out against it. */
export const TODAY = "2026-11-20";
export const ARCHIVE_MONTHS = 12;
/** lib/attention-items DRAFT_INVOICE_DAYS (mirrored: that module reaches Supabase; the test pins it). */
export const DRAFT_INVOICE_DAYS = 2;
export const DRAFT_INVOICE_RULE_TITLE = `Draft invoices over ${DRAFT_INVOICE_DAYS} days old (newer drafts are on Invoicing)`;
export const INVOICE_FILTER_LABELS: Record<ListFilterKey, string> = { overdue: "Overdue invoices", "draft-old": DRAFT_INVOICE_RULE_TITLE };
export const UNCERTAIN_MESSAGE = "We couldn't confirm whether this payment was saved: it may have been. Press Check and save to find out. The same payment is never recorded twice.";

export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "invoice", label: "Invoice", locked: true }, { key: "customer", label: "Customer" }, { key: "status", label: "Status" }, { key: "amount", label: "Amount" },
];
export const CHIPS: Array<{ v: ChipKey; label: string }> = [
  { v: "all", label: "All" }, { v: "overdue", label: "Overdue" }, { v: "outstanding", label: "Outstanding" }, { v: "partial", label: "Part paid" }, { v: "paid", label: "Paid" }, { v: "closed", label: "Draft / void" },
];
/** lib/status-colours invoiceStatusKey -> the shared badge tone (green paid, yellow part paid, red overdue, blue issued, grey draft / void / cancelled). */
const KEY_TONE: Record<string, StatusTone> = { paid: "ok", part_paid: "warn", overdue: "danger", issued: "info", draft: "neutral", void: "neutral", cancelled: "neutral" };

export type SeedLine = { description: string; quantity: number; unitPrice: number; vatPct: number; vatExempt?: boolean };
export type SeedPayment = { id: string; amount: number; paidOn: string; method: string; reference: string; by: string; reversesPaymentId?: string | null; voidReason?: string; source?: "recorded" | "legacy" };
export type SeedCreditNote = { ref: string | null; date: string; total: number; allocated: number; status: "draft" | "issued" };
export type SeedInvoice = {
  id: string; reference: string; unnumbered?: boolean; createdAt: string; customer: string; rawStatus: string; date: string; dueDate?: string; terms: string;
  quoteRef?: string; customerPo?: string; carriage: number; vatEnabled: boolean; carriageVat: boolean; credited: number; refunded: number; amountPaid: number;
  paidAt?: string; sentAt?: string; paymentUnverified?: boolean; paymentClaimedAt?: string | null; invoiceNote?: string; deliveryAddress?: string; manual?: "archived" | "active";
  lines: SeedLine[]; payments?: SeedPayment[]; creditNotes?: SeedCreditNote[]; deliveryNotes?: Array<{ ref: string; date: string; status: string }>;
  jobStage?: string; autoDraftedFrom?: string; chasePaused?: { reason: string; until?: string }; storedTotal?: number;
};
export type InvoiceRow = SeedInvoice & {
  amount: number; subtotal: number; vatAmount: number;
  status: ShownStatus; daysOverdue: number; balance: number; partPaid: boolean;
};

export const CUSTOMER_ADDRESS: Record<string, string[]> = {
  "Kilbride Hydraulics": ["Unit 4, Peel Park", "East Kilbride", "G74 5PB"], "Solway Marine Engineering": ["Whitesands Works", "Dumfries", "DG1 2RS"], "Carronside Automation": ["12 Carron Road", "Falkirk", "FK2 7XQ"],
  "Ashby Rail Services": ["Depot Road", "Ashby-de-la-Zouch", "LE65 2UB"], "Kestrel Components": ["Kestrel House, Mill Street", "Stroud", "GL5 3AD"], "Pemberton Packaging": ["Pemberton Mill", "Wigan", "WN3 4HT"],
  "Ardmore Precision": ["8 Ardmore Way", "Glenrothes", "KY6 2NQ"], "Wren & Calder": ["Calder Works", "Halifax", "HX1 5PQ"], "Brightwell Valves": ["Brightwell Estate", "Swindon", "SN2 8QA"], "Northgate Fabrication": ["Northgate Yard", "Lincoln", "LN1 3DE"],
};

/* ================================================================== */
/* 2. Sample data (fictional)                                          */
/* ================================================================== */

const L = (description: string, quantity: number, unitPrice: number, vatPct = 20, vatExempt = false): SeedLine => ({ description, quantity, unitPrice, vatPct, vatExempt });
const P = (id: string, amount: number, paidOn: string, method: string, reference: string, extra: Partial<SeedPayment> = {}): SeedPayment => ({ id, amount, paidOn, method, reference, by: "Fiona MacLeod", source: "recorded", ...extra });

export const SEED_INVOICES: SeedInvoice[] = [
  { id: "i-d1", reference: draftKey("i-d1"), unnumbered: true, createdAt: "2026-11-19T10:12:00Z", customer: "Kilbride Hydraulics", rawStatus: "draft", date: "2026-11-19", dueDate: "2026-12-19", terms: "30 days", customerPo: "KH-41102", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0,
    lines: [L("Manifold block, machined and anodised", 40, 86.5), L("First-off inspection report", 1, 120)], jobStage: "Draft, awaiting inspection" },
  { id: "i-d2", reference: draftKey("i-d2"), unnumbered: true, createdAt: "2026-11-16T14:40:00Z", customer: "Solway Marine Engineering", rawStatus: "draft", date: "2026-11-16", dueDate: "2026-12-16", terms: "30 days", carriage: 12.5, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0,
    lines: [L("Deck cleat 250 mm, 316 stainless", 24, 64), L("Backing plate, laser cut", 24, 11.75)], jobStage: "Ready to issue", autoDraftedFrom: "DLN-0211", deliveryNotes: [{ ref: "DLN-0211", date: "2026-11-16", status: "despatched" }] },
  { id: "i-d3", reference: draftKey("i-d3"), unnumbered: true, createdAt: "2026-11-18T09:05:00Z", customer: "Kestrel Components", rawStatus: "draft", date: "2026-11-18", dueDate: "2026-12-18", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0,
    lines: [L("Sensor housing, turned and milled", 250, 14.2), L("Anodise, black", 250, 2.35)], autoDraftedFrom: "DLN-0209", deliveryNotes: [{ ref: "DLN-0209", date: "2026-11-18", status: "despatched" }] },
  { id: "i-48", reference: "INV-1048", createdAt: "2026-11-17T08:00:00Z", customer: "Ashby Rail Services", rawStatus: "issued", date: "2026-11-17", dueDate: "2026-12-17", terms: "30 days", quoteRef: "QUO-0436", customerPo: "ARS-20799", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-11-17T09:30:00Z",
    lines: [L("Brake bracket weldment", 120, 38.4), L("Paint, RAL 7016", 120, 4.1)], deliveryNotes: [{ ref: "DLN-0206", date: "2026-11-16", status: "delivered" }] },
  { id: "i-47", reference: "INV-1047", createdAt: "2026-11-12T08:00:00Z", customer: "Northgate Fabrication", rawStatus: "sent", date: "2026-11-12", dueDate: "2026-12-12", terms: "30 days", quoteRef: "QUO-0434", customerPo: "NF-88213", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-11-12T11:00:00Z",
    lines: [L("Guard frame, 40 x 40 box section", 8, 412), L("Fixings and finishing", 1, 140)], deliveryAddress: "Northgate Yard\nGoods inward, Bay 3\nLincoln LN1 3DE" },
  { id: "i-46", reference: "INV-1046", createdAt: "2026-11-10T08:00:00Z", customer: "Ardmore Precision", rawStatus: "sent", date: "2026-11-10", dueDate: "2026-11-24", terms: "14 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-11-10T10:00:00Z",
    lines: [L("Calibration fixture, ground", 4, 640), L("Inspection and certification", 4, 85)] },
  { id: "i-45", reference: "INV-1045", createdAt: "2026-11-06T08:00:00Z", customer: "Brightwell Valves", rawStatus: "sent", date: "2026-11-06", dueDate: "2026-11-20", terms: "14 days", carriage: 18, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-11-06T13:00:00Z",
    lines: [L("Valve body, 316 investment cast, finish machined", 80, 52.3)] },
  { id: "i-44", reference: "INV-1044", createdAt: "2026-10-30T08:00:00Z", customer: "Carronside Automation", rawStatus: "sent", date: "2026-10-30", dueDate: "2026-11-13", terms: "14 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-30T09:00:00Z", paymentClaimedAt: "2026-11-18T09:20:00Z",
    lines: [L("Gearbox housing, 5 axis machined", 6, 312)] },
  { id: "i-43", reference: "INV-1043", createdAt: "2026-10-22T08:00:00Z", customer: "Pemberton Packaging", rawStatus: "sent", date: "2026-10-22", dueDate: "2026-11-05", terms: "14 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-22T09:00:00Z", chasePaused: { reason: "Query on the delivery", until: "2026-11-27" },
    lines: [L("Sealing jaw bar, hardened", 16, 94.5)], invoiceNote: "Goods received short by 2 off: replacement to follow." },
  { id: "i-42", reference: "INV-1042", createdAt: "2026-09-28T08:00:00Z", customer: "Solway Marine Engineering", rawStatus: "partial", date: "2026-09-28", dueDate: "2026-10-28", terms: "30 days", customerPo: "SM/5521", carriage: 0, vatEnabled: true, carriageVat: true, credited: 150, refunded: 0, amountPaid: 1000, sentAt: "2026-09-28T09:00:00Z",
    lines: [L("Bush, aluminium bronze, bored", 12, 58), L("Material certificates", 1, 35), L("Rudder stock sleeves, bronze", 12, 128)], payments: [P("p-42a", 1000, "2026-11-02", "BACS", "SM PAY 4471")],
    creditNotes: [{ ref: "CRN-0031", date: "2026-11-04", total: 150, allocated: 150, status: "issued" }] },
  { id: "i-41", reference: "INV-1041", createdAt: "2026-09-20T08:00:00Z", customer: "Wren & Calder", rawStatus: "sent", date: "2026-09-20", dueDate: "2026-10-20", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-09-20T09:00:00Z",
    lines: [L("Idler roller 89 mm, galvanised", 90, 41), L("Bearing set", 90, 7.4)] },
  { id: "i-40", reference: "INV-1040", createdAt: "2026-08-31T08:00:00Z", customer: "Kilbride Hydraulics", rawStatus: "sent", date: "2026-08-31", dueDate: "2026-09-30", terms: "30 days", customerPo: "KH-40918", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-08-31T09:00:00Z",
    lines: [L("Cylinder gland, turned", 100, 22.5), L("Rod end, turned and threaded", 100, 15.9)] },
  { id: "i-39", reference: "INV-1039", createdAt: "2026-08-13T08:00:00Z", customer: "Carronside Automation", rawStatus: "sent", date: "2026-08-13", dueDate: "2026-09-12", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-08-13T09:00:00Z",
    lines: [L("Linear actuator end cap, turned", 200, 6.8)] },
  { id: "i-38", reference: "INV-1038", createdAt: "2026-08-06T08:00:00Z", customer: "Carronside Automation", rawStatus: "sent", date: "2026-08-06", dueDate: "2026-09-05", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-08-06T09:00:00Z",
    lines: [L("Coupling flange, 4140", 30, 74)] },
  { id: "i-37", reference: "INV-1037", createdAt: "2026-10-12T08:00:00Z", customer: "Kestrel Components", rawStatus: "paid", date: "2026-10-12", dueDate: "2026-11-11", terms: "30 days", customerPo: "KC-2290", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-12T09:00:00Z", paidAt: "2026-11-02T10:00:00Z",
    lines: [L("Gimbal bracket, 7075-T651", 150, 31.8)], payments: [P("p-37a", 5724, "2026-11-02", "BACS", "KC REM 8812")] },
  { id: "i-36", reference: "INV-1036", createdAt: "2026-09-30T08:00:00Z", customer: "Northgate Fabrication", rawStatus: "paid", date: "2026-09-30", dueDate: "2026-10-30", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-09-30T09:00:00Z", paidAt: "2026-11-09T10:00:00Z",
    lines: [L("Handrail post, 48.3 mm tube, base plate welded", 36, 27.4)], payments: [P("p-36a", 400, "2026-10-27", "cheque", "Cheque 004519"), P("p-36x", -400, "2026-10-29", "cheque", "", { reversesPaymentId: "p-36a", voidReason: "Cheque bounced" }), P("p-36b", 1183.68, "2026-11-09", "BACS", "NF REM 2290")] },
  { id: "i-35", reference: "INV-1035", createdAt: "2026-10-20T08:00:00Z", customer: "Ashby Rail Services", rawStatus: "paid", date: "2026-10-20", dueDate: "2026-11-19", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-20T09:00:00Z", paidAt: "2026-11-12T10:00:00Z",
    lines: [L("Pivot pin, hardened", 60, 9.6), L("Pin carrier, machined", 60, 18.2)], payments: [P("p-35a", 2001.6, "2026-11-12", "BACS", "ARS 77120")] },
  { id: "i-34", reference: "INV-1034", createdAt: "2026-10-08T08:00:00Z", customer: "Ardmore Precision", rawStatus: "void", date: "2026-10-08", dueDate: "2026-11-07", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0,
    lines: [L("Reference gauge blocks", 3, 880)] },
  { id: "i-33", reference: "INV-1033", createdAt: "2026-07-14T08:00:00Z", customer: "Brightwell Valves", rawStatus: "written_off", date: "2026-07-14", dueDate: "2026-08-13", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-07-14T09:00:00Z",
    lines: [L("Valve actuator brackets", 20, 45.5)] },
  { id: "i-32", reference: "INV-1032", createdAt: "2026-07-31T08:00:00Z", customer: "Wren & Calder", rawStatus: "sent", date: "2026-07-31", dueDate: "2026-08-30", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, paymentUnverified: true,
    lines: [L("Conveyor frame sections", 6, 310)] },
  { id: "i-31", reference: "INV-1031", createdAt: "2026-10-01T08:00:00Z", customer: "Kilbride Hydraulics", rawStatus: "paid", date: "2026-10-01", dueDate: "2026-10-31", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-01T09:00:00Z", paidAt: "2026-10-29T10:00:00Z",
    lines: [L("Prototype test block", 2, 260)], payments: [P("p-31a", 724, "2026-10-29", "BACS", "KH 55103")] },
  { id: "i-30", reference: "INV-1030", createdAt: "2026-11-02T08:00:00Z", customer: "Ashby Rail Services", rawStatus: "sent", date: "2026-11-02", dueDate: "2026-12-02", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-11-02T09:00:00Z",
    lines: [L("Door pivot carrier, machined", 40, 18.2)], storedTotal: 800 },
  { id: "i-29", reference: "INV-1029", createdAt: "2026-09-10T08:00:00Z", customer: "Wren & Calder", rawStatus: "sent", date: "2026-09-10", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-09-10T09:00:00Z",
    lines: [L("Idler bracket, painted", 24, 12.4)] },
  { id: "i-28", reference: "INV-1028", createdAt: "2026-10-15T08:00:00Z", customer: "Pemberton Packaging", rawStatus: "paid", date: "2026-10-15", dueDate: "2026-11-14", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2026-10-15T09:00:00Z", paidAt: "2026-11-10T10:00:00Z",
    lines: [L("Cutter holder, hardened", 100, 12.4)], payments: [P("p-28a", 1488, "2026-11-10", "BACS", "PP 99120"), P("p-28b", 200, "2026-11-10", "BACS", "PP 99121")] },
  { id: "i-90", reference: "INV-0987", createdAt: "2025-09-10T08:00:00Z", customer: "Solway Marine Engineering", rawStatus: "paid", date: "2025-09-10", dueDate: "2025-10-10", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, sentAt: "2025-09-10T09:00:00Z", paidAt: "2025-10-06T10:00:00Z",
    lines: [L("Bush, aluminium bronze, bored", 30, 58)], payments: [P("p-90a", 2088, "2025-10-06", "BACS", "SM 2025-10")] },
  { id: "i-91", reference: "INV-0990", createdAt: "2026-10-01T08:00:00Z", customer: "Kestrel Components", rawStatus: "void", date: "2026-10-01", dueDate: "2026-10-31", terms: "30 days", carriage: 0, vatEnabled: true, carriageVat: true, credited: 0, refunded: 0, amountPaid: 0, manual: "archived",
    lines: [L("Test rig plates", 12, 74)] },
];

/** The few records that carry stored figures the lines alone do not give (a payment surplus, an imported total that disagrees with its lines). */
function withFigures(seed: SeedInvoice): SeedInvoice {
  const paid = seed.payments ? netPaid(seed.payments) : seed.amountPaid;
  return { ...seed, amountPaid: paid };
}

/* ================================================================== */
/* 3. Pure logic (real lib functions where they are pure; mirrors of the rest pinned by tests) */
/* ================================================================== */

const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export function daysBetween(later: string, earlier: string): number { return Math.round((dayMs(later.slice(0, 10)) - dayMs(earlier.slice(0, 10))) / 86_400_000); }
export function addDays(iso: string, days: number): string { return new Date(dayMs(iso) + days * 86_400_000).toISOString().slice(0, 10); }
/** Days implied by a terms string such as "30 days" or "Due on receipt" (the page's own helper). */
export function termsDays(terms: string): number { if (/receipt/i.test(terms)) return 0; const m = /(\d+)/.exec(terms); return m ? Number(m[1]) : 30; }
const pounds = (n: number) => gbp(n, 2);

export function totalsOfSeed(seed: Pick<SeedInvoice, "lines" | "carriage" | "vatEnabled" | "carriageVat">): DocumentTotals {
  return documentTotals(seed.lines, seed.carriage, { vatEnabled: seed.vatEnabled, carriageVat: seed.carriageVat, standardRate: 20 });
}

/** The page's derive(): shown status, days overdue, balance and part paid. */
export function derive(seed: SeedInvoice, today: string = TODAY): InvoiceRow {
  const totals = totalsOfSeed(seed);
  const stored = seed.storedTotal;
  const amount = stored ?? totals.total;
  const base = { ...seed, amount, subtotal: stored !== undefined ? fromPence(toPence(stored) - toPence(totals.vat)) : totals.subtotal, vatAmount: totals.vat };
  const lifecycle = invoiceLifecycle(seed.rawStatus);
  if (lifecycle === "paid") return { ...base, status: "paid", daysOverdue: 0, balance: 0, partPaid: false };
  if (lifecycle === "closed") return { ...base, status: "closed", daysOverdue: 0, balance: 0, partPaid: false };
  if (seed.paymentUnverified) return { ...base, status: "unverified", daysOverdue: 0, balance: 0, partPaid: false };
  const daysOverdue = daysPastDue(seed.dueDate, today) ?? 0;
  const partPaid = isPartPaid({ status: seed.rawStatus, total: amount, amount_paid: seed.amountPaid, credited_amount: seed.credited, refunded_amount: seed.refunded });
  return { ...base, status: daysOverdue > 0 ? "overdue" : "outstanding", daysOverdue, balance: balanceDue(amount, seed.amountPaid, seed.credited, seed.refunded), partPaid };
}

export function invoiceRows(seeds: readonly SeedInvoice[] = SEED_INVOICES, today: string = TODAY): InvoiceRow[] {
  return seeds.map((seed) => derive(withFigures(seed), today));
}

/** lib/archive phaseOf (mirrored: that module reaches Supabase). `now` is fixed at the sample's today so the rule is repeatable. */
export function phaseOf(record: { final: boolean; finalDate?: string | null }, manual: "archived" | "active" | undefined, months: number, now: Date = new Date(`${TODAY}T12:00:00Z`)): Phase {
  if (manual === "archived") return "archived";
  if (!record.final) return "open";
  if (manual === "active" || !record.finalDate) return "done";
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const at = new Date(record.finalDate);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}
export function phaseFor(invoice: Pick<InvoiceRow, "rawStatus" | "paidAt" | "date" | "manual">): Phase {
  return phaseOf({ final: isFinalInvoice(invoice.rawStatus), finalDate: invoice.paidAt || invoice.date }, invoice.manual, ARCHIVE_MONTHS);
}

const calendarDay = (v?: string) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const isVoid = (raw: string) => ["void", "voided", "cancelled", "canceled"].includes(invoiceStatus(raw));
/** lib/open-drafts isOpenDraft (mirrored). */
export const isOpenDraft = (raw: string, archived: boolean) => invoiceStatus(raw) === "draft" && !isVoid(raw) && !archived;
/** lib/list-filter invoiceMatchesFilter (mirrored). */
export function matchesListFilter(filter: string, i: { status: string; rawStatus: string; createdAt?: string }, today: string, archived = false): boolean {
  if (filter === "overdue") return i.status === "overdue";
  if (filter === "draft-old") { const created = calendarDay(i.createdAt); return isOpenDraft(i.rawStatus, archived) && Boolean(created) && daysBetween(today, created) > DRAFT_INVOICE_DAYS; }
  return true;
}
/** lib/list-filter draftInvoiceCounts (mirrored). */
export function draftCounts(rows: readonly InvoiceRow[], today: string = TODAY): { total: number; old: number } {
  const drafts = rows.filter((r) => isOpenDraft(r.rawStatus, phaseFor(r) === "archived"));
  return { total: drafts.length, old: drafts.filter((r) => matchesListFilter("draft-old", r, today, false)).length };
}

export type Filters = { phase: PhaseValue; chips: ReadonlySet<string>; listFilter: ListFilterKey | null };
export const DEFAULT_FILTERS: Filters = { phase: "open", chips: new Set(["all"]), listFilter: null };

export function visibleInvoices(rows: readonly InvoiceRow[], f: Filters, today: string = TODAY): InvoiceRow[] {
  return rows.filter((i) => (f.listFilter ? matchesListFilter(f.listFilter, i, today, phaseFor(i) === "archived") : (f.phase === "all" || phaseFor(i) === f.phase) && (f.chips.has("all") || f.chips.has(i.status) || (f.chips.has("partial") && i.partPaid))));
}
export function phaseCounts(rows: readonly InvoiceRow[]): Record<Phase, number> {
  return { open: rows.filter((x) => phaseFor(x) === "open").length, done: rows.filter((x) => phaseFor(x) === "done").length, archived: rows.filter((x) => phaseFor(x) === "archived").length };
}

/** Collectible invoices only (no drafts, void or cancelled), counted at what is still owed. */
export function unpaidOf(rows: readonly InvoiceRow[]): InvoiceRow[] { return rows.filter((i) => i.status === "overdue" || i.status === "outstanding"); }
export function totalOwed(rows: readonly InvoiceRow[]): number { return fromPence(unpaidOf(rows).reduce((sum, i) => sum + toPence(i.balance), 0)); }
export const AGING: Array<{ label: string; test: (days: number) => boolean; tone: "info" | "warn" | "danger" }> = [
  { label: "Current", test: (d) => d <= 0, tone: "info" }, { label: "1-30 days late", test: (d) => d >= 1 && d <= 30, tone: "warn" },
  { label: "31-60 days late", test: (d) => d >= 31 && d <= 60, tone: "warn" }, { label: "60+ days late", test: (d) => d > 60, tone: "danger" },
];
export function agingOf(rows: readonly InvoiceRow[]): Array<{ label: string; value: number; tone: "info" | "warn" | "danger" }> {
  const unpaid = unpaidOf(rows);
  return AGING.map((b) => ({ label: b.label, tone: b.tone, value: fromPence(unpaid.filter((i) => b.test(i.daysOverdue)).reduce((sum, i) => sum + toPence(i.balance), 0)) }));
}
export type LatePayer = { customer: string; label: "CHRONIC" | "WATCH"; late: string; avg: string; owed: number; worst: number };
export function latePayersOf(rows: readonly InvoiceRow[]): LatePayer[] {
  const by = new Map<string, { overdue: InvoiceRow[]; total: number; owed: number }>();
  for (const i of rows) {
    const e = by.get(i.customer) ?? { overdue: [], total: 0, owed: 0 };
    e.total += 1;
    if (i.status === "overdue") { e.overdue.push(i); e.owed += i.balance; }
    by.set(i.customer, e);
  }
  return [...by.entries()].filter(([, e]) => e.overdue.length).map(([customer, e]) => {
    const avgDays = Math.round(e.overdue.reduce((sum, i) => sum + i.daysOverdue, 0) / e.overdue.length);
    const worst = Math.max(...e.overdue.map((i) => i.daysOverdue));
    return { customer, label: worst > 60 ? "CHRONIC" as const : "WATCH" as const, late: `${e.overdue.length}/${e.total} overdue`, avg: `avg ${avgDays} days late`, owed: e.owed, worst };
  }).sort((a, b) => b.worst - a.worst).slice(0, 3);
}
export function trendsOf(rows: readonly InvoiceRow[], range: { from: string; to: string }) {
  const inRange = rows.filter((i) => i.date && i.date >= range.from && i.date <= range.to && isRaised(i.rawStatus));
  const paid = inRange.filter((i) => i.status === "paid" && i.paidAt && i.dueDate);
  const onTime = paidOnTime(inRange.map((i) => ({ status: i.rawStatus, payment_unverified: i.paymentUnverified, due_date: i.dueDate ?? null, paid_at: i.paidAt ?? null })));
  const lateDays = [
    ...paid.map((i) => Math.max(0, daysBetween((i.paidAt as string).slice(0, 10), i.dueDate as string))).filter((d) => d > 0),
    ...inRange.filter((i) => i.status === "overdue").map((i) => i.daysOverdue),
  ];
  return { raised: inRange.length, onTime: onTime.rate === null ? "—" : `${onTime.rate}%`, onTimeOf: paidOnTimeNote(onTime), avgLate: lateDays.length ? String(Math.round(lateDays.reduce((a, b) => a + b, 0) / lateDays.length)) : "—" };
}
export function creditHeldOf(rows: readonly InvoiceRow[]): { total: number; customers: number } {
  const by = new Map<string, number>();
  for (const i of rows) {
    const c = customerCredit({ status: i.rawStatus, total: i.amount, amount_paid: i.amountPaid, credited_amount: i.credited, refunded_amount: i.refunded, payment_unverified: i.paymentUnverified });
    if (c > 0) by.set(i.customer, (by.get(i.customer) ?? 0) + toPence(c));
  }
  return { total: fromPence([...by.values()].reduce((a, b) => a + b, 0)), customers: by.size };
}

/** lib/invoice-list-totals (mirrored): the compact list's net, VAT and the foot sums, in whole pence; void and cancelled add nothing. */
export function netAndVat(i: { amount: number; subtotal?: number; vatAmount?: number }): { net: number; vat: number } {
  const vat = i.vatAmount ?? 0;
  return { net: i.subtotal ?? fromPence(toPence(i.amount) - toPence(vat)), vat };
}
export function compactTotals(rows: readonly InvoiceRow[]) {
  let net = 0, vat = 0, gross = 0, paid = 0, outstanding = 0;
  for (const r of rows) {
    if (isVoid(r.rawStatus)) continue;
    const sp = netAndVat(r);
    net += toPence(sp.net); vat += toPence(sp.vat); gross += toPence(r.amount); paid += toPence(r.amountPaid); outstanding += toPence(r.balance);
  }
  return { count: rows.length, net: fromPence(net), vat: fromPence(vat), gross: fromPence(gross), paid: fromPence(paid), outstanding: fromPence(outstanding) };
}

/** The Status badge words, exactly as the list shows them. */
export function statusWords(i: Pick<InvoiceRow, "status" | "rawStatus" | "partPaid" | "dueDate" | "daysOverdue">): string {
  if (i.status === "paid") return "PAID";
  if (i.status === "unverified") return "PAYMENT TO CONFIRM";
  if (i.status === "closed") return i.rawStatus.toUpperCase();
  if (i.partPaid) return "PART PAID";
  return dueWords(i) ;
}
export function dueWords(i: Pick<InvoiceRow, "dueDate" | "daysOverdue">): string {
  if (!i.dueDate) return "No due date";
  return i.daysOverdue > 0 ? `${i.daysOverdue} days overdue` : i.daysOverdue === 0 ? "Due today" : `Due in ${Math.abs(i.daysOverdue)} days`;
}
export function toneOf(i: Pick<InvoiceRow, "status" | "rawStatus" | "partPaid" | "daysOverdue">): StatusTone {
  const key = invoiceStatusKey(i);
  return key ? KEY_TONE[key] ?? "neutral" : "neutral";
}
/** The small line under the amount (lib: the list's own text). */
export function amountNote(i: Pick<InvoiceRow, "amountPaid" | "balance" | "credited">): string {
  if (i.amountPaid > 0 && i.balance > 0) return `${pounds(i.amountPaid)} paid${i.credited > 0 ? `, ${pounds(i.credited)} credited` : ""}, ${pounds(i.balance)} still owed`;
  if (i.credited > 0 && i.balance > 0) return `${pounds(i.credited)} credited, ${pounds(i.balance)} still owed`;
  return "";
}

/** lib/invoice-void voidOffered and lib/invoice-write-off writeOffOffered / isWrittenOff (mirrored). */
export function voidOffered(i: Pick<InvoiceRow, "rawStatus" | "amountPaid" | "credited" | "refunded" | "paymentUnverified">): boolean {
  return ["issued", "sent"].includes(invoiceStatus(i.rawStatus)) && i.amountPaid === 0 && i.credited === 0 && i.refunded === 0 && !i.paymentUnverified;
}
export const isWrittenOff = (raw: string) => invoiceStatus(raw) === "written_off";
export function writeOffOffered(i: Pick<InvoiceRow, "rawStatus" | "amount" | "amountPaid" | "credited" | "refunded" | "paymentUnverified">): boolean {
  if (!["issued", "sent", "partial"].includes(invoiceStatus(i.rawStatus)) || i.paymentUnverified) return false;
  return balanceDue(i.amount, i.amountPaid, i.credited, i.refunded) > 0;
}
export const WRITE_OFF_REASON_MIN = 10;
export const VOID_REASON_MAX = 500;

/** What each role sees (middleware + RoleGate): Invoicing is for admin and office only. */
export function canUseInvoices(role: Role): boolean { return role === "admin" || role === "office"; }
/** Pay Selected in Full: the selected invoices that are waiting for payment (the page's own filter). */
export function payableOf(rows: readonly InvoiceRow[], selected: readonly string[]): InvoiceRow[] {
  return rows.filter((i) => selected.includes(i.reference) && !paymentBlockedReason(i.rawStatus) && (i.status === "overdue" || i.status === "outstanding" || i.status === "unverified"));
}
/** Why the stored total can't be printed from the lines (document-integrity totalsMismatch), or null. */
export function totalsProblem(i: InvoiceRow): string | null {
  const t = totalsOfSeed(i);
  return totalsMismatch(i.reference, { total: i.amount, subtotal: i.subtotal, vat: i.vatAmount }, { subtotal: t.subtotal, vat: t.vat, total: t.total }, i.rawStatus !== "draft")?.message ?? null;
}
export function scopeTitle(selected: number, inFilter: number): string {
  const plural = (n: number) => `${n} invoice${n === 1 ? "" : "s"}`;
  return selected > 0 ? `Exports the ${plural(selected)} selected` : `Exports all ${plural(inFilter)} in the current filter (nothing is selected)`;
}
export function paymentsScope(selected: number): string {
  return selected ? `Exports the payments of the ${selected} selected invoice${selected === 1 ? "" : "s"}` : "Exports every payment recorded on every invoice (nothing is selected)";
}

/** The sample's "Despatched but not invoiced" list (lib/uninvoiced reasons). */
export const UNINVOICED = [
  { id: "u1", ref: "DLN-0212", customer: "Kilbride Hydraulics", reason: "No draft yet", sent: "2026-11-19", detail: "Sent out yesterday: the automatic draft is still to be made." },
  { id: "u2", ref: "DLN-0204", customer: "Pemberton Packaging", reason: "Automatic draft failed", sent: "2026-11-13", detail: "The draft could not be made: the order has no price on line 2." },
  { id: "u3", ref: "DLN-0198", customer: "Northgate Fabrication", reason: "Invoice by hand", sent: "2026-11-09", detail: "A hand-made delivery note, so it has no order to price from." },
];
export const FROM_NOTES = [
  { id: "n1", ref: "DLN-0212", customer: "Kilbride Hydraulics", date: "2026-11-19", status: "despatched" },
  { id: "n2", ref: "DLN-0204", customer: "Pemberton Packaging", date: "2026-11-13", status: "delivered" },
  { id: "n3", ref: "DLN-0198", customer: "Northgate Fabrication", date: "2026-11-09", status: "signed" },
];

/* ================================================================== */
/* 4. The row action plan (structural item 7) and small local pieces   */
/* ================================================================== */

export type RowActionId = "view" | "pay" | "archive";
export interface RowAction { id: RowActionId; label: string; disabled?: boolean; hint?: string }
export const PAY_SETTLED_HINT = "Nothing is waiting for payment on this invoice";
/** Every real row control, in the order the More menu shows them. Record payment is not offered at all on a draft (the real reason is paymentBlockedReason). */
export function allRowActions(i: Pick<InvoiceRow, "rawStatus" | "status" | "paidAt" | "date" | "manual">): RowAction[] {
  return [
    { id: "view", label: "View" },
    ...(paymentBlockedReason(i.rawStatus) ? [] : [{ id: "pay" as const, label: "Record payment", disabled: i.status === "paid" || i.status === "closed", hint: i.status === "paid" || i.status === "closed" ? PAY_SETTLED_HINT : undefined }]),
    { id: "archive", label: phaseFor(i) === "archived" ? "Unarchive" : "Archive" },
  ];
}
/** The next step is the one visible button (Record payment while money is owed, otherwise View); the rest go to More. */
export function rowActionPlan(i: Pick<InvoiceRow, "rawStatus" | "status" | "paidAt" | "date" | "manual">): { primary: RowAction; more: RowAction[] } {
  const all = allRowActions(i);
  const pay = all.find((a) => a.id === "pay");
  const primaryId: RowActionId = pay && !pay.disabled ? "pay" : "view";
  return { primary: all.find((a) => a.id === primaryId) as RowAction, more: all.filter((a) => a.id !== primaryId) };
}
export const INVOICE_TITLE_TIP = "Invoices are what customers owe us. See what is unpaid and chase it.";

const VIEW_KEY = "invoices-preview:view";
const COMPACT_KEY = "invoices-preview:compact";
const ROLES: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
const SCREENS: Array<{ v: Screen | ListFilterKey | "uncertain"; label: string }> = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No invoices yet" },
  { v: "uncertain", label: "Uncertain payment" }, { v: "overdue", label: "Dashboard link: Overdue" }, { v: "draft-old", label: "Dashboard link: Old drafts" },
];

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

function StatusPill({ row, mode = "pill" }: { row: InvoiceRow; mode?: "pill" | "text" }) {
  return <StatusBadge tone={toneOf(row)} mode={mode}>{statusWords(row)}</StatusBadge>;
}

const Ref = ({ children }: { children: ReactNode }) => <span className={cx(typeScale.name, tabularNumbers, s.ref)}>{children}</span>;

/* ================================================================== */
/* 5. Dialog state                                                     */
/* ================================================================== */

type Dlg =
  | { k: "new" } | { k: "fromNotes" } | { k: "issue"; id: string; andSend: boolean } | { k: "sentConfirm"; id: string } | { k: "pay"; id: string }
  | { k: "bulk" } | { k: "confirmComplete"; id: string } | { k: "reverse"; id: string; paymentId: string } | { k: "void"; id: string }
  | { k: "writeoff"; id: string; mode: "write_off" | "reverse" } | { k: "deleteDraft"; id: string };

/* ================================================================== */
/* 6. The page                                                         */
/* ================================================================== */

export default function InvoicesPreview() {
  return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>;
}

function Inner() {
  const toast = useToast();
  const tipId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [uncertain, setUncertain] = useState(false);
  const [view, setViewState] = useState<ViewMode>("table");
  const [compact, setCompactState] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [range, setRange] = useState({ from: `${TODAY.slice(0, 8)}01`, to: TODAY });
  const [rangeDraft, setRangeDraft] = useState(range);
  const [reloadTimer, setReloadTimer] = useState<number | null>(null);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  const wide = useMedia("(min-width: 1024px)", true);
  const notPhone = useMedia("(min-width: 768px)", true);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") setViewState(v);
      if (window.localStorage.getItem(COMPACT_KEY) === "1") setCompactState(true);
    } catch { /* storage unavailable: defaults stay */ }
  }, []);
  useEffect(() => () => { if (reloadTimer) window.clearTimeout(reloadTimer); }, [reloadTimer]);
  const setView = (v: ViewMode) => { setViewState(v); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const setCompact = (on: boolean) => { setCompactState(on); try { window.localStorage.setItem(COMPACT_KEY, on ? "1" : "0"); } catch { /* ignore */ } };
  const shownView: ViewMode = wide ? view : "cards";

  const rows = useMemo(() => invoiceRows(), []);
  const byId = useMemo(() => new Map(rows.map((i) => [i.id, i])), [rows]);
  const loaded = screen === "ready";
  const data = useMemo(() => (screen === "ready" ? rows : []), [screen, rows]);
  const visible = useMemo(() => visibleInvoices(data, filters), [data, filters]);
  const counts = useMemo(() => phaseCounts(data), [data]);
  const unpaid = useMemo(() => unpaidOf(data), [data]);
  const owedTotal = useMemo(() => totalOwed(data), [data]);
  const aging = useMemo(() => agingOf(data), [data]);
  const latePayers = useMemo(() => latePayersOf(data), [data]);
  const trends = useMemo(() => trendsOf(data, range), [data, range]);
  const drafts = useMemo(() => draftCounts(data), [data]);
  const credit = useMemo(() => creditHeldOf(data), [data]);
  const overdue = useMemo(() => data.filter((i) => i.status === "overdue"), [data]);
  const inView = (c: ColumnKey) => !hidden.includes(c);
  const nSel = selected.length;
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const isAdmin = role === "admin";
  const denied = !canUseInvoices(role);
  const activeChips = CHIPS.filter((c) => c.v !== "all" && filters.chips.has(c.v));

  const resetAll = () => { setScreen("ready"); setUncertain(false); setFilters(DEFAULT_FILTERS); setSelected([]); setHidden([]); setDlg(null); setViewId(null); toast.clear(); };
  const pickScreen = (v: Screen | ListFilterKey | "uncertain") => {
    toast.clear(); setSelected([]);
    if (v === "uncertain") { setScreen("ready"); setUncertain((u) => !u); return; }
    if (v === "overdue" || v === "draft-old") { setScreen("ready"); setFilters({ ...DEFAULT_FILTERS, listFilter: v }); return; }
    setFilters((f) => ({ ...f, listFilter: null })); setScreen(v);
  };
  const retry = () => {
    setScreen("loading");
    const t = window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample invoices shown again. No server was contacted." }); }, 700);
    setReloadTimer(t);
  };
  const toggleChip = (value: string) => setFilters((f) => {
    const next = new Set(f.chips);
    if (value === "all") { next.clear(); next.add("all"); } else { next.delete("all"); if (next.has(value)) next.delete(value); else next.add(value); if (next.size === 0) next.add("all"); }
    return { ...f, chips: next };
  });
  const toggleSel = (ref: string) => setSelected((c) => (c.includes(ref) ? c.filter((r) => r !== ref) : [...c, ref]));
  const focusFiltersTrigger = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="filters-trigger"]')?.focus());
  const removeChip = (value: string, index: number) => {
    toggleChip(value);
    requestAnimationFrame(() => { const rest = activeRef.current?.querySelectorAll<HTMLElement>("[data-active-chip]"); if (rest && rest.length) rest[Math.min(index, rest.length - 1)].focus(); else document.querySelector<HTMLElement>('[data-testid="filters-trigger"]')?.focus(); });
  };
  const clearFilters = () => { setFilters((f) => ({ ...f, chips: new Set(["all"]) })); focusFiltersTrigger(); };
  const clearSelection = () => { setSelected([]); requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('input[type="checkbox"]')?.focus()); };
  const exportAs = (fmt: string, payments = false) => preview(`The ${fmt} export would cover ${payments ? paymentsScope(nSel).replace(/^Exports /, "").replace(/^the /, "the ") : nSel ? `the ${nSel} selected invoice${nSel === 1 ? "" : "s"}` : `all ${visible.length} invoice${visible.length === 1 ? "" : "s"} in the current filter`}. No file was downloaded.`);
  const payInFull = () => {
    const eligible = payableOf(rows, selected);
    const draftsSelected = rows.some((i) => selected.includes(i.reference) && paymentBlockedReason(i.rawStatus));
    if (!eligible.length) toast.show({ title: draftsSelected ? `None of the selected invoices is waiting for payment. ${DRAFT_PAYMENT_REASON}.` : "None of the selected invoices is waiting for payment" });
    else setDlg({ k: "bulk" });
  };
  const applyAging = (label: string) => setFilters((f) => ({ ...f, chips: new Set([label === "Current" ? "outstanding" : "overdue"]) }));
  const openPayment = (i: InvoiceRow) => setDlg({ k: "pay", id: i.id });
  const hasRows = data.length > 0;
  const [backlogOpen, setBacklogOpen] = useState(false);
  const archive = (i: InvoiceRow) => preview(`${shownInvoiceRef(i)} would be ${phaseFor(i) === "archived" ? "moved out of the archive" : "archived"}.`);
  const runAction = (i: InvoiceRow, id: RowActionId) => { if (id === "view") setViewId(i.id); else if (id === "pay") openPayment(i); else archive(i); };
  const actions = (i: InvoiceRow) => <RowActions i={i} run={runAction} />;
  const exportMenu = (n: number) => (
    <Menu label="Export" size="sm" variant="secondary" data-testid="export-trigger" aria-label={`Export. ${scopeTitle(n, visible.length)}`} items={[
      { id: "CSV", label: "CSV", onSelect: () => exportAs("CSV") }, { id: "Excel", label: "Excel", onSelect: () => exportAs("Excel") },
      { id: "Payments CSV", label: "Payments CSV", hint: paymentsScope(n), onSelect: () => exportAs("Payments CSV", true) }, { id: "Payments Excel", label: "Payments Excel", hint: paymentsScope(n), onSelect: () => exportAs("Payments Excel", true) },
      { id: "Word", label: "Word", onSelect: () => exportAs("Word") }, { id: "PDF", label: "PDF", onSelect: () => exportAs("PDF") },
    ]} />
  );

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="invoices-preview" data-role={role} data-pview={shownView}>
      <PreviewBar controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={typeScale.caption}>Not part of Tolra. Sample data; states are simulated and no request, payment or accounting call is made.</p>
            <p className={typeScale.label}>Role</p>
            <SegmentedControl label="Role" value={role} options={ROLES} size="sm" onChange={(v) => { setRole(v); toast.clear(); }} />
            <p className={typeScale.label}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {SCREENS.map((x) => {
                const cur = x.v === "uncertain" ? (uncertain ? "uncertain" : "") : filters.listFilter ?? screen;
                return <Button key={x.v} size="sm" variant="secondary" fullWidth aria-pressed={cur === x.v} onClick={() => pickScreen(x.v)}>{x.label}</Button>;
              })}
            </div>
            <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader title={<span title={INVOICE_TITLE_TIP} aria-describedby={tipId}>Invoicing</span>}
        actions={denied ? null : (
          <div className={s.headActions}>
            <Button variant="secondary" data-testid="chase-all" disabled={!loaded || !overdue.length} title={overdue.length ? "Draft a chaser email for every overdue invoice" : "No overdue invoices"}
              onClick={() => preview(`Chaser e-mails would be drafted for ${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"}. No chase was run and no e-mail was drafted.`)}>Chase All Overdue</Button>
            <Button variant="secondary" data-testid="from-notes" onClick={() => setDlg({ k: "fromNotes" })}>Invoice from Delivery Notes</Button>
            <Button variant="primary" data-testid="new-invoice" onClick={() => setDlg({ k: "new" })}>New invoice</Button>
          </div>
        )} />
      <p id={tipId} className={srOnly}>{INVOICE_TITLE_TIP}</p>
      {!denied && loaded && (drafts.total > 0 || credit.total > 0) ? (
        <div className={s.notes}>
          {drafts.total > 0 ? <p className={typeScale.label} data-testid="drafts-waiting" title={`${drafts.old} over ${DRAFT_INVOICE_DAYS} days old (what the dashboard counts). A draft has no number and isn't owed until a person issues it.`}>Drafts waiting to issue: {drafts.total}</p> : null}
          {credit.total > 0 ? <p className={cx(typeScale.label, s.noteWarn)} data-testid="customer-credit-held" title="Open an invoice with credit to refund it or apply it to another invoice.">Customer credit held: {pounds(credit.total)} for {credit.customers} customer{credit.customers === 1 ? "" : "s"}</p> : null}
        </div>
      ) : null}

      {denied ? (
        <div data-testid="access-denied">
          <EmptyState headingLevel={2} title="Access Denied" detail="Redirecting you back to the dashboard." />
          <p className={cx(typeScale.caption, s.deniedNote)}>Preview only: no redirect happens here. The real Invoicing page is for Admin and Office; Workshop and Viewer cannot open it.</p>
        </div>
      ) : (
        <>
          <Panel title="Money Dashboard" headingLevel={2}>
            <div className={s.money}>
              <div className={s.moneyTotal}>
                <p className={cx(typeScale.numeral, s.moneyFigure, loaded && overdue.length > 0 && s.moneyDanger)} data-testid="money-total">{loaded ? pounds(owedTotal) : "—"}</p>
                <p className={typeScale.secondary}>{loaded ? `Across ${unpaid.length} outstanding invoice${unpaid.length === 1 ? "" : "s"}` : screen === "loading" ? "Loading…" : " "}</p>
              </div>
              <StatTiles label="Ageing of money owed" columns={4}>
                {aging.map((b) => (
                  <StatTile key={b.label} flat label={b.label} value={loaded ? pounds(b.value) : "—"} loading={screen === "loading"} data-testid={`aging-${b.label.split(" ")[0].toLowerCase().replace(/[^a-z0-9]/g, "")}`}
                    className={cx(s.quiet, b.value > 0 && s[`tone${b.tone[0].toUpperCase()}${b.tone.slice(1)}`])}
                    onPress={loaded ? () => applyAging(b.label) : undefined} />
                ))}
              </StatTiles>
            </div>
          </Panel>

          <div className={s.insights}>
            <Panel title="Late Payer Patterns" headingLevel={2}>
              {screen === "loading" ? <p className={typeScale.secondary}>Loading…</p> : latePayers.length && loaded ? (
                <List plain dense label="Late payer patterns">
                  {latePayers.map((p) => (
                    <ListRow key={p.customer} className={s.payerRow} leading={<span className={s.badgeSlot}><StatusBadge tone={p.label === "CHRONIC" ? "danger" : "warn"}>{p.label}</StatusBadge></span>} title={p.customer}
                      meta={<>{p.late} · {p.avg} · <span className={tabularNumbers}>{pounds(p.owed)}</span> owed</>} />
                  ))}
                </List>
              ) : <p className={typeScale.secondary}>No customers have overdue invoices.</p>}
            </Panel>
            <Panel title="Invoicing Trends" headingLevel={2}>
              <div className={s.trends}>
                <DateRangeGroup label="Invoicing Trends date range" from={rangeDraft.from} to={rangeDraft.to} data-testid="trend-range"
                  onFromChange={(v) => setRangeDraft((r) => ({ ...r, from: v }))} onToChange={(v) => setRangeDraft((r) => ({ ...r, to: v }))}
                  onApply={() => { setRange(rangeDraft); preview(`The date range ${fmtDate(rangeDraft.from)} to ${fmtDate(rangeDraft.to)} is applied to the figures on this screen only.`); }} />
                <p className={typeScale.secondary}>Showing: {fmtDate(range.from)} to {fmtDate(range.to)}</p>
                <StatTiles label="Invoicing trends" columns={3}>
                  <StatTile flat className={s.quiet} label="Invoices Raised" value={loaded ? trends.raised : "—"} hint={loaded ? raisedCaption(range.from, range.to) : undefined} loading={screen === "loading"} data-testid="raised-caption" />
                  <StatTile flat className={s.quiet} label="Paid On Time" value={loaded ? trends.onTime : "—"} hint={loaded ? trends.onTimeOf : undefined} loading={screen === "loading"} data-testid="paid-on-time" />
                  <StatTile flat className={s.quiet} label="Average days late" value={loaded ? trends.avgLate : "—"} loading={screen === "loading"} />
                </StatTiles>
              </div>
            </Panel>
          </div>

          {nSel > 0 ? (
            <SelectionBar count={nSel} filteredTotal={visible.length} noun="invoice" onSelectAll={() => setSelected(visible.map((i) => i.reference))} onClear={clearSelection}
              statusText={({ count, filteredTotal }) => `${count} selected of ${filteredTotal} filtered ${filteredTotal === 1 ? "record" : "records"}`}>
              {exportMenu(nSel)}
              <Button size="sm" variant="secondary" data-testid="pay-selected" onClick={payInFull}>Pay Selected in Full</Button>
            </SelectionBar>
          ) : (
            <div className={s.toolbar} role="group" aria-label="List controls" aria-busy={screen === "loading" || undefined}>
              <div className={s.tbGroup}>
                <span className={s.showGroup} title={INVOICE_SHOW_NOTE}>
                  <span className={typeScale.label}>Show</span>
                  <SegmentedControl label="Show" value={filters.phase} disabled={!loaded && screen !== "empty"} size="sm"
                    onChange={(v) => setFilters((f) => ({ ...f, phase: v, chips: chipsForPhase(f.chips, v) }))}
                    options={[
                      { value: "open", label: `Open (${counts.open})`, testId: "show-open" }, { value: "done", label: `Done (${counts.done})`, testId: "show-done" },
                      { value: "archived", label: `Archived (${counts.archived})`, testId: "show-archived" }, { value: "all", label: "All", testId: "show-all" },
                    ]} />
                </span>
                <Popover label={activeChips.length ? `Filters (${activeChips.length})` : "Filters"} title="Filters" size="sm" variant="secondary" data-testid="filters-trigger">
                  <ChipGroup label="Filters">
                    {CHIPS.map((c) => <FilterChip key={c.v} selected={filters.chips.has(c.v)} disabled={screen === "loading"} onToggle={() => toggleChip(c.v)} data-testid={`chip-${c.v}`}>{c.label}</FilterChip>)}
                  </ChipGroup>
                  <p className={cx(typeScale.caption, s.popNote)}>{INVOICE_SHOW_NOTE}</p>
                </Popover>
              </div>
              <div className={s.tbGroup}>
                {exportMenu(0)}
                <Popover label="Columns" title="Invoices columns" size="sm" variant="secondary" data-testid="columns-trigger">
                  <p className={cx(typeScale.caption, s.colScope)}>Changes apply to everyone in this company. In this preview they change this screen only.</p>
                  {COLUMNS.map((c) => (c.locked ? (
                    <p key={c.key} className={cx(typeScale.name, s.colLocked)} data-testid={`col-${c.key}`}><span>{c.label}</span><span className={typeScale.caption}>Always shown</span></p>
                  ) : (
                    <Switch key={c.key} label={c.label} checked={inView(c.key)} onChange={(on) => setHidden((h) => (on ? h.filter((k) => k !== c.key) : [...h, c.key]))} data-testid={`col-${c.key}`} />
                  )))}
                  <div className={s.colReset}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={() => setHidden([])}>Reset to default (show all columns)</Button></div>
                </Popover>
                {notPhone ? <Button size="sm" variant="secondary" aria-pressed={compact} data-testid="compact-toggle" onClick={() => setCompact(!compact)}>Compact list</Button> : null}
                {notPhone ? (
                  <SegmentedControl label="View" value={shownView} onChange={setView} size="sm" options={[
                    { value: "cards", label: "Cards", testId: "view-cards-btn" },
                    { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" },
                    { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" },
                  ]} />
                ) : null}
              </div>
            </div>
          )}

          {filters.listFilter ? (
            <Callout tone="neutral" role="status" data-testid="list-filter-notice" action={<Button size="sm" variant="secondary" onClick={() => setFilters((f) => ({ ...f, listFilter: null }))}>Show everything</Button>}>
              Showing only: <strong>{INVOICE_FILTER_LABELS[filters.listFilter]}</strong>
            </Callout>
          ) : null}
          {activeChips.length ? (
            <div ref={activeRef} className={s.activeRow} role="group" aria-label="Active filters" data-testid="active-filters">
              {activeChips.map((c, i) => (
                <Button key={c.v} size="sm" variant="secondary" className={s.activeChip} data-active-chip={c.v} aria-label={`Remove filter ${c.label}`} onClick={() => removeChip(c.v, i)}>
                  {c.label}<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </Button>
              ))}
              <Button size="sm" variant="quiet" data-testid="clear-filters" onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : null}

          {uncertain && loaded ? (
            <Callout tone="warn" lead="" role="alert" data-testid="uncertain-payments"
              action={rows.filter((i) => i.reference === "INV-1042").map((i) => <span key={i.id} className={s.btnRow}><Ref>{i.reference}</Ref><Button size="sm" variant="secondary" onClick={() => openPayment(i)}>Check and save</Button></span>)}>
              {UNCERTAIN_MESSAGE}
            </Callout>
          ) : null}

          {loaded ? (
            <Panel title="Despatched but not invoiced" headingLevel={2} data-testid="uninvoiced-delivery-notes"
              actions={
                <span className={s.btnRow}>
                  <Button size="sm" variant="quiet" aria-expanded={backlogOpen} onClick={() => setBacklogOpen((o) => !o)}>{backlogOpen ? "Hide the list" : `Show the ${UNINVOICED.length}`}</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDlg({ k: "fromNotes" })}>Invoice from Delivery Notes</Button>
                </span>
              }>
              <p className={typeScale.secondary} data-testid="uninvoiced-count">{UNINVOICED.length} delivery notes despatched with no invoice.</p>
              {backlogOpen ? (
                <List plain dense label="Despatched but not invoiced">
                  {UNINVOICED.map((u) => (
                    <ListRow key={u.id} className={s.payerRow} title={<><Ref>{u.ref}</Ref> <span className={typeScale.body}>{u.customer}</span></>} meta={<>{u.detail}</>}
                      trailing={<><StatusBadge tone="warn">{u.reason}</StatusBadge><span className={cx(typeScale.secondary, tabularNumbers)}>Despatched {fmtDate(u.sent)}</span></>} />
                  ))}
                </List>
              ) : null}
            </Panel>
          ) : null}

          <h2 className={srOnly}>Invoices</h2>
          <div ref={listRef}>
            {screen === "loading" ? <LoadingState label="Loading invoices" rows={6} />
              : screen === "error" ? <FailedState title="Couldn’t load invoices." detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." onRetry={retry} retryLabel="Retry" headingLevel={3} />
              : visible.length === 0 ? (
                <EmptyState title={hasRows ? "No invoices match this filter" : "No invoices yet"}
                  detail={hasRows ? (filters.phase !== "all" ? `Nothing in Show: ${filters.phase[0].toUpperCase()}${filters.phase.slice(1)} matches this status. Try Show: All, or a different status.` : "Try a different filter.") : invoicesEmptyHint()}
                  action={hasRows ? <Button variant="secondary" onClick={() => setFilters((f) => ({ ...f, chips: new Set(["all"]) }))}>Show all</Button> : <Button variant="primary" onClick={() => setDlg({ k: "new" })}>New invoice</Button>} />
              ) : shownView === "cards" ? (
                <div className={s.cards} data-testid="view-cards">
                  {visible.map((i) => <InvoiceCard key={i.id} i={i} selected={selected.includes(i.reference)} inView={inView} onSelect={() => toggleSel(i.reference)} actions={actions(i)} />)}
                </div>
              ) : compact ? (
                <CompactTable rows={visible} onOpen={(i) => setViewId(i.id)} />
              ) : (
                <ScrollTable label="Invoices" dense={shownView === "list"} pinLast>
                  <thead>
                    <tr>
                      <th>
                        <span className={s.firstCell}>
                          <Checkbox aria-label={`Select all ${visible.length} filtered invoices`} checked={visible.length > 0 && visible.every((i) => selected.includes(i.reference))} onChange={(e) => setSelected(e.target.checked ? visible.map((i) => i.reference) : [])} />
                          Invoice
                        </span>
                      </th>
                      {inView("customer") ? <th>Customer</th> : null}
                      {inView("status") ? <th>Status</th> : null}
                      {inView("amount") ? <th className={s.right}>Amount</th> : null}
                      <th className={s.actionsHead}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => (
                      <tr key={i.id} data-invoice={shownInvoiceRef(i)} data-selected={selected.includes(i.reference) || undefined}>
                        <td>
                          <span className={s.firstCell}>
                            <Checkbox aria-label={`Select ${shownInvoiceRef(i)}`} data-testid="select-row" checked={selected.includes(i.reference)} onChange={() => toggleSel(i.reference)} />
                            <RefCell i={i} />
                          </span>
                        </td>
                        {inView("customer") ? <td><span className={cx(typeScale.name, s.clamp)} title={i.customer}>{i.customer}</span>{i.chasePaused ? <span className={cx(typeScale.caption, s.paused)} data-testid="chase-paused">Chasing paused</span> : null}</td> : null}
                        {inView("status") ? <td><StatusPill row={i} mode="text" />{i.partPaid && i.dueDate ? <span className={cx(typeScale.caption, s.cellNote)}>{dueWords(i)}</span> : null}</td> : null}
                        {inView("amount") ? <td className={cx(s.right, tabularNumbers)}><span className={typeScale.name}>{pounds(i.amount)}</span>{amountNote(i) ? <span className={cx(typeScale.caption, s.cellNote)}>{amountNote(i)}</span> : null}</td> : null}
                        <td className={s.actionsCell}><div className={s.rowActions}>{actions(i)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              )}
          </div>
        </>
      )}

      <Dialogs dlg={dlg} viewId={viewId} setViewId={setViewId} close={() => setDlg(null)} setDlg={setDlg} byId={byId} rows={rows} preview={preview} isAdmin={isAdmin} selected={selected} />
    </div>
  );
}

/* ---------------- row pieces ---------------- */

function RefCell({ i }: { i: InvoiceRow }) {
  return (
    <span className={s.refCell}>
      <Ref>{shownInvoiceRef(i)}</Ref>
      {i.jobStage ? <span className={cx(typeScale.caption, s.refNote)} data-testid="draft-job-stage">{i.jobStage}</span> : null}
      {i.autoDraftedFrom ? <span className={cx(typeScale.caption, s.refNote)} data-testid="auto-drafted">Auto-drafted from {i.autoDraftedFrom}</span> : null}
    </span>
  );
}

/** One visible button (the next step) and a More menu with every other real action; the buttons never wrap. */
function RowActions({ i, run }: { i: InvoiceRow; run: (i: InvoiceRow, id: RowActionId) => void }) {
  const no = shownInvoiceRef(i);
  const plan = rowActionPlan(i);
  const items = plan.more.map((a) => ({ id: a.id, label: a.label, disabled: a.disabled, hint: a.hint, separatorBefore: a.id === "archive", onSelect: () => run(i, a.id) }));
  const aria: Record<RowActionId, string> = { view: `View ${no}`, pay: `Record payment on ${no}`, archive: `${phaseFor(i) === "archived" ? "Unarchive" : "Archive"} ${no}` };
  return (
    <>
      <Button size="sm" variant="secondary" data-action={plan.primary.label} aria-label={aria[plan.primary.id]} onClick={() => run(i, plan.primary.id)}>{plan.primary.label}</Button>
      <Menu label="More" size="sm" variant="quiet" items={items} aria-label={`More actions for ${no}`} data-testid="more-trigger" />
    </>
  );
}

function InvoiceCard({ i, selected, inView, onSelect, actions }: { i: InvoiceRow; selected: boolean; inView: (c: ColumnKey) => boolean; onSelect: () => void; actions: ReactNode }) {
  const no = shownInvoiceRef(i);
  return (
    <article className={cx(s.card, selected && s.cardOn)} data-testid={`card-${no}`} data-selected={selected || undefined} aria-label={no}>
      <div className={s.cardTop}>
        <Checkbox aria-label={`Select ${no} for export`} title="Select for export" data-testid="select-row" checked={selected} onChange={onSelect} />
        <div className={s.cardRef}><RefCell i={i} /></div>
        {inView("status") ? <StatusPill row={i} /> : null}
      </div>
      <dl className={s.dl}>
        {inView("customer") ? <div className={s.dlWide}><dt className={typeScale.secondary}>Customer</dt><dd className={typeScale.name}>{i.customer}{i.chasePaused ? <span className={cx(typeScale.caption, s.paused)}>Chasing paused</span> : null}</dd></div> : null}
        {inView("status") && i.partPaid && i.dueDate ? <div><dt className={typeScale.secondary}>Due</dt><dd className={typeScale.body}>{dueWords(i)}</dd></div> : null}
        {inView("amount") ? <div className={s.dlWide}><dt className={typeScale.secondary}>Amount</dt><dd className={cx(typeScale.card, tabularNumbers)}>{pounds(i.amount)}</dd>{amountNote(i) ? <dd className={typeScale.caption}>{amountNote(i)}</dd> : null}</div> : null}
      </dl>
      <div className={s.cardActions}>{actions}</div>
    </article>
  );
}

/** The dense accounting list (components/invoices/compact-invoice-list): a click on a row opens the invoice. */
function CompactTable({ rows, onOpen }: { rows: InvoiceRow[]; onOpen: (i: InvoiceRow) => void }) {
  const t = compactTotals(rows);
  return (
    <ScrollTable label="Invoices, compact list" dense>
      <thead>
        <tr><th>Invoice</th><th>Date</th><th>Customer</th><th className={s.right}>Net</th><th className={s.right}>VAT</th><th className={s.right}>Gross</th><th className={s.right}>Paid</th><th className={s.right}>Outstanding</th><th>Status</th><th>Due</th></tr>
      </thead>
      <tbody data-testid="compact-invoice-list">
        {rows.map((i) => {
          const { net, vat } = netAndVat(i);
          return (
            <tr key={i.id} data-testid="compact-invoice-row" data-clickable="true" onClick={(e) => { if (rowClickIsForRow(e.target, e.currentTarget)) onOpen(i); }}>
              <td><Button variant="quiet" size="sm" aria-label={`Open ${shownInvoiceRef(i)}`} onClick={() => onOpen(i)}><Ref>{shownInvoiceRef(i)}</Ref></Button></td>
              <td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(i.date)}</td>
              <td><span className={s.clamp} title={i.customer}>{i.customer}</span></td>
              <td className={cx(s.right, tabularNumbers)}>{pounds(net)}</td><td className={cx(s.right, tabularNumbers)}>{pounds(vat)}</td>
              <td className={cx(s.right, typeScale.name, tabularNumbers)}>{pounds(i.amount)}</td><td className={cx(s.right, tabularNumbers)}>{pounds(i.amountPaid)}</td>
              <td className={cx(s.right, typeScale.name, tabularNumbers)}>{pounds(i.balance)}</td>
              <td><StatusPill row={i} mode="text" /></td><td className={cx(s.nowrap, tabularNumbers)}>{fmtDate(i.dueDate)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot data-testid="compact-invoice-totals">
        <tr><td colSpan={3}>Totals ({t.count} invoice{t.count === 1 ? "" : "s"})</td>
          <td className={cx(s.right, tabularNumbers)} data-total="net">{pounds(t.net)}</td><td className={cx(s.right, tabularNumbers)} data-total="vat">{pounds(t.vat)}</td>
          <td className={cx(s.right, tabularNumbers)} data-total="gross">{pounds(t.gross)}</td><td className={cx(s.right, tabularNumbers)} data-total="paid">{pounds(t.paid)}</td>
          <td className={cx(s.right, tabularNumbers)} data-total="outstanding">{pounds(t.outstanding)}</td><td colSpan={2} /></tr>
      </tfoot>
    </ScrollTable>
  );
}

/* ================================================================== */
/* 7. Dialogs (the real confirmations, none of them saves anything)    */
/* ================================================================== */

type DialogsProps = {
  dlg: Dlg | null; viewId: string | null; setViewId: (id: string | null) => void; close: () => void; setDlg: (d: Dlg | null) => void; byId: Map<string, InvoiceRow>; rows: InvoiceRow[];
  preview: (detail: string) => void; isAdmin: boolean; selected: string[];
};

function Dialogs({ dlg, viewId, setViewId, close, setDlg, byId, rows, preview, isAdmin, selected }: DialogsProps) {
  const inv = dlg && "id" in dlg ? byId.get(dlg.id) ?? null : null;
  const vi = viewId ? byId.get(viewId) ?? null : null;
  // A toast sits under an open modal (the dialog element is above everything), so a finished action closes the sheet too, as the real page does.
  const finish = (detail: string) => { close(); setViewId(null); preview(detail); };
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { setReason(""); setTried(false); setNote(""); }, [dlg?.k, inv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const bulk = payableOf(rows, selected);
  const bulkTotal = fromPence(bulk.reduce((sum, i) => sum + toPence(balanceDue(i.amount, i.amountPaid, i.credited, i.refunded)), 0));

  return (
    <>
      {vi ? <ViewSheet i={vi} isAdmin={isAdmin} onClose={() => setViewId(null)} setDlg={setDlg} preview={preview} /> : null}
      {dlg?.k === "new" ? <NewInvoiceSheet onClose={close} preview={(d) => finish(d)} /> : null}
      {dlg?.k === "fromNotes" ? <FromNotesSheet onClose={close} preview={(d) => finish(d)} /> : null}
      {dlg?.k === "pay" && inv ? <PaymentSheet i={inv} onClose={close} preview={(d) => finish(d)} /> : null}

      <Dialog open={dlg?.k === "issue" && !!inv} onClose={close} confirmLabel={dlg?.k === "issue" && dlg.andSend ? "Issue & send" : "Issue Invoice"}
        title={inv ? `Issue this invoice to ${inv.customer}?` : ""}
        description={`It gets the next invoice number and its contents are fixed. From then on it counts as money owed, whether or not it has been e-mailed. This can't be undone.${dlg?.k === "issue" && dlg.andSend ? " The e-mail and PDF open straight after; you then confirm it has gone." : ""}`}
        onConfirm={() => finish(`${inv ? shownInvoiceRef(inv) : "The draft"} would be issued with the next invoice number. No number was taken and no e-mail was opened.`)}>
        <p className={typeScale.caption}>Preview only. The finance check, the invoice number and the e-mail are not run.</p>
      </Dialog>

      <Dialog open={dlg?.k === "sentConfirm" && !!inv} onClose={close} cancelLabel="Not yet" confirmLabel={"I’ve sent it"}
        title={inv ? `Has ${inv.reference} gone to the customer?` : ""} description="Attach the PDF and send the email first, then record it here."
        onConfirm={() => finish(`${inv?.reference} would be recorded as sent.`)} />

      <Dialog open={dlg?.k === "bulk"} onClose={close} confirmLabel={`Confirm ${bulk.length} Paid in Full`}
        title={`Record ${bulk.length} invoice${bulk.length === 1 ? "" : "s"} as paid in full?`}
        description={`Records one payment on each, for its whole balance, dated today (${fmtDate(TODAY)}): ${pounds(bulkTotal)} received in total. For a part payment, use Record payment on that invoice.`}
        onConfirm={() => finish(`${bulk.length} payment${bulk.length === 1 ? "" : "s"} totalling ${pounds(bulkTotal)} would be recorded. No payment was recorded.`)}>
        <div className={s.payList}>
          <List dense label="Invoices to pay in full">
            {bulk.map((i) => <ListRow key={i.id} title={<Ref>{i.reference}</Ref>} meta={i.customer} trailing={<span className={cx(typeScale.name, tabularNumbers)}>{pounds(balanceDue(i.amount, i.amountPaid, i.credited, i.refunded))}</span>} />)}
          </List>
        </div>
      </Dialog>

      <Dialog open={dlg?.k === "confirmComplete" && !!inv} onClose={close} confirmLabel="Confirm payments complete" confirmDisabled={!note.trim()}
        title={inv ? `Confirm payments complete on ${inv.reference}?` : ""}
        description={inv ? `You are saying the payments recorded on this invoice (${pounds(inv.amountPaid)} so far) are all that has been received, so ${pounds(balanceDue(inv.amount, inv.amountPaid, inv.credited, inv.refunded))} is still owed. It then counts as money owed and can be chased. This is recorded in the audit log with your note.` : ""}
        onConfirm={() => finish(`${inv?.reference} would be confirmed as still owed. The audit log was not written.`)}>
        <Field label="Note" required><Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: checked against the bank statement" /></Field>
      </Dialog>

      <Dialog open={dlg?.k === "reverse" && !!inv} onClose={close} confirmLabel="Reverse payment"
        title="Reverse this payment?"
        description={(() => { const p = inv?.payments?.find((x) => dlg?.k === "reverse" && x.id === dlg.paymentId); return p ? `${pounds(p.amount)} received ${fmtDate(p.paidOn)}${p.method ? ` by ${p.method}` : ""}. The payment stays in the history, struck through with your reason, and the invoice balance goes back up. This can't be undone; if it was a mistake, record the payment again.` : ""; })()}
        onConfirm={() => { if (!reason.trim()) { setTried(true); return; } finish(`The payment on ${inv?.reference} would be reversed. No payment was changed.`); }}>
        <Field label="Reason" required error={tried && !reason.trim() ? "Give a reason (at least 1 character)." : undefined}>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: cheque bounced" />
        </Field>
      </Dialog>

      <Dialog open={dlg?.k === "void" && !!inv} onClose={close} cancelLabel="Keep invoice" confirmLabel="Void invoice" confirmDisabled={!reason.trim() || reason.length > VOID_REASON_MAX}
        title={inv ? `Void invoice ${inv.reference}?` : ""}
        description={inv ? `For ${inv.customer}. A void invoice is no longer owed and can't be brought back; its number stays used. An invoice with payments or credits against it can't be voided: correct it with a credit note instead.` : ""}
        onConfirm={() => finish(`${inv?.reference} would be voided. Nothing was changed.`)}>
        <Field label="Reason (required, kept in the history)"><Textarea rows={3} maxLength={VOID_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: raised to the wrong customer" /></Field>
      </Dialog>

      <Dialog open={dlg?.k === "writeoff" && !!inv} onClose={close} confirmLabel={dlg?.k === "writeoff" && dlg.mode === "reverse" ? "Reverse write-off" : "Write off invoice"}
        confirmDisabled={reason.trim().length < WRITE_OFF_REASON_MIN || reason.trim().length > 500}
        title={inv && dlg?.k === "writeoff" ? (dlg.mode === "reverse" ? `Reverse the write-off of invoice ${inv.reference}?` : `Write off invoice ${inv.reference}?`) : ""}
        description={inv && dlg?.k === "writeoff" ? (dlg.mode === "reverse"
          ? `For ${inv.customer}. The invoice is owed again for what was left to pay; its amounts and lines are unchanged.`
          : `For ${inv.customer}. What is still owed is no longer counted as owed and no more payments can be recorded against it. Its amounts and lines are unchanged, and it can be brought back with Reverse write-off.`) : ""}
        onConfirm={() => finish(`${inv?.reference} would be ${dlg?.k === "writeoff" && dlg.mode === "reverse" ? "brought back as owed" : "written off"}. Nothing was changed.`)}>
        <Field label={`Reason (required, at least ${WRITE_OFF_REASON_MIN} characters, kept in the history)`}>
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={dlg?.k === "writeoff" && dlg.mode === "reverse" ? "For example: the customer paid after all" : "For example: the customer has gone into liquidation"} />
        </Field>
      </Dialog>

      <Dialog open={dlg?.k === "deleteDraft" && !!inv} onClose={close} cancelLabel="Keep draft" confirmLabel="Delete draft"
        title={`Delete this draft invoice for ${inv?.customer ?? "the customer"}?`} description="The draft has no invoice number yet. Deleting it removes it for good and it cannot be brought back."
        onConfirm={() => finish("The draft would be deleted. It is still here.")} />
    </>
  );
}

/* ---------------- the invoice sheet ---------------- */

function TotalsBlock({ i, totals, problem }: { i: InvoiceRow; totals: DocumentTotals; problem: string | null }) {
  return (
    <dl className={cx(s.totals, typeScale.body)}>
      {i.lines.length && !problem ? (
        <>
          <div><dt>Subtotal</dt><dd className={tabularNumbers}>{pounds(totals.subtotal)}</dd></div>
          {totals.carriage ? <div><dt>Carriage</dt><dd className={tabularNumbers}>{pounds(totals.carriage)}</dd></div> : null}
          {i.vatEnabled ? (totals.vatBreakdown.filter((r) => !r.exempt).length ? totals.vatBreakdown.filter((r) => !r.exempt).map((r) => <div key={vatRowLabel(r)}><dt>{vatRowLabel(r)}</dt><dd className={tabularNumbers}>{pounds(r.vat)}</dd></div>) : <div><dt>VAT</dt><dd className={tabularNumbers}>{pounds(0)}</dd></div>) : <div><dt>No VAT</dt><dd>-</dd></div>}
          <div className={s.totalRow}><dt>Grand total</dt><dd className={tabularNumbers}>{pounds(totals.total)}</dd></div>
        </>
      ) : <div className={s.totalRow}><dt>Invoice total</dt><dd className={tabularNumbers}>{pounds(i.amount)}</dd></div>}
    </dl>
  );
}

function ViewSheet({ i, isAdmin, onClose, setDlg, preview }: { i: InvoiceRow; isAdmin: boolean; onClose: () => void; setDlg: (d: Dlg | null) => void; preview: (d: string) => void }) {
  const no = shownInvoiceRef(i);
  const totals = totalsOfSeed(i);
  const problem = totalsProblem(i);
  const address = CUSTOMER_ADDRESS[i.customer] ?? [];
  const payments = i.payments ?? [];
  const live = payments.filter((p) => !p.reversesPaymentId);
  const collectible = invoiceLifecycle(i.rawStatus) === "collectible";
  const claimed = Boolean(i.paymentClaimedAt);
  const [pausing, setPausing] = useState(false);
  const draft = i.rawStatus === "draft";
  const canPay = i.status === "overdue" || i.status === "outstanding";
  const credit = customerCredit({ status: i.rawStatus, total: i.amount, amount_paid: i.amountPaid, credited_amount: i.credited, refunded_amount: i.refunded });
  const hasCreditNotes = !draft && !["void", "voided", "cancelled", "canceled", "credited", "written_off"].includes(invoiceStatus(i.rawStatus));
  const first = draft ? "Draft: no number yet and not money owed. Issue it to give it a number; then it can be printed and sent."
    : isVoid(i.rawStatus) ? "Void: not owed." : isWrittenOff(i.rawStatus) ? "Written off: not owed." : i.sentAt ? `Sent ${fmtDate(i.sentAt)}, ${i.sentAt.slice(11, 16)}` : "Not recorded as sent yet";
  const fact = (label: string, value: ReactNode, opts: { wide?: boolean; num?: boolean; line?: boolean } = {}) => (
    <div className={opts.wide ? s.factWide : undefined}><dt className={typeScale.secondary}>{label}</dt><dd className={cx(typeScale.name, opts.num && tabularNumbers, opts.line && s.preline)}>{value}</dd></div>
  );

  return (
    <Sheet open size="lg" title={`${no} invoice details`} description="Invoice details and payments received." onClose={onClose} testId="dlg-view"
      footer={draft ? (
        <div className={s.viewFoot}>
          <p className={cx(typeScale.secondary, s.footNote)}>{first}</p>
          <div className={s.footGroup}>
            <Button variant="danger" onClick={() => setDlg({ k: "deleteDraft", id: i.id })}>Delete Draft</Button>
            <Button variant="secondary" onClick={() => preview("The draft editor would open here.")}>Edit Draft</Button>
            <Button variant="secondary" disabled={Boolean(problem)} onClick={() => setDlg({ k: "issue", id: i.id, andSend: false })}>Issue Invoice</Button>
            <Button variant="primary" disabled={Boolean(problem)} onClick={() => setDlg({ k: "issue", id: i.id, andSend: true })}>Issue &amp; send</Button>
          </div>
        </div>
      ) : (
        <div className={s.viewFoot}>
          <p className={cx(typeScale.secondary, s.footNote)}>{first}</p>
          <div className={s.footGroup}>
            {voidOffered(i) ? <Button variant="danger" onClick={() => setDlg({ k: "void", id: i.id })}>Void Invoice</Button> : null}
            {writeOffOffered(i) ? <Button variant="danger" onClick={() => setDlg({ k: "writeoff", id: i.id, mode: "write_off" })}>Write off</Button> : null}
            {isWrittenOff(i.rawStatus) ? <Button variant="secondary" onClick={() => setDlg({ k: "writeoff", id: i.id, mode: "reverse" })}>Reverse write-off</Button> : null}
            <Button variant="secondary" disabled={Boolean(problem)} onClick={() => preview(`The PDF for ${no} is not generated.`)}>Download PDF</Button>
            {!isVoid(i.rawStatus) ? <Button variant="secondary" disabled={Boolean(problem)} onClick={() => preview(`${no} would be e-mailed now with the PDF attached. No e-mail was sent.`)}>Email now</Button> : null}
            <Button variant="primary" disabled={Boolean(problem)} onClick={() => setDlg({ k: "sentConfirm", id: i.id })}>Send to Customer</Button>
          </div>
        </div>
      )}>
      <div className={s.sheetStack}>
        <dl className={s.facts}>
          <div><dt className={typeScale.secondary}>Customer</dt><dd className={typeScale.name}>{i.customer}</dd><dd className={typeScale.secondary}>{address.slice(1).join(", ")}</dd></div>
          {fact("Status", <StatusBadge tone={toneOf(i)}>{invoiceDetailStatusLabel(i)}</StatusBadge>)}
          {fact("Invoice Date", fmtDate(i.date) || "-")}
          {fact("Due Date", `${fmtDate(i.dueDate) || "-"}${i.status === "overdue" ? ` (${i.daysOverdue} days overdue)` : ""}`)}
          {fact("Payment Terms", i.terms || "-")}
          {i.quoteRef ? fact("Our Quote No.", i.quoteRef, { num: true }) : null}
          {i.customerPo ? fact("Customer PO", i.customerPo, { num: true }) : null}
          {i.deliveryAddress ? fact("Delivery Address", i.deliveryAddress, { line: true }) : null}
          {i.invoiceNote ? fact("Invoice Note", i.invoiceNote, { wide: true }) : null}
          {i.status === "paid" && i.amountPaid <= 0 ? fact("Paid", "Marked paid; the amount received was never recorded")
            : i.amountPaid > 0 ? fact("Paid", `${pounds(i.amountPaid)} received${i.status === "paid" && i.paidAt ? `, settled ${fmtDate(i.paidAt)}` : ""}${i.paymentUnverified ? "; payment to confirm" : i.partPaid ? `; balance due ${pounds(i.balance)}` : ""}`) : null}
        </dl>

        {i.id && collectible ? (
          claimed ? (
            <Callout tone="warn" lead="Payment to confirm" role="status" action={
              <span className={s.btnRow}>
                <Button size="sm" variant="primary" onClick={() => setDlg({ k: "pay", id: i.id })}>Confirm payment received</Button>
                <Button size="sm" variant="secondary" onClick={() => preview("Chasing would resume. Nothing was changed.")}>Not received, resume chasing</Button>
              </span>
            }>The customer says they have paid invoice {no}. Chasing is paused while you check your bank account. This does not mean the payment has been received.</Callout>
          ) : <div aria-label={`Payment check for invoice ${no}`} role="group"><Button size="sm" variant="secondary" onClick={() => preview(`${no} would be marked as customer says paid. Nothing was changed.`)}>Customer says paid</Button></div>
        ) : null}

        {!draft ? (
          <Panel variant="flat" label="Chasing" data-testid="chase-pause-invoice">
            {i.chasePaused ? (
              <div className={s.pauseRow}>
                <div><p className={cx(typeScale.name, s.pauseTitle)}>Chasing paused{i.chasePaused.until ? ` until ${fmtDate(i.chasePaused.until)}` : ""}</p><p className={typeScale.secondary}>Reason: {i.chasePaused.reason}</p><p className={typeScale.caption}>No chase e-mails are drafted for {no} while it is paused.</p></div>
                <Button size="sm" variant="secondary" onClick={() => preview("Chasing would resume. Nothing was changed.")}>Resume chasing</Button>
              </div>
            ) : pausing ? (
              <div className={s.pauseForm}>
                <Field label="Reason"><Input maxLength={300} placeholder="e.g. Query on the delivery" /></Field>
                <Field label="Until" optional><Input type="date" /></Field>
                <div className={s.btnRow}><Button size="sm" variant="primary" onClick={() => { setPausing(false); preview(`Chasing on ${no} would be paused.`); }}>Pause</Button><Button size="sm" variant="quiet" onClick={() => setPausing(false)}>Cancel</Button></div>
              </div>
            ) : (
              <div className={s.pauseRow}><p className={typeScale.secondary}>Chase steps run for {no}.</p><Button size="sm" variant="secondary" onClick={() => setPausing(true)}>Pause chasing</Button></div>
            )}
          </Panel>
        ) : null}

        {i.lines.length ? (
          <ScrollTable label="Invoice lines" dense>
            <thead><tr><th>Description</th><th className={s.right}>Qty</th><th className={s.right}>Unit Price</th><th className={s.right}>Total</th></tr></thead>
            <tbody>
              {i.lines.map((l, n) => (
                <tr key={n}><td className={s.preline}>{l.description}</td><td className={cx(s.right, tabularNumbers)}>{l.quantity}</td><td className={cx(s.right, tabularNumbers)}>{pounds(l.unitPrice)}</td><td className={cx(s.right, tabularNumbers)}>{pounds(documentTotals([{ quantity: l.quantity, unitPrice: l.unitPrice, vatPct: 0 }]).subtotal)}</td></tr>
              ))}
            </tbody>
          </ScrollTable>
        ) : <p className={typeScale.secondary}>No line items recorded for this invoice.</p>}

        <TotalsBlock i={i} totals={totals} problem={problem} />

        {problem ? <Callout tone="error" lead="">{problem}</Callout> : null}

        {!draft ? (
          <Panel title="Payments" headingLevel={3} variant="flat" actions={canPay ? <Button size="sm" variant="primary" onClick={() => setDlg({ k: "pay", id: i.id })}>Record payment</Button> : undefined}>
            {live.length ? (
              <List plain dense label="Payment history">
                {live.map((p) => {
                  const reversal = payments.find((o) => o.reversesPaymentId === p.id);
                  return (
                    <ListRow key={p.id} data-testid="payment-row" className={s.flushRow}
                      title={<span className={cx(s.payCells, reversal && s.struck)}><span className={tabularNumbers}>{p.paidOn ? fmtDate(p.paidOn) : "Date not recorded"}</span><span className={tabularNumbers}>{pounds(p.amount)}</span></span>}
                      meta={[p.method || (p.source === "legacy" ? "Carried over" : ""), p.reference, p.by].filter(Boolean).join(" · ")}
                      trailing={isAdmin && !reversal && p.source !== "legacy" ? <Button size="sm" variant="secondary" onClick={() => setDlg({ k: "reverse", id: i.id, paymentId: p.id })}>Reverse</Button> : undefined}>
                      {reversal ? <span className={cx(typeScale.caption, s.reversed)}>Reversed {fmtDate(reversal.paidOn)}: {reversal.voidReason}</span> : null}
                    </ListRow>
                  );
                })}
              </List>
            ) : <p className={typeScale.secondary}>{paymentsEmptyText({ loaded: true, status: i.status, amountPaid: i.amountPaid })}</p>}
            {i.credited > 0 ? <p className={cx(typeScale.secondary, s.panelNote)}>Credits applied {pounds(i.credited)}, balance due {pounds(i.balance)}.</p> : null}
            {payments.length ? <p className={cx(typeScale.secondary, s.panelNote)}>Received so far {pounds(netPaid(payments))}{i.balance > 0 ? `, balance due ${pounds(i.balance)}` : ""}.</p> : null}
          </Panel>
        ) : null}

        {credit > 0 ? (
          <Callout tone="warn" lead="" action={
            <span className={s.btnRow}>
              <Button size="sm" variant="secondary" onClick={() => preview("The credit would be applied to another invoice.")}>Apply to another invoice</Button>
              {isAdmin ? <Button size="sm" variant="secondary" onClick={() => preview(`A refund of ${pounds(credit)} would be recorded. No refund was made.`)}>Refund</Button> : null}
            </span>
          }><strong>Customer credit {pounds(credit)}</strong> on {i.reference}: paid or credited beyond the invoice. It stays on the account until it is refunded or applied to another invoice.</Callout>
        ) : null}

        <Panel title="Delivery notes" headingLevel={3} variant="flat">
          {i.deliveryNotes?.length ? (
            <List plain dense label="Delivery notes on this invoice">
              {i.deliveryNotes.map((n) => (
                <ListRow key={n.ref} className={s.flushRow} title={<Ref>{n.ref}</Ref>} meta={<span className={tabularNumbers}>{fmtDate(n.date)}</span>}
                  trailing={<><StatusBadge tone="info">{n.status}</StatusBadge><Button size="sm" variant="quiet" onClick={() => preview(`${n.ref} would open for printing.`)}>Open / print</Button></>} />
              ))}
            </List>
          ) : <p className={typeScale.secondary}>No delivery notes are linked to this invoice yet.</p>}
        </Panel>

        {hasCreditNotes ? (
          <Panel title="Credit notes" headingLevel={3} variant="flat" actions={<Button size="sm" variant="secondary" onClick={() => preview("The credit note form would open.")}>New credit note</Button>}>
            {i.creditNotes?.length ? (
              <List plain dense label="Credit notes for this invoice">
                {i.creditNotes.map((c) => (
                  <ListRow key={c.ref ?? "draft"} data-testid="credit-note-row" className={s.flushRow} title={<><Ref>{c.ref ?? "Draft"}</Ref> <span className={cx(typeScale.name, tabularNumbers)}>{pounds(c.total)}</span></>}
                    meta={<><span className={tabularNumbers}>{fmtDate(c.date)}</span> · {c.status === "draft" ? "Not issued" : `${pounds(c.allocated)} applied to ${i.reference}, ${pounds(fromPence(toPence(c.total) - toPence(c.allocated)))} left`}</>}
                    trailing={c.status === "issued" ? <Button size="sm" variant="secondary" onClick={() => preview(`The PDF for ${c.ref} is not generated.`)}>Download PDF</Button> : undefined} />
                ))}
              </List>
            ) : <p className={typeScale.secondary}>No credit notes against this invoice.</p>}
          </Panel>
        ) : null}

        {i.status === "unverified" ? (
          <Callout tone="warn" lead="" role="status" action={
            <span className={s.btnRow}>
              {isAdmin ? <Button size="sm" variant="secondary" onClick={() => setDlg({ k: "confirmComplete", id: i.id })}>Confirm Still Owed</Button> : null}
              <Button size="sm" variant="primary" onClick={() => setDlg({ k: "pay", id: i.id })}>Record payment</Button>
            </span>
          }>Imported without payment details. Check your records: record each payment you find, then confirm the payments are complete (with none recorded, that it is still owed in full). Recording a payment does not settle that by itself. Until you confirm, it isn&apos;t counted as money owed or chased.</Callout>
        ) : null}

        <Disclosure summary="Activity">
          <ul className={s.activityList}>
            <li><span className={tabularNumbers}>{fmtDate(i.createdAt)}</span> Fiona MacLeod created this invoice.</li>
            {!draft && i.sentAt ? <li><span className={tabularNumbers}>{fmtDate(i.sentAt)}</span> Fiona MacLeod recorded it as sent.</li> : null}
            {payments.length ? <li><span className={tabularNumbers}>{fmtDate(payments[payments.length - 1].paidOn)}</span> A payment of {pounds(Math.abs(payments[payments.length - 1].amount))} was {payments[payments.length - 1].reversesPaymentId ? "reversed" : "recorded"}.</li> : null}
          </ul>
        </Disclosure>
      </div>
    </Sheet>
  );
}

/* ---------------- record payment ---------------- */

function PaymentSheet({ i, onClose, preview }: { i: InvoiceRow; onClose: () => void; preview: (d: string) => void }) {
  const balance = balanceDue(i.amount, i.amountPaid, i.credited, i.refunded);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [date, setDate] = useState(TODAY);
  const [method, setMethod] = useState("BACS");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const problem = paymentAmountProblem(Number(amount), balance) ?? paymentDateProblem(date, TODAY);
    if (problem) { setError(problem); return; }
    preview(`A payment of ${pounds(Number(amount))} would be recorded on ${i.reference}. No payment was recorded.`);
  };
  return (
    <Sheet open size="sm" title={`Record a payment on ${i.reference}`} onClose={onClose} testId="dlg-pay" closeButton={false}
      description={`Invoice total ${pounds(i.amount)}${i.amountPaid > 0 ? `, ${pounds(i.amountPaid)} already received` : ""}. Balance due ${pounds(balance)}. The amount starts as the full balance: change it for a part payment.`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" onClick={() => { setAmount(balance.toFixed(2)); setError(null); }}>Pay balance in full</Button>
        <Button variant="primary" onClick={submit}>Save payment</Button>
      </>}>
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className={s.formGrid}>
          <Field label="Amount received (£)"><Input type="number" step="0.01" min="0.01" inputMode="decimal" required value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} /></Field>
          <Field label="Date received"><Input type="date" required max={TODAY} value={date} onChange={(e) => { setDate(e.target.value); setError(null); }} /></Field>
          <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m === "BACS" ? "BACS" : m[0].toUpperCase() + m.slice(1)}</option>)}</Select></Field>
          <Field label="Reference" optional><Input maxLength={100} placeholder="Cheque no. or bank reference" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
        {error ? <Callout tone="error" lead="">{error}</Callout> : null}
        <p className={typeScale.caption}>Preview only. No payment is recorded and no accounting system is contacted.</p>
      </form>
    </Sheet>
  );
}

/* ---------------- invoice from delivery notes ---------------- */

function FromNotesSheet({ onClose, preview }: { onClose: () => void; preview: (d: string) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [date, setDate] = useState(TODAY);
  const [due, setDue] = useState(addDays(TODAY, 30));
  return (
    <Sheet open size="md" title="Invoice from delivery notes" description="Choose the delivery notes to invoice. The lines and prices come from the order, so there is nothing to type. A delivery note can be invoiced once." onClose={onClose} testId="dlg-from-notes" closeButton={false}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!chosen.length} onClick={() => preview(`A draft invoice would be made from ${chosen.length} delivery note${chosen.length === 1 ? "" : "s"}.`)}>{`Make draft invoice${chosen.length > 1 ? ` from ${chosen.length} notes` : ""}`}</Button>
      </>}>
      <div className={s.sheetStack}>
        <List label="Delivery notes to invoice">
          {FROM_NOTES.map((n) => (
            <ListRow key={n.id} leading={<Checkbox id={`fn-${n.id}`} aria-label={`Invoice ${n.ref}`} checked={chosen.includes(n.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, n.id] : c.filter((x) => x !== n.id)))} />}
              title={<label htmlFor={`fn-${n.id}`} className={s.pickLabel}><Ref>{n.ref}</Ref> <span className={typeScale.body}>{n.customer}</span></label>}
              trailing={<span className={cx(typeScale.secondary, tabularNumbers)}>{fmtDate(n.date)}, {n.status}</span>} />
          ))}
        </List>
        <div className={s.formGrid}>
          <Field label="Invoice date"><Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setDue(addDays(e.target.value, 30)); }} /></Field>
          <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        </div>
        <p className={typeScale.caption}>Preview only. Nothing is read from your delivery notes and no invoice is made.</p>
      </div>
    </Sheet>
  );
}

/* ---------------- create invoice ---------------- */

type ExtraLine = { description: string; qty: string; unit: string; vat: VatChoice };

function NewInvoiceSheet({ onClose, preview }: { onClose: () => void; preview: (d: string) => void }) {
  const [customer, setCustomer] = useState("");
  const [date, setDate] = useState(TODAY);
  const [terms, setTerms] = useState("30 days");
  const [due, setDue] = useState(addDays(TODAY, 30));
  const [dueTouched, setDueTouched] = useState(false);
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("");
  const [carriage, setCarriage] = useState("");
  const [vatOn, setVatOn] = useState(true);
  const [vatChoice, setVatChoice] = useState<VatChoice>("20");
  const [extra, setExtra] = useState<ExtraLine[]>([]);
  const [tried, setTried] = useState(false);
  const [signal, setSignal] = useState(0);
  useEffect(() => { if (!dueTouched) setDue(addDays(date || TODAY, termsDays(terms))); }, [date, terms, dueTouched]);
  const totals = documentTotals([
    { quantity: Number(qty) || 0, unitPrice: Number(unit) || 0, ...fromVatChoice(vatChoice) },
    ...extra.map((l) => ({ quantity: Number(l.qty) || 0, unitPrice: Number(l.unit) || 0, ...fromVatChoice(l.vat) })),
  ], Number(carriage) || 0, { vatEnabled: vatOn, carriageVat: true, standardRate: 20 });
  const problems = [
    ...(customer ? [] : [{ fieldId: "inv-customer", message: "Choose a customer.", label: "Customer" }]),
    ...(unit ? [] : [{ fieldId: "inv-unit", message: "Enter a unit price.", label: "Unit price (ex VAT)" }]),
  ];
  const submit = () => { setTried(true); if (problems.length) { setSignal((n) => n + 1); return; } preview(`A draft invoice for ${customer} totalling ${pounds(totals.total)} would be saved. No invoice was created.`); };
  const setX = (n: number, patch: Partial<ExtraLine>) => setExtra((rows) => rows.map((r, k) => (k === n ? { ...r, ...patch } : r)));
  return (
    <Sheet open size="lg" title="Create Invoice" description="Enter the invoice details. With VAT on, the line is taxed at its rate and carriage at the standard rate." onClose={onClose} testId="dlg-new" closeButton={false}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save Invoice</Button></>}>
      <form className={s.form} noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {tried && problems.length ? <ErrorSummary errors={problems} focusSignal={signal} headingLevel={3} /> : null}
        <div className={s.formGrid}>
          <Field id="inv-customer" label="Customer" required error={tried && !customer ? "Choose a customer." : undefined}>
            <Select value={customer} onChange={(e) => setCustomer(e.target.value)}><option value="">Select customer...</option>{Object.keys(CUSTOMER_ADDRESS).map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          </Field>
          <Field label="Job" optional hint="Fills the customer, quote and PO."><Select defaultValue=""><option value="">Job (optional): fills the customer, quote and PO</option><option>JOB-2211 Manifold blocks</option><option>JOB-2208 Brake brackets</option></Select></Field>
          <Field label="Invoice date"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Due date"><Input type="date" required value={due} onChange={(e) => { setDueTouched(true); setDue(e.target.value); }} /></Field>
          <Field label="Terms"><Select value={terms} onChange={(e) => setTerms(e.target.value)}><option>30 days</option><option>14 days</option><option>Due on receipt</option></Select></Field>
          <Field label="Our quote no." optional><Input maxLength={50} placeholder="QUO-0123" /></Field>
          <Field label="Customer PO" optional><Input maxLength={100} placeholder="Customer PO" /></Field>
          <Field label="Tax point" optional hint="Only if different from the invoice date."><Input type="date" /></Field>
        </div>
        <Field label="Description" required><Textarea maxLength={500} placeholder="Description" /></Field>
        <div className={s.formGrid3}>
          <Field label="Quantity"><Input type="number" step="0.001" min="0" inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field id="inv-unit" label="Unit price (ex VAT)" required error={tried && !unit ? "Enter a unit price." : undefined}><Input type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
          <Field label="Carriage (ex VAT)" optional><Input type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={carriage} onChange={(e) => setCarriage(e.target.value)} /></Field>
        </div>
        {extra.map((l, n) => (
          <div key={n} className={s.extraRow}>
            <Field label={`Line ${n + 2} description`}><Input maxLength={500} placeholder="Description" value={l.description} onChange={(e) => setX(n, { description: e.target.value })} /></Field>
            <Field label="Qty"><Input type="number" step="0.001" min="0" inputMode="decimal" value={l.qty} onChange={(e) => setX(n, { qty: e.target.value })} /></Field>
            <Field label="Unit price"><Input type="number" step="0.01" min="0" inputMode="decimal" placeholder="0.00" value={l.unit} onChange={(e) => setX(n, { unit: e.target.value })} /></Field>
            <Field label="VAT rate"><Select value={l.vat} disabled={!vatOn} onChange={(e) => setX(n, { vat: e.target.value as VatChoice })}>{VAT_CHOICES.map((v) => <option key={v} value={v}>{VAT_CHOICE_LABELS[v]}</option>)}</Select></Field>
            <Button variant="quiet" size="sm" aria-label={`Remove line ${n + 2}`} onClick={() => setExtra((r) => r.filter((_, k) => k !== n))}>Remove</Button>
          </div>
        ))}
        <div><Button variant="secondary" size="sm" onClick={() => setExtra((r) => [...r, { description: "", qty: "1", unit: "", vat: "20" }])}>Add another line</Button></div>
        <div className={s.bFoot}>
          <div className={s.vatBox}>
            <Switch label="Add VAT" checked={vatOn} onChange={setVatOn} />
            <Field label={extra.length ? "First line VAT" : "Line VAT"}><Select value={vatChoice} disabled={!vatOn} onChange={(e) => setVatChoice(e.target.value as VatChoice)}>{VAT_CHOICES.map((v) => <option key={v} value={v}>{VAT_CHOICE_LABELS[v]}</option>)}</Select></Field>
          </div>
          <dl className={cx(s.totals, typeScale.body)} data-testid="new-totals">
            <div><dt>Subtotal</dt><dd className={tabularNumbers}>{pounds(totals.subtotal)}</dd></div>
            <div><dt>Carriage</dt><dd className={tabularNumbers}>{pounds(totals.carriage)}</dd></div>
            {vatOn ? (totals.vatBreakdown.filter((r) => !r.exempt).length ? totals.vatBreakdown.filter((r) => !r.exempt).map((r) => <div key={vatRowLabel(r)}><dt>{vatRowLabel(r)}</dt><dd className={tabularNumbers}>{pounds(r.vat)}</dd></div>) : <div><dt>VAT</dt><dd className={tabularNumbers}>{pounds(0)}</dd></div>) : <div><dt>No VAT</dt><dd>-</dd></div>}
            <div className={s.totalRow}><dt>Grand total</dt><dd className={tabularNumbers}>{pounds(totals.total)}</dd></div>
          </dl>
        </div>
        <p className={typeScale.caption}>Preview only. Saving does not create an invoice.</p>
      </form>
    </Sheet>
  );
}
