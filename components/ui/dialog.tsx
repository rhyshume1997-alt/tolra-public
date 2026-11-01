"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-[#0b1626]/55 backdrop-blur-[2px]",
        className
      )}
      {...props}
    />
  );
}

/**
 * The corner X. Positioned against the nearest positioned ancestor: the dialog itself, or a sticky DialogHeader that carries it.
 * 44px square on a touch screen.
 */
function DialogCloseButton() {
  return (
    <DialogPrimitive.Close className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-lg text-slate-500 transition outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-3 focus-visible:ring-brand-accent/35 pointer-coarse:size-11">
      <X className="size-4" />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}

/**
 * Bounded by the viewport and scrolls inside, so every control stays reachable on small screens (audit D30). Callers
 * set the width (max-w-*) and nothing else about the bound: a max-h-[..vh] override would undermine the dvh limit below.
 * One column that can't grow past the dialog, and long unbroken values (an e-mail, a part number) wrap instead of overflowing.
 */
function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { hideClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-5 break-words sm:p-7 text-ink shadow-[0_24px_60px_-20px_rgba(11,22,38,0.35)]",
          className
        )}
        {...props}
      >
        {children}
        {hideClose ? null : <DialogCloseButton />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * With stickyClose, the header (and the X, which moves into it) stays at the top of a long dialog while the body scrolls under it. Use it
 * with `hideClose` on the DialogContent so there is only one X. It must be the first child of the DialogContent: the negative margins pull
 * it out over the dialog's padding, and the negative top offset cancels that padding, which a sticky box would otherwise respect.
 */
function DialogHeader({
  className,
  stickyClose = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { stickyClose?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      data-sticky-close={stickyClose ? "" : undefined}
      className={cn(
        "flex flex-col gap-1.5 text-left",
        stickyClose && "sticky -top-5 z-10 -mx-5 -mt-5 bg-surface px-5 pb-3 pt-5 pr-14 sm:-top-7 sm:-mx-7 sm:-mt-7 sm:px-7 sm:pt-7 sm:pr-16",
        className
      )}
      {...props}
    >
      {children}
      {stickyClose ? <DialogCloseButton /> : null}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-xl font-semibold tracking-tight text-ink", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-slate-500", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
