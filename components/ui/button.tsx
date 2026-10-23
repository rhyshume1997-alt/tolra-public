import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding font-mono text-[0.7rem] font-medium uppercase tracking-[0.08em] whitespace-nowrap transition-[background-color,border-color,color,box-shadow] outline-none select-none focus-visible:ring-3 focus-visible:ring-brand-accent/35 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-brand text-brand-ink hover:bg-brand-hover",
        outline:
          "border-line bg-surface text-ink hover:border-ink/25 hover:bg-canvas aria-expanded:bg-canvas",
        // Job actions. Start = green outline, Finish = blue outline (Job Board and anywhere else a job is started or
        // finished). Border is #16A34A / #2563EB; the green text is one step darker (#15803D) because #16A34A on
        // white is only 3.3:1 and the label is small text (WCAG AA needs 4.5:1).
        start:
          "border-[#16A34A] bg-surface text-[#15803D] hover:bg-green-50 aria-expanded:bg-green-50 dark:text-green-400 dark:hover:bg-green-500/10",
        // Pause (Job Board Play/Pause, 049 plan 2.1): solid amber with ink text, distinct from Start's green and the orange Inspected icon.
        pause:
          "border-amber-500 bg-amber-500 text-[#1c1917] hover:bg-amber-400 aria-expanded:bg-amber-400 dark:border-amber-400 dark:bg-amber-400 dark:text-[#1c1917] dark:hover:bg-amber-300",
        finish:
          "border-[#2563EB] bg-surface text-[#2563EB] hover:bg-blue-50 aria-expanded:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10",
        secondary:
          "bg-ink/[0.05] text-ink hover:bg-ink/[0.09] aria-expanded:bg-ink/[0.09]",
        ghost:
          "text-ink hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.06]",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "normal-case tracking-normal font-sans text-sm text-brand-accent underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-2 px-4 pointer-coarse:h-11 pointer-coarse:px-5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2.5 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-4 text-[0.62rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3.5 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-4 text-[0.66rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-6 pointer-coarse:h-11 pointer-coarse:px-6 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-9 pointer-coarse:size-11",
        "icon-xs":
          "size-6 pointer-coarse:size-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 pointer-coarse:size-11",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
