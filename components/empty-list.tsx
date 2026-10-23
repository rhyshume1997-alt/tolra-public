import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

/**
 * The empty state of a list page: what is missing, one plain sentence saying what to do next, and the button for it.
 * One look for Quotes, Sales Orders, Purchase Orders, Delivery Notes, Invoicing and RFQ. The sentences live in
 * lib/empty-hints (`hintTestId` marks the sentence for tests).
 */
export function EmptyList({ title, hint, hintTestId, action }: { title: string; hint: string; hintTestId?: string; action?: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-lg font-semibold text-slate-950">{title}</p>
        <p className="text-sm text-slate-500" data-testid={hintTestId}>{hint}</p>
        {action}
      </CardContent>
    </Card>
  );
}
