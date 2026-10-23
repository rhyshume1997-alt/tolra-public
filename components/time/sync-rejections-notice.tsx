"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { type TimeSyncRejection, loadOpenRejections, rejectionDay, rejectionLine, rejectionNotices, resolveRejection } from "@/lib/time-sync-rejections";
import { useDatabaseHas075 } from "@/lib/use-database-has-075";

/**
 * Week review (075, G18): time actions a phone queued and the server refused when it synced (the week was approved first, or the time
 * was over 14 days old). One notice per person with the details; "Add on the sheet" opens that person's day to add a correction, and
 * "Resolved" marks the row done (audited). Office and admin only; hidden until the database has 075.
 */
export function SyncRejectionsNotice({ enabled, nameOf }: { enabled: boolean; nameOf: (userId: string) => string }) {
  const has075 = useDatabaseHas075(enabled) === true;
  const [rows, setRows] = useState<TimeSyncRejection[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !has075) return;
    try {
      setRows(await loadOpenRejections(supabase));
    } catch {
      setRows([]); // a read error hides the notice; the week review itself is unaffected
    }
  }, [has075]);
  useEffect(() => { void load(); }, [load]);

  async function resolve(row: TimeSyncRejection) {
    if (!supabase) return;
    setBusy(row.id);
    try {
      await resolveRejection(supabase, row.id, null);
      toast.success("Marked resolved.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't mark it resolved."));
    } finally {
      setBusy(null);
    }
  }

  if (!enabled || !has075) return null;
  const notices = rejectionNotices(rows, nameOf);
  if (!notices.length) return null;
  return (
    <div className="space-y-3" data-testid="sync-rejections">
      {notices.map((notice) => (
        <div key={notice.userId} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="sync-rejection-notice">
          <p className="flex items-start gap-2 font-medium"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {notice.text}.</p>
          <ul className="mt-2 space-y-1">
            {notice.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2" data-testid="sync-rejection-row">
                <span>{rejectionLine(row)}</span>
                <Button asChild size="sm" variant="outline"><Link href={`/time?date=${rejectionDay(row)}&user=${row.user_id}`}>Add on the sheet</Link></Button>
                <Button size="sm" variant="outline" disabled={busy === row.id} onClick={() => void resolve(row)} data-testid="sync-rejection-resolve"><Check className="size-4" /> Resolved</Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
