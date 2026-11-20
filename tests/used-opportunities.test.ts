import { describe, expect, it } from "vitest";
import { GenericAnalyzer } from "../src/categories/generic/analyzer.js";
import { calculateMarketStatistics } from "../src/market-analysis/statistics.js";
import { inspectUsedListing } from "../src/opportunities/condition.js";
import { evaluateOpportunity } from "../src/opportunities/evaluation.js";
import { defaultUsedSearchSettings } from "../src/opportunities/settings.js";
import { listingFixture } from "./fixtures/listings.js";

describe("used-listing evidence", () => {
  it("keeps seminovo out of the new classification", async () => {
    const listing = listingFixture({ title: "Samsung S24 semi-novo", description: "Como novo, sem defeitos", attributes: {} });
    expect(inspectUsedListing(listing)).toMatchObject({
      condition: "used",
      defects: [],
      evidence: expect.arrayContaining([expect.stringContaining("semi novo")]),
    });
    expect((await new GenericAnalyzer().extract(listing)).data["condition"]).toBe("used");
  });

  it.each([
    ["Usado. Não está lacrado. Nenhuma avaria.", "used"],
    ["Nunca foi usado, lacrado.", "new"],
    ["Nunca foi usado e acompanha cabo.", "new"],
    ["Recondicionado, parece novo.", "refurbished"],
    ["Usado para retirar peças, não funciona.", "damaged"],
    ["Modelo com cabo novo e bateria nova.", "unknown"],
    ["Nunca usada para mineração. Sem qualquer defeito.", "unknown"],
    ["Não é novo nem está lacrado. Sem defeitos.", "unknown"],
    ["Não está sendo usado para testes.", "unknown"],
    ["Item danificado. Não aceito devolução.", "damaged"],
    ["Usado, sem avarias e com tela sem trincas.", "used"],
    ["Usado, sem peças quebradas ou trincadas.", "used"],
    ["Usado. Se não funciona no seu aparelho, aceito devolução.", "used"],
  ])("reads only condition evidence specific to the item in %j", (description, condition) => {
    const listing = listingFixture({ title: "Produto", description, attributes: {} });
    expect(inspectUsedListing(listing).condition).toBe(condition);
  });

  it.each([
    "Usado com avarias.",
    "Usado para peças. Não liga.",
    "Usado para retirada de peças.",
    "Usado com a tela trincada.",
    "Aparelho usado. Funciona não.",
  ])("excludes explicit damage despite a used marketplace label: %j", (description) => {
    const listing = listingFixture({ description });
    expect(inspectUsedListing(listing)).toMatchObject({
      condition: "damaged",
      defects: expect.arrayContaining([expect.stringContaining("defeito")]),
    });
  });

  it("excludes a defective item labeled new and warns about the conflict", () => {
    const listing = listingFixture({ description: "Não liga.", attributes: { Condição: "Novo" } });
    expect(inspectUsedListing(listing)).toMatchObject({
      condition: "damaged",
      warnings: expect.arrayContaining([expect.stringContaining("conflitantes")]),
    });
  });

  it("compares generic models whose titles use different used-condition wording", async () => {
    const analyzer = new GenericAnalyzer();
    const [semiNew, used] = await Promise.all([
      analyzer.extract(listingFixture({ title: "Samsung Galaxy S25 semi-novo" })),
      analyzer.extract(listingFixture({ title: "Samsung Galaxy S25 usado" })),
    ]);
    expect(analyzer.isComparable(semiNew, used)).toBe(true);
  });

  it("uses listing attributes as evidence for condition and shipping", () => {
    const listing = listingFixture({
      description: null,
      attributes: { Condição: "Usado – em bom estado", Entrega: "OLX Entrega" },
    });
    expect(inspectUsedListing(listing)).toMatchObject({ condition: "used", shipping: "available" });
  });

  it.each([
    { itemCondition: "https://schema.org/UsedCondition" },
    { "Estado do produto": "Seminovo" },
  ])("recognizes explicitly supplied marketplace conditions: %j", (attributes) => {
    const listing = listingFixture({ description: null, attributes });
    expect(inspectUsedListing(listing).condition).toBe("used");
  });

  it("recognizes pickup-only despite the word envio", () => {
    const listing = listingFixture({ description: "Sem envio. Somente retirada em mãos." });
    expect(inspectUsedListing(listing).shipping).toBe("pickup_only");
  });

  it("recognizes paid shipping when only free delivery is unavailable", () => {
    const listing = listingFixture({ description: "Sem entrega grátis. Envio pelos Correios." });
    expect(inspectUsedListing(listing).shipping).toBe("available");
  });

  it("recognizes an unqualified statement that the seller does not offer delivery", () => {
    const listing = listingFixture({ description: "Não faço entrega." });
    expect(inspectUsedListing(listing).shipping).toBe("pickup_only");
  });

  it("keeps shipping unclear when the seller only rules out a specific shipping service", () => {
    const listing = listingFixture({ description: "Não faço entrega via OLX Entrega." });
    expect(inspectUsedListing(listing).shipping).toBe("unknown");
  });

  it("warns when marketplace shipping evidence conflicts with the seller's pickup-only statement", () => {
    const listing = listingFixture({ description: "Somente retirada no local.", attributes: { shipping: "available" } });
    expect(inspectUsedListing(listing)).toMatchObject({
      shipping: "pickup_only",
      warnings: expect.arrayContaining([expect.stringContaining("conflitantes")]),
    });
  });

  it("preserves unknown condition and shipping without explicit signals", () => {
    const listing = listingFixture({ description: "Bem conservado. Envie mensagem para combinar.", attributes: {} });
    expect(inspectUsedListing(listing)).toMatchObject({ condition: "unknown", shipping: "unknown" });
  });
});

describe("used opportunity evaluation", () => {
  const listing = listingFixture({ price: 850 });
  const settings = defaultUsedSearchSettings;
  const market = { sampleSize: 5, medianPrice: 1_000 };

  it("uses the asking-price median when five comparables meet the inclusive discount threshold", () => {
    expect(evaluateOpportunity({ listing, settings, market })).toMatchObject({
      classification: "opportunity",
      purpose: "personal",
      condition: "used",
      referencePrice: 1_000,
      sampleSize: 5,
      discountPercent: 15,
      estimatedProfit: null,
      estimatedMarginPercent: null,
      totalCost: null,
      settingsSnapshot: settings,
    });
  });

  it("keeps the discount below threshold as a candidate", () => {
    const aboveTargetPrice = { ...listing, price: 850.01 };
    expect(evaluateOpportunity({ listing: aboveTargetPrice, settings, market }).classification).toBe("candidate");
  });

  it("handles cent-level prices exactly at the discount threshold", () => {
    const atTarget = { ...listing, price: 128.52 };
    const comparison = { sampleSize: 5, medianPrice: 151.2 };
    expect(evaluateOpportunity({ listing: atTarget, settings, market: comparison })).toMatchObject({
      classification: "opportunity", discountPercent: 15,
    });
  });

  it.each([
    { low: 100.19, high: 100.21, median: 100.2, price: 85.17 },
    { low: 100.19, high: 100.2, median: 100.195, price: 85.16 },
  ])("uses the expected median of persisted cent prices $low and $high", ({ low, high, median, price }) => {
    const comparablePrices = [low, low, low, high, high, high];
    const market = calculateMarketStatistics(comparablePrices.map((value, index) => ({
      id: String(index), source: "olx", price: value,
    })));
    expect(evaluateOpportunity({ listing: { ...listing, price }, settings, market: market.combined })).toMatchObject({
      classification: "opportunity", referencePrice: median, sampleSize: 6,
    });
  });

  it.each([4, 5])("omits the median from a sample of %d when six comparables are required", (sampleSize) => {
    expect(evaluateOpportunity({
      listing,
      settings: { ...settings, minimumComparables: 6 },
      market: { sampleSize, medianPrice: 1_000 },
    })).toMatchObject({ classification: "candidate", sampleSize, referencePrice: null, discountPercent: null });
  });

  it.each(["Novo", "Recondicionado", "Com defeito"])("excludes explicit %s condition", (condition) => {
    const excluded = listingFixture({ price: 50, description: null, attributes: { Condição: condition } });
    expect(evaluateOpportunity({ listing: excluded, settings, market }).classification).toBe("excluded");
  });

  it("keeps unknown condition as a warned candidate despite the discount", () => {
    const unknown = listingFixture({ price: 50, description: null, attributes: {} });
    expect(evaluateOpportunity({ listing: unknown, settings, market })).toMatchObject({
      classification: "candidate",
      condition: "unknown",
      warnings: expect.arrayContaining([expect.stringContaining("condição")]),
    });
  });

  it.each([null, 0, -1, NaN, Infinity])("omits the discount for invalid purchase price %s", (price) => {
    expect(evaluateOpportunity({ listing: { ...listing, price }, settings, market })).toMatchObject({
      classification: "candidate", discountPercent: null, estimatedProfit: null, estimatedMarginPercent: null,
    });
  });

  it.each([null, "USD"])("requires a price explicitly denominated in BRL, given %s", (currency) => {
    expect(evaluateOpportunity({ listing: { ...listing, currency }, settings, market })).toMatchObject({
      classification: "candidate", discountPercent: null, estimatedProfit: null,
    });
  });

  it.each([null, 0, -1, NaN, Infinity])("omits an invalid market reference price %s", (medianPrice) => {
    expect(evaluateOpportunity({ listing, settings, market: { sampleSize: 5, medianPrice } })).toMatchObject({
      classification: "candidate", referencePrice: null, discountPercent: null,
    });
  });

  it("calculates resale profit after acquisition costs and the fee on the expected sale", () => {
    const resale = { ...settings, purpose: "resale", costs: { fixed: 50, feePercent: 5 } } as const;
    const evaluation = evaluateOpportunity({ listing, settings: resale, market });
    expect(evaluation).toMatchObject({ classification: "opportunity", estimatedProfit: 50, totalCost: 950 });
    expect(evaluation.estimatedMarginPercent).toBeCloseTo(5.26316);
  });

  it.each([
    { fixed: null, feePercent: 5 },
    { fixed: 50, feePercent: null },
  ])("keeps a resale with unknown costs as a candidate", (costs) => {
    const resale = { ...settings, purpose: "resale", costs } as const;
    expect(evaluateOpportunity({ listing, settings: resale, market })).toMatchObject({
      classification: "candidate", estimatedProfit: null, totalCost: null,
    });
  });

  it("uses an explicit zero cost and rejects zero profit", () => {
    const resale = { ...settings, purpose: "resale", costs: { fixed: 0, feePercent: 15 } } as const;
    expect(evaluateOpportunity({ listing, settings: resale, market })).toMatchObject({
      classification: "candidate", estimatedProfit: 0, totalCost: 1_000,
    });
  });

  it("avoids positive-profit rounding artifacts at the break-even price", () => {
    const atBreakEven = { ...listing, price: 128.52 };
    const comparison = { sampleSize: 5, medianPrice: 151.2 };
    const resale = { ...settings, purpose: "resale", costs: { fixed: 22.68, feePercent: 0 } } as const;
    expect(evaluateOpportunity({ listing: atBreakEven, settings: resale, market: comparison })).toMatchObject({
      classification: "candidate", estimatedProfit: 0, totalCost: 151.2,
    });
  });
});
