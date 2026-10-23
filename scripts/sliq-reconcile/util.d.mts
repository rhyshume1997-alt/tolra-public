/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const sum: (xs: number[]) => number;
export const fingerprint: (text: any) => string;
export const nameRef: (name: any) => string;
export function cmpVal(ctx: any, o: any): "equal" | "different" | "unverified";
