/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export class ParseError extends Error {}
export function parseCsv(text: string): { headers: string[]; rows: string[][] };
export function parseMoneyPence(raw: any): number | null;
export function parseQuantityMilli(raw: any): number | null;
export function parsePercentCenti(raw: any): number | null;
export function parseDate(raw: any, format: string): string | null;
export function penceToPounds(p: number | null | undefined): string | null;
export function poundsString(p: number | null | undefined): string;
