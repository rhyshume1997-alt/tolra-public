/**
 * Reads the records the NCR register shows. SELECTs only, under the signed-in user's own session (RLS applies; admin and office can
 * read all six tables). Inputs: the date range (local dates). Output: the raw rows for buildNcrRows, or { ok: false } on any failure.
 * Also reads the replacement reworks and roots of the reworks it finds, and reworks closed by a concession in range. Never throws and never writes. The range is padded by a day each side here; the exact inclusive filter is in ncr-register.ts.
 * Must not change: it must stay read-only.
 */
import { fetchAll } from "@/lib/fetch-all";
import { supabase } from "@/lib/supabase";

import type { NcrSources, RawEntry, RawEntryValue, RawInspection, RawJob, RawProblem, RawRework } from "@/lib/jobs/ncr-register";

export type NcrLoad = { ok: true; sources: NcrSources; truncated: boolean } | { ok: false };

const day = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString();
const chunks = <T,>(items: T[], size = 100) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export async function loadNcrRegister(range: { from: string; to: string }): Promise<NcrLoad> {
  const db = supabase;
  if (!db) return { ok: false };
  const lo = range.from ? day(range.from, -1) : null;
  const hi = range.to ? day(range.to, 2) : null;
  const ranged = <Q extends { gte: (c: string, v: string) => Q; lt: (c: string, v: string) => Q }>(q: Q, col: string): Q => {
    let out = q;
    if (lo) out = out.gte(col, lo);
    if (hi) out = out.lt(col, hi);
    return out;
  };
  try {
    const [reworks, inspections, problems] = await Promise.all([
      fetchAll<RawRework>((from, to) => ranged(db.from("job_rework").select("id, job_id, inspection_id, status, reason, instructions, affects_all, quantity_affected, quantity_scrapped, quantity_remade, raised_at, closed_at, closed_how, follow_up_of"), "raised_at").order("raised_at", { ascending: false }).order("id").range(from, to) as never),
      fetchAll<RawInspection>((from, to) => ranged(db.from("job_inspections").select("id, job_id, result, concession_reason, measured_notes, inspector_name, inspected_at").in("result", ["concession", "fail"]), "inspected_at").order("inspected_at", { ascending: false }).order("id").range(from, to) as never),
      fetchAll<RawProblem>((from, to) => ranged(db.from("job_problems").select("id, job_id, reason, note, status, reported_at, resolved_at, resolution_note"), "reported_at").order("reported_at", { ascending: false }).order("id").range(from, to) as never),
    ]);
    // Also needed so each record is counted once (ncr-register.ts): reworks closed by a concession in range (to recognise that
    // concession), then the replacement reworks of every rework held and the roots of every replacement held, until nothing new.
    const REWORK_COLS = "id, job_id, inspection_id, status, reason, instructions, affects_all, quantity_affected, quantity_scrapped, quantity_remade, raised_at, closed_at, closed_how, follow_up_of";
    const byId = new Map<string, RawRework>(reworks.rows.map((r) => [r.id, r]));
    const add = (rows: RawRework[]) => { for (const r of rows) byId.set(r.id, r); };
    add((await fetchAll<RawRework>((from, to) => ranged(db.from("job_rework").select(REWORK_COLS).eq("closed_how", "concession"), "closed_at").order("id").range(from, to) as never)).rows);
    const askedChildren = new Set<string>();
    let chainCapped = true; // stays true only if the 10-round cap is reached with links still unread
    for (let round = 0; round < 10; round++) {
      const children = [...byId.keys()].filter((id) => !askedChildren.has(id));
      const parents = [...new Set([...byId.values()].map((r) => r.follow_up_of).filter((id): id is string => Boolean(id) && !byId.has(id as string)))];
      if (!children.length && !parents.length) { chainCapped = false; break; }
      children.forEach((id) => askedChildren.add(id));
      for (const ids of chunks(children)) add((await fetchAll<RawRework>((from, to) => db.from("job_rework").select(REWORK_COLS).in("follow_up_of", ids).order("id").range(from, to) as never)).rows);
      for (const ids of chunks(parents)) add((await fetchAll<RawRework>((from, to) => db.from("job_rework").select(REWORK_COLS).in("id", ids).order("id").range(from, to) as never)).rows);
    }
    const allReworks = [...byId.values()];
    const reworkIds = allReworks.map((r) => r.id);
    const jobIds = [...new Set([...allReworks, ...inspections.rows, ...problems.rows].map((r) => r.job_id))];
    const entries: RawEntry[] = [];
    const entryValues: RawEntryValue[] = [];
    const jobs: RawJob[] = [];
    for (const ids of chunks(reworkIds)) {
      const got = await fetchAll<RawEntry>((from, to) => db.from("job_rework_entries").select("id, rework_id, kind, hours").in("rework_id", ids).order("id").range(from, to) as never);
      entries.push(...got.rows);
    }
    for (const ids of chunks(entries.filter((e) => e.kind === "material").map((e) => e.id))) {
      const { data, error } = await db.from("job_rework_entry_values").select("entry_id, material_cost").in("entry_id", ids);
      if (error) throw error;
      entryValues.push(...((data ?? []) as RawEntryValue[]));
    }
    for (const ids of chunks(jobIds)) {
      const { data, error } = await db.from("jobs").select("id, job_no, customer").in("id", ids);
      if (error) throw error;
      jobs.push(...((data ?? []) as RawJob[]));
    }
    return { ok: true, truncated: reworks.truncated || inspections.truncated || problems.truncated || chainCapped, sources: { reworks: allReworks, inspections: inspections.rows, problems: problems.rows, entries, entryValues, jobs } };
  } catch {
    return { ok: false };
  }
}
