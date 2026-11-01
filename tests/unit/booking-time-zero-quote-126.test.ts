/**
 * 126: the two database refusals reach people as their own sentence. Removing a booking with recorded machine time (schedule page and
 * the job's Machines dialog, both through deleteBooking or set_job_machines) and accepting a quote for £0.00 (accept_quote).
 * The database side is proved on the local stand-in (supabase/verify/booking_time_zero_quote_126.sql and the 126 proof scripts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import { friendlyError } from "@/lib/friendly-error";
import { deleteBooking } from "@/lib/machine-schedule";
import { quoteAcceptBlock } from "@/lib/quote-status";

const RECORDED = "This booking has recorded machine time; finish or release it instead.";

describe("126: a booking with recorded machine time", () => {
  beforeEach(() => rpc.mockReset());

  it("deleteBooking keeps the hint, so the schedule page and the Machines dialog show the database's sentence", async () => {
    rpc.mockResolvedValue({ error: { code: "23514", hint: "booking_has_runs", message: RECORDED } });
    const err = await deleteBooking("b-1").catch((e: unknown) => e);
    expect(rpc).toHaveBeenCalledWith("delete_machine_booking", { p_id: "b-1" });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(RECORDED);
    expect(friendlyError(err, "Could not remove booking")).toBe(RECORDED);
  });

  it("set_job_machines' refusal (the same error, straight from the RPC) shows the same sentence", () => {
    expect(friendlyError({ code: "23514", hint: "booking_has_runs", message: RECORDED }, "Couldn't save the machines.")).toBe(RECORDED);
  });

  it("the other delete refusals read as before", async () => {
    rpc.mockResolvedValue({ error: { code: "42501", hint: null, message: "Only admin, office or workshop staff can remove bookings" } });
    const err = await deleteBooking("b-2").catch((e: unknown) => e);
    expect(friendlyError(err, "Could not remove booking")).toBe("Could not remove booking");
    rpc.mockResolvedValue({ error: null });
    await expect(deleteBooking("b-3")).resolves.toBeUndefined();
  });
});

describe("126: a quote for £0.00", () => {
  it("accept_quote's refusal is the app's own sentence, shown as the database wrote it", () => {
    const sentence = quoteAcceptBlock(0);
    expect(sentence).toBe("A quote for £0.00 can't be accepted. Add a price or decline it.");
    expect(friendlyError({ code: "22023", hint: "quote_zero_value", message: sentence })).toBe(sentence);
  });
});
