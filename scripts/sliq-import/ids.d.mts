/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function legacyId(organizationId: string, kind: string, identity: string): number;
export function paymentIdentity(a: string, b: string | null, c: number, d: number): string;
export function normNumber(s: any): string;
export function normaliseName(name: any): string;
