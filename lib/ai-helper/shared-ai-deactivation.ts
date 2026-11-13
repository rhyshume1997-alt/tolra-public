/**
 * The one switch for Tolra-provided (shared platform key) AI. PM ruling C4: no shared Tolra key, so this is false and the shared mode is off.
 * Inputs: none. Outputs: one boolean read by the AI runner (refuses shared mode before reserving and again before any key read), the AI setup
 * card (Tolra choice hidden) and the AI page copy. The Tolra routes, tables, RPCs and dormant code are kept as they are.
 * Reversal: set to true (and roll back migration 154). Must not be changed to read env, a company setting or the database.
 */
export const SHARED_TOLRA_AI_ACTIVE = false;
