"use client";

/** Email history presentation. Receives existing filter, read and admin settlement callbacks from the route. */
import { FilterBar } from "@/components/filter-bar";
import { StatusBadge } from "@/components/status-badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button, Callout, EmptyState, FailedState, LoadingState, PageHeader, ScrollTable, StatTile, StatTiles, premiumTokens } from "@/components/ui/premium";
import { PRODUCT } from "@/lib/product";
import { emailStatusKey } from "@/lib/status-colours";

export type EmailRow = { id: string; to: string; subject: string; body: string; status: string; related: string; when: string };

interface Props {
  visible: EmailRow[];
  filters: Set<string>;
  setFilters: (filters: Set<string>) => void;
  loading: boolean;
  error: string | null;
  count: (status: string) => string;
  load: () => Promise<void>;
  statusLabel: (status: string) => string;
  settle?: (item: EmailRow, as: "sent" | "failed") => Promise<void>;
  settling: string | null;
}

const options = [
  { label: "Drafted", value: "drafted" },
  { label: "Sent manually", value: "sent_manually" },
  { label: "Sent", value: "sent_via_system" },
  { label: "Failed", value: "failed" },
  { label: "Needs checking", value: "unknown" },
];

export function EmailRedesign({ visible, filters, setFilters, loading, error, count, load, statusLabel, settle, settling }: Props) {
  return (
    <div className={`${premiumTokens} min-w-0 space-y-4`} data-testid="email-v2">
      <PageHeader title="Email & Payment Automation" description="Email history for the most recent 100 emails recorded by Tolra." />
      <Callout tone="info">
        Automatic email reading, quote follow-ups and payment reminders are coming soon. Review drafts in the Approval Queue.
      </Callout>
      <StatTiles label="Email history counts" columns={4}>
        {options.map(({ label, value }) => (
          <StatTile
            key={value}
            label={value === "sent_via_system" ? `Sent by ${PRODUCT.name}` : label}
            value={count(value)}
            pressed={filters.has(value)}
            onPress={() => setFilters(new Set([value]))}
          />
        ))}
      </StatTiles>
      <FilterBar options={[{ label: "All", value: "all" }, ...options]} activeValues={Array.from(filters)} onChange={setFilters} />
      {loading ? <LoadingState label="Loading email history" /> : error ? (
        <FailedState title="Couldn’t load email history" detail={error} onRetry={() => void load()} retryLabel="Retry" headingLevel={2} />
      ) : !visible.length ? (
        <EmptyState title="No emails recorded yet" headingLevel={2} />
      ) : (
        <ScrollTable label="Email history" primary={1} pinFirst={0} pinLast>
          <thead><tr>{["To", "Subject", "Related to", "Date", "Status", "Actions"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id}>
                <td>{item.to}</td>
                <th scope="row">{item.subject}</th>
                <td className="capitalize">{item.related}</td>
                <td>{item.when}</td>
                <td>
                  <StatusBadge status={emailStatusKey(item.status)} label={statusLabel(item.status)} />
                  {item.status === "unknown" && item.related === "job" && (
                    <Callout tone="warn" className="mt-2">
                      <p>We couldn’t confirm whether this was sent. Check with the customer or the provider’s log before sending it again.</p>
                      {settle ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" disabled={settling === item.id} onClick={() => void settle(item, "sent")}>It was sent</Button>
                          <Button size="sm" variant="secondary" disabled={settling === item.id} onClick={() => void settle(item, "failed")}>It was not sent</Button>
                        </div>
                      ) : <p>An administrator can settle this.</p>}
                    </Callout>
                  )}
                </td>
                <td>
                  <Dialog>
                    <DialogTrigger asChild><Button variant="secondary" size="sm">View</Button></DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>{item.subject}</DialogTitle>
                        <DialogDescription>To {item.to} · {item.when}</DialogDescription>
                      </DialogHeader>
                      <div className="whitespace-pre-wrap rounded-lg border p-4 text-sm text-slate-700">{item.body}</div>
                    </DialogContent>
                  </Dialog>
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
    </div>
  );
}
