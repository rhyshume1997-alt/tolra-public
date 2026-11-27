"use client";

/** Customer list presentation. Inputs already reflect archive filters, visible columns and permissions. */
import type { ReactNode } from "react";

import { ColumnToggle } from "@/components/column-toggle";
import { ViewSwitcher } from "@/components/view-switcher";
import { Button, Callout, EmptyState, FailedState, LoadingState, PageHeader, ScrollTable, StackedRows, premiumTokens } from "@/components/ui/premium";
import type { KnownCustomer } from "@/lib/customers";
import { useIsPhone, type ViewMode } from "@/lib/view-mode";

interface Props {
  customers: KnownCustomer[];
  isVisible: (key: string) => boolean;
  view: ViewMode;
  setView: (view: ViewMode) => void;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  emptyTitle: string;
  emptyDetail?: string;
  notice?: string;
  sourceWarning?: string;
  add: () => void;
  toolbar: ReactNode;
  phaseFilter: ReactNode;
  dialog: ReactNode;
  details: (customer: KnownCustomer) => ReactNode;
  actions: (customer: KnownCustomer) => ReactNode;
}

const customerFields = [
  { key: "contact", label: "Contact", value: (customer: KnownCustomer) => customer.contactName },
  { key: "email", label: "Email", value: (customer: KnownCustomer) => customer.email },
  { key: "phone", label: "Phone", value: (customer: KnownCustomer) => <>{customer.phone || "—"}{customer.mobile && <span className="block text-xs">Mobile {customer.mobile}</span>}</> },
  { key: "address", label: "Address", value: (customer: KnownCustomer) => customer.address },
];

export function CustomersRedesign({ customers, isVisible, view, setView, loading, error, load, emptyTitle, emptyDetail, notice, sourceWarning, add, toolbar, phaseFilter, dialog, details, actions }: Props) {
  const isPhone = useIsPhone();
  const fields = customerFields.filter((field) => isVisible(field.key));
  const title = (customer: KnownCustomer) => <>{customer.name}{details(customer)}</>;

  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="customers-v2">
      <PageHeader
        title="Customers"
        description="The companies we sell to. Used on quotes, sales orders and invoices."
        actions={<Button onClick={add}>New customer</Button>}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ColumnToggle tableKey="customers" />
        <ViewSwitcher value={view} onChange={setView} />
      </div>
      {toolbar}
      {phaseFilter}
      {notice && <Callout tone="warn" data-testid="customer-names-truncated">{notice}</Callout>}
      {sourceWarning && <Callout tone="warn" data-testid="customer-sources-incomplete">{sourceWarning}</Callout>}
      {loading ? <LoadingState label="Loading customers" /> : error ? (
        <FailedState title="Couldn’t load customers" detail={error} onRetry={() => void load()} retryLabel="Retry" headingLevel={2} />
      ) : !customers.length ? (
        <EmptyState title={emptyTitle} detail={emptyDetail} headingLevel={2} />
      ) : isPhone || view === "cards" ? (
        <StackedRows label="Customers" rows={customers.map((customer) => ({
          id: customer.id ?? customer.name,
          title: title(customer),
          fields: fields.map((field) => ({ label: field.label, value: field.value(customer) || "—" })),
          actions: actions(customer),
        }))} />
      ) : (
        <ScrollTable label="Customers" dense={view === "list"} pinLast>
          <thead>
            <tr>
              <th scope="col">Name</th>
              {fields.map((field) => <th key={field.key} scope="col">{field.label}</th>)}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id ?? customer.name}>
                <th scope="row">{title(customer)}</th>
                {fields.map((field) => <td key={field.key}>{field.value(customer) || "—"}</td>)}
                <td>{actions(customer)}</td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      {dialog}
    </div>
  );
}
