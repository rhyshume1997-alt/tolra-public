/**
 * Module K (worksheet builder): which blocks a company cannot remove from its worksheet.
 *
 * Inputs: the company's switches (customer sign-off, from organization_settings.customer_signoff_enabled). Outputs: the set of locked block
 * kinds, and a repair that puts any missing or hidden locked block back on a layout.
 *   - internalSignOff, materialTrace (traceability) and inspection: always locked. Tolra has no company switch that turns internal sign-off,
 *     traceability or inspection off (traceable, certs and checklist requirements are per job and per customer), so they are always "on".
 *     If a company switch for any of them is ever added, it is read here and nowhere else.
 *   - customerSignOff: locked while the company's Customer sign-off switch is on.
 * The renderer applies withRequiredBlocks to every layout at print time, so a layout saved before a switch was turned on still prints the
 * block. A locked block may be reordered and renamed, never hidden, never deleted.
 * Must not change: the locked set without Rhys's decision. Pure (no React, no I/O).
 */
import { type BlockKind, type WorksheetBlock, PALETTE } from "@/lib/worksheet-builder/blocks";

export type CompanyRequirements = { customerSignOff: boolean };

/** The requirements that apply when they could not be read: the strictest (customer sign-off kept). */
export const STRICT_REQUIREMENTS: CompanyRequirements = { customerSignOff: true };

export function lockedKinds(requirements: CompanyRequirements): ReadonlySet<BlockKind> {
  const locked = new Set<BlockKind>(["internalSignOff", "materialTrace", "inspection"]);
  if (requirements.customerSignOff) locked.add("customerSignOff");
  return locked;
}

export function isLockedBlock(block: Pick<WorksheetBlock, "kind">, requirements: CompanyRequirements): boolean {
  return lockedKinds(requirements).has(block.kind);
}

/** Every locked kind is present and visible: a hidden one is shown, a missing one is added at the end (before nothing else changes). */
export function withRequiredBlocks<T extends { blocks: WorksheetBlock[] }>(layout: T, requirements: CompanyRequirements): T {
  const locked = lockedKinds(requirements);
  const blocks = layout.blocks.map((block) => (locked.has(block.kind) && !block.visible ? { ...block, visible: true } : block));
  for (const kind of locked) {
    if (!blocks.some((block) => block.kind === kind)) blocks.push({ id: kind, kind, visible: true, label: PALETTE[kind].defaultLabel, ...(kind === "materialTrace" ? { traceableOnly: true } : {}) });
  }
  return { ...layout, blocks };
}

/** Plain-words problems with a layout about to be saved; empty when it is acceptable. */
export function lockedBlockProblems(layout: { blocks: WorksheetBlock[] }, requirements: CompanyRequirements): string[] {
  const problems: string[] = [];
  for (const kind of lockedKinds(requirements)) {
    const found = layout.blocks.filter((block) => block.kind === kind);
    if (!found.length) problems.push(`The ${PALETTE[kind].title} block cannot be removed.`);
    else if (!found.some((block) => block.visible)) problems.push(`The ${PALETTE[kind].title} block cannot be hidden.`);
  }
  return problems;
}
