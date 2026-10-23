import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder rows while a list loads: the same stack of rows the list pages already show (three Skeleton rows), with a label
 * so a screen reader hears "Loading users" instead of silence.
 */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-busy="true" aria-label={label} data-testid="list-skeleton">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-16" />)}
    </div>
  );
}
