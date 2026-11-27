// Inputs are paged attendance and labour reads. Hours require complete source rows.
import { describe, expect, it } from "vitest";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";
import { loadTimeData, type Client } from "@/lib/time-data";

const opts = { userId: "person", from: new Date("2026-10-19"), to: new Date("2026-10-26") };

function clientWithRows(eventCount: number, sessionCount: number, legacy = false) {
  const pages: { table: string; from: number; order: string[]; user: string | null }[] = [];
  const results = {
    attendance_events: Array.from({ length: eventCount }, (_, id) => ({ id: `event-${id}` })),
    operator_sessions: Array.from({ length: sessionCount }, (_, id) => ({ id: `session-${id}`, job_id: "job" })),
  };
  const client = {
    from(table: keyof typeof results) {
      let user: string | null = null;
      let columns = "";
      const order: string[] = [];
      const query = {
        select(value: string) { columns = value; return query; },
        eq(key: string, value: string) { if (key === "user_id") user = value; return query; },
        gte() { return query; },
        lt() { return query; },
        lte() { return Promise.resolve({ data: [], error: null }); },
        in() { return Promise.resolve({ data: [], error: null }); },
        or() { return query; },
        order(key: string) { order.push(key); return query; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        async range(from: number, to: number) {
          pages.push({ table, from, order, user });
          if (legacy && columns.includes("end_reason")) return { data: null, error: { code: "42703", message: "Missing end_reason" } };
          return { data: results[table].slice(from, Math.min(to + 1, from + 1000)), error: null };
        },
      };
      return query;
    },
  } as unknown as Client;
  return { client, pages };
}

describe("timesheet source pagination", () => {
  it("loads both sources past the server cap, using stable order and retaining the user filter", async () => {
    const { client, pages } = clientWithRows(1200, 1050, true);
    const data = await loadTimeData(client, opts);
    expect(data.events).toHaveLength(1200);
    expect(data.labour).toHaveLength(1050);
    expect(pages).toContainEqual({ table: "attendance_events", from: 1000, order: ["at", "id"], user: "person" });
    expect(pages).toContainEqual({ table: "operator_sessions", from: 1000, order: ["started_at", "id"], user: "person" });
    expect(data.events.at(-1)?.id).toBe("event-1199");
    expect(data.labour.at(-1)?.id).toBe("session-1049");
  });

  it.each([[MAX_LIST_ROWS + 1, 1], [1, MAX_LIST_ROWS + 1]])("refuses to return partial totals at %i events and %i sessions", async (events, labour) => {
    const { client } = clientWithRows(events, labour);
    await expect(loadTimeData(client, opts)).rejects.toMatchObject({ truncated: true, message: expect.stringContaining("truncated") });
  });
});
