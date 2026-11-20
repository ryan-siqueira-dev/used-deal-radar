import { describe, expect, it } from "vitest";
import { compareProducts } from "../src/dashboard/product-comparison.js";

const offer = { id: "a", source: "kabum", title: "Placa RTX 4060 8GB", brand: "MSI", mpn: "RTX4060-V1", gtin: null, condition: "new" as const, currency: "BRL" };
describe("product comparison", () => {
  it("confirms matching brand, manufacturer part number and known condition across sources", () => {
    expect(compareProducts(offer, { ...offer, id: "b", source: "terabyte" })).toMatchObject({ confidence: "confirmed" });
  });
  it("never groups different condition, currency or identical sources", () => {
    expect(compareProducts(offer, { ...offer, id: "b", source: "terabyte", condition: "used" })).toBeNull();
    expect(compareProducts(offer, { ...offer, id: "b", source: "terabyte", currency: "USD" })).toBeNull();
    expect(compareProducts(offer, { ...offer, id: "b" })).toBeNull();
  });
  it("does not confirm products with unknown condition or different manufacturer part number", () => {
    expect(compareProducts(offer, { ...offer, id: "b", source: "terabyte", condition: "unknown" })).toMatchObject({ confidence: "possible" });
    expect(compareProducts(offer, { ...offer, id: "b", source: "terabyte", mpn: "RTX4060-V2" })).toBeNull();
  });
});

describe("product identifier evidence", () => {
  it("does not match titles alone or generic model without an MPN", () => {
    const left = { ...offer, mpn: null };
    expect(compareProducts(left, { ...left, id: "b", source: "olx" })).toBeNull();
  });
  it("treats conflicting product identifiers as distinct", () => {
    const left = { ...offer, gtin: "7891234567890" };
    expect(compareProducts(left, { ...left, id: "b", source: "olx", gtin: "7899876543210" })).toBeNull();
  });
});
