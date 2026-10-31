"use client";

import { CONFIRMED_USER_REUSE_MS, confirmedUser } from "@/lib/confirmed-user";
import { missingDbObject } from "@/lib/db-features";
import { assertPageCompany } from "@/lib/page-company";
import { supabase } from "@/lib/supabase";
import { isSupplierStatus, type SupplierStatus } from "@/lib/supplier-status";
import { ValidationError } from "@/lib/validation/schemas";

export type SupplierRecord = {
  id?: string;
  name: string;
  email: string;
  contactName?: string;
  phone?: string;
  notes?: string;
  onTimeRate?: number;
  status?: string;
  /** ISO 9001 8.4 status (migration 082). undefined: not read (the database has no such column yet), so it is never sent on save. */
  supplierStatus?: SupplierStatus;
};

type SupplierDbRow = {
  id?: string;
  name: string;
  email: string | null;
  contact_name?: string | null;
  phone?: string | null;
  notes?: string | null;
  on_time_rate?: number | null;
  reliability_status?: string | null;
  supplier_status?: string | null;
};

function toSupplierRecord(row: SupplierDbRow): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email || "",
    contactName: row.contact_name || "",
    phone: row.phone || "",
    notes: row.notes || "",
    onTimeRate: Number(row.on_time_rate ?? 0),
    status: row.reliability_status || "Watch",
    ...(isSupplierStatus(row.supplier_status) ? { supplierStatus: row.supplier_status } : {}),
  };
}

const SUPPLIER_COLUMNS = "id, name, email, contact_name, phone, notes, on_time_rate, reliability_status";
/** With migration 082's status. Before 082 a read with it fails as a missing column, and the suppliers are read without it. */
const SUPPLIER_COLUMNS_082 = `${SUPPLIER_COLUMNS}, supplier_status`;

export const SUPPLIER_STATUS_NEEDS_UPDATE = "The supplier status can't be saved yet: the database update that adds it hasn't been applied. Nothing was changed.";

function normalizeSupplierStatus(status: string) {
  return status.trim().toLowerCase().replace(/\s+/g, "_");
}

export async function getCurrentOrganizationId() {
  return (await getCurrentUserAndOrganization()).organizationId;
}

/**
 * The signed-in user (confirmed by the auth server) and the company of THIS sign-in session, from the same two requests
 * getCurrentOrganizationId makes: a caller that needs both (lib/org-settings) does not ask the auth server a second time.
 */
export async function getCurrentUserAndOrganization(): Promise<{ userId: string; organizationId: string }> {
  if (!supabase) throw new Error("Supabase is not configured.");

  // The auth server's confirmation, shared with the rest of this page load when it is seconds old (lib/confirmed-user.ts): the
  // company below, and every read or write made with it, is still decided by the database (RLS, 017's session check).
  const { data: userData, error: userError } = await confirmedUser({ maxAgeMs: CONFIRMED_USER_REUSE_MS });
  if (userError || !userData.user) throw new Error("You must be signed in.");

  // The company of THIS sign-in session, as the database sees it (not the profile's copy).
  const { data: organizationId, error: organizationError } = await supabase.rpc("current_user_organization_id");
  if (organizationError || typeof organizationId !== "string") throw new Error("User profile organization was not found.");
  // S5: another tab may have switched the session to another company since this page opened: refuse rather than file it there.
  assertPageCompany(organizationId);
  return { userId: userData.user.id, organizationId };
}

export async function fetchSuppliersFromSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");

  const withStatus = await supabase.from("suppliers").select(SUPPLIER_COLUMNS_082).order("name");
  if (!withStatus.error) return (withStatus.data || []).map((row) => toSupplierRecord(row as SupplierDbRow));
  if (!missingDbObject(withStatus.error)) throw withStatus.error;
  const { data, error } = await supabase.from("suppliers").select(SUPPLIER_COLUMNS).order("name");
  if (error) throw error;
  return (data || []).map((row) => toSupplierRecord(row as SupplierDbRow));
}

export async function saveSupplierToSupabase(supplier: SupplierRecord) {
  if (!supabase) throw new Error("Supabase is not configured.");

  const organizationId = await getCurrentOrganizationId();
  const payload = {
    organization_id: organizationId,
    name: supplier.name,
    email: supplier.email,
    contact_name: supplier.contactName ?? null,
    phone: supplier.phone ?? null,
    notes: supplier.notes ?? null,
    // Only touch reliability fields when the caller supplies them.
    ...(supplier.onTimeRate !== undefined ? { on_time_rate: supplier.onTimeRate } : {}),
    ...(supplier.status !== undefined ? { reliability_status: normalizeSupplierStatus(supplier.status) } : {}),
    ...(supplier.supplierStatus !== undefined ? { supplier_status: supplier.supplierStatus } : {}),
  };

  const query = supplier.id
    ? supabase.from("suppliers").update(payload).eq("id", supplier.id)
    : supabase.from("suppliers").insert(payload);

  const { data, error } = await query.select(supplier.supplierStatus !== undefined ? SUPPLIER_COLUMNS_082 : SUPPLIER_COLUMNS).single();
  if (error) {
    if (supplier.supplierStatus !== undefined && missingDbObject(error)) throw new ValidationError(SUPPLIER_STATUS_NEEDS_UPDATE);
    throw error;
  }
  return toSupplierRecord(data as unknown as SupplierDbRow);
}

/** Deletes by id only: never by name, which could remove several suppliers. */
export async function deleteSupplierFromSupabase(supplier: SupplierRecord) {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!supplier.id) throw new Error("This supplier hasn't been saved yet, so it can't be deleted.");

  const { error } = await supabase.from("suppliers").delete().eq("id", supplier.id);
  if (error) throw error;
}
