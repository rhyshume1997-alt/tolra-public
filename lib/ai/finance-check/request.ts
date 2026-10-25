import { z } from "zod";

import { FINANCE_CHECK_KINDS, SUGGESTION_CODES } from "@/lib/ai/finance-check/check";

/** Roles that may run the check: the same roles the issue functions accept (spec section 2). Workshop and viewers never. */
export const FINANCE_CHECK_ROLES = ["admin", "office"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const checkRequestSchema = z.object({ kind: z.enum(FINANCE_CHECK_KINDS), id: z.string().regex(UUID) }).strict();

export const decisionRequestSchema = z.object({
  kind: z.enum(FINANCE_CHECK_KINDS),
  id: z.string().regex(UUID),
  suggestionId: z.string().regex(/^[a-z_]+:[A-Za-z0-9:_-]{1,100}$/),
  code: z.enum(SUGGESTION_CODES),
  decision: z.enum(["accepted", "rejected"]),
}).strict().refine((body) => body.suggestionId.startsWith(`${body.code}:`), { message: "suggestion id and code disagree" });
