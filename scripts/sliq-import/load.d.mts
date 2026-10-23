/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export function loadFolder(folder: string, profile: any, opts?: any): any;
export function readWorkbooks(folder: string): Promise<any[]>;
export function sha256Hex(bytes: any): string;
