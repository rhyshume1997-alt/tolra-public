"use client";

import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export type FilterOption = {
  label: string;
  value: string;
};

type FilterBarProps = {
  options: FilterOption[];
  label?: string;
  defaultActive?: string[];
  activeValues?: string[];
  onChange?: (active: Set<string>) => void;
};

export function FilterBar({
  options,
  label = "Filters",
  defaultActive = ["all"],
  activeValues,
  onChange,
}: FilterBarProps) {
  const [active, setActive] = useState(() => new Set(defaultActive));
  useEffect(() => {
    if (activeValues) setActive(new Set(activeValues));
  }, [activeValues]);

  const optionValues = useMemo(
    () => new Set(options.map((option) => option.value)),
    [options]
  );

  function toggle(value: string) {
    const next = new Set(active);

    if (value === "all") {
      next.clear();
      next.add("all");
    } else {
      next.delete("all");

      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }

      if (next.size === 0 && optionValues.has("all")) {
        next.add("all");
      }
    }

    setActive(next);
    onChange?.(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="label-mono mr-2 min-w-14 text-muted-foreground">
        {label}
      </span>
      {options.map((option) => {
        const selected = active.has(option.value);

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => toggle(option.value)}
            aria-pressed={selected}
            className={cn(
              "h-8 rounded-full border px-3.5 text-[0.82rem] transition pointer-coarse:min-h-11",
              selected
                ? "border-ink bg-ink text-white"
                : "border-line bg-surface text-ink/70 hover:border-ink/25 hover:text-ink"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
