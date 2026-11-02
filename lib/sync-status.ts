/**
 * What the always-visible sync indicator says (top bar, every screen width), from the offline outbox status
 * (lib/offline/scope.ts) and whether the browser has a connection. Pure: no browser or Supabase here, so the words are
 * tested once and the component only draws them.
 *
 * One state at a time, most urgent first:
 *   failed  - a change the server refused or that clashed is held on this device: a person has to look at it.
 *   offline - no connection (the browser says so, or a page is showing this device's copy).
 *   pending - online, with changes still waiting to upload.
 *   synced  - online and nothing waiting.
 * The sentences never reuse the offline notice's own ("waiting to sync", "needs attention" with a count first, "last synced"),
 * which other checks look for by text.
 */
export type SyncKind = "synced" | "offline" | "pending" | "failed";
export type SyncIndicator = {
  kind: SyncKind;
  /** A word or two for the chip (shown from small tablets up; phones show only the icon). */
  short: string;
  /** The full sentence: accessible name, tooltip and the polite live announcement. */
  label: string;
  /** pending is blue, the agreed colour for offline changes waiting to sync (lib/status-colours.ts sync_pending). */
  tone: "good" | "warn" | "pending" | "bad";
};

export type SyncInput = {
  /** A page fell back to this device's copy (lib/offline/scope.ts reportOffline). */
  offline: boolean;
  /** navigator.onLine (true where unknown). */
  browserOnline: boolean;
  /** Changes waiting in the outbox. */
  pending: number;
  /** Changes held for a person: refused by the server, or in conflict. */
  held: number;
};

const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

export function syncIndicator(input: SyncInput): SyncIndicator {
  const pending = Math.max(0, input.pending | 0);
  const held = Math.max(0, input.held | 0);
  if (held) {
    return { kind: "failed", short: "Needs attention", label: `Upload failed – needs attention (${changes(held)} not saved)`, tone: "bad" };
  }
  if (input.offline || !input.browserOnline) {
    return { kind: "offline", short: "Offline", label: pending ? `Offline – ${changes(pending)} kept on this device` : "Offline", tone: "warn" };
  }
  if (pending) return { kind: "pending", short: `${pending} to upload`, label: `${changes(pending)} waiting to upload`, tone: "pending" };
  return { kind: "synced", short: "Synced", label: "Online and synced", tone: "good" };
}

type Op = { kind: string; jobNo?: string };
const KIND_LABEL: Record<string, string> = { worksheet: "Worksheet", start: "Start", run_start: "Start", pause: "Pause", run_pause: "Pause", finish: "Finish", photo: "Photo", signoff: "Signature", clock_refusal: "Network-lock report" };

/** One line per queued or held change, for the indicator's panel: "Worksheet · J-1001". */
export function describeChange(op: Op): string {
  const what = KIND_LABEL[op.kind] ?? "Change";
  return op.jobNo ? `${what} · ${op.jobNo}` : what;
}

/** "queued 09:30" in the device's own clock (24-hour), or "" when the time can't be read. */
export function queuedAtLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `queued ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export type RetryOutcome = { tone: "success" | "info" | "warning"; message: string; showDetails: boolean };

/**
 * What to tell the person after Retry. `outbox` (null = the read could not be verified) is the COMPLETE state read after the pass (waiting + in conflict + refused), not the
 * pass's own result: a pass reports only what it replayed, so a change held by an earlier pass would look like "all uploaded".
 * `threw`: the pass itself failed (no connection). `ran`: there was a scope and a connection to try (false = nothing on this device).
 */
export function retryOutcome(input: { ran: boolean; threw: boolean; outbox: { pending: number; conflicts: number; rejected: number } | null }): RetryOutcome {
  // The outbox could not be read (or the company changed while reading): never claim success on a state nobody verified.
  if (!input.outbox) return { tone: "warning", message: "Couldn't check what is left to upload. Your changes are kept on this device; try Retry again.", showDetails: false };
  const { pending, conflicts, rejected } = input.outbox;
  const held = conflicts + rejected;
  const waiting = pending > 0 || input.threw;
  if (held) {
    const heldText = `${changes(held)} not saved and need${held === 1 ? "s" : ""} you`;
    const rest = pending ? ` ${changes(pending)} also still waiting to upload.` : "";
    return { tone: "warning", message: `${heldText[0].toUpperCase()}${heldText.slice(1)}: use Show details to retry, review or dismiss ${held === 1 ? "it" : "them"}.${rest}`, showDetails: true };
  }
  if (waiting) return { tone: "warning", message: "Still can't reach the server. Your changes are kept on this device.", showDetails: false };
  if (!input.ran) return { tone: "info", message: "Nothing to upload from this device.", showDetails: false };
  return { tone: "success", message: "Everything is uploaded.", showDetails: false };
}
