import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";

import { AUDIT_ACTIONS, AUDIT_TABLES } from "@/lib/audit-contract";
import { clientIp, forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

// The shared contract (lib/audit-contract.ts); the database enforces the same rule by role (migration 023).
const MAX_JSON_BYTES = 16 * 1024;

const jsonValue = z.unknown().refine((value) => {
  if (value === undefined) return true;
  try {
    return JSON.stringify(value).length <= MAX_JSON_BYTES;
  } catch {
    return false;
  }
});

const auditSchema = z.object({
  // lib/audit.ts callers still send "organization_settings.update"; normalise it to the upper-case form.
  action: z
    .string()
    .transform((value) => (value === "organization_settings.update" ? "ORGANIZATION_SETTINGS_UPDATE" : value))
    .pipe(z.string().regex(/^[A-Z_]{2,64}$/))
    .pipe(z.enum(AUDIT_ACTIONS)),
  entityTable: z.enum(AUDIT_TABLES),
  entityId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(128)).optional(),
  oldData: jsonValue.optional(),
  newData: jsonValue.optional(),
  metadata: jsonValue.optional(),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const auth = await requireProfile();
  if (isErrorResponse(auth)) return auth;

  const json = await readJson(request, 64 * 1024);
  if (!json.ok) return json.response;

  const parsed = auditSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { action, entityTable, entityId, oldData, newData, metadata } = parsed.data;

  const { error } = await auth.supabase.rpc("write_audit", {
    p_action: action,
    p_entity_table: entityTable,
    p_entity_id: entityId ?? null,
    p_old: oldData ?? null,
    p_new: newData ?? null,
    p_metadata: metadata ?? {},
    p_ip: clientIp(request),
    p_user_agent: (await headers()).get("user-agent")?.slice(0, 256) ?? null,
  });

  if (error) {
    console.error("[audit] write_audit failed", error.code);
    if (error.code === "42501") return jsonError("Forbidden", 403);
    return jsonError("Could not record audit event", 500);
  }

  return NextResponse.json({ ok: true });
}
