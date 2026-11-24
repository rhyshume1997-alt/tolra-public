"use client";

/** Supplier presentation. Receives the live directory and existing mutation callbacks from the route. */
import type { ReactNode } from "react";

import { ColumnToggle } from "@/components/column-toggle";
import { StatusBadge } from "@/components/status-badge";
import { ViewSwitcher } from "@/components/view-switcher";
import { Button, EmptyState, FailedState, LoadingState, Menu, PageHeader, ScrollTable, StackedRows, premiumTokens } from "@/components/ui/premium";
import { suppliersEmptyHint } from "@/lib/empty-hints";
import { SUPPLIER_STATUS_BADGE, SUPPLIER_STATUS_LABELS } from "@/lib/supplier-status";
import type { SupplierRecord } from "@/lib/supabase-business";
import { useIsPhone, type ViewMode } from "@/lib/view-mode";

interface Props {
  suppliers: SupplierRecord[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  statusAvailable: boolean;
  isVisible: (key: string) => boolean;
  view: ViewMode;
  setView: (view: ViewMode) => void;
  load: () => Promise<void>;
  edit: (supplier: SupplierRecord) => void;
  remove: (supplier: SupplierRecord) => Promise<void>;
  toolbar: ReactNode;
  dialog: ReactNode;
}

const supplierFields = [
  { key: "contact", label: "Contact", value: (supplier: SupplierRecord) => supplier.contactName },
  { key: "email", label: "Email", value: (supplier: SupplierRecord) => supplier.email },
  { key: "phone", label: "Phone", value: (supplier: SupplierRecord) => supplier.phone },
  { key: "notes", label: "Notes", value: (supplier: SupplierRecord) => supplier.notes },
];

function SupplierStatus({ supplier }: { supplier: SupplierRecord }) {
  const { supplierStatus } = supplier;
  return supplierStatus ? <StatusBadge status={SUPPLIER_STATUS_BADGE[supplierStatus]} label={SUPPLIER_STATUS_LABELS[supplierStatus]} /> : null;
}

export function SuppliersRedesign({ suppliers, loading, error, saving, statusAvailable, isVisible, view, setView, load, edit, remove, toolbar, dialog }: Props) {
  const isPhone = useIsPhone();
  const fields = supplierFields.filter((field) => isVisible(field.key));
  const showStatus = statusAvailable && isVisible("status");
  const add = () => edit({ name: "", email: "" });

  const actions = (supplier: SupplierRecord) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" disabled={!supplier.id} onClick={() => edit(supplier)} aria-label={`Edit ${supplier.name}`}>Edit</Button>
      <Menu
        label="More"
        aria-label={`More actions for ${supplier.name}`}
        size="sm"
        variant="quiet"
        items={[{ id: "delete", label: "Delete", disabled: !supplier.id || saving, onSelect: () => void remove(supplier) }]}
      />
    </div>
  );

  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="suppliers-v2">
      <PageHeader
        title="Suppliers"
        description="The companies we buy from. Used on purchase orders."
        actions={<Button onClick={add}>New supplier</Button>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ColumnToggle tableKey="suppliers" />
        <ViewSwitcher value={view} onChange={setView} />
      </div>
      {toolbar}
      {loading ? <LoadingState label="Loading suppliers" /> : error ? (
        <FailedState title="Couldn’t load suppliers" detail={error} onRetry={() => void load()} retryLabel="Retry" headingLevel={2} />
      ) : !suppliers.length ? (
        <EmptyState title="No suppliers yet" detail={suppliersEmptyHint()} headingLevel={2} />
      ) : isPhone || view === "cards" ? (
        <StackedRows label="Suppliers" rows={suppliers.map((supplier) => ({
          id: supplier.id ?? supplier.name,
          title: supplier.name,
          status: showStatus ? <SupplierStatus supplier={supplier} /> : undefined,
          fields: fields.map((field) => ({ label: field.label, value: field.value(supplier) || "—" })),
          actions: actions(supplier),
        }))} />
      ) : (
        <ScrollTable label="Suppliers" dense={view === "list"} pinLast>
          <thead>
            <tr>
              <th scope="col">Name</th>
              {fields.map((field) => <th key={field.key} scope="col">{field.label}</th>)}
              {showStatus && <th scope="col">Status</th>}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((supplier) => (
              <tr key={supplier.id ?? supplier.name}>
                <th scope="row">{supplier.name}</th>
                {fields.map((field) => <td key={field.key}>{field.value(supplier) || "—"}</td>)}
                {showStatus && <td>{supplier.supplierStatus ? <SupplierStatus supplier={supplier} /> : "—"}</td>}
                <td>{actions(supplier)}</td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      {dialog}
    </div>
  );
}
