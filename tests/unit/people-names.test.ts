import { describe, expect, it } from "vitest";

import { actorLabel } from "@/lib/activity";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { peopleMap, personName, withUsernames } from "@/lib/people";

describe("one name rule for every surface: display name, then username, then —", () => {
  it("never shows an e-mail address", () => {
    const people = withUsernames(peopleMap([{ user_id: "a", display_name: null }, { user_id: "b", display_name: "b@x.test" }]), [{ user_id: "a", full_name: null, username: "dsmith" }, { user_id: "b", full_name: "b@x.test", username: "b@x.test" }]);
    expect(personName(people, "a")).toBe("dsmith");
    expect(personName(people, "b")).toBe("—");
    expect(Object.values(people).join(" ")).not.toContain("@");
  });
  it("company_people names win; an admin's usernames fill only the gaps", () => {
    const people = peopleMap([{ user_id: "a", display_name: "Dave" }, { user_id: "b", display_name: null }]);
    const merged = withUsernames(people, [{ user_id: "a", full_name: "Dave", username: "dave1" }, { user_id: "b", full_name: "", username: "jones", email: "jo@x.test" }, { user_id: "c", full_name: null, username: null }]);
    expect(merged).toEqual({ a: "Dave", b: "jones" });
  });
  it("names an activity actor by id (with the username fallback), else the trail's usable name, else —", () => {
    const people = { u1: "jones" };
    expect(actorLabel({ actor_name: "Dave", actor_user_id: "u1" }, people)).toBe("jones");
    expect(actorLabel({ actor_name: "Dave", actor_user_id: "nobody" }, people)).toBe("Dave");
    expect(actorLabel({ actor_name: null, actor_user_id: "u1" }, people)).toBe("jones");
    expect(actorLabel({ actor_name: "ops@x.test", actor_user_id: "nobody" }, people)).toBe("—");
  });
  it("loads company_people for everyone, and org_members only for an admin", async () => {
    const calls: string[] = [];
    const client = { rpc: async (fn: string) => { calls.push(fn); return fn === "company_people" ? { data: [{ user_id: "b", display_name: null }], error: null } : { data: [{ user_id: "b", full_name: null, username: "jones" }], error: null }; } };
    expect(await loadCompanyPeople(client)).toEqual({ b: null });
    expect(calls).toEqual(["company_people"]);
    expect(await loadCompanyPeople(client, { usernames: true })).toEqual({ b: "jones" });
    expect(canReadUsernames({ role: "office", secondary_role: "admin" })).toBe(true);
    expect(canReadUsernames({ role: "workshop" })).toBe(false);
    expect(await loadCompanyPeople({ rpc: async () => ({ data: null, error: { message: "offline" } }) })).toBeNull();
  });
});
