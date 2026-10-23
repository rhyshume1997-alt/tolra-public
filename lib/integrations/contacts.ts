// The customer on a Tolra document to the provider's contact (G22): matched by exact name, or created; two matches is a problem, never a
// guess. Pure: the provider is asked for every contact it holds under that name (archived included) and this decides.

import type { ContactCandidate, ContactDecision } from "@/lib/integrations/types";

/**
 * - exactly one contact with exactly this name (spaces at the ends ignored) and it is active: link it;
 * - two or more with exactly this name: a problem (an admin chooses);
 * - exactly one and it is archived: a problem (Xero won't take a document for it; an admin decides);
 * - none with exactly this name, but one that differs only in capitals: a problem (Xero treats names alike regardless of case, so
 *   creating would clash, and linking would be a guess);
 * - none at all: create it.
 */
export function decideContact(customer: string, candidates: ContactCandidate[]): ContactDecision {
  const name = customer.trim();
  if (!name) return { kind: "problem", reason: "The document has no customer name." };
  const exact = candidates.filter((c) => c.name.trim() === name);
  if (exact.length >= 2) return { kind: "problem", reason: `${exact.length} contacts in Xero are called "${name}": choose one.` };
  if (exact.length === 1) {
    return exact[0].archived
      ? { kind: "problem", reason: `The Xero contact "${name}" is archived: restore it in Xero or choose another.` }
      : { kind: "link", id: exact[0].id };
  }
  const similar = candidates.filter((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (similar.length) return { kind: "problem", reason: `Xero has "${similar[0].name.trim()}", spelt differently from "${name}": choose the contact.` };
  return { kind: "create" };
}
