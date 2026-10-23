/**
 * Demo mode shows built-in sample records when the database is empty or
 * unreachable. It must never be on in production: real tenants would see
 * another company's data and "edit" records that are never saved.
 * Turn on only for local demos with NEXT_PUBLIC_DEMO_MODE=true.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
