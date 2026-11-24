"use client";
/*
 * BOUNDARY (module 7, shared UI, NEW v5). Inputs: FiltersPopover {groups (each a "chips" group: options, selected[], onToggle(value); or a "segmented" group: options, value, onChange(value)), active (the removable chips: {id, label, onRemove}), onClear, label? ("Filters"),
 * title? (popover heading), extra? (any further controls shown under the groups), disabled?, clearLabel? ("Clear filters"), data-testid (on the trigger)}.
 * Output: the composition six previews each built: a "Filters (n)" button (n = how many filters are on; no count at 0) that opens a Popover with each group (FilterChip rows, SegmentedControls), a quiet "Clear filters" button only while a filter is on, and under them a list of RemovableChips
 * ("Active filters") with one chip per filter that is on. Focus: Escape or an outside press closes the popover and returns focus to the Filters button (the Popover does this); removing a chip moves focus to the next chip, or to the Filters button when it was the last; Clear filters moves focus to the Filters button.
 * Must not change: it is controlled and filters nothing (the caller owns the filter state and computes `active`); no icons; the count and the chips are words, never colour alone; Clear filters shows only when active is not empty.
 */
import { useRef, type ReactNode } from "react";
import styles from "./premium.module.css";
import { Button } from "./Button";
import { ChipGroup, FilterChip } from "./FilterChip";
import { Popover } from "./Menu";
import { RemovableChip, RemovableChips } from "./RemovableChip";
import { SegmentedControl } from "./SegmentedControl";
import { cx, premiumTokens } from "./tokens";

export interface FilterChoice { value: string; label: string; count?: number; testId?: string }

export type FilterGroup =
  | { kind: "chips"; id: string; label: string; options: FilterChoice[]; selected: string[]; onToggle: (value: string) => void }
  | { kind: "segmented"; id: string; label: string; options: FilterChoice[]; value: string; onChange: (value: string) => void };

export interface ActiveFilter { id: string; label: string; onRemove: () => void; /** Accessible name for the remove button; default "Remove filter: <label>". */ removeLabel?: string }

export interface FiltersPopoverProps {
  groups: FilterGroup[];
  active: ActiveFilter[];
  onClear: () => void;
  label?: string;
  title?: string;
  extra?: ReactNode;
  disabled?: boolean;
  clearLabel?: string;
  className?: string;
  "data-testid"?: string;
}

/** Pure (v5, exported for tests): the trigger text, "Filters" or "Filters (3)". */
export function filtersLabel(label: string, activeCount: number): string {
  return activeCount > 0 ? `${label} (${activeCount})` : label;
}

export function FiltersPopover({ groups, active, onClear, label = "Filters", title, extra, disabled, clearLabel = "Clear filters", className, ...rest }: FiltersPopoverProps) {
  const root = useRef<HTMLDivElement>(null);
  const triggerText = filtersLabel(label, active.length);
  const toTrigger = () => requestAnimationFrame(() => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus()));
  const afterRemove = (index: number) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const chips = root.current?.querySelectorAll<HTMLElement>("[data-fp-chip] button") ?? [];
    const next = chips[Math.min(index, chips.length - 1)];
    if (next) next.focus();
    else root.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus();
  }));

  return (
    <div ref={root} className={cx(premiumTokens, styles.fp, className)}>
      {disabled ? (
        <Button variant="secondary" disabled data-testid={rest["data-testid"]}>{triggerText}</Button>
      ) : (
        <Popover label={triggerText} title={title ?? label} data-testid={rest["data-testid"]}>
          <div className={styles.fpBody}>
            {groups.map((g) => (
              <div key={g.id} className={styles.fpGroup}>
                <p className={styles.fpGroupLabel} aria-hidden="true">{g.label}</p>
                {g.kind === "chips" ? (
                  <ChipGroup label={g.label}>
                    {g.options.map((o) => (
                      <FilterChip key={o.value} selected={g.selected.includes(o.value)} count={o.count} onToggle={() => g.onToggle(o.value)} data-testid={o.testId}>{o.label}</FilterChip>
                    ))}
                  </ChipGroup>
                ) : (
                  <SegmentedControl label={g.label} value={g.value} onChange={g.onChange} options={g.options.map((o) => ({ value: o.value, label: o.label, testId: o.testId }))} />
                )}
              </div>
            ))}
            {extra}
          </div>
        </Popover>
      )}
      {active.length ? <Button variant="quiet" onClick={() => { onClear(); toTrigger(); }}>{clearLabel}</Button> : null}
      {active.length ? (
        <RemovableChips label="Active filters" className={styles.fpChips}>
          {active.map((a, i) => (
            <span key={a.id} data-fp-chip="true" style={{ display: "contents" }}>
              <RemovableChip data-chip={a.id} removeLabel={a.removeLabel} onRemove={() => { a.onRemove(); afterRemove(i); }}>{a.label}</RemovableChip>
            </span>
          ))}
        </RemovableChips>
      ) : null}
    </div>
  );
}
