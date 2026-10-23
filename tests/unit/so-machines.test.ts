/** Machines on sales-order lines (migration 043): summing per machine for the job, grouping by line after a rebuild, and the chip text. */
import { describe, expect, it } from "vitest";

import { type OrderPlanRow, describeMachines, formatHours, groupPlanByLine, sumMachineHours, totalHours } from "@/lib/so-machines";

const row = (machine_id: string, estimated_hours: number, line_key: number, position = 0, sales_order_line_id: string | null = `L${line_key}`): OrderPlanRow =>
  ({ machine_id, estimated_hours, line_key, position, sales_order_line_id });

describe("sumMachineHours", () => {
  it("makes one row per machine, summed across lines, in order of first appearance", () => {
    const plan = [row("lathe", 2, 1, 0), row("mill", 4, 0, 0), row("lathe", 1, 0, 1), row("mill", 1.5, 1, 1)];
    expect(sumMachineHours(plan)).toEqual([{ machine_id: "mill", hours: 5.5 }, { machine_id: "lathe", hours: 3 }]);
  });

  it("sums past 1000 (the function refuses that when the plan is set; the dialog warns) and rounds to the penny of an hour", () => {
    expect(sumMachineHours([row("mill", 900, 0), row("mill", 400, 1)])).toEqual([{ machine_id: "mill", hours: 1300 }]);
    expect(sumMachineHours([row("mill", 0.1, 0), row("mill", 0.2, 1)])).toEqual([{ machine_id: "mill", hours: 0.3 }]);
    expect(sumMachineHours([])).toEqual([]);
  });
});

describe("groupPlanByLine", () => {
  const lines = [{ id: "A", position: 0 }, { id: "B", position: 1 }];

  it("attaches rows to the line they name", () => {
    const { byLine, detached } = groupPlanByLine(lines, [row("mill", 4, 0, 0, "A"), row("lathe", 1, 1, 0, "B"), row("mill", 2, 1, 1, "B")]);
    expect([...byLine.keys()]).toEqual(["A", "B"]);
    expect(byLine.get("A")!.map((r) => r.machine_id)).toEqual(["mill"]);
    expect(byLine.get("B")!.map((r) => r.machine_id)).toEqual(["lathe", "mill"]);
    expect(detached).toEqual([]);
  });

  it("after a rebuild, a detached row goes to the line at its position; a row with no such line is left over", () => {
    const { byLine, detached } = groupPlanByLine([{ id: "S", position: 0 }], [row("mill", 4, 0, 0, null), row("lathe", 1, 1, 0, null), row("saw", 1, 0, 1, "gone")]);
    expect(byLine.get("S")!.map((r) => r.machine_id)).toEqual(["mill", "saw"]);
    expect(detached.map((r) => [r.machine_id, r.line_key])).toEqual([["lathe", 1]]);
  });
});

describe("chip text", () => {
  it("prints hours without trailing zeros and the plan in one line", () => {
    expect(formatHours(6)).toBe("6 h");
    expect(formatHours(2.5)).toBe("2.5 h");
    expect(formatHours(0.25)).toBe("0.25 h");
    expect(formatHours(Number.NaN)).toBe("0 h");
    expect(describeMachines([{ name: "Mill", hours: 6 }, { name: "Lathe", hours: 2.5 }])).toBe("Mill 6 h, Lathe 2.5 h");
    expect(totalHours([{ hours: 5.5 }, { hours: 2 }])).toBe(7.5);
  });
});
