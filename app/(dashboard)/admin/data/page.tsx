"use client";

import { DataImport } from "@/components/data-import";
import { RoleGate } from "@/components/role-gate";

/** Admin > Data (migration 076): import customers, suppliers, stock, quotes, sales orders, jobs, purchase orders, invoices and payments from one upload. */
export default function AdminDataPage() {
  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Data</h1>
          <p className="mt-2 text-sm text-slate-500">Bring records in from a spreadsheet. The database checks every row first and writes nothing if any row has a problem.</p>
        </div>
        <DataImport />
      </div>
    </RoleGate>
  );
}
