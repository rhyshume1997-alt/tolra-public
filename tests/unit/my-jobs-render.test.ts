/**
 * The workshop "My jobs" cards rendered (react-dom/server): every action is a link to the job on the Job Board and nothing else, the
 * notes strip shows the specification, each light carries its word, and without access to the Job Board there are no actions at all.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MyJobs } from "@/components/workshop/my-jobs";
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
    for (const word of ["Running", "Not started", "Overdue", "No due date"]) expect(html).toContain(`>${word}<`);
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
