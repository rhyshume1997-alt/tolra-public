import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({ select: () => ({ maybeSingle }) }) } }));

import { CompanyProfileLoadError, CompanyProfileMissingError, requireCompanyProfile, resetCompanyProfile } from "@/lib/company";

const row = { organization_id: null, company_profile: { documentName: "Marpet Ltd", addressLines: ["1 Street"], vatRegistered: false } };

describe("company profile load retry", () => {
  beforeEach(() => {
    resetCompanyProfile();
    maybeSingle.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries once when the first load fails", async () => {
    maybeSingle.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ data: row, error: null });
    expect((await requireCompanyProfile()).documentName).toBe("Marpet Ltd");
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("throws the load error after two failures and does not cache the failure", async () => {
    maybeSingle.mockRejectedValue(new Error("network"));
    await expect(requireCompanyProfile()).rejects.toThrow(CompanyProfileLoadError);
    await expect(requireCompanyProfile()).rejects.toThrow("Couldn't load company details. Try again.");
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({ data: row, error: null });
    expect((await requireCompanyProfile()).documentName).toBe("Marpet Ltd");
  });

  it("still throws CompanyProfileMissingError for a genuinely missing profile", async () => {
    maybeSingle.mockResolvedValue({ data: { organization_id: null, company_profile: null }, error: null });
    await expect(requireCompanyProfile()).rejects.toThrow(CompanyProfileMissingError);
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });
});
