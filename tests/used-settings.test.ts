import { describe, expect, it } from "vitest";
import { searchDefinitionSchema } from "../src/searches/validation.js";
import { defaultUsedSearchSettings, getUsedSearchSettings, usedSearchSettingsSchema } from "../src/opportunities/settings.js";

const legacySearch = {
  name: "RTX usada",
  query: "RTX 3060 Ti",
  category: "gpu",
  providers: ["mercadolivre"],
  minPrice: null,
  maxPrice: null,
  minYear: null,
  maxYear: null,
  location: null,
  radiusKm: null,
  minimumScore: 70,
  intervalMinutes: 60,
  forbiddenWords: [],
};

describe("used opportunity settings", () => {
  it("applies reference, location and unknown-cost defaults when a purpose is set", () => {
    const defaults = {
      purpose: "personal",
      minimumDiscountPercent: 15,
      minimumComparables: 5,
      facebookLocation: "Itajaí, SC",
      facebookRadiusKm: 40,
      costs: { fixed: null, feePercent: null },
    };
    expect(defaultUsedSearchSettings).toEqual(defaults);
    expect(usedSearchSettingsSchema.parse({ purpose: "resale" })).toEqual({ ...defaults, purpose: "resale" });
  });

  it("accepts stored JSON with zero known costs and custom reference thresholds", () => {
    const settings = {
      purpose: "resale",
      minimumDiscountPercent: 0,
      minimumComparables: 9,
      facebookLocation: "Joinville, SC",
      facebookRadiusKm: 75,
      costs: { fixed: 0, feePercent: 0 },
    };
    expect(getUsedSearchSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it.each([
    undefined,
    null,
    "{}",
    [],
    {},
    { purpose: "invalid" },
    { purpose: "personal", minimumComparables: 4 },
    { purpose: "personal", minimumComparables: 6.5 },
    { purpose: "personal", minimumDiscountPercent: Infinity },
    { purpose: "personal", minimumDiscountPercent: 101 },
    { purpose: "personal", facebookRadiusKm: 0 },
    { purpose: "personal", facebookLocation: " " },
    { purpose: "resale", costs: { fixed: -1, feePercent: 5 } },
    { purpose: "resale", costs: { fixed: null, feePercent: 101 } },
  ])("returns null for absent or invalid JSON: %j", (settings) => {
    expect(getUsedSearchSettings(settings)).toBeNull();
  });

  it("preserves omitted and null settings for existing searches", () => {
    expect(searchDefinitionSchema.parse(legacySearch).opportunitySettings).toBeUndefined();
    expect(searchDefinitionSchema.parse({ ...legacySearch, opportunitySettings: null }).opportunitySettings).toBeNull();
  });

  it("restricts opted-in searches to supported used marketplaces", () => {
    const opportunitySettings = { purpose: "personal" };
    expect(searchDefinitionSchema.safeParse({ ...legacySearch, opportunitySettings }).success).toBe(true);
    expect(searchDefinitionSchema.safeParse({ ...legacySearch, providers: ["kabum"], opportunitySettings }).success).toBe(false);
    expect(searchDefinitionSchema.parse({ ...legacySearch, providers: ["olx", "facebook", "mercadolivre"], opportunitySettings }).opportunitySettings)
      .toEqual(defaultUsedSearchSettings);
  });
});
