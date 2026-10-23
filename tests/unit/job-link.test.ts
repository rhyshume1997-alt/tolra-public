import { describe, expect, it } from "vitest";

import { jobHref, linkedJobId } from "@/lib/job-link";

const jobs = [
  { id: "id-1", job_no: "J-0101" },
  { id: "id-2", job_no: "J-0102" },
];

describe("jobHref", () => {
  it("names the job by id, the param the Job Board opens", () => {
    expect(jobHref({ id: "id-1", job_no: "J-0101" })).toBe("/jobs?job=id-1");
  });

  it("falls back to the job number when no id is to hand", () => {
    expect(jobHref({ id: null, job_no: "J-0101" })).toBe("/jobs?created=J-0101");
    expect(jobHref({ job_no: "J 1&2" })).toBe("/jobs?created=J%201%262");
  });
});

describe("linkedJobId", () => {
  it("?job=<id> picks that job", () => {
    expect(linkedJobId("?job=id-2", jobs)).toBe("id-2");
  });

  it("?created=<job_no> picks the job with that number among those loaded", () => {
    expect(linkedJobId("?created=J-0102", jobs)).toBe("id-2");
    expect(linkedJobId("?created=%20J-0101%20", jobs)).toBe("id-1");
  });

  it("?job= wins over ?created=", () => {
    expect(linkedJobId("?job=id-1&created=J-0102", jobs)).toBe("id-1");
  });

  it("a job the user cannot see (not loaded), or no param, picks nothing", () => {
    expect(linkedJobId("?job=other", jobs)).toBeNull();
    expect(linkedJobId("?created=J-9999", jobs)).toBeNull();
    expect(linkedJobId("", jobs)).toBeNull();
  });

  it("an unknown ?job= falls through to ?created=", () => {
    expect(linkedJobId("?job=other&created=J-0102", jobs)).toBe("id-2");
  });
});
