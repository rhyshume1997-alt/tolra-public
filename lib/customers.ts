"use client";

import { databaseHas073, missingDbObject } from "@/lib/db-features";
import { DEMO_MODE } from "@/lib/demo";
import { fetchAll } from "@/lib/fetch-all";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";
import { ValidationError, customerSchema, parseOrThrow } from "@/lib/validation/schemas";

export type CustomerRecord = {
  id?: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  /** Mobile number (migration 073). undefined: not read (the database has no such column yet), so it is never sent on save. */
  mobile?: string;
  /**
   * New jobs for this customer are traceable (ISO 9001 8.5.2, migration 082: material cert no. and heat/cast no. before an inspection
   * pass). undefined: not read (the database has no such column yet), so it is never sent on save.
   */
  traceableDefault?: boolean;
};

type CustomerDbRow = {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  mobile?: string | null;
};

const CUSTOMER_COLUMNS = "id, name, contact_name, email, phone, address, notes";
/** With migration 073's mobile. Before 073 a read with it fails as a missing column, and the customers are read without it. */
const CUSTOMER_COLUMNS_073 = `${CUSTOMER_COLUMNS}, mobile`;

export const TRACEABLE_NEEDS_UPDATE = "Traceable can't be saved yet: the database update that adds it hasn't been applied. Nothing was changed.";

export const MOBILE_NEEDS_UPDATE = "The mobile number can't be saved yet: the database update that adds it hasn't been applied. Nothing was changed.";

// Generic placeholder customers for demo mode only. JNR's real test customers live in the demo data module and are
// loaded lazily by loadDemoCustomers() so they never ship in the production bundle.
export const DEMO_CUSTOMERS: CustomerRecord[] = [
  "Aerospace Components Ltd",
  "Defence Manufacturing Co",
  "Precision Engineering Group",
  "Industrial Systems Ltd",
  "Marine Engineering Co",
  "Construction Services Ltd",
].map((name) => ({ name, contactName: "", email: "", phone: "", address: "", notes: "" }));

/** Demo mode only: JNR's real test customers followed by the placeholder ones. Returns [] outside demo mode. */
export async function loadDemoCustomers(): Promise<CustomerRecord[]> {
  if (!DEMO_MODE) return [];
  const m = await import("@/lib/jnr-test-data");
  return [...m.JNR_TEST_CUSTOMERS, ...DEMO_CUSTOMERS];
}

function toCustomerRecord(row: CustomerDbRow): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name || "",
    email: row.email || "",
    phone: row.phone || "",
    address: row.address || "",
    notes: row.notes || "",
    ...(Object.prototype.hasOwnProperty.call(row, "mobile") ? { mobile: row.mobile || "" } : {}),
  };
}

/** The reads the customer list needs (an injected client keeps it testable). */
export type CustomerReader = {
  from: (table: "customers") => { select: (columns: string) => { order: (column: string) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }> } };
};

/**
 * Every customer, with the mobile when the database has it (`has073`, from the cached databaseHas073 probe): before 073 the list is
 * read without it, so no request fails. If the column is missing anyway (the probe was wrong, or the update was rolled back) the
 * list is read again without it, never an error for that.
 */
export async function readCustomers(client: CustomerReader, has073 = true): Promise<CustomerRecord[]> {
  if (!has073) {
    const { data, error } = await client.from("customers").select(CUSTOMER_COLUMNS).order("name");
    if (error) throw error;
    return (data || []).map((row) => toCustomerRecord(row as CustomerDbRow));
  }
  const withMobile = await client.from("customers").select(CUSTOMER_COLUMNS_073).order("name");
  if (!withMobile.error) return (withMobile.data || []).map((row) => toCustomerRecord(row as CustomerDbRow));
  if (!missingDbObject(withMobile.error)) throw withMobile.error;
  const without = await client.from("customers").select(CUSTOMER_COLUMNS).order("name");
  if (without.error) throw without.error;
  return (without.data || []).map((row) => toCustomerRecord(row as CustomerDbRow));
}

/** The row written on save. The mobile is included only when it was read (or the form offered it): never a blank over a real one. */
export function customerPayload(customer: CustomerRecord, organizationId: string | null) {
  return {
    organization_id: organizationId,
    name: customer.name.trim(),
    contact_name: customer.contactName.trim() || null,
    email: customer.email.trim() || null,
    phone: customer.phone.trim() || null,
    address: customer.address.trim() || null,
    notes: customer.notes.trim() || null,
    ...(customer.mobile === undefined ? {} : { mobile: customer.mobile.trim() || null }),
    ...(customer.traceableDefault === undefined ? {} : { traceable_default: customer.traceableDefault }),
  };
}

/** The reads the traceable defaults need (an injected client keeps it testable). */
export type TraceableReader = {
  from: (table: "customers") => { select: (columns: string) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }> };
};

/**
 * Each customer's traceable default (migration 082) added to the records. Before 082 (a missing column) the records are returned as
 * they were, without it; any other failure is thrown.
 */
export async function withTraceableDefaults(client: TraceableReader, customers: CustomerRecord[]): Promise<CustomerRecord[]> {
  const { data, error } = await client.from("customers").select("id, traceable_default");
  if (error) {
    if (missingDbObject(error)) return customers;
    throw error;
  }
  const byId = new Map((data ?? []).map((row) => [String((row as { id: unknown }).id), Boolean((row as { traceable_default?: unknown }).traceable_default)]));
  return customers.map((customer) => (customer.id && byId.has(customer.id) ? { ...customer, traceableDefault: byId.get(customer.id) } : customer));
}

/** Throws when Supabase is unavailable so callers can show the demo-data banner. */
export async function fetchCustomers(): Promise<CustomerRecord[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const customers = await readCustomers(supabase as unknown as CustomerReader, await databaseHas073());
  return withTraceableDefaults(supabase as unknown as TraceableReader, customers);
}

/** The reads the archived customers need (an injected client keeps it testable). */
export type ArchivedCustomerReader = {
  from: (table: "record_archive_state") => { select: (columns: string) => { eq: (column: string, value: string) => { eq: (column: string, value: string) => { order: (column: string) => { range: (from: number, to: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> } } } } };
};

/**
 * The ids of the customers archived by hand (migration 100: record_archive_state, Archive on the Customers page), every row page by
 * page. Before 100 there are none (the table holds no customers' rows), so this reads an empty set.
 */
export async function readArchivedCustomerIds(client: ArchivedCustomerReader): Promise<Set<string>> {
  const { rows } = await fetchAll((from, to) => client.from("record_archive_state").select("record_id").eq("record_table", "customers").eq("state", "archived").order("record_id").range(from, to), { maxRows: Number.MAX_SAFE_INTEGER });
  return new Set(rows.map((row) => String(row.record_id)));
}

/** The customers a new document may pick: every saved customer that isn't archived. Pure. */
export function withoutArchived<C extends { id?: string }>(customers: C[], archived: ReadonlySet<string>): C[] {
  return customers.filter((customer) => !customer.id || !archived.has(customer.id));
}

/**
 * The customer pickers' list (new documents): saved customers less the archived ones. Fails closed: if the archive choices can't
 * be read this throws (the picker then offers no customer, says so and offers Retry), never the whole saved list.
 */
export async function fetchPickerCustomers(): Promise<CustomerRecord[]> {
  const customers = await fetchCustomers();
  return withoutArchived(customers, await readArchivedCustomerIds(supabase as unknown as ArchivedCustomerReader));
}

/** The picker's names: what `load` returns, or none and `failed` when it throws (fail closed: never a list it couldn't check). */
export async function loadPickerNames(load: () => Promise<CustomerRecord[]>): Promise<{ names: string[]; failed: boolean }> {
  try {
    return { names: (await load()).map((customer) => customer.name), failed: false };
  } catch (err) {
    console.error(err);
    return { names: [], failed: true };
  }
}

/** The picker's options: the names, with the document's own customer first when it isn't among them (an archived one stays shown). */
export function pickerOptions(names: string[], current: string): string[] {
  return current && !names.includes(current) ? [current, ...names] : names;
}

/** A customer shown in the Customers page and the pickers: a saved record, or a name that exists only on documents (`notSaved`). */
export type KnownCustomer = CustomerRecord & { notSaved?: true };

/** The Add customer form's starting values for a customer that has none yet: the name prefilled, the mobile offered once the database has it. */
export function newCustomerDraft(name = "", has073 = false): CustomerRecord {
  return { name, contactName: "", email: "", phone: "", address: "", notes: "", ...(has073 ? { mobile: "" } : {}) };
}

/** The tables that hold the customer as text. Admin and office read all of them (the same access as the customers table). */
const DOCUMENT_TABLES = ["rfqs", "quotes", "sales_orders", "invoices"] as const;

type NamePage = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
/** The reads the document names need (an injected client keeps it testable). */
export type DocumentNameReader = {
  from: (table: string) => { select: (columns: string) => { order: (column: string) => { range: (from: number, to: number) => NamePage } } };
};

/**
 * Saved customers first (as read), then each name found only on documents, once, marked `notSaved`, in name order. Names match as
 * findCustomer does: exact, ignoring case and surrounding spaces. Pure; writes nothing.
 */
export function mergeKnownCustomers(saved: CustomerRecord[], documentNames: Array<string | null | undefined>): KnownCustomer[] {
  const seen = new Set(saved.map((customer) => customer.name.trim().toLowerCase()));
  const extra = new Map<string, string>();
  for (const raw of documentNames) {
    const name = (raw || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || extra.has(key)) continue;
    extra.set(key, name);
  }
  const unsaved = [...extra.values()].sort((a, b) => a.localeCompare(b)).map((name): KnownCustomer => ({ name, contactName: "", email: "", phone: "", address: "", notes: "", notSaved: true }));
  return [...saved, ...unsaved];
}

/**
 * Customer names on RFQs, quotes, sales orders and invoices: every row, page by page past the API's 1,000-row cap (lib/fetch-all).
 * A table that can't be read adds nothing; it never fails the list. `truncated`: a table reached fetchAll's upper bound.
 */
export async function readDocumentCustomerNames(client: DocumentNameReader): Promise<{ names: string[]; truncated: boolean }> {
  const results = await Promise.all(DOCUMENT_TABLES.map(async (table) => {
    try {
      const { rows, truncated } = await fetchAll((from, to) => client.from(table).select("id, customer").order("id").range(from, to));
      return { names: rows.map((row) => String(row.customer ?? "")), truncated };
    } catch {
      return { names: [], truncated: false };
    }
  }));
  return { names: results.flatMap((result) => result.names), truncated: results.some((result) => result.truncated) };
}

/**
 * The Customers page's list: saved customers plus names that exist only on documents. Only that page reads the documents; every
 * customer picker keeps the saved list (fetchCustomers).
 */
export async function fetchKnownCustomers(): Promise<{ customers: KnownCustomer[]; documentNamesTruncated: boolean }> {
  const saved = await fetchCustomers();
  const { names, truncated } = await readDocumentCustomerNames(supabase as unknown as DocumentNameReader);
  return { customers: mergeKnownCustomers(saved, names), documentNamesTruncated: truncated };
}

export async function saveCustomer(customer: CustomerRecord): Promise<CustomerRecord> {
  if (!supabase) throw new Error("Supabase is not configured.");
  parseOrThrow(customerSchema, { name: customer.name, email: customer.email.trim(), phone: customer.phone, mobile: customer.mobile });
  const organizationId = await getCurrentOrganizationId();
  const payload = customerPayload(customer, organizationId);
  const columns = customer.mobile === undefined ? CUSTOMER_COLUMNS : CUSTOMER_COLUMNS_073;
  const query = customer.id
    ? supabase.from("customers").update(payload).eq("id", customer.id)
    : supabase.from("customers").insert(payload);
  const { data, error } = await query.select(columns).single();
  if (error) {
    if (customer.traceableDefault !== undefined && missingDbObject(error) && /traceable/i.test(error.message ?? "")) throw new ValidationError(TRACEABLE_NEEDS_UPDATE);
    if (customer.mobile !== undefined && missingDbObject(error)) throw new ValidationError(MOBILE_NEEDS_UPDATE);
    throw error;
  }
  return toCustomerRecord(data as unknown as CustomerDbRow);
}

/** Finds a customer by exact name, ignoring case and surrounding spaces. No fuzzy or fallback matching. */
export function findCustomer(customers: CustomerRecord[], name: string) {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return customers.find((customer) => customer.name.trim().toLowerCase() === wanted);
}

/** Customer name followed by the lines of their address, ready for the Quote To / Invoice To / Deliver To blocks. */
export function customerAddressLines(name: string, customer?: CustomerRecord) {
  const address = (customer?.address || "").split(/\r?\n|,\s*/).map((line) => line.trim()).filter(Boolean);
  return [customer?.name || name, ...address].filter(Boolean);
}

/** Loads the signed-in organisation's customers (demo list only in demo mode when the load fails). */
async function customersForLookup(): Promise<CustomerRecord[]> {
  try {
    return await fetchCustomers();
  } catch (err) {
    console.error(err);
    return DEMO_MODE ? loadDemoCustomers() : [];
  }
}

/** Looks the customer up by exact name (case-insensitive). Never throws; undefined when not found. */
export async function resolveCustomer(name: string): Promise<CustomerRecord | undefined> {
  return findCustomer(await customersForLookup(), name);
}

/** Returns the customer's printable address lines. Never throws; with no match it is just the name as typed. */
export async function resolveCustomerAddress(name: string): Promise<string[]> {
  return customerAddressLines(name, await resolveCustomer(name));
}
