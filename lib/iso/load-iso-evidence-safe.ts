/**
 * BOUNDARY (module 9, ISO templates). Inputs: a loader promise and a time limit. Output: the loader's result, or a fallback when it fails or does not
 * answer in time, so the ISO page can never sit on "Loading ISO templates" for ever. Pure (no React, no I/O of its own).
 * Must not change: nothing here reads or writes data; the fallback evidence marks everything as unread, so every clause shows "not evidenced" (the same
 * rule the page already applies to any read that failed).
 */
import { EMPTY_EVIDENCE } from "@/lib/iso/gap-checklist";
import { loadIsoEvidence, type IsoEvidence } from "@/lib/iso/load-iso-evidence";

export const ISO_LOAD_LIMIT_MS = 20_000;

/** Resolves with `fallback` if `work` rejects or takes longer than `ms`. Never rejects. */
export async function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function failedIsoEvidence(): IsoEvidence {
  return {
    evidence: EMPTY_EVIDENCE,
    facts: { inspectors: null, suppliers: null, traceableJobs: null, openNcrs: null },
    ncrRows: null,
    unread: ["all records"],
  };
}

export function loadIsoEvidenceSafe(load: () => Promise<IsoEvidence> = loadIsoEvidence, ms: number = ISO_LOAD_LIMIT_MS): Promise<IsoEvidence> {
  return settleWithin(load(), ms, failedIsoEvidence());
}
