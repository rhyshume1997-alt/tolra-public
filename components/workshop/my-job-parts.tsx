"use client";

/**
 * Parts done on a My jobs card (migration 118): "12 of 50 parts" in words, a "+1 part" button (48 px or taller, glove sized) and a
 * "Change the count" form to log several at once or to take parts off again (a correction is a negative entry that must say why). Logging
 * needs a connection and says so: nothing is queued offline, and nothing is shown as saved until the server has it. Nothing here starts,
 * pauses or finishes a job. Hidden until the database says it has 118 (lib/job-parts, fail closed).
 */
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  NEEDS_CONNECTION, PARTS_NOTE_MAX, entrySignature, logJobParts, opKeyFor, outcomeUnknown, parseEntry, partsControls, partsFailure, partsText, requiredParts,
  type PartsTotals,
} from "@/lib/job-parts";
import { supabase } from "@/lib/supabase";

const TAP = "h-auto min-h-12 whitespace-normal px-4 py-2 text-base font-semibold pointer-coarse:h-auto pointer-coarse:min-h-12";

export function MyJobParts({ jobId, jobNo, quantity, role, parts, readOnly = false, onLogged }: {
  jobId: string;
  jobNo: string;
  /** The job's quantity required (M). */
  quantity: number | null;
  role: string | null | undefined;
  parts: PartsTotals;
  readOnly?: boolean;
  /** Called after the server took an entry, so the totals are read again. */
  onLogged?: () => void;
}) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const required = requiredParts(quantity);
  const text = partsText(parts, jobId, quantity);
  const done = parts.done.get(jobId);
  const controls = partsControls({ available: parts.available, role, online, readOnly, required, done });
  const [form, setForm] = useState(false);
  const [takeOff, setTakeOff] = useState(false);
  const [amount, setAmount] = useState("1");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = useRef<{ key: string; signature: string } | null>(null);

  // Hidden until the database has 118 and the count for this job is known: never "0 of 50" for a read that failed.
  if (!text) return null;

  async function send(quantityToLog: number, noteToLog: string, after?: () => void) {
    if (saving) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setFailure(NEEDS_CONNECTION);
      return;
    }
    if (!supabase) {
      setFailure(NEEDS_CONNECTION);
      return;
    }
    setSaving(true);
    setFailure(null);
    // The same entry sent again after a lost answer keeps its key, so it is still one entry; a new tap after a definite answer is a new key.
    key.current = opKeyFor(key.current, entrySignature(jobId, quantityToLog, noteToLog), () => crypto.randomUUID());
    try {
      await logJobParts(supabase, jobId, quantityToLog, noteToLog, key.current.key);
      key.current = null;
      after?.();
      onLogged?.();
      toast.success(quantityToLog > 0 ? `${quantityToLog} part${quantityToLog === 1 ? "" : "s"} logged on ${jobNo}.` : `${-quantityToLog} part${quantityToLog === -1 ? "" : "s"} taken off ${jobNo}.`);
    } catch (err) {
      // A definite refusal ends this entry (the next tap is a new one) and the count is read again, so a number made stale by another
      // device is put right on screen. A lost connection keeps the key: sending the same entry again is still one entry.
      if (!outcomeUnknown(err)) {
        key.current = null;
        onLogged?.();
      }
      setFailure(partsFailure(err));
    } finally {
      setSaving(false);
    }
  }

  function saveForm() {
    const entry = parseEntry({ amount, takeOff, note });
    if (!entry.ok) {
      setFailure(entry.message);
      return;
    }
    void send(entry.quantity, entry.note, () => {
      setForm(false);
      setAmount("1");
      setNote("");
      setTakeOff(false);
    });
  }

  return (
    <div className="space-y-3" data-testid="my-job-parts">
      <p className="text-base font-semibold text-ink" data-testid="my-job-parts-count" aria-label={`Parts logged on ${jobNo}: ${text}`}>
        Parts logged: <span className="tabular-nums">{text}</span>
      </p>
      {controls.show ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Button type="button" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-add-part" aria-label={`Add 1 part to ${jobNo}`} disabled={saving || !controls.canAdd} onClick={() => void send(1, "")}>
              <Plus className="size-5" />{saving ? "Saving..." : "+1 part"}
            </Button>
            <Button type="button" variant="outline" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-change-count" aria-expanded={form} aria-label={`Change the parts count for ${jobNo}`} onClick={() => { setForm((v) => !v); setFailure(null); }}>
              Change the count
            </Button>
          </div>
          {controls.note ? <p className="text-sm text-muted-foreground" data-testid="my-job-parts-note">{controls.note}</p> : null}
          {form ? (
            <div className="space-y-3 border border-line bg-surface p-4" data-testid="my-job-parts-form">
              <div className="flex flex-wrap gap-3" role="group" aria-label={`Add or take off parts on ${jobNo}`}>
                <Button type="button" variant={takeOff ? "outline" : "default"} className={`${TAP} flex-1`} aria-pressed={!takeOff} data-testid="my-job-parts-mode-add" onClick={() => setTakeOff(false)}><Plus className="size-5" />Add parts</Button>
                <Button type="button" variant={takeOff ? "default" : "outline"} className={`${TAP} flex-1`} aria-pressed={takeOff} data-testid="my-job-parts-mode-off" disabled={!controls.canTakeOff} onClick={() => setTakeOff(true)}><Minus className="size-5" />Take parts off</Button>
              </div>
              <label className="block text-sm font-semibold text-ink" htmlFor={`parts-amount-${jobId}`}>{takeOff ? "How many to take off?" : "How many to add?"}</label>
              <Input
                id={`parts-amount-${jobId}`}
                data-testid="my-job-parts-amount"
                aria-label={`Number of parts for ${jobNo}`}
                className="min-h-12 text-lg"
                type="text"
                inputMode="numeric"
                value={amount}
                disabled={saving}
                onChange={(event) => setAmount(event.target.value)}
              />
              <label className="block text-sm font-semibold text-ink" htmlFor={`parts-note-${jobId}`}>{takeOff ? "Why? (needed)" : "Note (optional)"}</label>
              <Textarea
                id={`parts-note-${jobId}`}
                data-testid="my-job-parts-note-input"
                aria-label={`Parts note for ${jobNo}`}
                className="min-h-20"
                value={note}
                maxLength={PARTS_NOTE_MAX}
                disabled={saving}
                placeholder={takeOff ? "Counted the wrong tray" : "Tray 4"}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button type="button" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-parts-save" disabled={saving} onClick={saveForm}>{saving ? "Saving..." : takeOff ? "Take parts off" : "Add parts"}</Button>
                <Button type="button" variant="outline" className={`${TAP} w-full sm:w-auto`} disabled={saving} onClick={() => { setForm(false); setFailure(null); }}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {failure ? <p role="alert" data-testid="my-job-parts-error" className="text-sm font-semibold text-destructive">{failure}</p> : null}
        </>
      ) : null}
    </div>
  );
}
