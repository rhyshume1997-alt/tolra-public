/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function neutraliseCsvText(text: any): string;
export function csvField(value: any): string;
export function toCsv(columns: string[], rows: any[]): string;
