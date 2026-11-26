"use client";

/**
 * BOUNDARY (module 9, ISO templates). Inputs: the sections of a body, a change handler, and for read-only use `readOnly`. Output: one labelled text box per
 * section with its gaps ("[to complete]") counted, highlighted in a preview line and reachable with "Select next gap"; or, read-only, the same text as plain
 * paragraphs. Must not change: it stores and saves nothing; a gap is always shown as the words "[to complete]" (the highlight is never the only signal).
 */
import { useRef } from "react";

import { Button, Field, Textarea } from "@/components/ui/premium";
import { countGapsInText, nextGapRange, splitGaps, type IsoBody } from "@/lib/iso/editable-document";

function Highlighted({ line }: { line: string }) {
  return <>{splitGaps(line).map((p, i) => (p.gap ? <mark key={i} className="rounded bg-amber-100 px-1 font-medium text-amber-900">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

/** Read-only text with the gaps highlighted. */
export function IsoBodyReadOnly({ body, hasTable }: { body: IsoBody; hasTable?: (heading: string) => boolean }) {
  return (
    <div className="space-y-4">
      {body.sections.map((s, i) => (
        <section key={`${i}-${s.heading}`} className="min-w-0">
          <h3 className="text-sm font-semibold">{s.heading}</h3>
          {s.text.split("\n").map((l, j) => <p key={j} className="mt-1 break-words text-sm leading-6 text-slate-700"><Highlighted line={l} /></p>)}
          {hasTable?.(s.heading) ? <p className="mt-1 text-xs text-slate-500">A blank table to fill in by hand prints under this section.</p> : null}
        </section>
      ))}
    </div>
  );
}

function SectionField({ index, heading, text, table, disabled, onText }: { index: number; heading: string; text: string; table: boolean; disabled: boolean; onText: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const gaps = countGapsInText(text);
  const gapLines = text.split("\n").filter((l) => l.includes("[to complete]"));
  function selectNextGap() {
    const el = ref.current;
    const range = el ? nextGapRange(el.value, (el.selectionEnd ?? 0)) : null;
    if (!el || !range) return;
    el.focus();
    el.setSelectionRange(range.start, range.end);
  }
  return (
    <div className="min-w-0 space-y-2" data-testid={`iso-section-${index}`}>
      <Field label={heading} hint={table ? "A blank table to fill in by hand prints under this section." : undefined}>
        <Textarea ref={ref} large value={text} disabled={disabled} rows={Math.min(14, Math.max(4, text.split("\n").length + 1))} maxLength={20000} onChange={(e) => onText(e.target.value)} />
      </Field>
      {gaps > 0 ? (
        <div className="flex flex-wrap items-start gap-3 text-sm" data-testid={`iso-gaps-${index}`}>
          <span className="font-medium text-amber-900">{gaps === 1 ? "1 gap to complete" : `${gaps} gaps to complete`}</span>
          <Button size="lg" variant="secondary" disabled={disabled} onClick={selectNextGap}>Select next gap</Button>
          <ul className="min-w-0 basis-full space-y-1 text-slate-700">
            {gapLines.map((l, i) => <li key={i} className="break-words"><Highlighted line={l} /></li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function IsoSectionFields({ body, tables, disabled, onChange }: { body: IsoBody; tables: (heading: string) => boolean; disabled: boolean; onChange: (next: IsoBody) => void }) {
  return (
    <div className="space-y-6">
      {body.sections.map((s, i) => (
        <SectionField key={`${i}-${s.heading}`} index={i} heading={s.heading} text={s.text} table={tables(s.heading)} disabled={disabled}
          onText={(value) => onChange({ sections: body.sections.map((x, j) => (j === i ? { ...x, text: value } : x)) })} />
      ))}
    </div>
  );
}
