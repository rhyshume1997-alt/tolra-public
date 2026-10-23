/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const NOT_COLLECTIBLE: Set<string>;
export const VOID_FAMILY: Set<string>;
export function lifecycle(status: any): "paid" | "closed" | "collectible";
export function statusOf(status: any): string;
export function buildTarget(snapshot: any): any;
