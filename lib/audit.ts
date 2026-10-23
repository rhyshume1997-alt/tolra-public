"use client";

import type { AuditAction, AuditTable } from "@/lib/audit-contract";

type AuditPayload = {
  /** "organization_settings.update" is the older spelling the API still accepts. */
  action: AuditAction | "organization_settings.update";
  entityTable: AuditTable;
  entityId?: string | number;
  oldData?: unknown;
  newData?: unknown;
  metadata?: Record<string, unknown>;
};

const MAX_BODY_BYTES = 16 * 1024;

function size(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Infinity;
  }
}

/** Replaces oversized snapshots with a marker so the request body stays under 16KB. */
function truncate(value: unknown) {
  return value === undefined || size(value) <= 4096 ? value : { truncated: true };
}

export async function auditEvent(payload: AuditPayload) {
  try {
    let body = { ...payload, oldData: truncate(payload.oldData), newData: truncate(payload.newData) };
    if (size(body) > MAX_BODY_BYTES) body = { ...body, oldData: { truncated: true }, newData: { truncated: true }, metadata: { truncated: true } };
    if (size(body) > MAX_BODY_BYTES) return;
    const res = await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!res.ok) console.error(`Audit request failed (${res.status})`);
  } catch (err) {
    console.error("Audit request failed", err);
  }
}
