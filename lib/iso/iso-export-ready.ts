/**
 * BOUNDARY (module 9, ISO templates). Inputs: the company the page is for, the company id read before and after the reads, the company profile and the
 * evidence read. Output: true only when every read succeeded for that one company. Pure (no I/O).
 * Must not change: any missing company, mismatch, missing profile or unread record is false; a confirmed empty read (unread: []) is true.
 */
import type { CompanyProfile } from "@/lib/company";
import type { IsoEvidence } from "@/lib/iso/load-iso-evidence";

export function isoReadIsComplete(expectedOrg: string | null | undefined, beforeOrg: string | null | undefined, afterOrg: string | null | undefined, company: CompanyProfile | null, evidence: IsoEvidence): boolean {
  return Boolean(expectedOrg && beforeOrg === expectedOrg && afterOrg === expectedOrg && company && evidence.unread.length === 0);
}
