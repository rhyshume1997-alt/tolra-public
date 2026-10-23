import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A checkbox with a touch-sized hit area: the label around it is 44x44 on a coarse pointer (a finger), compact
 * otherwise. Pass aria-label (or wrap it in your own label text) so it has a name. Keyboard and focus work as for a
 * native checkbox.
 */
function SelectBox({ className, boxClassName, ...props }: Omit<React.ComponentProps<"input">, "type"> & { boxClassName?: string }) {
  return (
    <label data-slot="select-box-hit" className={cn("inline-flex size-6 shrink-0 cursor-pointer items-center justify-center pointer-coarse:size-11", boxClassName)}>
      <input
        type="checkbox"
        data-slot="select-box"
        className={cn("size-4 cursor-pointer accent-[var(--brand)] pointer-coarse:size-6", className)}
        {...props}
      />
    </label>
  )
}

export { SelectBox }
