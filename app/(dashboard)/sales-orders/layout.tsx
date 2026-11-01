import { SalesOrdersGate } from "@/components/sales-orders-gate";

/** Covers the list and the print page: both open only when an admin has switched Sales Orders on (Settings > Menu). */
export default function SalesOrdersLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SalesOrdersGate>{children}</SalesOrdersGate>;
}
