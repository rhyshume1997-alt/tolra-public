import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { STATUS_MAP, type StatusKey, statusColourClasses } from "@/lib/status-colours";
import { cn } from "@/lib/utils";

/**
 * The one status badge: colour from the central map (lib/status-colours.ts), always with its word beside it. `label` keeps a page's
 * existing wording (e.g. "Done", "Despatched", "3 days overdue"); without it the map's word is shown. A status that is not one of
 * the agreed ones (`status` null) renders as the plain badge it was, with `unmapped` styling.
 */
export function StatusBadge({ status, label, className, unmapped, ...props }: Omit<React.ComponentProps<typeof Badge>, "variant" | "children"> & {
  status: StatusKey | null | undefined;
  label?: React.ReactNode;
  unmapped?: { variant?: React.ComponentProps<typeof Badge>["variant"]; className?: string };
}) {
  if (!status) return <Badge variant={unmapped?.variant} className={cn(unmapped?.className, className)} {...props}>{label}</Badge>;
  const entry = STATUS_MAP[status];
  return (
    <Badge data-status={status} data-colour={entry.colour} className={cn(statusColourClasses(status).badge, className)} {...props}>
      {label ?? entry.label}
    </Badge>
  );
}
