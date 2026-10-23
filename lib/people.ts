/**
 * Who did what (migration 035). Names only: the people of the signed-in company come from company_people() as
 * (user_id, display_name), never an e-mail address, and anyone we can't name shows as "—". The database records the actors
 * (triggers, from the session); these helpers turn a record's actor columns into the "Started by Dave · 12/10/2026, 09:30"
 * lines on the detail views. Nothing here guesses: a missing actor or time stays missing.
 */
import { fmtDateTime } from "@/lib/dates";
import { USERNAME_PATTERN } from "@/lib/username";

/** What an unknown person or time shows as. */
export const UNKNOWN = "—";

/** user id -> display name (null: that person has no usable name). */
export type PeopleMap = Record<string, string | null>;

/** A usable display name, or null: trimmed, and never anything that looks like an e-mail address. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.includes("@")) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** The people list as a map, from the rows company_people() returns. */
export function peopleMap(rows: unknown): PeopleMap {
  const map: PeopleMap = {};
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (row && typeof row === "object" && typeof (row as { user_id?: unknown }).user_id === "string") {
      map[(row as { user_id: string }).user_id] = cleanName((row as { display_name?: unknown }).display_name);
    }
  }
  return map;
}

/**
 * The people map with a sign-in username for anyone who has no usable name (no full name, or a "name" that was an e-mail address), from
 * rows of (user_id, username): org_members() (an admin's own company; everyone else gets no rows) and the signed-in person's own profile.
 * A real name always wins; a username is only used when it is a valid username (they can't contain "@", so never an e-mail). Nothing
 * else of those rows (e-mail, role) is kept.
 */
export function withUsernames(people: PeopleMap, rows: unknown): PeopleMap {
  if (!Array.isArray(rows)) return people;
  const out: PeopleMap = { ...people };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { user_id: id, username } = row as { user_id?: unknown; username?: unknown };
    if (typeof id !== "string" || !id || out[id]) continue;
    const name = typeof username === "string" && USERNAME_PATTERN.test(username.trim()) ? cleanName(username) : null;
    if (name) out[id] = name;
  }
  return out;
}

/**
 * How an admin's own lists (the Activity page's person filter) name a member: their name, else their username (a sign-in name,
 * never an address), else "—". Never an e-mail address.
 */
export function memberLabel(member: { full_name?: unknown; username?: unknown }): string {
  return cleanName(member.full_name) ?? cleanName(member.username) ?? UNKNOWN;
}

/** The display name for a user id: a real name, or "—" (no id, someone outside the company, or no name on file). */
export function personName(people: PeopleMap, id: unknown): string {
  return typeof id === "string" && id ? people[id] ?? UNKNOWN : UNKNOWN;
}

export type WhoLine = {
  key: string;
  /** "Started by", "Signed by (customer)" ... */
  label: string;
  name: string;
  /** ISO timestamp, or null when the record doesn't say. */
  at: string | null;
  /** "recorded by Dave" on a customer signature. */
  note?: string;
};

/** One line as text: "Started by Dave · 12/10/2026, 09:30". An unknown time is left off rather than guessed. */
export function lineText(line: WhoLine): string {
  const when = line.at ? fmtDateTime(line.at) : "";
  return `${line.label} ${line.name}${line.note ? ` (${line.note})` : ""}${when ? ` · ${when}` : ""}`;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const status = (row: Row) => String(row.status ?? "").trim().toLowerCase();

/** The columns each record type's who/when lines read. */
export const WHO_COLUMNS: Record<string, string> = {
  jobs: "created_by, created_at, started_by, started_at, finished_by, finished_at, inspected_by_user, inspected_by, inspected_at",
  quotes: "created_by, created_at, status, sent_by, sent_at, accepted_by, accepted_at",
  sales_orders: "created_by, created_at, status, confirmed_by, confirmed_at",
  invoices: "created_by, created_at, status, issued_by, issued_at, emailed_by, sent_date, paid_by, paid_at",
  purchase_orders: "created_by, created_at, received_by, received_at",
  delivery_notes: "created_by, created_at, status, despatched_by, despatched_at, signed_by_name, signed_recorded_by, signed_at, emailed_by, emailed_at",
  credit_notes: "created_by, created_at, status, issued_by, issued_at",
};

export type PaymentRow = { created_by?: unknown; created_at?: unknown; amount?: unknown; reverses_payment_id?: unknown };

/** A job's reworks and scrapped quantities (migration 037), for the job's who/when lines. */
export type ReworkRow = { id?: unknown; inspection_id?: unknown; follow_up_of?: unknown; raised_by?: unknown; raised_at?: unknown; started_by?: unknown; started_at?: unknown; finished_by?: unknown; finished_at?: unknown };
export type ScrapRow = { id?: unknown; created_by?: unknown; created_at?: unknown; quantity?: unknown };
export type JobExtras = { reworks?: ReworkRow[]; scrap?: ScrapRow[] };

/**
 * The who/when lines for a record, in the order things happen. A milestone that hasn't happened has no line. A milestone that
 * has happened but whose person (or time) was never recorded (older records) still shows, with "—".
 */
export function whoWhenLines(table: string, row: Row, people: PeopleMap, payments: PaymentRow[] = [], job: JobExtras = {}): WhoLine[] {
  const name = (id: unknown) => personName(people, id);
  const line = (key: string, label: string, by: unknown, at: unknown, extra: Partial<WhoLine> = {}): WhoLine => ({ key, label, name: name(by), at: text(at), ...extra });
  const out: WhoLine[] = [line("created", "Created by", row.created_by, row.created_at)];
  switch (table) {
    case "jobs":
      if (row.started_at) out.push(line("started", "Started by", row.started_by, row.started_at));
      if (row.finished_at) out.push(line("finished", "Finished by", row.finished_by, row.finished_at));
      // Failed inspections and their rework, in the order they happened: who failed it, who started the rework, what was scrapped, who finished it.
      pushRework(out, job, line);
      if (row.inspected_at) {
        // The person's name from the company list; a job released before 035 only has the typed name, used when it is a name.
        const fallback = row.inspected_by === "Inspector" ? null : cleanName(row.inspected_by); // "Inspector" is the placeholder for a signer with no name
        const named = typeof row.inspected_by_user === "string" && row.inspected_by_user ? name(row.inspected_by_user) : fallback ?? UNKNOWN;
        out.push({ key: "inspected", label: "Inspected by", name: named, at: text(row.inspected_at) });
      }
      break;
    case "quotes":
      if (row.sent_at) out.push(line("sent", "Sent by", row.sent_by, row.sent_at));
      if (row.accepted_at || status(row) === "accepted") out.push(line("accepted", "Accepted by", row.accepted_by, row.accepted_at));
      break;
    case "sales_orders":
      if (row.confirmed_at || row.confirmed_by || status(row) === "confirmed") out.push(line("confirmed", "Confirmed by", row.confirmed_by, row.confirmed_at));
      break;
    case "invoices":
      if (status(row) && status(row) !== "draft") out.push(line("issued", "Issued by", row.issued_by, row.issued_at));
      if (row.sent_date) out.push(line("emailed", "E-mailed by", row.emailed_by, row.sent_date));
      payments
        .filter((p) => !p.reverses_payment_id)
        .forEach((p, index) => out.push(line(`payment-${index}`, "Payment recorded by", p.created_by, p.created_at)));
      if (status(row) === "paid") out.push(line("paid", "Paid (cleared) by", row.paid_by, row.paid_at));
      break;
    case "purchase_orders":
      if (row.received_at) out.push(line("received", "Received by", row.received_by, row.received_at));
      break;
    case "delivery_notes": {
      if (["despatched", "delivered", "signed"].includes(status(row))) out.push(line("despatched", "Despatched by", row.despatched_by, row.despatched_at));
      if (row.emailed_at) out.push(line("emailed", "E-mailed by", row.emailed_by, row.emailed_at));
      if (row.signed_at || status(row) === "signed") {
        // The customer's own signature is the name they typed; the staff member who recorded it is a separate note.
        const customer = typeof row.signed_by_name === "string" && row.signed_by_name.trim() ? row.signed_by_name.trim() : UNKNOWN;
        const recorder = typeof row.signed_recorded_by === "string" && row.signed_recorded_by ? `recorded by ${name(row.signed_recorded_by)}` : undefined;
        out.push({ key: "signed", label: "Signed by (customer)", name: customer, at: text(row.signed_at), note: recorder });
      }
      break;
    }
    case "credit_notes":
      if (status(row) === "issued") out.push(line("issued", "Issued by", row.issued_by, row.issued_at));
      break;
    default:
      break;
  }
  return out;
}

/** The rework lines of a job, oldest first: failed inspection, rework started, scrapped quantities, rework finished, replacements reopened. */
function pushRework(out: WhoLine[], job: JobExtras, line: (key: string, label: string, by: unknown, at: unknown) => WhoLine) {
  const events: WhoLine[] = [];
  // One failed inspection opens a rework per failed order line: it is one "Failed inspection" line. A replacement rework (opened for
  // replacements still owed) says so.
  const failures = new Set<string>();
  (job.reworks ?? []).forEach((rework, index) => {
    const key = typeof rework.id === "string" ? rework.id : String(index);
    if (rework.follow_up_of) {
      events.push(line(`reopened-${key}`, "Replacements reopened by", rework.raised_by, rework.raised_at));
    } else {
      const failure = typeof rework.inspection_id === "string" ? rework.inspection_id : key;
      if (!failures.has(failure)) events.push(line(`failed-${key}`, "Failed inspection by", rework.raised_by, rework.raised_at));
      failures.add(failure);
    }
    if (rework.started_at) events.push(line(`rework-started-${key}`, "Rework started by", rework.started_by, rework.started_at));
    if (rework.finished_at) events.push(line(`rework-finished-${key}`, "Rework finished by", rework.finished_by, rework.finished_at));
  });
  (job.scrap ?? []).forEach((scrap, index) => {
    const key = typeof scrap.id === "string" ? scrap.id : String(index);
    events.push(line(`scrap-${key}`, `Scrapped ${typeof scrap.quantity === "number" ? scrap.quantity : "some"} by`, scrap.created_by, scrap.created_at));
  });
  // ISO timestamps sort as text; an event without a time keeps its place after the ones with one.
  events.sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
  out.push(...events);
}
