"use client";

/**
 * BOUNDARY (Jobs module 2, PREVIEW ONLY, v2 on the shared premium set). Inputs: none from the server. Everything shown is fictional sample data copied from the
 * design parity fixture (24 jobs, 20 open), held in this file, plus the person's clicks. Outputs: the Job Board look-and-feel prototype (Cards, List, Table,
 * filters, selection, Columns, Export, row actions, preview dialogs) that changes LOCAL STATE ONLY. It never reads or writes Supabase, calls no server action or
 * API route, imports no lib/ business module (only the shared UI set in components/ui/premium), and every committing action says plainly that nothing was saved.
 * The typed data and the pure state logic (the first half) are exported for tests/unit/jobsPreview.test.ts; the presentation is built from components/ui/premium
 * (PreviewBar, PageHeader, StatTile, SegmentedControl, Popover, Menu, SelectionBar, ScrollTable, StackedRows, StatusBadge, Dialog, Sheet, Toast, Callout, state panels).
 * Structural changes approved by the owner (STRUCTURAL-CHANGES-BRIEF 1, 2, 4, 7, 9, 10, 11): Show and Due are inline segmented quick filters, every other filter lives in a
 * "Filters (n)" popover with removable chips and one "Clear filters"; the bulk bar shows only while a row is ticked (a quiet count line holds its place); the generic page
 * sentence moved to a tooltip and a screen-reader description of the title; each row has ONE primary action and a "More" menu; one PreviewBar strip; the v4 type scale.
 * MUST NOT CHANGE: wording, defaults (List view, Show Open, no other filter), the 14 columns and their order, role gating and action order mirror today's Job Board
 * (app/(dashboard)/jobs/page.tsx, lib/job-flow.ts, lib/job-status.ts, lib/job-actions.ts). Do not wire this file to real data or real actions; do not add controls the
 * real board does not have (no tabs, search box or sort). Row controls keep a 48 px hit area (e2e rule).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import {
  Button, Callout, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, Field, FilterChip, Input, LoadingState, Menu, PageHeader, Popover, PreviewBar, ScrollTable,
  SegmentedControl, Select, SelectionBar, Sheet, StackedRows, StatTile, StatTiles, StatusBadge, Switch, Textarea, ToastProvider, cx, focusFirstInvalid, premiumTokens, srOnly,
  tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { MenuItem, StatusTone } from "@/components/ui/premium";

import s from "./JobsPreview.module.css";

/* ================================================================== */
/* 1. Types                                                            */
/* ================================================================== */

export type Role = "admin" | "office" | "workshop" | "viewer";
export type ViewMode = "cards" | "list" | "table";
export type Status = "not_started" | "running" | "paused" | "waiting" | "complete";
export type DueLight = "On time" | "At risk" | "Late" | "No due date";
export type Stage = "Material" | "Setup" | "Machining" | "Inspection";
export type ShowFilter = "open" | "complete" | "archived" | "all";
export type TypeFilter = "all" | "customer" | "internal";
export type GroupBy = "none" | "machine";
export type DueFilter = "all" | DueLight;
export type Tile = "open" | "not_started" | "running" | "waiting" | "complete";
export type Screen = "ready" | "loading" | "error" | "empty" | "offline" | "truncated";
export type ColumnKey = "ref" | "customer" | "description" | "specification" | "drawings" | "attachments" | "stage" | "machine" | "operator" | "due" | "started" | "finished" | "inspection" | "actions";

type SeedJob = {
  ref: string; internal: boolean; relTo: string | null; relFrom: string[]; customer: string; description: string; specification: string;
  drawings: string; attachments: string; stage: Stage | null; status: Status; due: DueLight | null; dueText: string | null; rework: boolean; problem: boolean;
  progress: string; started: string; finished: string; inspection: string; reworkNote: string | null; parts: string | null;
  pick: string | null; inUse: string | null; timer: string | null; addMachine: boolean; release: boolean; planned: string | null;
  operator: string; pausedBy: string | null; createdAt: string; archived: boolean; inspectAdminOnly: boolean;
};

export type Job = Omit<SeedJob, "operator"> & { assignee: string | null; preview?: boolean };

export type ActionLabel = "Start" | "Resume" | "Start timer" | "Pick a machine" | "Pause" | "Finish" | "Finished" | "Inspected" | "Reopen" | "Release early" | "Rework" | "Worksheet" | "Machines" | "Print" | "Delivery note" | "Send" | "Archive";
export type Action = { label: ActionLabel; disabled: boolean };

/* ================================================================== */
/* 2. Typed sample data (fictional; copied from the design parity fixture, computed there with Tolra's real logic) */
/* ================================================================== */

export const PREVIEW_TODAY = "2026-11-20";
export const PREVIEW_NOW = "20/11/2026, 10:30";
export const ME = "Sam Okoro";
export const PEOPLE = ["Sam Okoro", "Callum", "Mairi", "Tomasz", "Dave", "Ellie", "Priya"] as const;
export const MACHINES = ["VMC 1", "VMC 2", "Lathe 1", "Lathe 2", "Waterjet", "Weld bay 1", "Weld bay 2", "Press brake"] as const;
export const COLUMNS: Array<{ key: ColumnKey; label: string; locked?: boolean }> = [
  { key: "ref", label: "Job No", locked: true }, { key: "customer", label: "Customer" }, { key: "description", label: "Description" },
  { key: "specification", label: "Specification" }, { key: "drawings", label: "Drawings" }, { key: "attachments", label: "Attachments" },
  { key: "stage", label: "Stage" }, { key: "machine", label: "Machine" }, { key: "operator", label: "Operator" },
  { key: "due", label: "Due", locked: true }, { key: "started", label: "Started" }, { key: "finished", label: "Finished" },
  { key: "inspection", label: "Inspection" }, { key: "actions", label: "Actions", locked: true },
];
export const STAGES: Stage[] = ["Material", "Setup", "Machining", "Inspection"];
export const STATUS_WORD: Record<Status, string> = { not_started: "Not started", running: "Running", paused: "Paused", waiting: "Waiting for inspection", complete: "Complete" };
export const EMPTY_HINT: Record<Role, string> = {
  admin: "No jobs yet. Convert a confirmed sales order to a job, or press New job to add one.",
  office: "No jobs yet. Convert a confirmed sales order to a job, or press New job to add one.",
  workshop: "No jobs yet. Press New job to add one, or ask the office to send jobs through from sales orders.",
  viewer: "No jobs yet. Jobs show here once the office adds them.",
};
export const AVERAGE_JOB_TIME = { days: "5.8 d", hours: "139.1 h" };

// SEED_BEGIN
const SEED: SeedJob[] = [
  {"ref": "J-0434", "internal": true, "relTo": "J-0418", "relFrom": [], "customer": "Internal", "description": "Tooling: vice jaws for J-0418", "specification": "Internal: soft jaws for the manifold blocks.", "drawings": "None", "attachments": "None", "stage": "Setup", "status": "not_started", "due": "On time", "dueText": "23/11/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Pick a machine", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "VMC 2 4 h (booked)", "operator": "Assigned to Tomasz", "pausedBy": null, "createdAt": "2026-11-20T08:45:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0433", "internal": false, "relTo": null, "relFrom": [], "customer": "Fenwick Packaging", "description": "Hopper lids", "specification": "2 mm stainless sheet, laser blank, fold.", "drawings": "None", "attachments": "PO-FP-3318.pdf", "stage": "Material", "status": "not_started", "due": "At risk", "dueText": "23/11/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Press brake", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Press brake 3 h (booked)", "operator": "Assigned to Priya", "pausedBy": null, "createdAt": "2026-11-20T08:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0432", "internal": false, "relTo": null, "relFrom": [], "customer": "Brigg Agricultural", "description": "Hydraulic ram sleeves", "specification": "Honed tube, hand-finish on the bench, 6 off.", "drawings": "None", "attachments": "PO-BA-8872.pdf", "stage": "Machining", "status": "running", "due": "On time", "dueText": "27/11/2026", "rework": false, "problem": false, "progress": "On the bench", "started": "20/11/2026, 08:15", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "N/A (bench)", "inUse": null, "timer": "Bench: running for 2:15", "addMachine": true, "release": false, "planned": "Lathe 2 6 h (booked)", "operator": "Assigned to Dave", "pausedBy": null, "createdAt": "2026-11-20T07:40:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0431", "internal": false, "relTo": null, "relFrom": [], "customer": "Wensley Sports Equipment", "description": "Gland plate; Spacer ring", "specification": "- Gland plate [GP-114] x 20\n- Spacer ring [SR-22] x 40", "drawings": "WSE-GP-114.pdf", "attachments": "PO-WSE-6144.pdf", "stage": "Setup", "status": "not_started", "due": "On time", "dueText": "10/12/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Lathe 1", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 1 6 h (booked)", "operator": "Assigned to You", "pausedBy": null, "createdAt": "2026-11-19T13:30:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0430", "internal": false, "relTo": null, "relFrom": [], "customer": "Fenwick Packaging", "description": "Roller end caps", "specification": "Acetal rod, turn caps, 60 off.", "drawings": "None", "attachments": "PO-FP-3310.pdf", "stage": "Material", "status": "not_started", "due": "On time", "dueText": "04/12/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Pick a machine", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Weld bay 1 5 h", "operator": "Unassigned", "pausedBy": null, "createdAt": "2026-11-19T11:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0429", "internal": false, "relTo": "J-0398", "relFrom": [], "customer": "Kestrel Instruments", "description": "Rework: sensor mounts, bore oversize", "specification": "Re-bore to 25.00 +0.03 and re-measure.", "drawings": "None", "attachments": "PO-KI-4980.pdf", "stage": null, "status": "running", "due": "At risk", "dueText": "21/11/2026", "rework": true, "problem": false, "progress": "Failed inspection, being reworked", "started": "17/11/2026, 08:30", "finished": "19/11/2026, 14:00", "inspection": "Failed: sent to rework", "reworkNote": "Rework under way: All 12. Bore oversize.", "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "VMC 1 3 h (done)", "operator": "Assigned to Callum", "pausedBy": null, "createdAt": "2026-11-19T09:15:00Z", "archived": false, "inspectAdminOnly": true},
  {"ref": "J-0428", "internal": true, "relTo": null, "relFrom": [], "customer": "Ardent Rail Components", "description": "Jig fixture for J-0422", "specification": "Internal: weld fixture for the clamp plates.", "drawings": "None", "attachments": "None", "stage": "Machining", "status": "running", "due": "On time", "dueText": "30/11/2026", "rework": false, "problem": false, "progress": "Running on Weld bay 1", "started": "18/11/2026, 10:00", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": null, "inUse": "Weld bay 1, since 20/11/2026, 08:00", "timer": "Weld bay 1: running for 2:30", "addMachine": true, "release": true, "planned": "Weld bay 1 16 h (running)", "operator": "Assigned to Ellie", "pausedBy": null, "createdAt": "2026-11-19T07:50:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0427", "internal": false, "relTo": null, "relFrom": [], "customer": "Kestrel Instruments", "description": "Sensor mounts", "specification": "Anodised aluminium mounts, 50 off, mill and drill.", "drawings": "KI-MOUNT-09.pdf", "attachments": "PO-KI-5012.pdf", "stage": "Setup", "status": "paused", "due": "On time", "dueText": "03/12/2026", "rework": false, "problem": false, "progress": "Paused", "started": "19/11/2026, 13:00", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Press brake", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Press brake 7 h (booked)", "operator": "Assigned to Callum", "pausedBy": "Paused by Callum 09:55", "createdAt": "2026-11-18T15:40:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0426", "internal": false, "relTo": null, "relFrom": [], "customer": "Brigg Agricultural", "description": "Hopper brackets", "specification": "6 mm steel, cut and weld, 24 off.", "drawings": "None", "attachments": "PO-BA-8860.pdf", "stage": "Machining", "status": "running", "due": "At risk", "dueText": "26/11/2026", "rework": false, "problem": true, "progress": "Running on Weld bay 2", "started": "19/11/2026, 09:10", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": null, "inUse": "Weld bay 2, since 20/11/2026, 09:10", "timer": "Weld bay 2: running for 1:20", "addMachine": true, "release": true, "planned": "Weld bay 2 9 h (running), VMC 2 2.5 h (booked)", "operator": "Assigned to Mairi", "pausedBy": null, "createdAt": "2026-11-18T10:25:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0425", "internal": false, "relTo": null, "relFrom": [], "customer": "Wensley Sports Equipment", "description": "Gym rack uprights", "specification": "Square tube, cut, drill, weld, powder-coat ready.", "drawings": "WSE-UPRIGHT-02.pdf", "attachments": "PO-WSE-6120.pdf", "stage": "Inspection", "status": "waiting", "due": null, "dueText": "17/11/2026", "rework": false, "problem": false, "progress": "Waiting for inspection", "started": "12/11/2026, 07:45", "finished": "18/11/2026, 16:00", "inspection": "Not inspected", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 2 5 h (done), VMC 1 3.5 h (done)", "operator": "Assigned to Tomasz", "pausedBy": null, "createdAt": "2026-11-18T08:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0424", "internal": false, "relTo": null, "relFrom": [], "customer": "Northgate Marine Fabrication", "description": "Rudder pintles", "specification": "Duplex stainless, turn, polish bearing faces.", "drawings": "None", "attachments": "PO-NMF-5541.pdf", "stage": "Inspection", "status": "waiting", "due": null, "dueText": "23/11/2026", "rework": false, "problem": false, "progress": "Waiting for inspection", "started": "16/11/2026, 08:20", "finished": "19/11/2026, 11:30", "inspection": "Not inspected", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 1 4 h (done)", "operator": "Assigned to Dave", "pausedBy": null, "createdAt": "2026-11-17T14:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0423", "internal": false, "relTo": null, "relFrom": [], "customer": "Tamar Hydraulics", "description": "Valve spools", "specification": "EN24T, turn and grind to 0.005, 20 off.", "drawings": "TH-SPOOL-31.pdf", "attachments": "PO-TH-2188.pdf", "stage": "Inspection", "status": "waiting", "due": null, "dueText": "20/11/2026", "rework": false, "problem": false, "progress": "Waiting for inspection", "started": "13/11/2026, 07:50", "finished": "19/11/2026, 15:10", "inspection": "Not inspected", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "VMC 2 6 h (done)", "operator": "Assigned to Callum", "pausedBy": null, "createdAt": "2026-11-17T08:10:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0422", "internal": false, "relTo": null, "relFrom": [], "customer": "Ardent Rail Components", "description": "Cable clamp plates", "specification": "5 mm aluminium plate, 100 off, no due date agreed yet.", "drawings": "None", "attachments": "None", "stage": "Material", "status": "not_started", "due": "No due date", "dueText": null, "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Pick a machine", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": null, "operator": "Assigned to Priya", "pausedBy": null, "createdAt": "2026-11-16T09:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0421", "internal": false, "relTo": null, "relFrom": [], "customer": "Calder Valley Pumps Ltd", "description": "Bearing housings", "specification": "No specification recorded.", "drawings": "CVP-2240-A.pdf", "attachments": "PO-CV-77184.pdf", "stage": "Material", "status": "not_started", "due": "On time", "dueText": "27/11/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Pick a machine", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "VMC 1 6 h (booked)", "operator": "Unassigned", "pausedBy": null, "createdAt": "2026-11-13T11:10:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0420", "internal": false, "relTo": null, "relFrom": [], "customer": "Fenwick Packaging", "description": "Guard brackets", "specification": "3 mm mild steel, laser blank then fold on the press brake. 30 off.", "drawings": "None", "attachments": "PO-FP-3302.pdf", "stage": "Setup", "status": "not_started", "due": "On time", "dueText": "25/11/2026", "rework": false, "problem": false, "progress": "Not started", "started": "Not started", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Press brake", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Press brake 4 h (booked)", "operator": "Assigned to Ellie", "pausedBy": null, "createdAt": "2026-11-13T08:30:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0419", "internal": false, "relTo": null, "relFrom": [], "customer": "Brigg Agricultural", "description": "PTO shaft collars", "specification": "EN8 steel, turn and part off, 40 off, keyway cut.", "drawings": "BA-COLLAR-07.pdf", "attachments": "PO-BA-8841.pdf", "stage": "Machining", "status": "running", "due": "At risk", "dueText": "24/11/2026", "rework": false, "problem": false, "progress": "Started (not timed)", "started": "19/11/2026, 07:30", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": "Lathe 2", "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 2 10 h (booked)", "operator": "Assigned to Dave", "pausedBy": null, "createdAt": "2026-11-12T13:45:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0418", "internal": false, "relTo": null, "relFrom": ["J-0434"], "customer": "Tamar Hydraulics", "description": "Manifold blocks", "specification": "Aluminium blocks, drill and tap six ports, pressure-test ready.", "drawings": "TH-MAN-220.pdf", "attachments": "PO-TH-2209.pdf", "stage": "Machining", "status": "running", "due": "On time", "dueText": "20/11/2026", "rework": false, "problem": false, "progress": "Running on VMC 2", "started": "18/11/2026, 07:55", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": "5 of 12 parts", "pick": null, "inUse": "VMC 2, since 20/11/2026, 07:55", "timer": "VMC 2: running for 2:35", "addMachine": true, "release": true, "planned": "VMC 2 8 h (running)", "operator": "Assigned to Tomasz", "pausedBy": null, "createdAt": "2026-11-12T10:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0415", "internal": false, "relTo": null, "relFrom": [], "customer": "Northgate Marine Fabrication", "description": "Hatch frame set", "specification": "316 stainless, waterjet profile then weld and dress. 4 off.", "drawings": "NMF-HATCH-014.pdf", "attachments": "PO-NMF-5530.pdf", "stage": "Machining", "status": "running", "due": "Late", "dueText": "19/11/2026", "rework": false, "problem": false, "progress": "Running on Waterjet", "started": "17/11/2026, 08:00", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": null, "pick": null, "inUse": "Waterjet, since 20/11/2026, 08:05", "timer": "Waterjet: running for 2:25", "addMachine": true, "release": true, "planned": "Waterjet 3 h (running), Weld bay 1 5 h (booked)", "operator": "Assigned to Mairi", "pausedBy": null, "createdAt": "2026-11-11T09:20:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0412", "internal": false, "relTo": null, "relFrom": [], "customer": "Calder Valley Pumps Ltd", "description": "Impeller housing", "specification": "6082-T6 aluminium, 12 off. CNC milling, 3 setups, bore 62 H7, deburr, first-off inspect.", "drawings": "CVP-2231-B-revC.pdf", "attachments": "PO-CV-77120.pdf", "stage": "Machining", "status": "running", "due": "Late", "dueText": "18/11/2026", "rework": false, "problem": false, "progress": "Running on VMC 1", "started": "16/11/2026, 07:40", "finished": "Not finished", "inspection": "Not finished", "reworkNote": null, "parts": "3 of 12 parts", "pick": null, "inUse": "VMC 1, since 20/11/2026, 07:40", "timer": "VMC 1: running for 2:50", "addMachine": true, "release": true, "planned": "VMC 1 12 h (running)", "operator": "Assigned to Callum", "pausedBy": null, "createdAt": "2026-11-10T08:05:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0411", "internal": false, "relTo": null, "relFrom": [], "customer": "Ardent Rail Components", "description": "Bracket set", "specification": "Bent and welded brackets.", "drawings": "None", "attachments": "None", "stage": null, "status": "complete", "due": null, "dueText": "13/11/2026", "rework": false, "problem": false, "progress": "Inspected", "started": "05/11/2026, 07:50", "finished": "12/11/2026, 16:00", "inspection": "Inspected (before inspection records)", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Press brake 5 h (done)", "operator": "Assigned to Ellie", "pausedBy": null, "createdAt": "2026-11-06T10:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0410", "internal": false, "relTo": null, "relFrom": [], "customer": "Northgate Marine Fabrication", "description": "Cleat plates", "specification": "Waterjet profile, deburr.", "drawings": "None", "attachments": "None", "stage": null, "status": "complete", "due": null, "dueText": "20/11/2026", "rework": false, "problem": false, "progress": "Inspected", "started": "11/11/2026, 08:00", "finished": "16/11/2026, 12:00", "inspection": "Passed", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Waterjet 6 h (done)", "operator": "Assigned to Mairi", "pausedBy": null, "createdAt": "2026-11-05T09:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0409", "internal": false, "relTo": null, "relFrom": [], "customer": "Tamar Hydraulics", "description": "Piston rods", "specification": "Hard chrome rod stock, turn to length.", "drawings": "None", "attachments": "None", "stage": null, "status": "complete", "due": null, "dueText": "19/11/2026", "rework": false, "problem": false, "progress": "Inspected", "started": "10/11/2026, 08:10", "finished": "17/11/2026, 14:20", "inspection": "Passed", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 1 9 h (done)", "operator": "Assigned to Dave", "pausedBy": null, "createdAt": "2026-11-04T08:30:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0408", "internal": false, "relTo": null, "relFrom": [], "customer": "Calder Valley Pumps Ltd", "description": "Seal carriers", "specification": "Bronze, turn and bore.", "drawings": "None", "attachments": "None", "stage": null, "status": "complete", "due": null, "dueText": "16/11/2026", "rework": false, "problem": false, "progress": "Inspected", "started": "09/11/2026, 08:00", "finished": "13/11/2026, 15:00", "inspection": "Passed", "reworkNote": null, "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "Lathe 2 8 h (done), VMC 1 4 h (done)", "operator": "Assigned to Tomasz", "pausedBy": null, "createdAt": "2026-11-03T08:00:00Z", "archived": false, "inspectAdminOnly": false},
  {"ref": "J-0398", "internal": false, "relTo": null, "relFrom": ["J-0429"], "customer": "Kestrel Instruments", "description": "Sensor housings", "specification": "Anodised aluminium housings, 12 off.", "drawings": "None", "attachments": "PO-KI-4901.pdf", "stage": null, "status": "running", "due": "Late", "dueText": "18/11/2026", "rework": true, "problem": false, "progress": "Failed inspection, being reworked", "started": "02/11/2026, 08:00", "finished": "12/11/2026, 10:00", "inspection": "Failed: sent to rework", "reworkNote": "Waiting for the workshop: 4 of 12. Anodise colour out of tolerance.", "parts": null, "pick": null, "inUse": null, "timer": null, "addMachine": false, "release": false, "planned": "VMC 1 10 h (done)", "operator": "Assigned to Callum", "pausedBy": null, "createdAt": "2026-10-26T09:00:00Z", "archived": false, "inspectAdminOnly": true},
];
// SEED_END

const assigneeOf = (operator: string): string | null => {
  if (operator === "Unassigned") return null;
  const name = operator.replace(/^Assigned to /, "");
  return name === "You" ? ME : name;
};

export const initialJobs = (): Job[] => SEED.map(({ operator, ...rest }) => ({ ...rest, relFrom: [...rest.relFrom], assignee: assigneeOf(operator) }));

/* ================================================================== */
/* 3. Pure logic: rules, filters, counts, actions, local operations     */
/* ================================================================== */

const open = (j: Job) => j.status !== "complete" && !j.archived;
const unfinished = (j: Job) => j.status === "not_started" || j.status === "running" || j.status === "paused";
export const inRework = (j: Job) => j.rework && j.status === "running";
/** The due light shows for Not started and Running (paused included) jobs only; a job waiting for inspection or Complete shows its status alone. */
export const showsDueLight = (j: Job) => unfinished(j);
const dueIso = (text: string | null) => (text ? `${text.slice(6, 10)}-${text.slice(3, 5)}-${text.slice(0, 2)}` : null);
/** J-0415 and J-0412 in the sample: an unfinished job whose required date is before today (a job in rework is not counted). */
export const isOverdue = (j: Job) => !j.rework && unfinished(j) && !!dueIso(j.dueText) && (dueIso(j.dueText) as string) < PREVIEW_TODAY;

export type Filters = { show: ShowFilter; type: TypeFilter; group: GroupBy; due: DueFilter; rework: boolean; stages: Stage[]; tile: Tile | null; listFilter: "overdue" | null };
export const DEFAULT_FILTERS: Filters = { show: "open", type: "all", group: "none", due: "all", rework: false, stages: [], tile: null, listFilter: null };

export function visibleJobs(jobs: Job[], f: Filters): Job[] {
  if (f.listFilter === "overdue") return jobs.filter(isOverdue);
  return jobs.filter((j) => {
    if (f.show === "open" && !open(j)) return false;
    if (f.show === "complete" && !(j.status === "complete" && !j.archived)) return false;
    if (f.show === "archived" && !j.archived) return false;
    if (f.tile === "not_started" && j.status !== "not_started") return false;
    if (f.tile === "running" && j.status !== "running" && j.status !== "paused") return false;
    if (f.tile === "waiting" && j.status !== "waiting") return false;
    if (f.type === "customer" && j.internal) return false;
    if (f.type === "internal" && !j.internal) return false;
    if (f.due !== "all" && !(showsDueLight(j) && j.due === f.due)) return false;
    if (f.rework && !j.rework) return false;
    if (f.stages.length && !(j.stage && f.stages.includes(j.stage))) return false;
    return true;
  });
}

export type Counts = { open: number; complete: number; archived: number; internal: number; notStarted: number; running: number; waiting: number; due: Record<DueLight, number>; rework: number };
export function countsOf(jobs: Job[]): Counts {
  const live = jobs.filter((j) => !j.archived);
  const due: Record<DueLight, number> = { "On time": 0, "At risk": 0, Late: 0, "No due date": 0 };
  for (const j of live) if (showsDueLight(j) && j.due) due[j.due] += 1;
  return {
    open: live.filter((j) => j.status !== "complete").length, complete: live.filter((j) => j.status === "complete").length, archived: jobs.filter((j) => j.archived).length,
    internal: jobs.filter((j) => j.internal).length, notStarted: live.filter((j) => j.status === "not_started").length,
    running: live.filter((j) => j.status === "running" || j.status === "paused").length, waiting: live.filter((j) => j.status === "waiting").length, due,
    rework: live.filter((j) => j.rework && j.status !== "complete").length,
  };
}

/** Which machines a job is planned on ("VMC 1 12 h (running), Lathe 2 5 h (done)" gives VMC 1 and Lathe 2). */
export const plannedMachines = (j: Job): string[] => (j.planned ? j.planned.split(", ").map((x) => x.replace(/ \d+(\.\d+)? h.*$/, "")) : []);

export type MachineGroup = { heading: string; jobs: Job[] };
export function machineGroups(jobs: Job[]): MachineGroup[] {
  const by = new Map<string, Job[]>();
  const none: Job[] = [];
  for (const j of jobs) {
    const names = plannedMachines(j);
    if (!names.length) none.push(j);
    for (const n of names) by.set(n, [...(by.get(n) ?? []), j]);
  }
  const groups = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ heading: `On ${name} (${list.length})`, jobs: list }));
  if (none.length) groups.push({ heading: `No machine (${none.length})`, jobs: none });
  return groups;
}

/** Row actions in the real board's order, gated by role (the sequences are pinned against the parity fixture in the unit test). */
export function actionsFor(j: Job, role: Role, view: ViewMode): Action[] {
  const out: Action[] = [];
  const add = (label: ActionLabel, disabled = false) => out.push({ label, disabled });
  const staff = role !== "viewer";
  const office = role === "admin" || role === "office";
  const rw = inRework(j);
  if (staff && !rw) {
    if (j.status === "not_started") add(j.pick === "Pick a machine" && j.planned ? "Pick a machine" : "Start");
    else if (j.status === "running") add(j.inUse || j.timer ? "Pause" : "Start timer");
    else if (j.status === "paused") add("Resume");
    if (unfinished(j)) add("Finish");
    else add("Finished", true);
  }
  if (staff) {
    if (view === "list") add("Inspected", !(rw ? role === "admin" : j.status === "waiting"));
    else if (j.status === "waiting" || (rw && role === "admin")) add("Inspected");
  }
  if (office && (j.status === "waiting" || j.status === "complete")) add("Reopen");
  if (view !== "list" && role === "admin" && (j.status === "waiting" || rw)) add("Release early");
  if (j.rework) add("Rework");
  add("Worksheet");
  if (staff) add("Machines");
  add("Print");
  if (office && j.finished !== "Not finished") add("Delivery note");
  if (office) add("Send");
  if (view !== "list" && office && j.status === "complete" && !j.archived) add("Archive");
  // A viewer sees Rework (history), Worksheet and Print only; a not-started or running job in rework-free state has no Inspected for them.
  return role === "viewer" ? out.filter((a) => a.label === "Rework" || a.label === "Worksheet" || a.label === "Print") : out;
}

/** What the List's chevron opens (Release early and Archive live there instead of in the row). */
export function expandedActionsFor(j: Job, role: Role): Action[] {
  const out: Action[] = [];
  if (role === "admin" && (j.status === "waiting" || inRework(j))) out.push({ label: "Release early", disabled: false });
  if ((role === "admin" || role === "office") && j.status === "complete" && !j.archived) out.push({ label: "Archive", disabled: false });
  return out;
}

export const actionLine = (actions: Action[]) => actions.map((a) => (a.disabled && a.label === "Inspected" ? `${a.label} (disabled)` : a.label)).join("|");

export function disabledReason(j: Job, label: ActionLabel): string {
  if (label === "Finished") return `${j.ref}: already finished`;
  if (inRework(j)) return `${j.ref}: not available for this job right now`;
  return `${j.ref}: finish the job first, then record the inspection`;
}

export type Op =
  | { type: "start"; machine?: string | null } | { type: "pick"; machine: string }
  | { type: "pause" } | { type: "finish" } | { type: "reopen" } | { type: "releaseEarly" } | { type: "archive" } | { type: "releaseMachine" }
  | { type: "inspect"; result: "pass" | "fail" | "concession" }
  | { type: "assign"; to: string | null };

/** One local change to one job (no network, no storage). The wording of the progress text follows the real board's. */
export function applyOp(j: Job, op: Op): Job {
  switch (op.type) {
    case "start": {
      const machine = op.machine === undefined ? (j.pick && (MACHINES as readonly string[]).includes(j.pick) ? j.pick : null) : op.machine;
      const base = { ...j, status: "running" as Status, stage: "Machining" as Stage, started: j.started === "Not started" ? PREVIEW_NOW : j.started, pausedBy: null };
      return machine
        ? { ...base, pick: machine, inUse: `${machine}, since ${PREVIEW_NOW}`, timer: `${machine}: running for 0:00`, release: true, progress: `Running on ${machine}` }
        : { ...base, pick: "N/A (bench)", inUse: null, timer: "Bench: running for 0:00", release: false, progress: "On the bench" };
    }
    case "pick": return { ...j, pick: op.machine };
    case "pause": return { ...j, status: "paused", inUse: null, timer: null, release: false, progress: "Paused", pausedBy: `Paused by You ${PREVIEW_NOW.slice(12)}` };
    case "finish": return { ...j, status: "waiting", stage: "Inspection", finished: PREVIEW_NOW, inUse: null, timer: null, release: false, progress: "Waiting for inspection", inspection: "Not inspected", pausedBy: null };
    case "inspect":
      if (op.result === "fail") return { ...j, status: "running", rework: true, stage: null, inspection: "Failed: sent to rework", progress: "Failed inspection, being reworked", reworkNote: "Waiting for the workshop: all. Preview rework." };
      return { ...j, status: "complete", stage: null, rework: false, reworkNote: null, progress: "Inspected", inspection: op.result === "pass" ? "Passed" : "Released on concession" };
    case "reopen": return { ...j, status: "running", stage: "Machining", finished: "Not finished", inspection: "Not finished", inUse: null, timer: null, release: false, progress: "Started (not timed)", rework: false, reworkNote: null };
    case "releaseEarly": return { ...j, status: "complete", stage: null, progress: "Inspected", inspection: "Released early, not inspected", rework: false, reworkNote: null };
    case "archive": return { ...j, archived: true };
    case "releaseMachine": return { ...j, inUse: null, timer: null, release: false, pick: "Pick a machine", progress: "Started (not timed)" };
    case "assign": return { ...j, assignee: op.to };
  }
}

export type BulkPlan = { targets: Job[]; skipped: Array<{ job: Job; reason: string }> };
/** Bulk Finish only (there is no bulk Start). Names the jobs that will and will not change. */
export function planBulkFinish(selected: Job[]): BulkPlan {
  const targets: Job[] = [];
  const skipped: Array<{ job: Job; reason: string }> = [];
  for (const job of selected) {
    if (inRework(job)) skipped.push({ job, reason: "in rework" });
    else if (unfinished(job)) targets.push(job);
    else skipped.push({ job, reason: "already finished" });
  }
  return { targets, skipped };
}

export const selectionScope = (selected: number, filtered: number) =>
  selected ? `Exports the ${selected} job${selected === 1 ? "" : "s"} selected` : `Exports all ${filtered} job${filtered === 1 ? "" : "s"} in the current filter (nothing is selected)`;

export function nextJobNo(jobs: Job[]): string {
  const top = jobs.reduce((m, j) => Math.max(m, Number(j.ref.replace(/\D/g, "")) || 0), 0);
  return `J-${String(top + 1).padStart(4, "0")}`;
}

/** Which tile, if any, is pressed (derived from Show and the tile filter). */
export function pressedTile(f: Filters): Tile | null {
  if (f.listFilter) return null;
  if (f.show === "complete" && !f.tile) return "complete";
  if (f.show === "open") return f.tile ?? "open";
  return null;
}

/* ---------------- reducer ---------------- */

export type State = {
  role: Role; view: ViewMode; filters: Filters; unit: "days" | "hours"; jobs: Job[]; selected: string[]; expanded: string[];
  hidden: ColumnKey[]; screen: Screen; flash: string | null;
};
export const initialState = (): State => ({ role: "admin", view: "list", filters: DEFAULT_FILTERS, unit: "days", jobs: initialJobs(), selected: [], expanded: [], hidden: [], screen: "ready", flash: null });

export type Act =
  | { t: "show"; v: ShowFilter } | { t: "type"; v: TypeFilter } | { t: "group"; v: GroupBy } | { t: "due"; v: DueFilter } | { t: "rework" }
  | { t: "stage"; v: Stage } | { t: "tile"; v: Tile } | { t: "clearListFilter" } | { t: "listFilter" } | { t: "clearFilters" }
  | { t: "view"; v: ViewMode } | { t: "role"; v: Role } | { t: "unit"; v: "days" | "hours" } | { t: "screen"; v: Screen }
  | { t: "toggleColumn"; v: ColumnKey } | { t: "resetColumns" }
  | { t: "select"; ref: string } | { t: "selectAll"; refs: string[] } | { t: "clearSelection" } | { t: "expand"; ref: string }
  | { t: "op"; ref: string; op: Op } | { t: "bulkFinish"; refs: string[] } | { t: "addJob"; job: Job } | { t: "clearFlash" } | { t: "reset"; view: ViewMode };

const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function reduce(st: State, a: Act): State {
  const f = st.filters;
  switch (a.t) {
    case "show": return { ...st, filters: { ...f, show: a.v, tile: null, listFilter: null } };
    case "type": return { ...st, filters: { ...f, type: a.v } };
    case "group": return { ...st, filters: { ...f, group: a.v } };
    case "due": return { ...st, filters: { ...f, due: a.v } };
    case "rework": return { ...st, filters: { ...f, rework: !f.rework } };
    case "stage": return { ...st, filters: { ...f, stages: toggle(f.stages, a.v) } };
    case "tile": return { ...st, filters: { ...f, listFilter: null, show: a.v === "complete" ? "complete" : "open", tile: a.v === "open" || a.v === "complete" ? null : a.v } };
    case "listFilter": return { ...st, filters: { ...f, listFilter: "overdue" } };
    case "clearFilters": return { ...st, filters: DEFAULT_FILTERS };
    case "clearListFilter": return { ...st, filters: { ...f, listFilter: null } };
    case "view": return { ...st, view: a.v };
    case "role": return { ...st, role: a.v, selected: a.v === "viewer" ? [] : st.selected };
    case "unit": return { ...st, unit: a.v };
    case "screen": return { ...st, screen: a.v };
    case "toggleColumn": return COLUMNS.find((c) => c.key === a.v)?.locked ? st : { ...st, hidden: toggle(st.hidden, a.v) };
    case "resetColumns": return { ...st, hidden: [] };
    case "select": return { ...st, selected: toggle(st.selected, a.ref) };
    case "selectAll": return { ...st, selected: [...a.refs] };
    case "clearSelection": return { ...st, selected: [] };
    case "expand": return { ...st, expanded: toggle(st.expanded, a.ref) };
    case "op": return { ...st, flash: a.ref, jobs: st.jobs.map((j) => (j.ref === a.ref ? applyOp(j, a.op) : j)) };
    case "bulkFinish": return { ...st, selected: [], jobs: st.jobs.map((j) => (a.refs.includes(j.ref) ? applyOp(j, { type: "finish" }) : j)) };
    case "addJob": return { ...st, jobs: [a.job, ...st.jobs], flash: a.job.ref };
    case "clearFlash": return st.flash ? { ...st, flash: null } : st;
    case "reset": return { ...initialState(), view: a.view };
  }
}

/* ================================================================== */
/* 3b. v2 pure helpers: filter summary and the one-primary row split    */
/* ================================================================== */

/** The page sentence that used to sit under the title. Kept word for word as the title's tooltip and a screen-reader description (owner-approved change 4). */
export const JOBS_INTRO = "Jobs are the work in the workshop. Follow each one from start to finish.";
/** Wording of the notes that used to sit beside the Due and Tag filters; now tooltips and descriptions (owner-approved change 1). */
export const DUE_NOTE = "Not started and Running jobs only";
export const REWORK_NOTE = "Running jobs put back after a failed inspection (or for replacements)";
export const PREVIEW_ONLY = "Preview only, nothing was saved.";

export type ActiveChip = { id: string; label: string; remove: Act };
/** The filters that live under "Filters (n)" and are active right now, each with the action that removes it. Show and Due are always visible, so they are not chips. */
export function activeChips(f: Filters): ActiveChip[] {
  const out: ActiveChip[] = [];
  if (f.type !== "all") out.push({ id: "type", label: `Type: ${f.type === "internal" ? "Internal" : "Customer"}`, remove: { t: "type", v: "all" } });
  if (f.group !== "none") out.push({ id: "group", label: "Group: Machine", remove: { t: "group", v: "none" } });
  if (f.rework) out.push({ id: "rework", label: "Tag: Rework", remove: { t: "rework" } });
  for (const g of f.stages) out.push({ id: `stage-${g}`, label: `Stage: ${g}`, remove: { t: "stage", v: g } });
  return out;
}
/** The n in "Filters (n)". */
export const popoverFilterCount = (f: Filters) => activeChips(f).length;
/** True when anything differs from the default view (Show Open, nothing else): then, and only then, "Clear filters" shows. */
export const isFiltered = (f: Filters) => f.show !== "open" || f.due !== "all" || f.tile !== null || f.listFilter !== null || popoverFilterCount(f) > 0;

/** One primary per row (the state-aware next step) and everything else in the row's More menu, in the real board's order. */
export function splitRowActions(actions: Action[]): { primary: Action | null; more: Action[] } {
  const label = primaryLabel(actions);
  const primary = label ? actions.find((a) => a.label === label) ?? null : null;
  return { primary, more: actions.filter((a) => a !== primary) };
}

/** The word lists the pure tests pin: every Job Board action the row can offer, split into where it is reachable. */
export const reachableActionLabels = (j: Job, role: Role, view: ViewMode): ActionLabel[] => {
  const { primary, more } = splitRowActions(actionsFor(j, role, view));
  return [...(primary ? [primary.label] : []), ...more.map((a) => a.label)];
};

/** One state-aware primary per row (Start, Resume, Start timer, Pick a machine, Pause, or Inspected when it is the next step). */
export function primaryLabel(actions: Action[]): ActionLabel | null {
  const play = actions.find((a) => ["Start", "Resume", "Start timer", "Pick a machine", "Pause"].includes(a.label));
  if (play) return play.label;
  const insp = actions.find((a) => a.label === "Inspected" && !a.disabled);
  return insp ? insp.label : null;
}

/* ================================================================== */
/* 4. Presentation (shared premium components)                          */
/* ================================================================== */

type Say = { ok: (m: string) => void; info: (m: string) => void; fail: (m: string) => void };
const stop = (m: string) => (/[.!?]$/.test(m) ? m : `${m}.`);
/** Neutral preview acknowledgements through the shared Toast: never a success look, always "Preview only, nothing was saved." (errors keep the red alert toast). */
function useSay(): Say {
  const t = useToast();
  return useMemo<Say>(() => ({
    ok: (m) => t.show({ title: stop(m), detail: PREVIEW_ONLY }),
    info: (m) => t.show({ title: stop(m), detail: PREVIEW_ONLY }),
    fail: (m) => t.show({ title: stop(m), tone: "error" }),
  }), [t]);
}

const VIEW_KEY = "jobs-preview:view";
const subscribeMedia = (query: string) => (notify: () => void) => { const m = window.matchMedia(query); m.addEventListener("change", notify); return () => m.removeEventListener("change", notify); };
/** Wide = the fixed-sidebar layout (over 1024px). Phones (under 768px) have no switcher. Server and tests render wide. */
function useMedia(query: string, server: boolean) {
  const sub = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(sub, () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : server), () => server);
}

const statusTone = (st: Status): StatusTone => (st === "not_started" ? "neutral" : st === "running" ? "progress" : st === "complete" ? "ok" : "warn");
const dueTone: Record<DueLight, StatusTone> = { "On time": "ok", "At risk": "warn", Late: "danger", "No due date": "neutral" };

function Chevron({ down }: { down?: boolean }) { return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={down ? s.chevDown : undefined}><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

type RowCtx = {
  role: Role; view: ViewMode; say: Say; onAct: (j: Job, a: Action) => void; onPick: (j: Job, m: string) => void; dispatch: (a: Act) => void;
  onRelease: (j: Job) => void; goTo: (ref: string) => void;
};

/** The machine list as a menu: a primary "Pick a machine" or the small picker in the Machine column. Picking changes local state only. */
function MachineMenu({ job, ctx, label, variant, size, testId }: { job: Job; ctx: RowCtx; label: string; variant: "primary" | "secondary"; size: "sm" | "md"; testId: string }) {
  const items: MenuItem[] = [
    ...MACHINES.map((m) => ({ id: m, label: m, hint: job.pick === m ? "Chosen" : undefined, onSelect: () => ctx.onPick(job, m) })),
    { id: "bench", label: "No machine (bench)", onSelect: () => ctx.onPick(job, "N/A (bench)") },
    { id: "add", label: "Add machine", separatorBefore: true, onSelect: () => ctx.say.info("Add machine opens the Machine Schedule in the real board.") },
  ];
  return <Menu label={label} aria-label={`${label}, machine for ${job.ref}`} variant={variant} size={size} data-testid={testId} items={items} />;
}

/** IdState: the status word and the due word as quiet dot-and-word text (the Due column carries the pills). */
function IdState({ job }: { job: Job }) {
  return (
    <span className={s.idState}>
      <StatusBadge mode="text" tone={statusTone(job.status)}>{STATUS_WORD[job.status]}</StatusBadge>
      {showsDueLight(job) && job.due ? <StatusBadge mode="text" tone={dueTone[job.due]}>{job.due}</StatusBadge> : null}
    </span>
  );
}

function Tags({ job }: { job: Job }) {
  return (
    <>
      {job.internal ? <StatusBadge tone="info-neutral">Internal</StatusBadge> : null}
      {job.rework ? <StatusBadge tone="info">Rework</StatusBadge> : null}
      {job.problem ? <StatusBadge tone="danger">Problem</StatusBadge> : null}
    </>
  );
}

function DueCell({ job }: { job: Job }) {
  return (
    <div className={s.dueCell}>
      {job.dueText ? <span className={cx(typeScale.name, tabularNumbers)}>{job.dueText}</span> : null}
      <span className={s.badges}>
        <StatusBadge tone={statusTone(job.status)}>{STATUS_WORD[job.status]}</StatusBadge>
        {job.rework ? <StatusBadge tone="info">Rework</StatusBadge> : null}
        {job.problem ? <StatusBadge tone="danger">Problem</StatusBadge> : null}
        {showsDueLight(job) && job.due ? <StatusBadge tone={dueTone[job.due]}>{job.due}</StatusBadge> : null}
      </span>
    </div>
  );
}

function FileNames({ names }: { names: string }) {
  return names === "None" ? <span className={typeScale.secondary}>None</span> : <span className={s.file}>{names}</span>;
}

function MachineCell({ job, ctx }: { job: Job; ctx: RowCtx }) {
  const staff = ctx.role !== "viewer";
  const isOpen = job.status !== "complete" && !job.archived;
  const picker = staff && isOpen && job.pick && !job.inUse;
  const addMachine = staff && isOpen && job.addMachine;
  const releaseBtn = ctx.role === "admin" && job.release;
  return (
    <div className={s.machine}>
      {job.inUse ? <span className={s.inUse}><b>In use</b><span>{job.inUse}</span></span> : null}
      {!job.inUse && job.pick === "N/A (bench)" && !staff ? <span>N/A (bench)</span> : null}
      {picker || job.timer || addMachine ? (
        <span className={s.mCtl}>
          {picker ? <MachineMenu job={job} ctx={ctx} label={job.pick as string} variant="secondary" size="sm" testId="machine-picker" /> : null}
          {job.timer ? <span className={cx(typeScale.secondary, tabularNumbers)}>{job.timer}</span> : null}
          {releaseBtn ? <Button size="sm" variant="secondary" data-op="release" onClick={() => ctx.onRelease(job)}>Release</Button> : null}
          {addMachine ? <Button size="sm" variant="quiet" data-op="add-machine" onClick={() => ctx.say.info("Add machine opens the Machine Schedule in the real board.")}>Add machine</Button> : null}
        </span>
      ) : null}
      {job.planned ? <span className={typeScale.caption}>Planned: {job.planned}</span> : null}
      {!job.planned && !job.inUse && !picker && !(job.pick === "N/A (bench)") ? <span className={typeScale.secondary}>{"—"}</span> : null}
    </div>
  );
}

function OperatorCell({ job, ctx }: { job: Job; ctx: RowCtx }) {
  const isOpen = job.status !== "complete" && !job.archived;
  const mine = job.assignee === ME;
  return (
    <div className={s.operator}>
      <span>{job.assignee ? `Assigned to ${mine ? "You" : job.assignee}` : "Unassigned"}</span>
      {job.pausedBy ? <span className={typeScale.secondary}>{job.pausedBy}</span> : null}
      {isOpen && (ctx.role === "admin" || ctx.role === "office") ? (
        <Select aria-label={`Assign ${job.ref}`} value={job.assignee ?? ""} onChange={(e) => { const to = e.target.value || null; ctx.dispatch({ t: "op", ref: job.ref, op: { type: "assign", to } }); ctx.say.ok(to ? `${job.ref} assigned to ${to === ME ? "you" : to}.` : `${job.ref} unassigned.`); }}>
          <option value="">Unassigned</option>
          {PEOPLE.map((p) => <option key={p} value={p}>{p === ME ? `${p} (you)` : p}</option>)}
        </Select>
      ) : null}
      {isOpen && ctx.role === "workshop" ? (
        <Button size="sm" variant="secondary" data-op={mine ? "hand-back" : "take"} onClick={() => { ctx.dispatch({ t: "op", ref: job.ref, op: { type: "assign", to: mine ? null : ME } }); ctx.say.ok(mine ? `${job.ref} handed back.` : `${job.ref} is now yours.`); }}>{mine ? "Hand back" : "Take this job"}</Button>
      ) : null}
    </div>
  );
}

/** ONE primary action and a More menu holding every other action (a disabled one stays in the menu and says why). Fixed width, never wraps. */
function RowActions({ job, ctx }: { job: Job; ctx: RowCtx }) {
  const { primary, more } = splitRowActions(actionsFor(job, ctx.role, ctx.view));
  const items: MenuItem[] = more.map((a) => ({ id: a.label, label: a.label, disabled: a.disabled, hint: a.disabled ? disabledReason(job, a.label) : undefined, onSelect: () => ctx.onAct(job, a) }));
  return (
    <div className={s.actions} data-testid="row-actions">
      {primary ? (
        primary.label === "Pick a machine"
          ? <MachineMenu job={job} ctx={ctx} label="Pick a machine" variant="primary" size="md" testId="row-primary" />
          : <Button variant="primary" className={s.primaryAct} data-action={primary.label} data-testid="row-primary" onClick={() => ctx.onAct(job, primary)}>{primary.label}</Button>
      ) : <span className={s.primarySlot} />}
      {items.length ? <Menu label="More" aria-label={`More actions for ${job.ref}`} data-testid="row-more" items={items} /> : null}
    </div>
  );
}

function RelatedLinks({ job, ctx }: { job: Job; ctx: RowCtx }) {
  return (
    <>
      {job.relTo ? <Button size="sm" variant="quiet" className={s.related} data-op="related-link" onClick={() => ctx.goTo(job.relTo as string)}>Related to {job.relTo}</Button> : null}
      {job.relFrom.map((r) => <Button key={r} size="sm" variant="quiet" className={s.related} data-op="related-link" onClick={() => ctx.goTo(r)}>Related: {r}</Button>)}
    </>
  );
}

/* ---------------- table and list ---------------- */

const DATA_CELL: Record<Exclude<ColumnKey, "ref" | "machine" | "operator" | "due" | "actions" | "stage">, (j: Job) => ReactNode> = {
  customer: (j) => <span className={typeScale.name}>{j.customer}</span>,
  description: (j) => <span className={s.clamp}>{j.description}</span>,
  specification: (j) => <span className={cx(s.clamp, typeScale.secondary)}>{j.specification}</span>,
  drawings: (j) => <FileNames names={j.drawings} />,
  attachments: (j) => <FileNames names={j.attachments} />,
  started: (j) => <span className={cx(tabularNumbers, j.started === "Not started" && typeScale.secondary)}>{j.started}</span>,
  finished: (j) => <span className={cx(tabularNumbers, j.finished === "Not finished" && typeScale.secondary)}>{j.finished}</span>,
  inspection: (j) => <><span className={cx(j.inspection === "Not finished" && typeScale.secondary)}>{j.inspection}</span>{j.reworkNote ? <span className={cx(typeScale.secondary, s.block)}>Rework: {j.reworkNote}</span> : null}</>,
};

function cellFor(key: ColumnKey, j: Job, ctx: RowCtx): ReactNode {
  switch (key) {
    case "ref": return (
      <div className={s.refCell}>
        <span className={s.refLine}><span className={cx(typeScale.name, tabularNumbers)}>{j.ref}</span>{j.internal ? <StatusBadge tone="info-neutral">Internal</StatusBadge> : null}</span>
        <IdState job={j} />
        <RelatedLinks job={j} ctx={ctx} />
      </div>
    );
    case "stage": return <><span className={typeScale.name}>{j.stage ?? "—"}</span><span className={cx(typeScale.secondary, s.block)} data-testid="job-progress">{j.progress}</span></>;
    case "machine": return <MachineCell job={j} ctx={ctx} />;
    case "operator": return <OperatorCell job={j} ctx={ctx} />;
    case "due": return <DueCell job={j} />;
    case "actions": return <RowActions job={j} ctx={ctx} />;
    default: return DATA_CELL[key](j);
  }
}

function JobTable({ jobs, groups, view, columns, selected, expanded, role, ctx, flash, dispatch }: {
  jobs: Job[]; groups: MachineGroup[] | null; view: "list" | "table"; columns: Array<{ key: ColumnKey; label: string }>; selected: string[]; expanded: string[];
  role: Role; ctx: RowCtx; flash: string | null; dispatch: (a: Act) => void;
}) {
  const list = view === "list";
  const allTicked = jobs.length > 0 && jobs.every((j) => selected.includes(j.ref));
  const span = columns.length + 1;
  const record = (j: Job, scope = "") => {
    const isOpen = expanded.includes(j.ref);
    const extra = expandedActionsFor(j, role);
    const ticked = selected.includes(j.ref);
    return (
      <tbody key={`${scope}${j.ref}`} data-record="true" data-selected={ticked || undefined}>
        <tr data-job={j.ref} data-status={j.status} data-flash={flash === j.ref || undefined} data-selected={ticked || undefined} className={s.row}>
          <td className={s.cSel}>
            <span className={s.selCell}>
              <Checkbox checked={ticked} onChange={() => dispatch({ t: "select", ref: j.ref })} aria-label={`Select ${j.ref}`} data-testid="select-row" />
              {list ? <Button variant="quiet" className={s.expander} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details for ${j.ref}`} data-op="expander" onClick={() => dispatch({ t: "expand", ref: j.ref })}><Chevron down={isOpen} /></Button> : null}
            </span>
          </td>
          {columns.map((c) => <td key={c.key} data-col={c.key} className={cx(s[`c_${c.key}`], c.key === "ref" && s.stickyRef)}>{cellFor(c.key, j, ctx)}</td>)}
        </tr>
        {list && isOpen ? (
          <tr data-sub="true" data-testid="list-expansion">
            <td colSpan={span}>
              <div className={s.expandBody}>
                <span><b>Progress:</b> {j.progress}</span>
                {j.parts ? <span><b>Parts logged:</b> {j.parts}</span> : null}
                {j.reworkNote ? <span><b>Rework:</b> {j.reworkNote}</span> : null}
                {extra.map((a) => <Button key={a.label} size="sm" variant="secondary" data-action={a.label} onClick={() => ctx.onAct(j, a)}>{a.label}</Button>)}
              </div>
            </td>
          </tr>
        ) : null}
      </tbody>
    );
  };
  return (
    <div data-testid={`view-${view}`} className={cx(s.jt, list ? s.isList : s.isTable)}>
      <ScrollTable label={`Jobs, ${view} view`} dense pinLast>
        <thead>
          <tr>
            <th className={s.cSel}><span className={s.selCell}><Checkbox checked={allTicked} onChange={() => dispatch({ t: "selectAll", refs: allTicked ? [] : jobs.map((j) => j.ref) })} aria-label={`Select all ${jobs.length} filtered jobs`} data-testid="select-all-header" />{list ? <span className={srOnly}>Details</span> : null}</span></th>
            {columns.map((c) => <th key={c.key} scope="col" data-col={c.key} className={cx(s[`c_${c.key}`], c.key === "ref" && s.stickyRef)}>{c.label}</th>)}
          </tr>
        </thead>
        {groups
          ? groups.flatMap((g) => [
              <tbody key={g.heading}><tr className={s.groupRow}><th colSpan={span} scope="colgroup" className={s.groupCell}><span className={s.groupText}>{g.heading}</span></th></tr></tbody>,
              ...g.jobs.map((j) => record(j, `${g.heading}/`)),
            ])
          : jobs.map((j) => record(j))}
      </ScrollTable>
    </div>
  );
}

/* ---------------- cards (the shared StackedRows, arranged in a grid) ---------------- */

const CARD_FIELDS: Array<{ key: ColumnKey; label: string }> = COLUMNS.filter((c) => c.key !== "ref" && c.key !== "actions");

function JobCards({ jobs, columns, selected, ctx, flash, dispatch, label }: { jobs: Job[]; columns: Array<{ key: ColumnKey }>; selected: string[]; ctx: RowCtx; flash: string | null; dispatch: (a: Act) => void; label: string }) {
  const shown = CARD_FIELDS.filter((f) => columns.some((c) => c.key === f.key));
  const rows = jobs.map((j) => ({
    id: j.ref,
    testId: `job-card-${j.ref}`,
    title: (
      <span className={s.cardTitle} data-flash={flash === j.ref || undefined}>
        <Checkbox checked={selected.includes(j.ref)} onChange={() => dispatch({ t: "select", ref: j.ref })} aria-label={`Select ${j.ref}`} data-testid="select-row" />
        <span className={tabularNumbers}>{j.ref}</span>
        <Tags job={j} />
      </span>
    ),
    status: <IdState job={j} />,
    fields: [
      ...shown.map((f) => ({ label: f.label, value: f.key === "stage" ? cellFor("stage", j, ctx) : f.key === "due" ? <span className={tabularNumbers}>{j.dueText ?? "No due date"}</span> : cellFor(f.key, j, ctx) })),
      ...(j.parts ? [{ label: "Parts logged", value: j.parts }] : []),
    ],
    actions: <><RowActions job={j} ctx={ctx} /><RelatedLinks job={j} ctx={ctx} /></>,
  }));
  return <StackedRows className={s.cardGrid} label={label} rows={rows} />;
}

/* ---------------- tiles, filters, columns, export ---------------- */

function Tiles({ counts, pressed, unit, dispatch, loading, empty }: { counts: Counts; pressed: Tile | null; unit: "days" | "hours"; dispatch: (a: Act) => void; loading?: boolean; empty?: boolean }) {
  const tiles: Array<{ id: Tile; label: string; value: number; definition: string }> = [
    { id: "open", label: "Open jobs", value: counts.open, definition: "Not started + Running + Waiting for inspection. Complete jobs are not counted." },
    { id: "not_started", label: "Not started", value: counts.notStarted, definition: "Open: no work started yet" },
    { id: "running", label: "Running", value: counts.running, definition: "Open: started, not finished (rework included)" },
    { id: "waiting", label: "Waiting for inspection", value: counts.waiting, definition: "Open: finished, not yet passed" },
    { id: "complete", label: "Complete", value: counts.complete, definition: "Passed inspection; not archived" },
  ];
  return (
    <StatTiles label="Job totals" columns={4} className={s.tiles} data-testid="tiles">
      {tiles.map((t) => <StatTile key={t.id} label={t.label} value={t.value} definition={t.definition} loading={loading} pressed={pressed === t.id} onPress={() => dispatch({ t: "tile", v: t.id })} data-testid={`tile-${t.id}`} />)}
      <StatTile
        data-testid="tile-average"
        loading={loading}
        label={<span className={s.avgLabel}>Average job time<SegmentedControl size="sm" label="Average job time unit" value={unit} onChange={(v) => dispatch({ t: "unit", v })} options={[{ value: "hours", label: "Hours", testId: "unit-hours" }, { value: "days", label: "Days", testId: "unit-days" }]} /></span>}
        value={empty ? "—" : unit === "days" ? AVERAGE_JOB_TIME.days : AVERAGE_JOB_TIME.hours}
        definition="Start to finish."
      />
    </StatTiles>
  );
}

function FilterBar({ f, counts, dispatch, dim }: { f: Filters; counts: Counts; dispatch: (a: Act) => void; dim?: boolean }) {
  const n = (v: number) => (dim ? "—" : v);
  const chips = activeChips(f);
  const show: Array<{ value: ShowFilter; label: string }> = [
    { value: "open", label: `Open (${n(counts.open)})` }, { value: "complete", label: `Complete (${n(counts.complete)})` }, { value: "archived", label: `Archived (${n(counts.archived)})` }, { value: "all", label: "All" },
  ];
  const due: Array<{ value: DueFilter; label: string }> = [
    { value: "all", label: "All" }, { value: "On time", label: `On time (${n(counts.due["On time"])})` }, { value: "At risk", label: `At risk (${n(counts.due["At risk"])})` },
    { value: "Late", label: `Late (${n(counts.due.Late)})` }, { value: "No due date", label: `No due date (${n(counts.due["No due date"])})` },
  ];
  return (
    <section className={s.fbar} aria-label="Filters" data-testid="filters">
      <div className={s.fRow}>
        <div className={s.fGroup}>
          <span className={typeScale.label} aria-hidden="true">Show</span>
          <SegmentedControl label="Show" disabled={dim} value={(f.listFilter ? "" : f.show) as ShowFilter} onChange={(v) => dispatch({ t: "show", v })} options={show.map((o) => ({ ...o, testId: `show-${o.value}` }))} />
        </div>
        <div className={s.fGroup} title={DUE_NOTE}>
          <span className={typeScale.label} aria-hidden="true">Due</span>
          <SegmentedControl label={`Due. ${DUE_NOTE}`} disabled={dim} value={f.due} onChange={(v) => dispatch({ t: "due", v })} options={due.map((o) => ({ ...o, testId: `due-${o.value}` }))} />
        </div>
        <Popover label={chips.length ? `Filters (${chips.length})` : "Filters"} title="Filters" data-testid="filters-trigger">
          <div className={s.filterBody} data-testid="filters-panel">
            <div className={s.pField}>
              <span className={typeScale.label}>Type</span>
              <SegmentedControl size="sm" label="Type" value={f.type} onChange={(v) => dispatch({ t: "type", v })} options={([["all", "All"], ["customer", "Customer"], ["internal", `Internal (${n(counts.internal)})`]] as Array<[TypeFilter, string]>).map(([value, label]) => ({ value, label, testId: `type-${value}` }))} />
            </div>
            <div className={s.pField}>
              <span className={typeScale.label}>Group</span>
              <SegmentedControl size="sm" label="Group" value={f.group} onChange={(v) => dispatch({ t: "group", v })} options={([["none", "None"], ["machine", "Machine"]] as Array<[GroupBy, string]>).map(([value, label]) => ({ value, label, testId: `group-${value}` }))} />
            </div>
            <div className={s.pField}>
              <span className={typeScale.label}>Tag</span>
              <Switch checked={f.rework} disabled={dim} data-testid="tag-rework" label={`Rework (${n(counts.rework)})`} hint={REWORK_NOTE} onChange={() => dispatch({ t: "rework" })} />
            </div>
            <div className={s.pField}>
              <span className={typeScale.label}>Stage</span>
              <ChipGroup label="Stage">{STAGES.map((g) => <FilterChip key={g} selected={f.stages.includes(g)} disabled={dim} data-testid={`stage-${g.toLowerCase()}`} onToggle={() => dispatch({ t: "stage", v: g })}>{g}</FilterChip>)}</ChipGroup>
            </div>
          </div>
        </Popover>
        {isFiltered(f) ? <Button variant="quiet" data-testid="clear-filters" onClick={() => dispatch({ t: "clearFilters" })}>Clear filters</Button> : null}
      </div>
      {chips.length ? (
        <ul className={s.chipRow} aria-label="Active filters" data-testid="active-chips">
          {chips.map((c) => (
            <li key={c.id}>
              <Button size="sm" variant="secondary" aria-label={`Remove filter ${c.label}`} data-chip={c.id} onClick={() => dispatch(c.remove)}>
                {c.label}
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ColumnsMenu({ hidden, role, dispatch }: { hidden: ColumnKey[]; role: Role; dispatch: (a: Act) => void }) {
  const own = role === "workshop" || role === "viewer";
  return (
    <Popover label="Columns" title="Job Board columns" data-testid="columns-trigger">
      <div className={s.colsBody} data-testid="columns-panel">
        {COLUMNS.map((c) => (
          <Switch key={c.key} checked={c.locked ? true : !hidden.includes(c.key)} label={c.label} hint={c.locked ? "Always on" : undefined} disabled={!!c.locked} data-testid={`col-${c.key}`} onChange={() => dispatch({ t: "toggleColumn", v: c.key })} />
        ))}
        <Button variant="quiet" onClick={() => dispatch({ t: "resetColumns" })}>{own ? "Reset to the company view" : "Reset to default (show all columns)"}</Button>
        <p className={typeScale.caption}>{own ? "Your own view on this device only. Everyone else, and the company setting, are not changed." : "Changes apply to everyone in this company."} Preview: nothing is saved.</p>
      </div>
    </Popover>
  );
}

function ExportMenu({ say, nSel, total, testId }: { say: Say; nSel: number; total: number; testId: string }) {
  return (
    <Menu label="Export" aria-label={`Export. ${selectionScope(nSel, total)}`} data-testid={testId}
      items={["CSV", "Excel", "Word", "PDF"].map((fmt) => ({ id: fmt, label: fmt, onSelect: () => say.info(`${fmt} export is not generated in the preview. ${selectionScope(nSel, total)}`) }))} />
  );
}

/* ---------------- dialogs (shared Dialog for confirmations, shared Sheet for read-only details) ---------------- */

type DialogState =
  | { k: "pause" | "finish" | "inspect" | "reopen" | "release" | "rework" | "worksheet" | "machines" | "delivery" | "send" | "releaseMachine" | "takeover"; ref: string; machine?: string }
  | { k: "bulk" } | { k: "newjob" };

function Row({ label, value }: { label: string; value: ReactNode }) { return <div className={s.kv}><dt>{label}</dt><dd>{value}</dd></div>; }
const PreviewNote = () => <p className={cx(typeScale.caption, s.dlgNote)}>Preview data. Nothing here is saved, sent or printed.</p>;
const noop = () => {};

function DialogHost({ dlg, open, close, st, dispatch, vis, say }: { dlg: DialogState | null; open: boolean; close: () => void; st: State; dispatch: (a: Act) => void; vis: Job[]; say: Say }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<"pass" | "fail" | "concession">("pass");
  const [form, setForm] = useState({ customer: "", description: "", internal: false });
  const [errors, setErrors] = useState<{ customer?: string; description?: string }>({});
  useEffect(() => { setReason(""); setResult("pass"); setForm({ customer: "", description: "", internal: false }); setErrors({}); }, [dlg]);

  let dialog: { title: string; description?: string; confirmLabel: string; onConfirm: () => void; confirmDisabled?: boolean; body?: ReactNode } | null = null;
  let sheet: { title: string; body: ReactNode } | null = null;

  if (dlg?.k === "bulk") {
    const selected = st.jobs.filter((j) => st.selected.includes(j.ref));
    const plan = planBulkFinish(selected);
    dialog = {
      title: `Finish ${selected.length} selected job${selected.length === 1 ? "" : "s"}?`, confirmLabel: `Finish ${plan.targets.length} job${plan.targets.length === 1 ? "" : "s"}`, confirmDisabled: !plan.targets.length,
      onConfirm: () => { dispatch({ t: "bulkFinish", refs: plan.targets.map((j) => j.ref) }); close(); say.ok(`${plan.targets.length} job${plan.targets.length === 1 ? "" : "s"} finished on screen.`); },
      body: (
        <div className={s.dlgStack}>
          <p className={typeScale.name}>Will be finished ({plan.targets.length}): {plan.targets.map((j) => j.ref).join(", ") || "none"}</p>
          {plan.skipped.length ? <p>Will not change ({plan.skipped.length}): {plan.skipped.map((x) => `${x.job.ref} (${x.reason})`).join(", ")}</p> : null}
          <p>Only the {selected.length} selected job{selected.length === 1 ? " is" : "s are"} affected, not every filtered job ({vis.length}).</p>
          <PreviewNote />
        </div>
      ),
    };
  } else if (dlg?.k === "newjob") {
    const create = () => {
      const next: { customer?: string; description?: string } = {};
      if (!form.internal && !form.customer.trim()) next.customer = "Enter the customer, or tick Internal job.";
      if (!form.description.trim()) next.description = "Enter a description.";
      setErrors(next);
      if (next.customer || next.description) { window.setTimeout(() => focusFirstInvalid([], (document.querySelector("dialog[open]") as ParentNode | null) ?? document), 0); return; }
      const ref = nextJobNo(st.jobs);
      const job: Job = { ...initialJobs()[0], ref, internal: form.internal, relTo: null, relFrom: [], customer: form.internal ? "Internal" : form.customer.trim(), description: form.description.trim(), specification: "", drawings: "None", attachments: "None", stage: "Material", status: "not_started", due: "No due date", dueText: null, rework: false, problem: false, progress: "Not started", started: "Not started", finished: "Not finished", inspection: "Not finished", reworkNote: null, parts: null, pick: null, inUse: null, timer: null, addMachine: false, release: false, planned: null, assignee: null, pausedBy: null, createdAt: "2026-11-20T10:30:00Z", archived: false, inspectAdminOnly: false, preview: true };
      dispatch({ t: "addJob", job });
      close();
      say.ok(`${ref} added to this preview only.`);
    };
    dialog = {
      title: "New job", confirmLabel: "Create job", onConfirm: create,
      body: (
        <div className={s.dlgStack}>
          <Field label="Customer" error={errors.customer}><Input value={form.customer} disabled={form.internal} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></Field>
          <Field label="Description" error={errors.description}><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Switch checked={form.internal} label="Internal job (no customer)" data-testid="newjob-internal" onChange={(v) => setForm({ ...form, internal: v })} />
          <PreviewNote />
        </div>
      ),
    };
  } else if (dlg) {
    const job = st.jobs.find((j) => j.ref === dlg.ref);
    if (job) {
      const op = (o: Op, msg: string) => { dispatch({ t: "op", ref: job.ref, op: o }); close(); say.ok(msg); };
      const note = <PreviewNote />;
      switch (dlg.k) {
        case "pause": dialog = { title: `Pause ${job.ref}?`, description: "Are you sure you want to pause this job?", confirmLabel: "Pause job", onConfirm: () => op({ type: "pause" }, `${job.ref} paused on screen.`), body: note }; break;
        case "finish": dialog = { title: `Finish ${job.ref}?`, description: "Are you sure you want to finish this job?", confirmLabel: "Finish job", onConfirm: () => op({ type: "finish" }, `${job.ref} finished on screen: now Waiting for inspection.`), body: note }; break;
        case "releaseMachine": dialog = { title: `Release ${job.inUse?.split(",")[0] ?? "machine"}?`, description: `${job.ref} stops using the machine.`, confirmLabel: "Release", onConfirm: () => op({ type: "releaseMachine" }, `${job.inUse?.split(",")[0] ?? "Machine"} released (was ${job.ref}).`), body: note }; break;
        case "takeover": dialog = { title: `Check before using ${dlg.machine}`, description: `${dlg.machine} is in use. Take over ${job.ref}?`, confirmLabel: "Take over", body: note, onConfirm: () => { const other = st.jobs.find((j) => j.inUse?.startsWith(`${dlg.machine},`) && j.ref !== job.ref); if (other) dispatch({ t: "op", ref: other.ref, op: { type: "pause" } }); op({ type: "start", machine: dlg.machine }, `${job.ref} started on ${dlg.machine}${other ? `; ${other.ref} paused` : ""}.`); } }; break;
        case "send": dialog = { title: `Send ${job.ref} to Workshop`, description: "The workshop gets the job by email in the real board.", confirmLabel: "Send", onConfirm: () => { close(); say.info(`${job.ref} was not sent. No email is sent from the preview.`); }, body: note }; break;
        case "inspect": dialog = {
          title: `Record inspection: ${job.ref}`, description: `${job.customer}: ${job.description}`, confirmLabel: "Record inspection",
          onConfirm: () => op({ type: "inspect", result }, result === "fail" ? `${job.ref} failed inspection: put back to Running, tagged Rework.` : `${job.ref} inspected: Complete.`),
          body: (
            <div className={s.dlgStack}>
              <SegmentedControl label="Inspection result" value={result} onChange={setResult} options={[{ value: "pass", label: "Passed" }, { value: "fail", label: "Failed: send to rework" }, ...(st.role === "admin" ? [{ value: "concession" as const, label: "Released on concession" }] : [])]} />
              {note}
            </div>
          ),
        }; break;
        case "reopen": dialog = { title: `Reopen ${job.ref}`, description: "Back to Running, with a reason.", confirmLabel: "Reopen job", confirmDisabled: !reason.trim(), onConfirm: () => op({ type: "reopen" }, `${job.ref} reopened: back to Running.`), body: <div className={s.dlgStack}><Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{note}</div> }; break;
        case "release": dialog = { title: `Release ${job.ref} early`, description: "Release without waiting for the inspection result.", confirmLabel: "Release job", confirmDisabled: !reason.trim(), onConfirm: () => op({ type: "releaseEarly" }, `${job.ref} released early: Complete.`), body: <div className={s.dlgStack}><Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{note}</div> }; break;
        case "rework": sheet = { title: `Rework: ${job.ref}`, body: <dl className={s.kvList}><Row label="Inspection" value={job.inspection} /><Row label="Rework" value={job.reworkNote ?? "No rework recorded"} /><Row label="Status" value={job.progress} /></dl> }; break;
        case "worksheet": sheet = { title: `Worksheet - ${job.ref}`, body: <><dl className={s.kvList}><Row label="Customer" value={job.customer} /><Row label="Description" value={job.description} /><Row label="Specification" value={job.specification || "None"} /><Row label="Drawings" value={job.drawings} /><Row label="Attachments" value={job.attachments} /><Row label="Planned machines" value={job.planned ?? "None"} /></dl><p className={typeScale.secondary}>The full worksheet form (material, programs, times, checklist, sign-off) is not part of this preview.</p></> }; break;
        case "machines": sheet = { title: `Machines - ${job.ref}`, body: <><dl className={s.kvList}><Row label="Planned" value={job.planned ?? "None"} /><Row label="In use" value={job.inUse ?? "Not running on a machine"} /></dl><p className={typeScale.secondary}>Booking hours is not part of this preview.</p></> }; break;
        case "delivery": sheet = { title: `Delivery note - ${job.ref}`, body: <><dl className={s.kvList}><Row label="Customer" value={job.customer} /><Row label="Description" value={job.description} /></dl><p className={typeScale.secondary}>No delivery note is created in this preview.</p></> }; break;
      }
    }
  }
  return (
    <>
      <Dialog open={open && !!dialog} title={dialog?.title ?? ""} description={dialog?.description} confirmLabel={dialog?.confirmLabel ?? ""} confirmDisabled={dialog?.confirmDisabled} onConfirm={dialog?.onConfirm ?? noop} onClose={close}>{dialog?.body}</Dialog>
      <Sheet open={open && !!sheet} size="sm" title={sheet?.title ?? ""} closeButton={false} onClose={close} footer={<Button variant="primary" onClick={close}>Close</Button>}>{sheet?.body}</Sheet>
    </>
  );
}

/* ---------------- preview furniture ---------------- */

function PreviewControls({ st, dispatch, onReset }: { st: State; dispatch: (a: Act) => void; onReset: () => void }) {
  const roles: Array<{ value: Role; label: string }> = [{ value: "admin", label: "Admin" }, { value: "office", label: "Office" }, { value: "workshop", label: "Workshop" }, { value: "viewer", label: "Viewer" }];
  const screens: Array<{ v: Screen | "overdue"; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No jobs" }, { v: "offline", label: "Offline" }, { v: "truncated", label: "Truncated" }, { v: "overdue", label: "Dashboard filter" }];
  const current = st.filters.listFilter ? "overdue" : st.screen;
  return (
    <Popover label="Preview controls" title="Preview controls" size="sm" data-testid="dock-toggle">
      <div className={s.dockBody} data-testid="dock">
        <SegmentedControl size="sm" label="Role" value={st.role} options={roles} onChange={(v) => dispatch({ t: "role", v })} />
        <p className={typeScale.label}>Screen state</p>
        <ChipGroup label="Screen state">
          {screens.map((x) => <FilterChip key={x.v} selected={current === x.v} onToggle={() => { if (x.v === "overdue") { dispatch({ t: "screen", v: "ready" }); dispatch({ t: "listFilter" }); } else { dispatch({ t: "clearListFilter" }); dispatch({ t: "screen", v: x.v }); } }}>{x.label}</FilterChip>)}
        </ChipGroup>
        <Button variant="secondary" onClick={onReset}>Reset preview data</Button>
        <p className={typeScale.caption}>Sample data. States are simulated; no request is made.</p>
      </div>
    </Popover>
  );
}

/* ---------------- the page ---------------- */

export default function JobsPreview() {
  return (
    <ToastProvider placement="bottom-right" offset={16}>
      <JobsBoard />
    </ToastProvider>
  );
}

function JobsBoard() {
  const [st, dispatch] = useReducer(reduce, undefined, initialState);
  const [dlg, setDlg] = useState<DialogState | null>(null);
  const lastDlg = useRef<DialogState | null>(null);
  if (dlg) lastDlg.current = dlg;
  const say = useSay();
  const toast = useToast();
  const wide = useMedia("(min-width: 1025px)", true);
  const notPhone = useMedia("(min-width: 768px)", true);

  useEffect(() => {
    try { const v = window.localStorage.getItem(VIEW_KEY); if (v === "cards" || v === "list" || v === "table") dispatch({ t: "view", v }); } catch { /* storage unavailable: the default List stays */ }
  }, []);
  const setView = (v: ViewMode) => { dispatch({ t: "view", v }); try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  const view: ViewMode = wide ? st.view : "cards";

  const counts = useMemo(() => countsOf(st.jobs), [st.jobs]);
  const vis = useMemo(() => (st.screen === "empty" || st.screen === "loading" ? [] : visibleJobs(st.jobs, st.filters)), [st.jobs, st.filters, st.screen]);
  const shown = st.screen === "empty" ? countsOf([]) : counts;
  const selectedVisible = useMemo(() => vis.filter((j) => st.selected.includes(j.ref)), [vis, st.selected]);
  const columns = COLUMNS.filter((c) => c.locked || !st.hidden.includes(c.key));
  const groups = st.filters.group === "machine" ? machineGroups(vis) : null;
  const viewer = st.role === "viewer";
  const nSel = selectedVisible.length;

  useEffect(() => { if (!st.flash) return; const t = window.setTimeout(() => dispatch({ t: "clearFlash" }), 1600); return () => window.clearTimeout(t); }, [st.flash]);
  // a state, role or dashboard-filter change clears any message so nothing lingers across it
  useEffect(() => { toast.clear(); }, [st.screen, st.role, st.filters.listFilter, toast]);

  const startJob = useCallback((job: Job, machine?: string | null) => {
    const m = machine === undefined ? (job.pick && (MACHINES as readonly string[]).includes(job.pick) ? job.pick : null) : machine;
    const busy = m ? st.jobs.find((j) => j.ref !== job.ref && j.inUse?.startsWith(`${m},`)) : null;
    if (busy) { setDlg({ k: "takeover", ref: job.ref, machine: m as string }); return; }
    dispatch({ t: "op", ref: job.ref, op: { type: "start", machine: m } });
    say.ok(`${job.ref} started ${m ? `on ${m}` : "on the bench"}.`);
  }, [st.jobs, say]);

  const onAct = useCallback((job: Job, a: Action) => {
    if (a.disabled) { say.info(disabledReason(job, a.label)); return; }
    switch (a.label) {
      case "Start": case "Resume": case "Start timer": startJob(job); break;
      case "Pause": setDlg({ k: "pause", ref: job.ref }); break;
      case "Finish": setDlg({ k: "finish", ref: job.ref }); break;
      case "Inspected": setDlg({ k: "inspect", ref: job.ref }); break;
      case "Reopen": setDlg({ k: "reopen", ref: job.ref }); break;
      case "Release early": setDlg({ k: "release", ref: job.ref }); break;
      case "Rework": setDlg({ k: "rework", ref: job.ref }); break;
      case "Worksheet": setDlg({ k: "worksheet", ref: job.ref }); break;
      case "Machines": setDlg({ k: "machines", ref: job.ref }); break;
      case "Delivery note": setDlg({ k: "delivery", ref: job.ref }); break;
      case "Send": setDlg({ k: "send", ref: job.ref }); break;
      case "Print": say.info(`The print sheet for ${job.ref} is not opened in the preview.`); break;
      case "Archive": dispatch({ t: "op", ref: job.ref, op: { type: "archive" } }); say.ok(`${job.ref} archived.`); break;
      default: break;
    }
  }, [startJob, say]);

  const goTo = useCallback((ref: string) => {
    const el = document.querySelector(`[data-job="${ref}"], [data-testid="job-card-${ref}"]`);
    if (el) { el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); (el as HTMLElement).setAttribute("data-flash", "true"); window.setTimeout(() => el.removeAttribute("data-flash"), 1600); }
    else say.info(`${ref} is not in the current filter.`);
  }, [say]);

  const ctx: RowCtx = useMemo(() => ({
    role: st.role, view, say, onAct, dispatch,
    onPick: (job, machine) => { dispatch({ t: "op", ref: job.ref, op: { type: "pick", machine } }); say.ok(`${job.ref}: ${machine === "N/A (bench)" ? "no machine (bench)" : machine} chosen. Press Start to begin.`); },
    onRelease: (job) => setDlg({ k: "releaseMachine", ref: job.ref }), goTo,
  }), [st.role, view, say, onAct, goTo]);

  const reload = () => { dispatch({ t: "screen", v: "loading" }); window.setTimeout(() => { dispatch({ t: "screen", v: "ready" }); say.info("Sample jobs shown again. No server was contacted."); }, 700); };

  const noJobs = st.screen === "empty";
  const jobWord = (n: number) => `${n} filtered job${n === 1 ? "" : "s"}`;
  const idleNote = st.screen === "loading" ? "Loading jobs" : `${vis.length} job${vis.length === 1 ? "" : "s"} shown`;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="jobs-preview" data-role={st.role} data-pview={view}>
      <PreviewBar data-testid="preview-bar" controls={<PreviewControls st={st} dispatch={dispatch} onReset={() => { dispatch({ t: "reset", view: st.view }); say.info("Sample data reset."); }} />} />
      <PageHeader
        title={<span title={JOBS_INTRO} data-testid="job-board-title">Job Board</span>}
        description={<span className={srOnly}>{JOBS_INTRO}</span>}
        actions={
          <>
            <ColumnsMenu hidden={st.hidden} role={st.role} dispatch={dispatch} />
            {notPhone ? (
              <SegmentedControl label="View" value={view} onChange={setView} options={[
                { value: "cards", label: "Cards", testId: "view-cards-btn" },
                { value: "list", label: "List", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-list-btn" },
                { value: "table", label: "Table", disabled: !wide, disabledReason: "Needs a screen wider than 1024px", testId: "view-table-btn" },
              ]} />
            ) : null}
            <ExportMenu say={say} nSel={nSel} total={vis.length} testId="export-trigger" />
            {viewer ? null : <Button variant="primary" data-testid="new-job" onClick={() => setDlg({ k: "newjob" })}>New job</Button>}
          </>
        }
      />

      {st.screen === "offline" ? (
        <Callout tone="warn" lead="Offline" role="status" data-testid="state-offline" action={<Button size="sm" variant="secondary" onClick={() => say.info("Nothing to sync: the preview queued no changes.")}>Sync now</Button>}>
          Last synced 09:41. 2 changes waiting to sync. Simulated: this preview queues nothing.
        </Callout>
      ) : null}

      {st.screen === "error" ? (
        <div data-testid="state-error"><FailedState headingLevel={2} title={"Couldn’t load jobs."} detail="The list could not be fetched. This is a simulated failure: no request was made and nothing was lost." retryLabel="Retry" onRetry={reload} /></div>
      ) : null}

      {st.screen !== "error" ? (
        <>
          <Tiles counts={shown} pressed={pressedTile(st.filters)} unit={st.unit} dispatch={dispatch} loading={st.screen === "loading"} empty={st.screen === "empty"} />
          <FilterBar f={st.filters} counts={shown} dispatch={dispatch} dim={st.screen === "loading"} />
          {st.filters.listFilter ? (
            <Callout tone="info" lead="Showing only" role="status" data-testid="state-listfilter" action={<Button size="sm" variant="secondary" onClick={() => dispatch({ t: "clearListFilter" })}>Show everything</Button>}>Jobs past their required date</Callout>
          ) : null}

          <SelectionBar
            count={nSel} filteredTotal={vis.length} noun="filtered job" idleNote={idleNote}
            statusText={({ count, filteredTotal }) => `${count} selected of ${jobWord(filteredTotal)}.`}
            onSelectAll={() => dispatch({ t: "selectAll", refs: vis.map((j) => j.ref) })} onClear={() => dispatch({ t: "clearSelection" })}
          >
            {nSel > 0 ? (
              <>
                <Button size="sm" variant="secondary" data-testid="print-pack" onClick={() => say.info(`The workshop pack for ${nSel} job${nSel === 1 ? "" : "s"} is not opened in the preview.`)}>Print Workshop Pack</Button>
                <ExportMenu say={say} nSel={nSel} total={vis.length} testId="export-selected-trigger" />
                {viewer ? null : (
                  <Button size="sm" variant="primary" data-testid="finish-selected" aria-disabled={!planBulkFinish(selectedVisible).targets.length || undefined}
                    onClick={() => { if (!planBulkFinish(selectedVisible).targets.length) { say.fail("None of the selected jobs can be finished."); return; } setDlg({ k: "bulk" }); }}>Finish Selected ({nSel})</Button>
                )}
              </>
            ) : null}
          </SelectionBar>

          {st.screen === "truncated" ? <Callout tone="info" lead="Note" role="status" data-testid="state-truncated">Showing the newest 1,000 records only. Older records exist but aren{"’"}t listed here.</Callout> : null}

          {st.screen === "loading" ? <div data-testid="state-loading"><LoadingState label="Loading jobs" rows={8} /></div> : noJobs ? (
            <div data-testid="state-empty"><EmptyState headingLevel={2} title={EMPTY_HINT[st.role]} action={viewer ? undefined : <Button variant="primary" onClick={() => setDlg({ k: "newjob" })}>New job</Button>} /></div>
          ) : view === "cards" ? (
            groups ? (
              <div className={s.cardGroups}>{groups.map((g) => <section key={g.heading}><h2 className={cx(typeScale.card, s.groupHead)}>{g.heading}</h2><JobCards label={g.heading} jobs={g.jobs} columns={columns} selected={st.selected} ctx={ctx} flash={st.flash} dispatch={dispatch} /></section>)}</div>
            ) : (
              <div data-testid="view-cards"><JobCards label="Jobs, cards" jobs={vis} columns={columns} selected={st.selected} ctx={ctx} flash={st.flash} dispatch={dispatch} /></div>
            )
          ) : vis.length || groups ? (
            <JobTable jobs={vis} groups={groups} view={view} columns={columns} selected={st.selected} expanded={st.expanded} role={st.role} ctx={ctx} flash={st.flash} dispatch={dispatch} />
          ) : st.filters.show === "archived" ? null : (
            <div data-testid="state-nomatch"><EmptyState headingLevel={2} title="No jobs match these filters." action={isFiltered(st.filters) ? <Button variant="secondary" onClick={() => dispatch({ t: "clearFilters" })}>Clear filters</Button> : undefined} /></div>
          )}
        </>
      ) : null}

      <DialogHost dlg={lastDlg.current} open={dlg !== null} close={() => setDlg(null)} st={st} dispatch={dispatch} vis={vis} say={say} />
    </div>
  );
}
