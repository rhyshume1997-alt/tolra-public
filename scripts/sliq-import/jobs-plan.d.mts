/* eslint-disable @typescript-eslint/no-explicit-any */
// Loose types for the plain-JavaScript modules, so the tests that import them type-check.
export const JOBS_REPORT_FORMAT: string;
export function analyseJobs(loaded: any, jobsLoaded: any, opts: any): { report: any; plan: any };
export function jobsVerificationCsv(jobsReport: any): string;
export function wipVerificationCsv(jobsReport: any): string;
export function renderJobsMarkdown(jobsReport: any): string;
export function jobsKnownNumbers(jobsLoaded: any): string[];
export function mergeJobsIntoReport(report: any, jobsReport: any): any;
