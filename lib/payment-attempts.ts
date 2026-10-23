/**
 * Recording a payment when the answer may be lost (migration 032). record_invoice_payment is idempotent by request id, so
 * the screen keeps ONE id per attempt on an invoice, and registers it BEFORE sending. The register is kept in localStorage
 * under the signed-in user, company and invoice, so a lost answer survives closing the dialog, a reload or a new tab.
 *   - "sent": registered, outcome unknown. Reopening reuses the same id and values, and the database is asked whether a
 *     payment with that id exists before anything is sent again.
 *   - "refused": the function itself refused (nothing was saved). The record stays, so the same values sent again reuse the
 *     same id (checked first, like "sent"); changed values get a new id. It is dropped on success, or after a day.
 * A network failure, timeout or 5xx is never a refusal: only an error the database function raised says nothing was saved.
 * Each invoice's attempt is its own storage entry, read fresh on every use and written on its own, so two tabs working on
 * different invoices never overwrite each other. An attempt is only sent once its record is durably saved (written and read
 * back): when storage is missing, blocked or full, nothing is sent and the screen says why.
 */
export type PaymentAttempt = { requestId: string; amount: string; paidOn: string; method: string; reference: string };

export type PaymentOutcome = { status: string; amountPaid: number; balance: number };

type Stored = PaymentAttempt & { state: "sent" | "refused" | "done"; at: number };

/** Codes our own function (or the API in front of it) uses to refuse before or without writing anything. */
const DEFINITE = /^(22023|42501|P0002|PGRST116|PGRST301|23\d{3})$/;
const KEY_PREFIX = "quoteflow-payment-attempt:";
const REFUSED_KEEP_MS = 24 * 60 * 60 * 1000;
/** A recorded payment is remembered this long, so a dialog opened before it can't send a second one without a fresh look. */
const DONE_KEEP_MS = 60 * 60 * 1000;

/** True when the error is a refusal that certainly wrote nothing. Anything else (no code, 5xx, timeout, offline) is uncertain. */
export function isDefiniteRefusal(err: unknown): boolean {
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code ?? "") : "";
  return DEFINITE.test(code);
}

/** The attempt couldn't be saved durably, so it must not be sent. */
export class AttemptNotSaved extends Error {
  constructor(cause?: unknown) {
    super("This browser couldn't save the payment attempt (storage blocked or full), so nothing was sent.");
    this.name = "AttemptNotSaved";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Runs `fn` while holding an exclusive lock that every tab of this browser shares (the Web Locks API), so two tabs paying
 * the SAME invoice can't both read "no attempt" and send two different request ids: the second waits, then finds the
 * first's attempt and checks it. Without Web Locks nothing is sent (see recordWithRecovery).
 */
export type LockRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export function browserLocks(): LockRunner | null {
  try {
    const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks || typeof locks.request !== "function") return null;
    return <T>(name: string, fn: () => Promise<T>) => locks.request(name, { mode: "exclusive" }, fn) as Promise<T>;
  } catch {
    return null;
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const SAME_VALUES = (a: PaymentAttempt, b: Omit<PaymentAttempt, "requestId">) =>
  a.amount === b.amount && a.paidOn === b.paidOn && a.method === b.method && a.reference === b.reference;

/** The attempts of ONE user in ONE company, one storage entry per invoice. Another user or company has other keys. */
export class PaymentAttempts {
  private readonly prefix: string;
  private readonly storage: StorageLike | null;

  constructor(
    userId: string, organizationId: string, storage: StorageLike | null = defaultStorage(), private now: () => number = Date.now,
    /** Shared across tabs; null when the browser can't provide one (then nothing is sent). */
    readonly locks: LockRunner | null = browserLocks(),
  ) {
    this.prefix = `${KEY_PREFIX}${userId}:${organizationId}:`;
    this.storage = storage;
  }

  /** Any live record, including a recently recorded ("done") one. */
  private readAny(invoiceId: string): Stored | undefined {
    try {
      const raw = this.storage?.getItem(this.prefix + invoiceId);
      if (!raw) return undefined;
      const a = JSON.parse(raw) as Stored;
      if (!a || typeof a.requestId !== "string") return undefined;
      if (a.state === "sent") return a;
      if (a.state === "refused" && this.now() - a.at < REFUSED_KEEP_MS) return a;
      if (a.state === "done" && this.now() - a.at < DONE_KEEP_MS) return a;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** An attempt still in progress (sent or refused); a recorded one isn't returned. */
  private read(invoiceId: string): (Stored & { state: "sent" | "refused" }) | undefined {
    const a = this.readAny(invoiceId);
    return a && a.state !== "done" ? (a as Stored & { state: "sent" | "refused" }) : undefined;
  }

  /** When a payment on this invoice was last recorded from this browser (within the last hour), if any. */
  recordedAt(invoiceId: string): number | undefined {
    const a = this.readAny(invoiceId);
    return a?.state === "done" ? a.at : undefined;
  }

  /** Writes and reads back; throws AttemptNotSaved unless the record is really there. */
  private write(invoiceId: string, attempt: Stored) {
    if (!this.storage) throw new AttemptNotSaved();
    const value = JSON.stringify(attempt);
    try {
      this.storage.setItem(this.prefix + invoiceId, value);
      if (this.storage.getItem(this.prefix + invoiceId) !== value) throw new Error("read back differs");
    } catch (err) {
      throw new AttemptNotSaved(err);
    }
  }

  private remove(invoiceId: string) {
    try {
      this.storage?.removeItem(this.prefix + invoiceId);
    } catch {
      // Nothing to protect any more: the payment is settled.
    }
  }

  /** The name of the cross-tab lock for one invoice of this user and company. */
  lockName(invoiceId: string) {
    return this.prefix + invoiceId;
  }

  /** The record for this invoice, if any attempt has been registered (read fresh, so another tab's attempt is seen). */
  get(invoiceId: string): (PaymentAttempt & { state: "sent" | "refused" }) | undefined {
    return this.read(invoiceId);
  }

  /** Invoices with an attempt whose outcome is unknown. */
  uncertainIds(): string[] {
    const ids: string[] = [];
    try {
      const n = this.storage?.length ?? 0;
      for (let i = 0; i < n; i += 1) {
        const k = this.storage!.key(i);
        if (k && k.startsWith(this.prefix)) {
          const id = k.slice(this.prefix.length);
          if (this.read(id)?.state === "sent") ids.push(id);
        }
      }
    } catch {
      return ids;
    }
    return ids;
  }

  isUncertain(invoiceId: string) {
    return this.read(invoiceId)?.state === "sent";
  }

  /**
   * Registers an attempt BEFORE it is sent and returns it only once it is durably saved (throws AttemptNotSaved otherwise).
   * The same values as a kept refusal reuse its id; an uncertain attempt is always returned as it was (its id and values),
   * whatever the dialog now says. Otherwise a new id.
   */
  register(invoiceId: string, values: Omit<PaymentAttempt, "requestId">, newId: () => string): PaymentAttempt {
    const existing = this.read(invoiceId);
    let attempt: Stored;
    if (existing?.state === "sent") attempt = existing;
    else if (existing && SAME_VALUES(existing, values)) attempt = { ...existing, state: "sent", at: this.now() };
    else attempt = { ...values, requestId: newId(), state: "sent", at: this.now() };
    this.write(invoiceId, attempt);
    return attempt;
  }

  /** A definite refusal: nothing was saved. The record is kept (as "refused") so a retry with the same values reuses its id. */
  refused(invoiceId: string) {
    const a = this.read(invoiceId);
    if (!a) return;
    try {
      this.write(invoiceId, { ...a, state: "refused", at: this.now() });
    } catch {
      // Left as "sent": the next try checks the database first, which is the safe side.
    }
  }

  /** The payment is recorded (or found recorded): the attempt is over. It is remembered for an hour (see recordedAt). */
  done(invoiceId: string) {
    const a = this.readAny(invoiceId);
    try {
      if (a) this.write(invoiceId, { ...a, state: "done", at: this.now() });
      else this.remove(invoiceId);
    } catch {
      this.remove(invoiceId);
    }
  }
}

export type RecordDeps = {
  /** Calls record_invoice_payment with the attempt's request id. */
  record: (attempt: PaymentAttempt) => Promise<{ outcome: PaymentOutcome | null; error: unknown }>;
  /** Asks whether a payment with this request id exists on the invoice; `error` when that could not be asked. */
  find: (requestId: string) => Promise<{ outcome: PaymentOutcome | null; error: unknown }>;
};

export type RecordResult =
  | { kind: "done"; outcome: PaymentOutcome; recovered: boolean; attempt: PaymentAttempt }
  | { kind: "refused"; error: unknown; attempt: PaymentAttempt }
  | { kind: "unknown"; error: unknown; attempt: PaymentAttempt }
  | { kind: "not-saved"; error: AttemptNotSaved }
  | { kind: "no-lock"; error: Error }
  | { kind: "stale"; error: Error };

/**
 * Registers the attempt, then, if it was tried before (uncertain or refused), asks the database whether it exists, and only
 * then sends. Never sends a second id for an attempt that may have been committed.
 */
export async function recordWithRecovery(
  invoiceId: string, values: Omit<PaymentAttempt, "requestId">, attempts: PaymentAttempts, deps: RecordDeps, newId: () => string,
  /** When the dialog was opened: a payment recorded on this invoice after that (another tab, a double click) stops this one. */
  openedAt: number = Number.NEGATIVE_INFINITY,
): Promise<RecordResult> {
  // One tab at a time per invoice, for the whole read, register, check and send. No shared lock: nothing is sent.
  if (!attempts.locks) {
    return { kind: "no-lock", error: new Error("This browser can't coordinate payments between tabs, so nothing was sent. Use an up-to-date browser.") };
  }
  return attempts.locks(attempts.lockName(invoiceId), async () => {
    const recorded = attempts.recordedAt(invoiceId);
    if (recorded !== undefined && recorded >= openedAt && attempts.get(invoiceId) === undefined) {
      return { kind: "stale", error: new Error("A payment on this invoice was just recorded (another tab or a second click). Nothing more was sent: check the invoice, then record any further payment.") };
    }
    return recordLocked(invoiceId, values, attempts, deps, newId);
  });
}

async function recordLocked(
  invoiceId: string, values: Omit<PaymentAttempt, "requestId">, attempts: PaymentAttempts, deps: RecordDeps, newId: () => string,
): Promise<RecordResult> {
  const triedBefore = attempts.get(invoiceId) !== undefined;
  let attempt: PaymentAttempt;
  try {
    attempt = attempts.register(invoiceId, values, newId);
  } catch (err) {
    if (err instanceof AttemptNotSaved) return { kind: "not-saved", error: err };
    throw err;
  }
  if (triedBefore) {
    const found = await deps.find(attempt.requestId);
    if (found.error) return { kind: "unknown", error: found.error, attempt };
    if (found.outcome) {
      attempts.done(invoiceId);
      return { kind: "done", outcome: found.outcome, recovered: true, attempt };
    }
  }
  const { outcome, error } = await deps.record(attempt);
  if (!error && outcome) {
    attempts.done(invoiceId);
    return { kind: "done", outcome, recovered: false, attempt };
  }
  if (error && isDefiniteRefusal(error)) {
    attempts.refused(invoiceId);
    return { kind: "refused", error, attempt };
  }
  return { kind: "unknown", error: error ?? new Error("No answer"), attempt };
}

/**
 * Bulk "Pay in full": one attempt per invoice through recordWithRecovery, one after another. An invoice whose answer is lost
 * keeps its attempt (kind "unknown"); running the batch again reuses that request id and asks the database first, so a
 * payment is never sent twice under a new id. One invoice's outcome never stops the others.
 */
export async function recordBatch(
  items: { id: string; values: Omit<PaymentAttempt, "requestId"> }[], attempts: PaymentAttempts, depsFor: (id: string) => RecordDeps, newId: () => string,
  openedAt: number = Number.NEGATIVE_INFINITY,
): Promise<{ id: string; result: RecordResult }[]> {
  const out: { id: string; result: RecordResult }[] = [];
  for (const item of items) out.push({ id: item.id, result: await recordWithRecovery(item.id, item.values, attempts, depsFor(item.id), newId, openedAt) });
  return out;
}
