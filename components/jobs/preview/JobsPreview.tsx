"use client";

/**
 * BOUNDARY (Jobs module 2, PREVIEW ONLY). Inputs: none from the server. Everything shown is fictional sample data copied from the
 * design parity fixture (24 jobs, 20 open), held in this file, plus the person's clicks. Outputs: a Job Board look-and-feel
 * prototype (Cards, List, Table, filters, selection, Columns, Export, row actions, preview dialogs) that changes LOCAL STATE ONLY.
 * It never reads or writes Supabase, calls no server action or API route, imports no lib/ business module, and every action says
 * plainly that nothing was saved. Presentation is in this file's second half and in JobsPreview.module.css; the typed data and the
 * pure state logic (first half) are exported for tests/unit/jobsPreview.test.tsx.
 * MUST NOT CHANGE: wording, defaults, column order, role gating and action order mirror today's Job Board (app/(dashboard)/jobs/page.tsx,
 * lib/job-flow.ts, lib/job-status.ts, lib/job-actions.ts). Do not wire this file to real data or real actions; do not add controls
 * that the real board does not have (no tabs, search box or sort). Row controls stay at least 48px tall (e2e rule).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Dialog, DropdownMenu, Popover } from "radix-ui";

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
  | { t: "stage"; v: Stage } | { t: "tile"; v: Tile } | { t: "clearListFilter" } | { t: "listFilter" }
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
/* 4. Presentation                                                      */
/* ================================================================== */

/* Preview acknowledgements: one neutral "Preview only" toast style (never a real-success look), shown by <Toasts/> below the top bar. */
type ToastItem = { id: number; text: string; kind: "preview" | "error" };
let toastSeq = 0;
const toastSubs = new Set<(t: ToastItem | null) => void>();
const stop = (m: string) => (/[.!?]$/.test(m) ? m : `${m}.`);
const push = (text: string, kind: ToastItem["kind"]) => toastSubs.forEach((f) => f({ id: ++toastSeq, text, kind }));
const say = {
  ok: (m: string) => push(stop(m), "preview"),
  info: (m: string) => push(stop(m), "preview"),
  fail: (m: string) => push(stop(m), "error"),
};

const VIEW_KEY = "jobs-preview:view";
const subscribeMedia = (query: string) => (notify: () => void) => { const m = window.matchMedia(query); m.addEventListener("change", notify); return () => m.removeEventListener("change", notify); };
/** Wide = the fixed-sidebar layout (over 1024px). Phones (under 768px) have no switcher. Server and tests render wide. */
function useMedia(query: string, server: boolean) {
  const sub = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(sub, () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : server), () => server);
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
const family = (st: Status): "grey" | "blue" | "yellow" | "green" => (st === "not_started" ? "grey" : st === "running" ? "blue" : st === "complete" ? "green" : "yellow");
const dueFamily: Record<DueLight, "green" | "yellow" | "red" | "grey"> = { "On time": "green", "At risk": "yellow", Late: "red", "No due date": "grey" };
const tone = (name: string) => s[name] ?? "";

function Check() { return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className={s.checkGlyph}><path d="M3.2 8.4l3 3 6.6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function Chevron({ down }: { down?: boolean }) { return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={down ? s.chevDown : undefined}><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

function Badge({ word, color, kind }: { word: string; color: "grey" | "blue" | "yellow" | "green" | "red" | "purple" | "violet"; kind?: "status" | "tag" }) {
  return <span className={cx(s.badge, tone(`b_${color}`), kind === "tag" && s.badgeTag)} data-badge={word}><i className={s.lamp} aria-hidden />{word}</span>;
}

/* ---------------- small parts ---------------- */

function Segmented<T extends string>({ label, value, options, onChange, size }: { label: string; value: T; options: Array<{ v: T; label: string; hidden?: boolean; disabled?: string; testId?: string }>; onChange: (v: T) => void; size?: "sm" }) {
  return (
    <div role="group" aria-label={label} className={cx(s.seg, size === "sm" && s.segSm)}>
      {options.filter((o) => !o.hidden).map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} aria-disabled={o.disabled ? true : undefined} title={o.disabled} data-testid={o.testId} className={s.segBtn} onClick={() => { if (!o.disabled) onChange(o.v); }}>{o.label}</button>
      ))}
    </div>
  );
}

function Chip({ pressed, onClick, children, testId, tag, dim }: { pressed: boolean; onClick: () => void; children: ReactNode; testId?: string; tag?: boolean; dim?: boolean }) {
  return <button type="button" aria-pressed={pressed} aria-disabled={dim || undefined} data-testid={testId} className={cx(s.chip, tag && s.chipTag, dim && s.chipDim)} onClick={dim ? undefined : onClick}>{pressed ? <Check /> : null}{children}</button>;
}

/** A real switch (role="switch", aria-checked): label left, track right, whole row is the hit area (at least 44px). Local state only. */
function Switch({ checked, onChange, label, note, disabled, testId, compact, id }: { checked: boolean; onChange: (next: boolean) => void; label: ReactNode; note?: string; disabled?: string; testId?: string; compact?: boolean; id?: string }) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-disabled={disabled ? true : undefined} title={disabled} data-testid={testId} className={cx(s.sw, compact && s.swCompact)}
      onClick={() => { if (!disabled) onChange(!checked); }}>
      <span className={s.swLabel}>{label}</span>
      {note ? <span className={s.swNote}>{note}</span> : null}
      <span className={s.swTrack} aria-hidden><span className={s.swThumb} /></span>
    </button>
  );
}

function Checkbox({ checked, onChange, label, testId }: { checked: boolean; onChange: () => void; label: string; testId?: string }) {
  return <input type="checkbox" className={s.check} checked={checked} onChange={onChange} aria-label={label} data-testid={testId} />;
}

const TERTIARY = new Set<ActionLabel>(["Worksheet", "Machines", "Print", "Delivery note", "Release early", "Archive", "Rework", "Reopen"]);
/** One state-aware primary per row (Start, Resume, Start timer, Pick a machine, Pause, or Inspected when it is the next step); Send and Finish are secondary; the rest are quiet. */
export function primaryLabel(actions: Action[]): ActionLabel | null {
  const play = actions.find((a) => ["Start", "Resume", "Start timer", "Pick a machine", "Pause"].includes(a.label));
  if (play) return play.label;
  const insp = actions.find((a) => a.label === "Inspected" && !a.disabled);
  return insp ? insp.label : null;
}
const kindFor = (a: Action, primary: ActionLabel | null) => (a.disabled ? "off" : a.label === primary ? "primary" : TERTIARY.has(a.label) ? "tertiary" : "secondary");

function ActionButton({ action, job, onAct, primary }: { action: Action; job: Job; onAct: (job: Job, a: Action) => void; primary?: ActionLabel | null }) {
  const kind = kindFor(action, primary ?? null);
  return (
    <button type="button" data-action={action.label} aria-disabled={action.disabled || undefined} className={cx(s.act, tone(`a_${kind}`))}
      title={action.disabled ? disabledReason(job, action.label) : undefined} onClick={() => onAct(job, action)}>{action.label}</button>
  );
}

function MachinePicker({ job, onPick, children }: { job: Job; onPick: (job: Job, machine: string) => void; children: ReactNode }) {
  const [openPop, setOpen] = useState(false);
  return (
    <Popover.Root open={openPop} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.pop} align="start" sideOffset={6} aria-label={`Pick a machine for ${job.ref}`}>
          <p className={s.popTitle}>Pick a machine</p>
          {MACHINES.map((m) => <button key={m} type="button" className={s.popItem} data-selected={job.pick === m || undefined} onClick={() => { onPick(job, m); setOpen(false); }}>{m}</button>)}
          <button type="button" className={s.popItem} onClick={() => { onPick(job, "N/A (bench)"); setOpen(false); }}>No machine (bench)</button>
          <button type="button" className={cx(s.popItem, s.popAdd)} onClick={() => { say.info("Add machine opens the Machine Schedule in the real board."); setOpen(false); }}>Add machine</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function StatusLine({ job }: { job: Job }) {
  return <span className={cx(s.statusLine, tone(`t_${family(job.status)}`))}><i className={s.lamp} aria-hidden />{STATUS_WORD[job.status]}</span>;
}

/** The one status grammar for Cards and List: dot plus status word, then the due word. */
function IdState({ job }: { job: Job }) {
  return <span className={s.idState}><StatusLine job={job} />{showsDueLight(job) && job.due ? <span className={cx(s.dueWord, tone(`d_${dueFamily[job.due]}`))}>{job.due}</span> : null}</span>;
}

function DueCell({ job }: { job: Job }) {
  return (
    <div className={s.dueCell}>
      {job.dueText ? <span className={s.date}>{job.dueText}</span> : null}
      <span className={s.badges}>
        <Badge word={STATUS_WORD[job.status]} color={family(job.status)} />
        {job.rework ? <Badge word="Rework" color="purple" kind="tag" /> : null}
        {job.problem ? <Badge word="Problem" color="red" kind="tag" /> : null}
        {showsDueLight(job) && job.due ? <Badge word={job.due} color={dueFamily[job.due]} /> : null}
      </span>
    </div>
  );
}

function FileNames({ names }: { names: string }) {
  return names === "None" ? <span className={s.none}>None</span> : <span className={s.file}>{names}</span>;
}

type RowCtx = {
  role: Role; view: ViewMode; onAct: (j: Job, a: Action) => void; onPick: (j: Job, m: string) => void; dispatch: (a: Act) => void;
  onRelease: (j: Job) => void; goTo: (ref: string) => void;
};

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
          {picker ? (
            <MachinePicker job={job} onPick={ctx.onPick}>
              <button type="button" className={cx(s.pickBtn, job.pick === "Pick a machine" && s.pickEmpty)} data-op="picker">{job.pick}<Chevron down /></button>
            </MachinePicker>
          ) : null}
          {job.timer ? <span className={s.timer}>{job.timer}</span> : null}
          {releaseBtn ? <button type="button" className={cx(s.act, s.a_secondary)} data-op="release" onClick={() => ctx.onRelease(job)}>Release</button> : null}
          {addMachine ? <button type="button" className={cx(s.act, s.a_link)} data-op="add-machine" onClick={() => say.info("Add machine opens the Machine Schedule in the real board.")}>Add machine</button> : null}
        </span>
      ) : null}
      {job.planned ? <span className={s.planned}>Planned: {job.planned}</span> : null}
      {!job.planned && !job.inUse && !picker && !(job.pick === "N/A (bench)") ? <span className={s.none}>{"\u2014"}</span> : null}
    </div>
  );
}

function OperatorCell({ job, ctx }: { job: Job; ctx: RowCtx }) {
  const isOpen = job.status !== "complete" && !job.archived;
  const mine = job.assignee === ME;
  return (
    <div className={s.operator}>
      <span>{job.assignee ? `Assigned to ${mine ? "You" : job.assignee}` : "Unassigned"}</span>
      {job.pausedBy ? <span className={s.sub}>{job.pausedBy}</span> : null}
      {isOpen && (ctx.role === "admin" || ctx.role === "office") ? (
        <label className={s.selWrap}>
          <select aria-label={`Assign ${job.ref}`} className={s.select} value={job.assignee ?? ""} onChange={(e) => { const to = e.target.value || null; ctx.dispatch({ t: "op", ref: job.ref, op: { type: "assign", to } }); say.ok(to ? `${job.ref} assigned to ${to === ME ? "you" : to}.` : `${job.ref} unassigned.`); }}>
            <option value="">Unassigned</option>
            {PEOPLE.map((p) => <option key={p} value={p}>{p === ME ? `${p} (you)` : p}</option>)}
          </select>
          <Chevron down />
        </label>
      ) : null}
      {isOpen && ctx.role === "workshop" ? (
        <button type="button" className={cx(s.act, s.a_secondary)} data-op={mine ? "hand-back" : "take"} onClick={() => { ctx.dispatch({ t: "op", ref: job.ref, op: { type: "assign", to: mine ? null : ME } }); say.ok(mine ? `${job.ref} handed back.` : `${job.ref} is now yours.`); }}>{mine ? "Hand back" : "Take this job"}</button>
      ) : null}
    </div>
  );
}

function RowActions({ job, ctx, align }: { job: Job; ctx: RowCtx; align?: "end" }) {
  const actions = actionsFor(job, ctx.role, ctx.view);
  const primary = primaryLabel(actions);
  return (
    <div className={cx(s.actions, align === "end" && s.actionsEnd)}>
      {actions.map((a) => {
        if (a.label === "Pick a machine") {
          return (
            <MachinePicker key={a.label} job={job} onPick={ctx.onPick}>
              <button type="button" data-action="Pick a machine" className={cx(s.act, s.a_primary)}>Pick a machine</button>
            </MachinePicker>
          );
        }
        return <ActionButton key={a.label} action={a} job={job} onAct={ctx.onAct} primary={primary} />;
      })}
    </div>
  );
}

function RelatedLinks({ job, ctx }: { job: Job; ctx: RowCtx }) {
  return (
    <>
      {job.relTo ? <button type="button" className={s.related} data-op="related-link" onClick={() => ctx.goTo(job.relTo as string)}>Related to {job.relTo}</button> : null}
      {job.relFrom.map((r) => <button key={r} type="button" className={s.related} data-op="related-link" onClick={() => ctx.goTo(r)}>Related: {r}</button>)}
    </>
  );
}

/* ---------------- table and list ---------------- */

const DATA_CELL: Record<Exclude<ColumnKey, "ref" | "machine" | "operator" | "due" | "actions" | "stage">, (j: Job) => ReactNode> = {
  customer: (j) => <span className={s.strong}>{j.customer}</span>,
  description: (j) => <span className={s.clamp}>{j.description}</span>,
  specification: (j) => <span className={cx(s.clamp, s.small)}>{j.specification}</span>,
  drawings: (j) => <FileNames names={j.drawings} />,
  attachments: (j) => <FileNames names={j.attachments} />,
  started: (j) => <span className={cx(s.date, j.started === "Not started" && s.none)}>{j.started}</span>,
  finished: (j) => <span className={cx(s.date, j.finished === "Not finished" && s.none)}>{j.finished}</span>,
  inspection: (j) => <><span className={cx(s.small, j.inspection === "Not finished" && s.none)}>{j.inspection}</span>{j.reworkNote ? <span className={cx(s.small, s.sub, s.block)}>Rework: {j.reworkNote}</span> : null}</>,
};

function cellFor(key: ColumnKey, j: Job, ctx: RowCtx): ReactNode {
  switch (key) {
    case "ref": return (
      <div className={s.refCell}>
        <span className={s.refLine}><span className={s.ref}>{j.ref}</span>{j.internal ? <Badge word="Internal" color="violet" kind="tag" /> : null}</span>
        <IdState job={j} />
        <RelatedLinks job={j} ctx={ctx} />
      </div>
    );
    case "stage": return <><span className={s.strong}>{j.stage ?? "—"}</span><span className={cx(s.small, s.sub, s.block)} data-testid="job-progress">{j.progress}</span></>;
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
  const scroller = useRef<HTMLDivElement>(null);
  const [sc, setSc] = useState({ l: false, r: false });
  const upd = useCallback(() => { const e = scroller.current; if (e) setSc({ l: e.scrollLeft > 2, r: e.scrollLeft + e.clientWidth < e.scrollWidth - 2 }); }, []);
  useEffect(() => { upd(); window.addEventListener("resize", upd); return () => window.removeEventListener("resize", upd); }, [upd, jobs, columns, view]);
  const allTicked = jobs.length > 0 && jobs.every((j) => selected.includes(j.ref));
  const span = columns.length + (list ? 2 : 1);
  const row = (j: Job, scope = "") => {
    const isOpen = expanded.includes(j.ref);
    const extra = expandedActionsFor(j, role);
    return [
      <tr key={`${scope}${j.ref}`} data-job={j.ref} data-status={j.status} data-flash={flash === j.ref || undefined} data-selected={selected.includes(j.ref) || undefined} className={s.row}>
        <td className={cx(s.cSel, s.stickyL0)}><Checkbox checked={selected.includes(j.ref)} onChange={() => dispatch({ t: "select", ref: j.ref })} label={`Select ${j.ref}`} testId="select-row" /></td>
        {list ? <td className={cx(s.cDet, s.stickyL1)}><button type="button" className={s.expander} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details for ${j.ref}`} data-op="expander" onClick={() => dispatch({ t: "expand", ref: j.ref })}><Chevron down={isOpen} /></button></td> : null}
        {columns.map((c) => <td key={c.key} data-col={c.key} className={cx(s[`c_${c.key}`], c.key === "ref" && (list ? s.stickyL2 : s.stickyL1), c.key === "actions" && s.stickyR)}>{cellFor(c.key, j, ctx)}</td>)}
      </tr>,
      list && isOpen ? (
        <tr key={`${scope}${j.ref}-x`} className={s.expandRow} data-testid="list-expansion">
          <td colSpan={span}>
            <div className={s.expandBody}>
              <span><b>Progress:</b> {j.progress}</span>
              {j.parts ? <span><b>Parts logged:</b> {j.parts}</span> : null}
              {j.reworkNote ? <span><b>Rework:</b> {j.reworkNote}</span> : null}
              {extra.map((a) => <ActionButton key={a.label} action={a} job={j} onAct={ctx.onAct} primary={null} />)}
            </div>
          </td>
        </tr>
      ) : null,
    ];
  };
  return (
    <div className={cx(s.tableCard, list ? s.isList : s.isTable)} data-testid={`view-${view}`} data-sl={sc.l || undefined} data-sr={sc.r || undefined}>
      <div className={s.scroller} ref={scroller} onScroll={upd} tabIndex={0} role="region" aria-label={`Jobs, ${view} view`}>
        <table className={s.table}>
          <thead>
            <tr>
              <th className={cx(s.cSel, s.stickyL0)}><Checkbox checked={allTicked} onChange={() => dispatch({ t: "selectAll", refs: allTicked ? [] : jobs.map((j) => j.ref) })} label={`Select all ${jobs.length} filtered jobs`} testId="select-all-header" /></th>
              {list ? <th className={cx(s.cDet, s.stickyL1)}><span className={s.srOnly}>Details</span></th> : null}
              {columns.map((c) => <th key={c.key} scope="col" data-col={c.key} className={cx(s[`c_${c.key}`], c.key === "ref" && (list ? s.stickyL2 : s.stickyL1), c.key === "actions" && s.stickyR)}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups
              ? groups.flatMap((g) => [<tr key={g.heading} className={s.groupRow}><th colSpan={span} scope="colgroup"><span className={s.groupText}>{g.heading}</span></th></tr>, ...g.jobs.flatMap((j) => row(j, `${g.heading}/`))])
              : jobs.flatMap((j) => row(j))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- cards ---------------- */

const CARD_FIELDS: Array<{ key: ColumnKey; label: string }> = COLUMNS.filter((c) => c.key !== "ref" && c.key !== "actions");

function JobCard({ j, columns, selected, ctx, flash, dispatch }: { j: Job; columns: Array<{ key: ColumnKey }>; selected: boolean; ctx: RowCtx; flash: boolean; dispatch: (a: Act) => void }) {
  const shown = CARD_FIELDS.filter((f) => columns.some((c) => c.key === f.key));
  return (
    <article className={s.card} data-job={j.ref} data-status={j.status} data-flash={flash || undefined} data-selected={selected || undefined} aria-label={`Job ${j.ref}`}>
      <header className={s.cardHead}>
        <Checkbox checked={selected} onChange={() => dispatch({ t: "select", ref: j.ref })} label={`Select ${j.ref}`} testId="select-row" />
        <div className={s.cardId}>
          <span className={s.refLine}><span className={s.ref}>{j.ref}</span>{j.internal ? <Badge word="Internal" color="violet" kind="tag" /> : null}</span>
          <RelatedLinks job={j} ctx={ctx} />
        </div>
      </header>
      <div className={cx(s.badges, s.cardBadges)}>
        <IdState job={j} />
        {j.rework ? <Badge word="Rework" color="purple" kind="tag" /> : null}
        {j.problem ? <Badge word="Problem" color="red" kind="tag" /> : null}
        {j.status === "running" && j.progress !== "Not started" ? <span className={s.suffix}>{`· ${j.progress}`}</span> : null}
      </div>
      <dl className={s.fields}>
        {shown.map((f) => (
          <div key={f.key} className={cx(s.field, (f.key === "description" || f.key === "specification" || f.key === "machine") && s.fieldWide)}>
            <dt>{f.label}</dt>
            <dd>{f.key === "stage" ? <><span className={s.strong}>{j.stage ?? "—"}</span></> : f.key === "due" ? <span className={s.date}>{j.dueText ?? "No due date"}</span> : cellFor(f.key, j, ctx)}</dd>
          </div>
        ))}
        {j.parts ? <div className={s.field}><dt>Parts logged</dt><dd>{j.parts}</dd></div> : null}
      </dl>
      <div className={s.cardActions}><RowActions job={j} ctx={ctx} /></div>
    </article>
  );
}

/* ---------------- header, tiles, filters, selection ---------------- */

function Tiles({ counts, pressed, unit, dispatch, loading, empty }: { counts: Counts; pressed: Tile | null; unit: "days" | "hours"; dispatch: (a: Act) => void; loading?: boolean; empty?: boolean }) {
  const tiles: Array<{ id: Tile; label: string; value: number; sub: string; hint: string; color: string }> = [
    { id: "open", label: "Open jobs", value: counts.open, sub: "Not started, running or waiting", hint: "Not started + Running + Waiting for inspection. Complete jobs are not counted.", color: "navy" },
    { id: "not_started", label: "Not started", value: counts.notStarted, sub: "No work yet", hint: "Open: no work started yet", color: "grey" },
    { id: "running", label: "Running", value: counts.running, sub: "In progress, rework included", hint: "Open: started, not finished (rework included)", color: "blue" },
    { id: "waiting", label: "Waiting for inspection", value: counts.waiting, sub: "Finished, not passed", hint: "Open: finished, not yet passed", color: "yellow" },
    { id: "complete", label: "Complete", value: counts.complete, sub: "Passed, not archived", hint: "Passed inspection; not archived", color: "green" },
  ];
  return (
    <section className={s.tiles} aria-label="Job totals" data-testid="tiles">
      {tiles.map((t) => (
        <button key={t.id} type="button" aria-pressed={pressed === t.id} title={t.hint} className={cx(s.tile, tone(`k_${t.color}`))} data-testid={`tile-${t.id}`} onClick={() => dispatch({ t: "tile", v: t.id })}>
          <span className={s.tileLabel}><i className={s.lamp} aria-hidden />{t.label}</span>
          <span className={cx(s.tileValue, loading && s.tileLoading)}>{loading ? "\u2014" : t.value}</span>
          <span className={s.tileSub}>{t.sub}</span>
        </button>
      ))}
      <div className={cx(s.tile, s.tileStatic, tone("k_grey"))} data-testid="tile-average">
        <span className={s.tileLabel}><i className={s.lamp} aria-hidden />Average job time</span>
        <span className={cx(s.tileValue, loading && s.tileLoading)}>{loading || empty ? "\u2014" : unit === "days" ? AVERAGE_JOB_TIME.days : AVERAGE_JOB_TIME.hours}</span>
        <span className={s.tileSub}>Start to finish.
          <Segmented size="sm" label="Average job time unit" value={unit} onChange={(v) => dispatch({ t: "unit", v })} options={[{ v: "hours", label: "Hours", testId: "unit-hours" }, { v: "days", label: "Days", testId: "unit-days" }]} />
        </span>
      </div>
    </section>
  );
}

function FilterRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className={s.fRow}><span className={s.fLabel}>{label}</span><div className={s.fChips}>{children}{note ? <span className={s.fNote}>{note}</span> : null}</div></div>;
}

function Filters({ f, counts, dispatch, dim }: { f: Filters; counts: Counts; dispatch: (a: Act) => void; dim?: boolean }) {
  const n = (v: number) => (dim ? "\u2014" : v);
  const due: Array<{ v: DueFilter; label: string }> = [{ v: "all", label: "All" }, { v: "On time", label: `On time (${n(counts.due["On time"])})` }, { v: "At risk", label: `At risk (${n(counts.due["At risk"])})` }, { v: "Late", label: `Late (${n(counts.due.Late)})` }, { v: "No due date", label: `No due date (${n(counts.due["No due date"])})` }];
  return (
    <section className={s.filters} aria-label="Filters" data-testid="filters">
      <FilterRow label="Show">
        {([["open", `Open (${n(counts.open)})`], ["complete", `Complete (${n(counts.complete)})`], ["archived", `Archived (${n(counts.archived)})`], ["all", "All"]] as Array<[ShowFilter, string]>).map(([v, l]) => <Chip dim={dim} key={v} pressed={f.show === v && !f.listFilter} testId={`show-${v}`} onClick={() => dispatch({ t: "show", v })}>{l}</Chip>)}
      </FilterRow>
      <FilterRow label="Type">
        {([["all", "All"], ["customer", "Customer"], ["internal", `Internal (${n(counts.internal)})`]] as Array<[TypeFilter, string]>).map(([v, l]) => <Chip dim={dim} key={v} pressed={f.type === v} testId={`type-${v}`} onClick={() => dispatch({ t: "type", v })}>{l}</Chip>)}
      </FilterRow>
      <FilterRow label="Group">
        {([["none", "None"], ["machine", "Machine"]] as Array<[GroupBy, string]>).map(([v, l]) => <Chip dim={dim} key={v} pressed={f.group === v} testId={`group-${v}`} onClick={() => dispatch({ t: "group", v })}>{l}</Chip>)}
      </FilterRow>
      <FilterRow label="Due" note="Not started and Running jobs only">
        {due.map((d) => <Chip dim={dim} key={d.v} pressed={f.due === d.v} testId={`due-${d.v}`} onClick={() => dispatch({ t: "due", v: d.v })}>{d.label}</Chip>)}
      </FilterRow>
      <FilterRow label="Tag" note="Running jobs put back after a failed inspection (or for replacements)">
        <Switch compact checked={f.rework} disabled={dim ? "Loading" : undefined} testId="tag-rework" label={`Rework (${n(counts.rework)})`} onChange={() => dispatch({ t: "rework" })} />
      </FilterRow>
      <FilterRow label="Stage">
        {STAGES.map((g) => <Chip dim={dim} key={g} pressed={f.stages.includes(g)} testId={`stage-${g.toLowerCase()}`} onClick={() => dispatch({ t: "stage", v: g })}>{g}</Chip>)}
      </FilterRow>
    </section>
  );
}

function ColumnsMenu({ hidden, role, dispatch }: { hidden: ColumnKey[]; role: Role; dispatch: (a: Act) => void }) {
  const own = role === "workshop" || role === "viewer";
  return (
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className={cx(s.btn, s.btnSecondary)} data-testid="columns-trigger">Columns<Chevron down /></button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={cx(s.pop, s.colsPop)} align="end" sideOffset={6} aria-label="Job Board columns" data-testid="columns-panel">
          <p className={s.popTitle}>Job Board columns</p>
          {COLUMNS.map((c) => (
            <Switch key={c.key} checked={c.locked ? true : !hidden.includes(c.key)} label={c.label} note={c.locked ? "Always on" : undefined} disabled={c.locked ? `${c.label} is always shown` : undefined}
              testId={`col-${c.key}`} onChange={() => dispatch({ t: "toggleColumn", v: c.key })} />
          ))}
          <div className={s.menuSep} />
          <button type="button" className={s.popItem} onClick={() => dispatch({ t: "resetColumns" })}>{own ? "Reset to the company view" : "Reset to default (show all columns)"}</button>
          <p className={s.menuNote}>{own ? "Your own view on this device only. Everyone else, and the company setting, are not changed." : "Changes apply to everyone in this company."} Preview: nothing is saved.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExportMenu({ dark }: { dark: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className={cx(s.btn, dark ? s.btnOnDark : s.btnSecondary)} data-testid="export-trigger">Export<Chevron down /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cx(s.menu, s.menuNarrow)} align="end" sideOffset={6}>
          {["CSV", "Excel", "Word", "PDF"].map((fmt) => <DropdownMenu.Item key={fmt} className={s.menuItem} onSelect={() => say.info(`${fmt} export is not generated in the preview.`)}>{fmt}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/* ---------------- dialogs ---------------- */

function Modal({ open: isOpen, title, description, onClose, children, footer, wide }: { open: boolean; title: string; description?: string; onClose: () => void; children?: ReactNode; footer: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={cx(s.dialog, wide && s.dialogWide)}>
          <Dialog.Title className={s.dlgTitle}>{title}</Dialog.Title>
          {description ? <Dialog.Description className={s.dlgDesc}>{description}</Dialog.Description> : <Dialog.Description className={s.srOnly}>{title}</Dialog.Description>}
          <div className={s.dlgBody}>{children}</div>
          <p className={s.dlgPreview}>Preview data. Nothing here is saved, sent or printed.</p>
          <div className={s.dlgFoot}>{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type DialogState =
  | { k: "pause" | "finish" | "inspect" | "reopen" | "release" | "rework" | "worksheet" | "machines" | "delivery" | "send" | "releaseMachine" | "takeover"; ref: string; machine?: string }
  | { k: "bulk" } | { k: "newjob" };

function Row({ label, value }: { label: string; value: ReactNode }) { return <div className={s.kv}><dt>{label}</dt><dd>{value}</dd></div>; }

function Dialogs({ dlg, close, st, dispatch, vis }: { dlg: DialogState | null; close: () => void; st: State; dispatch: (a: Act) => void; vis: Job[] }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<"pass" | "fail" | "concession">("pass");
  const [form, setForm] = useState({ customer: "", description: "", internal: false });
  const [formError, setFormError] = useState("");
  useEffect(() => { setReason(""); setResult("pass"); setForm({ customer: "", description: "", internal: false }); setFormError(""); }, [dlg]);
  if (!dlg) return null;
  const cancel = <button type="button" className={cx(s.btn, s.btnSecondary)} onClick={close}>Cancel</button>;
  const done = <button type="button" className={cx(s.btn, s.btnPrimary)} onClick={close}>Close</button>;

  if (dlg.k === "bulk") {
    const selected = st.jobs.filter((j) => st.selected.includes(j.ref));
    const plan = planBulkFinish(selected);
    return (
      <Modal open title={`Finish ${selected.length} selected job${selected.length === 1 ? "" : "s"}?`} onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} disabled={!plan.targets.length} onClick={() => { dispatch({ t: "bulkFinish", refs: plan.targets.map((j) => j.ref) }); close(); say.ok(`${plan.targets.length} job${plan.targets.length === 1 ? "" : "s"} finished on screen.`); }}>Finish {plan.targets.length} job{plan.targets.length === 1 ? "" : "s"}</button></>}>
        <p className={s.lead}>Will be finished ({plan.targets.length}): {plan.targets.map((j) => j.ref).join(", ") || "none"}</p>
        {plan.skipped.length ? <p className={s.dlgText}>Will not change ({plan.skipped.length}): {plan.skipped.map((x) => `${x.job.ref} (${x.reason})`).join(", ")}</p> : null}
        <p className={s.dlgText}>Only the {selected.length} selected job{selected.length === 1 ? " is" : "s are"} affected, not every filtered job ({vis.length}).</p>
      </Modal>
    );
  }
  if (dlg.k === "newjob") {
    const create = () => {
      if (!form.internal && !form.customer.trim()) { setFormError("Enter the customer, or tick Internal job."); return; }
      if (!form.description.trim()) { setFormError("Enter a description."); return; }
      const ref = nextJobNo(st.jobs);
      const job: Job = { ...initialJobs()[0], ref, internal: form.internal, relTo: null, relFrom: [], customer: form.internal ? "Internal" : form.customer.trim(), description: form.description.trim(), specification: "", drawings: "None", attachments: "None", stage: "Material", status: "not_started", due: "No due date", dueText: null, rework: false, problem: false, progress: "Not started", started: "Not started", finished: "Not finished", inspection: "Not finished", reworkNote: null, parts: null, pick: null, inUse: null, timer: null, addMachine: false, release: false, planned: null, assignee: null, pausedBy: null, createdAt: "2026-11-20T10:30:00Z", archived: false, inspectAdminOnly: false, preview: true };
      dispatch({ t: "addJob", job });
      close();
      say.ok(`${ref} added to this preview only.`);
    };
    return (
      <Modal open title="New job" onClose={close} footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={create}>Create job</button></>}>
        <label className={s.field2}><span>Customer</span><input className={s.input} value={form.customer} disabled={form.internal} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></label>
        <label className={s.field2}><span>Description</span><input className={s.input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <Switch checked={form.internal} label="Internal job (no customer)" testId="newjob-internal" onChange={(v) => setForm({ ...form, internal: v })} />
        {formError ? <p role="alert" className={s.formError}>{formError}</p> : null}
      </Modal>
    );
  }
  const job = st.jobs.find((j) => j.ref === dlg.ref);
  if (!job) return null;
  const op = (o: Op, msg: string) => { dispatch({ t: "op", ref: job.ref, op: o }); close(); say.ok(msg); };
  switch (dlg.k) {
    case "pause": return <Modal open title={`Pause ${job.ref}?`} description="Are you sure you want to pause this job?" onClose={close} footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => op({ type: "pause" }, `${job.ref} paused on screen.`)}>Pause job</button></>} />;
    case "finish": return <Modal open title={`Finish ${job.ref}?`} description="Are you sure you want to finish this job?" onClose={close} footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => op({ type: "finish" }, `${job.ref} finished on screen: now Waiting for inspection.`)}>Finish job</button></>} />;
    case "releaseMachine": return <Modal open title={`Release ${job.inUse?.split(",")[0] ?? "machine"}?`} description={`${job.ref} stops using the machine.`} onClose={close} footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => op({ type: "releaseMachine" }, `${job.inUse?.split(",")[0] ?? "Machine"} released (was ${job.ref}).`)}>Release</button></>} />;
    case "takeover": return (
      <Modal open title={`Check before using ${dlg.machine}`} description={`${dlg.machine} is in use. Take over ${job.ref}?`} onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => { const other = st.jobs.find((j) => j.inUse?.startsWith(`${dlg.machine},`) && j.ref !== job.ref); if (other) dispatch({ t: "op", ref: other.ref, op: { type: "pause" } }); op({ type: "start", machine: dlg.machine }, `${job.ref} started on ${dlg.machine}${other ? `; ${other.ref} paused` : ""}.`); }}>Take over</button></>} />
    );
    case "inspect": return (
      <Modal open title={`Record inspection: ${job.ref}`} description={`${job.customer}: ${job.description}`} onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => op({ type: "inspect", result }, result === "fail" ? `${job.ref} failed inspection: put back to Running, tagged Rework.` : `${job.ref} inspected: Complete.`)}>Record inspection</button></>}>
        <fieldset className={s.radios}>
          <legend className={s.srOnly}>Inspection result</legend>
          {([["pass", "Passed"], ["fail", "Failed: send to rework"], ...(st.role === "admin" ? [["concession", "Released on concession"]] : [])] as Array<["pass" | "fail" | "concession", string]>).map(([v, l]) => (
            <label key={v} className={s.radio}><input type="radio" name="result" checked={result === v} onChange={() => setResult(v)} />{l}</label>
          ))}
        </fieldset>
      </Modal>
    );
    case "reopen": return (
      <Modal open title={`Reopen ${job.ref}`} description="Back to Running, with a reason." onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} disabled={!reason.trim()} onClick={() => op({ type: "reopen" }, `${job.ref} reopened: back to Running.`)}>Reopen job</button></>}>
        <label className={s.field2}><span>Reason</span><textarea className={s.input} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </Modal>
    );
    case "release": return (
      <Modal open title={`Release ${job.ref} early`} description="Release without waiting for the inspection result." onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} disabled={!reason.trim()} onClick={() => op({ type: "releaseEarly" }, `${job.ref} released early: Complete.`)}>Release job</button></>}>
        <label className={s.field2}><span>Reason</span><textarea className={s.input} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </Modal>
    );
    case "rework": return (
      <Modal open title={`Rework: ${job.ref}`} onClose={close} footer={done}>
        <dl className={s.kvList}><Row label="Inspection" value={job.inspection} /><Row label="Rework" value={job.reworkNote ?? "No rework recorded"} /><Row label="Status" value={job.progress} /></dl>
      </Modal>
    );
    case "worksheet": return (
      <Modal open title={`Worksheet - ${job.ref}`} onClose={close} footer={done} wide>
        <dl className={s.kvList}><Row label="Customer" value={job.customer} /><Row label="Description" value={job.description} /><Row label="Specification" value={job.specification || "None"} /><Row label="Drawings" value={job.drawings} /><Row label="Attachments" value={job.attachments} /><Row label="Planned machines" value={job.planned ?? "None"} /></dl>
        <p className={s.dlgText}>The full worksheet form (material, programs, times, checklist, sign-off) is not part of this preview.</p>
      </Modal>
    );
    case "machines": return (
      <Modal open title={`Machines - ${job.ref}`} onClose={close} footer={done}>
        <dl className={s.kvList}><Row label="Planned" value={job.planned ?? "None"} /><Row label="In use" value={job.inUse ?? "Not running on a machine"} /></dl>
        <p className={s.dlgText}>Booking hours is not part of this preview.</p>
      </Modal>
    );
    case "delivery": return (
      <Modal open title={`Delivery note - ${job.ref}`} onClose={close} footer={done}>
        <dl className={s.kvList}><Row label="Customer" value={job.customer} /><Row label="Description" value={job.description} /></dl>
        <p className={s.dlgText}>No delivery note is created in this preview.</p>
      </Modal>
    );
    case "send": return (
      <Modal open title={`Send ${job.ref} to Workshop`} description="The workshop gets the job by email in the real board." onClose={close}
        footer={<>{cancel}<button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => { close(); say.info(`${job.ref} was not sent. No email is sent from the preview.`); }}>Send</button></>} />
    );
  }
}

/* ---------------- states, dock ---------------- */

function SkeletonRows() {
  return (
    <div className={s.skelCard} role="status" aria-live="polite" aria-label="Loading jobs" data-testid="state-loading">
      <p className={s.srOnly}>Loading jobs</p>
      {Array.from({ length: 8 }, (_, i) => <div key={i} className={s.skelRow}><i /><i /><i /><i /><i /></div>)}
    </div>
  );
}

function PreviewControls({ st, dispatch, onReset }: { st: State; dispatch: (a: Act) => void; onReset: () => void }) {
  const roles: Array<{ v: Role; label: string }> = [{ v: "admin", label: "Admin" }, { v: "office", label: "Office" }, { v: "workshop", label: "Workshop" }, { v: "viewer", label: "Viewer" }];
  const screens: Array<{ v: Screen | "overdue"; label: string }> = [{ v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "empty", label: "No jobs" }, { v: "offline", label: "Offline" }, { v: "truncated", label: "Truncated" }, { v: "overdue", label: "Dashboard filter" }];
  const current = st.filters.listFilter ? "overdue" : st.screen;
  return (
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className={s.dockToggle} data-testid="dock-toggle">Preview controls<span>{st.role}</span></button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.dockPanel} align="start" sideOffset={8} data-testid="dock" aria-label="Preview controls">
          <p className={s.dockTitle}>Preview controls <span>Not part of Tolra</span></p>
          <Segmented label="Role" value={st.role} options={roles} onChange={(v) => dispatch({ t: "role", v })} size="sm" />
          <p className={s.dockLabel}>Screen state</p>
          <div className={s.dockStates}>
            {screens.map((x) => <button key={x.v} type="button" aria-pressed={current === x.v} className={s.dockBtn} onClick={() => { if (x.v === "overdue") { dispatch({ t: "screen", v: "ready" }); dispatch({ t: "listFilter" }); } else { dispatch({ t: "clearListFilter" }); dispatch({ t: "screen", v: x.v }); } }}>{x.label}</button>)}
          </div>
          <button type="button" className={cx(s.btn, s.btnSecondary, s.dockReset)} onClick={onReset}>Reset preview data</button>
          <p className={s.dockNote}>Sample data. States are simulated; no request is made.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Toasts({ resetKey }: { resetKey: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const f = (item: ToastItem | null) => {
      if (!item) { setItems([]); return; }
      setItems((c) => [...c.slice(-1), item]);
      window.setTimeout(() => setItems((c) => c.filter((x) => x.id !== item.id)), 3500);
    };
    toastSubs.add(f);
    return () => { toastSubs.delete(f); };
  }, []);
  useEffect(() => { setItems([]); }, [resetKey]);
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className={cx(s.toast, x.kind === "error" && s.toastErr)} data-testid="toast">
          <p>{x.kind === "preview" ? <b>Preview only. </b> : null}{x.text}{x.kind === "preview" ? " Nothing was saved." : ""}</p>
          <button type="button" aria-label="Dismiss message" className={s.toastClose} onClick={() => setItems((c) => c.filter((y) => y.id !== x.id))}><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- the page ---------------- */

export default function JobsPreview() {
  const [st, dispatch] = useReducer(reduce, undefined, initialState);
  const [dlg, setDlg] = useState<DialogState | null>(null);
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

  const startJob = useCallback((job: Job, machine?: string | null) => {
    const m = machine === undefined ? (job.pick && (MACHINES as readonly string[]).includes(job.pick) ? job.pick : null) : machine;
    const busy = m ? st.jobs.find((j) => j.ref !== job.ref && j.inUse?.startsWith(`${m},`)) : null;
    if (busy) { setDlg({ k: "takeover", ref: job.ref, machine: m as string }); return; }
    dispatch({ t: "op", ref: job.ref, op: { type: "start", machine: m } });
    say.ok(`${job.ref} started ${m ? `on ${m}` : "on the bench"}.`);
  }, [st.jobs]);

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
  }, [startJob]);

  const goTo = useCallback((ref: string) => {
    const el = document.querySelector(`[data-job="${ref}"]`);
    if (el) { el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); (el as HTMLElement).setAttribute("data-flash", "true"); window.setTimeout(() => el.removeAttribute("data-flash"), 1600); }
    else say.info(`${ref} is not in the current filter.`);
  }, []);

  const ctx: RowCtx = useMemo(() => ({
    role: st.role, view, onAct, dispatch,
    onPick: (job, machine) => { dispatch({ t: "op", ref: job.ref, op: { type: "pick", machine } }); say.ok(`${job.ref}: ${machine === "N/A (bench)" ? "no machine (bench)" : machine} chosen. Press Start to begin.`); },
    onRelease: (job) => setDlg({ k: "releaseMachine", ref: job.ref }), goTo,
  }), [st.role, view, onAct, goTo]);

  const reload = () => { dispatch({ t: "screen", v: "loading" }); window.setTimeout(() => { dispatch({ t: "screen", v: "ready" }); say.info("Sample jobs shown again. No server was contacted."); }, 700); };

  const noJobs = st.screen === "empty";
  const barDark = nSel > 0;

  return (
    <div className={s.root} data-testid="jobs-preview" data-role={st.role} data-pview={view}>
      <header className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.titleLine}>
            <h1 className={s.title}>Job Board</h1>
            <span className={s.previewTag} title="Everything on this screen is fictional sample data. Nothing is read from or saved to your account.">Preview · sample data, nothing is saved</span>
            <PreviewControls st={st} dispatch={dispatch} onReset={() => { dispatch({ t: "reset", view: st.view }); say.info("Sample data reset."); }} />
          </div>
          <p className={s.subtitle}>Jobs are the work in the workshop. Follow each one from start to finish.</p>
        </div>
        <div className={s.headControls}>
          <ColumnsMenu hidden={st.hidden} role={st.role} dispatch={dispatch} />
          {notPhone ? (
            <Segmented label="View" value={view} onChange={setView} options={[{ v: "cards", label: "Cards", testId: "view-cards-btn" }, { v: "list", label: "List", disabled: wide ? undefined : "Needs a screen wider than 1024px", testId: "view-list-btn" }, { v: "table", label: "Table", disabled: wide ? undefined : "Needs a screen wider than 1024px", testId: "view-table-btn" }]} />
          ) : null}
          {viewer ? null : <button type="button" className={cx(s.btn, s.btnPrimary)} data-testid="new-job" onClick={() => setDlg({ k: "newjob" })}>New job</button>}
        </div>
      </header>

      {st.screen === "offline" ? (
        <div className={s.banner} role="status" data-testid="state-offline"><b>Offline - last synced 09:41</b><span>2 changes waiting to sync.</span><span className={s.sim}>Simulated: this preview queues nothing.</span><button type="button" className={cx(s.btn, s.btnSecondary, s.btnSm)} onClick={() => say.info("Nothing to sync: the preview queued no changes.")}>Sync now</button></div>
      ) : null}

      {st.screen === "error" ? (
        <div className={s.errorCard} role="alert" data-testid="state-error">
          <div><p className={s.stateTitle}>Couldn{"\u2019"}t load jobs.</p><p className={s.stateText}>The list could not be fetched. This is a simulated failure: no request was made and nothing was lost.</p></div>
          <button type="button" className={cx(s.btn, s.btnSecondary)} onClick={reload}>Retry</button>
        </div>
      ) : null}

      {st.screen !== "error" ? (
        <>
          <Tiles counts={shown} pressed={pressedTile(st.filters)} unit={st.unit} dispatch={dispatch} loading={st.screen === "loading"} empty={st.screen === "empty"} />
          <Filters f={st.filters} counts={shown} dispatch={dispatch} dim={st.screen === "loading"} />
          {st.filters.listFilter ? (
            <div className={s.notice} role="status" data-testid="state-listfilter"><span>Showing only: Jobs past their required date</span><button type="button" className={cx(s.btn, s.btnSecondary, s.btnSm)} onClick={() => dispatch({ t: "clearListFilter" })}>Show everything</button></div>
          ) : null}

          <div className={cx(s.bar, barDark && s.barOn)} data-testid="selection-bar" data-active={barDark || undefined}>
            <button type="button" className={cx(s.btn, barDark ? s.btnOnDark : s.btnSecondary)} data-testid="select-all" onClick={() => dispatch({ t: "selectAll", refs: vis.map((j) => j.ref) })}>Select all {vis.length} filtered</button>
            <button type="button" className={cx(s.btn, barDark ? s.btnOnDark : s.btnSecondary)} disabled={!nSel} data-testid="clear-selection" onClick={() => dispatch({ t: "clearSelection" })}>Clear selection</button>
            <p className={s.barStatus} data-testid="selection-status"><b>{nSel} selected</b> of {vis.length} filtered job{vis.length === 1 ? "" : "s"}.</p>
            <span className={s.barSpacer} />
            <button type="button" className={cx(s.btn, barDark ? s.btnOnDark : s.btnSecondary)} data-testid="print-pack" onClick={() => { if (!nSel) say.fail(`No jobs selected. Tick the jobs to print${vis.length ? ` (or use "Select all ${vis.length} filtered")` : ""}, then press Print Workshop Pack again.`); else say.info(`The workshop pack for ${nSel} job${nSel === 1 ? "" : "s"} is not opened in the preview.`); }}>Print Workshop Pack</button>
            <ExportMenu dark={barDark} />
            {viewer ? null : (
              <button type="button" className={cx(s.btn, barDark ? s.btnFinishOnDark : s.btnSecondary)} data-testid="finish-selected" aria-disabled={!nSel || undefined}
                onClick={() => { if (!nSel) { say.fail("Select at least one job first."); return; } if (!planBulkFinish(selectedVisible).targets.length) { say.fail("None of the selected jobs can be finished."); return; } setDlg({ k: "bulk" }); }}>Finish Selected ({nSel})</button>
            )}
          </div>
          <p className={s.barNote} data-testid="selection-note">Print, export, Start and Finish apply to the selected jobs only. {selectionScope(nSel, vis.length)}.</p>

          {st.screen === "truncated" ? <p className={s.notice} role="status" data-testid="state-truncated">Showing the newest 1,000 records only. Older records exist but aren{"’"}t listed here.</p> : null}

          {st.screen === "loading" ? <SkeletonRows /> : noJobs ? (
            <div className={s.emptyCard} data-testid="state-empty"><p className={s.stateTitle}>{EMPTY_HINT[st.role]}</p>{viewer ? null : <button type="button" className={cx(s.btn, s.btnPrimary)} onClick={() => setDlg({ k: "newjob" })}>New job</button>}</div>
          ) : view === "cards" ? (
            groups ? (
              <div className={s.cardGroups}>{groups.map((g) => <section key={g.heading}><h2 className={s.groupHead}>{g.heading}</h2><div className={s.cards}>{g.jobs.map((j) => <JobCard key={`${g.heading}/${j.ref}`} j={j} columns={columns} selected={st.selected.includes(j.ref)} ctx={ctx} flash={st.flash === j.ref} dispatch={dispatch} />)}</div></section>)}</div>
            ) : (
              <div className={s.cards} data-testid="view-cards">{vis.map((j) => <JobCard key={j.ref} j={j} columns={columns} selected={st.selected.includes(j.ref)} ctx={ctx} flash={st.flash === j.ref} dispatch={dispatch} />)}</div>
            )
          ) : vis.length || groups ? (
            <JobTable jobs={vis} groups={groups} view={view} columns={columns} selected={st.selected} expanded={st.expanded} role={st.role} ctx={ctx} flash={st.flash} dispatch={dispatch} />
          ) : st.filters.show === "archived" ? null : (
            <div className={s.emptyCard} data-testid="state-nomatch"><p>No jobs match these filters.</p></div>
          )}
        </>
      ) : null}

      <Dialogs dlg={dlg} close={() => setDlg(null)} st={st} dispatch={dispatch} vis={vis} />
      <Toasts resetKey={`${st.screen}|${st.role}|${st.filters.listFilter ?? ""}`} />
    </div>
  );
}
