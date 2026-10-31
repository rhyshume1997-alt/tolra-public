/**
 * The workshop "My jobs" cards rendered (react-dom/server): every action is a link to the job on the Job Board and nothing else, the
 * notes strip shows the specification, each light carries its word, and without access to the Job Board there are no actions at all.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MyJobs } from "@/components/workshop/my-jobs";
import type { OpenProblems } from "@/lib/job-problems";
import type { MyJob } from "@/lib/my-jobs";

const running: MyJob = { id: "r1", jobNo: "J-2409", customer: "Severn Valve Co", description: "Valve body", quantity: 4, stage: "machining", status: "running", due: "2026-10-26", dueLight: "overdue", notes: "Deburr all edges" };
const todo: MyJob = { id: "t1", jobNo: "J-2427", customer: "Aldridge Hydraulics Ltd", description: "Gland nut", quantity: 50, stage: "setup", status: "not_started", due: null, dueLight: "no_due_date", notes: "" };
const render = (role: string, canOpenJobs = true) => renderToStaticMarkup(createElement(MyJobs, { jobs: [running, todo], role, canOpenJobs }));
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("MyJobs render", () => {
  it("each action only opens that job on the Job Board; Pause on the running job only", () => {
    const html = render("workshop");
    expect(hrefs(html)).toEqual(["/jobs?job=r1", "/jobs?job=r1", "/jobs?job=t1"]);
    expect(html).toContain("Finish on the Job Board");
    expect(html).toContain("Start on the Job Board");
    expect(html.match(/data-testid="my-job-pause"/g)).toHaveLength(1);
  });
  it("the specification in the notes strip; status and due light as words", () => {
    const html = render("workshop");
    expect(html.match(/data-testid="my-job-notes"/g)).toHaveLength(1);
    expect(html).toContain("Deburr all edges");
    for (const word of ["Running", "Not started", "Late", "No due date"]) expect(html).toContain(`>${word}<`);
    expect(html).toContain("Severn Valve Co · Valve body · qty 4");
  });
  it("a viewer gets View only; without the Job Board, no actions", () => {
    const viewer = render("viewer");
    expect(viewer.match(/View on the Job Board<\/a>/g)).toHaveLength(2);
    expect(viewer).not.toContain("Start on the Job Board");
    expect(viewer).not.toContain("my-job-pause");
    const closed = render("workshop", false);
    expect(hrefs(closed)).toEqual([]);
    expect(closed).toContain("J-2409");
  });
});

// Migration 117: Open drawing and Problem on each card.
const withProblems = (role: string, initialProblems: OpenProblems) => renderToStaticMarkup(createElement(MyJobs, { jobs: [running, todo], role, canOpenJobs: true, initialProblems }));
const reported: OpenProblems = { available: true, problems: [{ id: "p1", job_id: "r1", reason: "material", note: "Wrong grade", reported_by: "u9", reported_at: "2026-10-14T09:00:00Z" }] };

describe("MyJobs: Open drawing and Problem", () => {
  it("Open drawing is on every card for every role, at least 48 px tall, and is a button (not a link to the Job Board)", () => {
    for (const role of ["workshop", "viewer", "office"]) {
      const html = render(role);
      expect(html.match(/data-testid="my-job-drawing"/g), role).toHaveLength(2);
      expect(html).toContain("Open drawing");
      expect(html).toMatch(/class="[^"]*min-h-12[^"]*"[^>]*data-testid="my-job-drawing"|data-testid="my-job-drawing"[^>]*class="[^"]*min-h-12/);
    }
    expect(hrefs(render("workshop"))).toEqual(["/jobs?job=r1", "/jobs?job=r1", "/jobs?job=t1"]);
  });

  it("fail closed: no Problem button or flag until the database says it has 117 (missing, or not known)", () => {
    for (const available of [null, false]) {
      const html = withProblems("workshop", { available, problems: reported.problems });
      expect(html, String(available)).not.toContain('data-testid="my-job-problem"');
      expect(html).toContain("Open drawing");
    }
    expect(render("workshop")).not.toContain('data-testid="my-job-problem"');
  });

  it("with 117: workshop, office and admin get a 48 px Problem button on each card; a viewer gets none", () => {
    for (const role of ["workshop", "office", "admin"]) {
      const html = withProblems(role, { available: true, problems: [] });
      expect(html.match(/data-testid="my-job-problem"/g), role).toHaveLength(2);
      expect(html).toMatch(/class="[^"]*min-h-12[^"]*"[^>]*data-testid="my-job-problem"|data-testid="my-job-problem"[^>]*class="[^"]*min-h-12/);
    }
    expect(withProblems("viewer", { available: true, problems: [] })).not.toContain('data-testid="my-job-problem"');
  });

  it("a job with an open problem carries a Problem tag and a flag in words, on that job only; Start and Pause still there", () => {
    const html = withProblems("workshop", reported);
    expect(html.match(/data-testid="my-job-problem-tag"/g)).toHaveLength(1);
    expect(html).toContain(">Problem<");
    expect(html.match(/data-testid="my-job-problem-flag"/g)).toHaveLength(1);
    expect(html).toContain("Problem reported: Material. Waiting for the office.");
    expect(html).toContain("Finish on the Job Board");
    expect(html).toContain("Start on the Job Board");
    expect(html.match(/data-testid="my-job-pause"/g)).toHaveLength(1);
    // A viewer sees the flag (it is information) and gets no button.
    const viewer = withProblems("viewer", reported);
    expect(viewer.match(/data-testid="my-job-problem-flag"/g)).toHaveLength(1);
    expect(viewer).not.toContain('data-testid="my-job-problem"');
  });

  it("an open problem shows a bold headline with the reason, and marks that card only; a card without one has neither", () => {
    const html = withProblems("workshop", reported);
    expect(html).toMatch(/data-testid="my-job-problem-headline" class="[^"]*font-bold[^"]*"[^>]*>(<svg[^>]*>.*?<\/svg>)?Problem: Material</);
    expect(html.match(/data-problem="open"/g)).toHaveLength(1);
    const cards = html.split("<article").slice(1);
    expect(cards).toHaveLength(2);
    const flagged = cards.find((card) => card.includes('data-job-id="r1"')) ?? "";
    const plain = cards.find((card) => card.includes('data-job-id="t1"')) ?? "";
    expect(flagged).toContain('data-problem="open"');
    expect(flagged).toContain("border-[#DC2626]");
    expect(plain).not.toContain("data-problem");
    expect(plain).not.toContain("my-job-problem-headline");
    expect(plain).not.toContain("border-[#DC2626]");
    expect(plain).toContain("border-line");
    // No open problem anywhere: no card is marked.
    expect(withProblems("workshop", { available: true, problems: [] })).not.toContain("data-problem");
  });
});
