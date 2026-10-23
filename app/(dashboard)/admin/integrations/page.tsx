"use client";

import { Suspense } from "react";

import { IntegrationsPanel } from "@/components/integrations-panel";
import { RoleGate } from "@/components/role-gate";

/** Admin > Integrations (migration 084, G22): connect each company to its own accounting system. Xero first; admins only. */
export default function AdminIntegrationsPage() {
  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="mt-2 text-sm text-slate-500">Send this company&apos;s issued invoices and credit notes to its accounting system. Off until an admin connects it.</p>
        </div>
        <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
          <IntegrationsPanel />
        </Suspense>
      </div>
    </RoleGate>
  );
}
