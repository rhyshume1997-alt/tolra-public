/**
 * Module K (worksheet builder): which sheet a print uses. Pure.
 *
 * Inputs: the company's Basic/JNR choice (lib/print-layout), the person's per-print override, and the builder's loaded state.
 * Outputs: either the legacy sheet ("basic" or "jnr", which print exactly as before) or one of the company's own layouts.
 * Rules: with the builder off, not yet loaded, or its state unreadable, the answer is exactly what lib/print-layout's chosenPrintLayout
 * gives, so nothing changes for a company that does not use the builder. A custom layout that no longer exists is ignored, never an error.
 * Must not change: the "builder off means legacy" rule.
 */
import { type CompanyPrintLayout, type PrintLayout, chosenPrintLayout, parsePrintLayout } from "@/lib/print-layout";
import { type WorksheetBuilderState, type WorksheetLayout, customChoiceId, packFallback } from "@/lib/worksheet-builder/layouts";

export type PrintChoice = { kind: "legacy"; layout: PrintLayout } | { kind: "custom"; layout: WorksheetLayout };

/** The picker's value: "" (company setting), "basic", "jnr" or "custom:<id>". */
export type PrintOverride = string | null;

/** Narrows anything to a value the picker may hold. */
export function parsePrintOverride(value: unknown): PrintOverride {
  if (typeof value !== "string") return null;
  return parsePrintLayout(value) ? value : customChoiceId(value) ? value : null;
}

export function resolvePrintChoice(args: { company: CompanyPrintLayout | null; override: PrintOverride; builder: { enabled: boolean; state: WorksheetBuilderState } | null }): PrintChoice | null {
  const { company, override, builder } = args;
  const usable = builder && builder.enabled ? builder.state : null;
  const overrideId = customChoiceId(override);
  if (usable) {
    const wanted = overrideId ?? (override ? null : usable.activeId);
    const layout = wanted ? usable.layouts.find((l) => l.id === wanted && !l.archived) : undefined;
    if (layout) return { kind: "custom", layout };
  }
  const legacy = chosenPrintLayout(company, parsePrintLayout(override));
  return legacy ? { kind: "legacy", layout: legacy } : null;
}

/** Where only a Basic or JNR table can print (the workshop pack): the legacy layout, or a custom layout's base. */
export function packLayoutOf(choice: PrintChoice): PrintLayout {
  return choice.kind === "legacy" ? choice.layout : packFallback(choice.layout);
}
