"use client";

import { VAT_CHOICE_LABELS, VAT_CHOICES, type VatChoice } from "@/lib/vat";

/** The document's "Add VAT" switch. Hidden (null) when the company isn't VAT registered: nothing gets VAT then. */
export function VatToggle({ checked, onChange, registered, disabled }: { checked: boolean; onChange: (checked: boolean) => void; registered: boolean; disabled?: boolean }) {
  if (!registered) return <p className="text-xs text-slate-500">Not VAT registered: no VAT is added (Settings &gt; Company details).</p>;
  return (
    <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
      <input type="checkbox" className="size-4" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      Add VAT
    </label>
  );
}

/** Per-line VAT rate: 20% / 5% / 0% / Exempt. */
export function VatRateSelect({ value, onChange, disabled, className = "h-9 rounded-lg border px-2 text-sm", label = "VAT rate" }: { value: VatChoice; onChange: (choice: VatChoice) => void; disabled?: boolean; className?: string; label?: string }) {
  return (
    <select aria-label={label} className={className} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as VatChoice)}>
      {VAT_CHOICES.map((choice) => <option key={choice} value={choice}>{VAT_CHOICE_LABELS[choice]}</option>)}
    </select>
  );
}
