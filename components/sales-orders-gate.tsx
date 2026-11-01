"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Skeleton } from "@/components/ui/skeleton";
import { useOrgSettings } from "@/lib/org-settings";
import { SALES_ORDERS_OFF_NOTICE, salesOrdersEnabled } from "@/lib/sales-orders-switch";

/**
 * Page guard for /sales-orders and everything under it. Sales Orders is off until an admin switches it on in Settings > Menu
 * (lib/sales-orders-switch), so a pasted or bookmarked address sends the person to Quotes with a notice. Nothing is decided until
 * the company's settings have loaded, so a company that has it on is never bounced.
 */
export function SalesOrdersGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { hiddenNav, loaded } = useOrgSettings();
  const on = salesOrdersEnabled(hiddenNav);
  const off = loaded && !on;

  useEffect(() => {
    if (!off) return;
    toast.info(SALES_ORDERS_OFF_NOTICE);
    router.replace("/quotes");
  }, [off, router]);

  if (!loaded || off) return <Skeleton className="h-80" />;
  return <>{children}</>;
}
