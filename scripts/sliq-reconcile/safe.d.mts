/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const fingerprint: (text: any) => string;
export function safeRef(value: any, prefix?: string): string;
export function safeFile(value: any): string;
export const safeText: (value: any) => any;
export const VOCAB: Set<string>;
export function safeWord(value: any): any;
export const stripQuoted: (message: any) => string;
export function scrub(text: any): string;
export class SafeError extends Error {}
