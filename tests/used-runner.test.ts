import { Prisma, type Search } from "@prisma/client";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenericAnalyzer } from "../src/categories/generic/analyzer.js";
import { CategoryAnalyzerRegistry } from "../src/categories/registry.js";
import { analysisInputHash, SearchRunner } from "../src/jobs/search-runner.js";
import type { ListingRepository } from "../src/listings/repository.js";
import { calculateMarketStatistics } from "../src/market-analysis/statistics.js";
import { MarketplaceRegistry } from "../src/marketplaces/registry.js";
import { ProviderError } from "../src/marketplaces/provider.js";
import type { TelegramNotifier } from "../src/notifications/telegram.js";
import { listingFixture } from "./fixtures/listings.js";
import { isStrongUsedDuplicate } from "../src/matching/used-duplicates.js";
import { listingContentHash, sha256, stableStringify } from "../src/utils/hash.js";

const database = vi.hoisted(() => ({
  claim: vi.fn(),
  createRun: vi.fn(),
  updateRuns: vi.fn(),
}));
vi.mock("../src/db/client.js", () => {
  const client = {
    search: { updateMany: database.claim },
    searchRun: { create: database.createRun, updateMany: database.updateRuns },
  };
  return { prisma: { ...client, $transaction: (operation: (transaction: typeof client) => unknown) => operation(client) } };
});

const settings = {
  purpose: "personal", minimumDiscountPercent: 15, minimumComparables: 5,
  facebookLocation: "Itajaí, SC", facebookRadiusKm: 50,
  costs: { fixed: null, feePercent: null },
};

function searchFixture(changes: Record<string, unknown> = {}): Search {
  return {
    id: "used-search", name: "Sofá", query: "sofá", category: "generic",
    minPrice: null, maxPrice: null, minYear: null, maxYear: null,
    location: "Itajaí, SC", radiusKm: 50, minimumScore: 70, intervalMinutes: 60,
    providers: ["olx", "facebook"], forbiddenWords: [], active: true,
    opportunitySettings: settings,
    createdAt: new Date(), updatedAt: new Date(), lastRunAt: null,
    runLeaseId: null, runLeaseExpiresAt: null, ...changes,
  } as Search;
}

function setup() {
  const marketplaces = new MarketplaceRegistry();
  const searchOlx = vi.fn().mockResolvedValue([]);
  const searchFacebook = vi.fn().mockResolvedValue([]);
  const searchMercadoLivre = vi.fn().mockResolvedValue([]);
  const getDetails = vi.fn().mockResolvedValue(listingFixture());
  marketplaces.register({ name: "mercadolivre", search: searchMercadoLivre, getListingDetails: getDetails });
  marketplaces.register({ name: "olx", search: searchOlx, getListingDetails: getDetails });
  marketplaces.register({ name: "facebook", search: searchFacebook, getListingDetails: getDetails });
  const analyzers = new CategoryAnalyzerRegistry();
  analyzers.register(new GenericAnalyzer());
  const repository = {
    upsertSummary: vi.fn(), toDetails: vi.fn(), updateDetails: vi.fn(), getStructured: vi.fn().mockResolvedValue(null),
    saveStructured: vi.fn(), findUsedComparables: vi.fn().mockResolvedValue([]),
    findComparables: vi.fn().mockResolvedValue([]), recentCrossMarketplaceCandidates: vi.fn().mockResolvedValue([]),
    getPriceHistory: vi.fn().mockResolvedValue([]), findAnalysis: vi.fn().mockResolvedValue(null),
    createAnalysis: vi.fn(), claimNotification: vi.fn(),
    setCurrentAnalysis: vi.fn(),
  };
  const telegram = { send: vi.fn() };
  const runner = new SearchRunner(marketplaces, analyzers, repository as unknown as ListingRepository,
    null, telegram as unknown as TelegramNotifier, pino({ level: "silent" }),
    { detailConcurrency: 2, defaultLimit: 50, comparableMaxAgeDays: 30 });
  return { runner, repository, telegram, searchOlx, searchFacebook, searchMercadoLivre };
}

describe("used search pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.claim.mockResolvedValue({ count: 1 });
    database.createRun.mockResolvedValue({ id: "run" });
    database.updateRuns.mockResolvedValue({ count: 1 });
  });

  it("applies Facebook scope without applying the region to OLX", async () => {
    const { runner, searchOlx, searchFacebook } = setup();
    await runner.run(searchFixture());
    expect(searchOlx).toHaveBeenCalledWith(expect.objectContaining({ location: null, radiusKm: null }));
    expect(searchFacebook).toHaveBeenCalledWith(expect.objectContaining({
      location: "Itajaí, SC", radiusKm: 50, verifyLocation: true,
    }));
    expect(database.createRun).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ searchId: "used-search", status: "running" }),
    }));
    expect(database.updateRuns).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "success", finishedAt: expect.any(Date) }),
    }));
  });

  it("requests only used Mercado Livre items nationwide without changing legacy criteria", async () => {
    const { runner, searchMercadoLivre, searchOlx } = setup();
    await runner.run(searchFixture({ providers: ["mercadolivre", "olx"] }));
    expect(searchMercadoLivre).toHaveBeenCalledWith(expect.objectContaining({
      condition: "used", location: null, radiusKm: null,
    }));
    expect(searchOlx.mock.calls[0]?.[0]).not.toHaveProperty("condition");
    expect(database.updateRuns).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "success", providers: expect.objectContaining({
        mercadolivre: expect.objectContaining({ status: "empty", count: 0 }),
      }) }),
    }));
    searchMercadoLivre.mockClear();
    await runner.run(searchFixture({ providers: ["mercadolivre"], opportunitySettings: null }));
    expect(searchMercadoLivre.mock.calls[0]?.[0]).not.toHaveProperty("condition");
  });

  it("records a total source failure and waits for the next scheduled interval", async () => {
    const { runner, searchOlx, searchFacebook } = setup();
    searchOlx.mockRejectedValue(new ProviderError("olx_blocked", "Blocked", false));
    searchFacebook.mockRejectedValue(new ProviderError("facebook_region_unverified", "Unverified", false));
    await runner.run(searchFixture());
    expect(database.updateRuns).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", providers: expect.objectContaining({
        olx: expect.objectContaining({ status: "failed", error: "olx_blocked" }),
        facebook: expect.objectContaining({ status: "failed", error: "facebook_region_unverified" }),
      }) }),
    }));
    expect(database.claim).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastRunAt: expect.any(Date) }),
    }));
  });

  it("keeps successful results when the other source fails", async () => {
    const { runner, searchFacebook } = setup();
    searchFacebook.mockRejectedValue(new ProviderError("facebook_session_missing", "Missing", false));
    await runner.run(searchFixture());
    expect(database.updateRuns).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "partial" }),
    }));
  });

  it("includes purpose, costs and source scope in analysis identity", async () => {
    const listing = listingFixture();
    const structured = await new GenericAnalyzer().extract(listing);
    const market = calculateMarketStatistics([]);
    const pipeline = { pipelineVersion: 3, extractionModel: null, analysisModel: null };
    const hash = (opportunitySettings: unknown) => analysisInputHash(
      searchFixture({ opportunitySettings }), listing, structured, structured, market, [], pipeline,
    );
    const original = hash(settings);
    expect(hash({ ...settings, purpose: "resale" })).not.toBe(original);
    expect(hash({ ...settings, costs: { fixed: 100, feePercent: 5 } })).not.toBe(original);
    expect(hash({ ...settings, facebookRadiusKm: 25 })).not.toBe(original);
  });

  it("preserves the pre-upgrade identity for unchanged legacy searches", async () => {
    const search = searchFixture({ opportunitySettings: null });
    const listing = listingFixture();
    const structured = await new GenericAnalyzer().extract(listing);
    const market = calculateMarketStatistics([]);
    const pipeline = { pipelineVersion: 2, extractionModel: null, analysisModel: null };
    const oldIdentity = sha256(stableStringify({
      listing: { contentHash: listingContentHash(listing), currency: "BRL", location: "Itajaí, SC", source: "olx" },
      deterministic: structured, enriched: structured, market, priceHistory: [], pipeline,
      search: { query: "sofá", category: "generic", minPrice: null, maxPrice: null, minYear: null, maxYear: null,
        location: "Itajaí, SC", radiusKm: 50, minimumScore: 70, providers: ["facebook", "olx"], forbiddenWords: [] },
    }));
    expect(analysisInputHash(search, listing, structured, structured, market, [], pipeline)).toBe(oldIdentity);
  });

  it("invalidates used cache identity when the persisted summary generation changes", async () => {
    const search = searchFixture();
    const listing = listingFixture();
    const structured = await new GenericAnalyzer().extract(listing);
    const market = calculateMarketStatistics([]);
    const pipeline = { pipelineVersion: 3, extractionModel: null, analysisModel: null };
    const first = analysisInputHash(search, listing, structured, structured, market, [], pipeline, { fingerprint: "old", contentHash: null });
    const second = analysisInputHash(search, listing, structured, structured, market, [], pipeline, { fingerprint: "new", contentHash: "details-now-known" });
    expect(second).not.toBe(first);
  });

  it("accepts a zero maximum price through the API-compatible provider contract", async () => {
    const { runner, searchOlx } = setup();
    await runner.run(searchFixture({ maxPrice: new Prisma.Decimal(0) }));
    expect(searchOlx).toHaveBeenCalledWith(expect.objectContaining({ maxPrice: 0 }));
  });

  it("checkpoints a source before waiting for its page load", async () => {
    const { runner, searchOlx } = setup();
    let release!: (value: []) => void;
    searchOlx.mockReturnValue(new Promise<[]>((resolve) => { release = resolve; }));
    const running = runner.run(searchFixture());
    await vi.waitFor(() => expect(database.updateRuns).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discovered: 0, providers: expect.objectContaining({ olx: expect.objectContaining({ status: "running" }) }) }),
    })));
    release([]);
    await running;
  });

  it("distinguishes repeated same-source items from independent products with generic titles", () => {
    const a = { id: "a", source: "olx" as const, title: "Sofá usado", price: 1_000, location: "Itajaí, SC", sellerName: "Maria", imageUrl: "https://images.example.com/sofa.jpg" };
    expect(isStrongUsedDuplicate(a, { ...a, id: "b" })).toBe(true);
    expect(isStrongUsedDuplicate(a, { ...a, id: "b", sellerName: "Pedro" })).toBe(false);
    expect(isStrongUsedDuplicate(a, { ...a, id: "b", source: "facebook", price: 1_800 })).toBe(false);
    expect(isStrongUsedDuplicate(a, { ...a, id: "b", source: "facebook", sellerName: "Pedro", imageUrl: "https://images.example.com/other.jpg" })).toBe(false);
  });

  it("persists a local neighboring-city opportunity for this search without sending Telegram", async () => {
    const { runner, repository, telegram, searchFacebook } = setup();
    const details = listingFixture({ source: "facebook", externalId: "item-1", title: "Sofá usado 3 lugares",
      url: "https://www.facebook.com/marketplace/item/123456", location: "Balneário Camboriú, SC", price: 850 });
    const row = { ...details, id: "listing-1", category: "generic", price: new Prisma.Decimal(850),
      fingerprint: "fingerprint", contentHash: "content", updatedAt: new Date(), suppressedAt: null };
    repository.upsertSummary.mockResolvedValue({ listing: row, isNew: true, contentChanged: true,
      needsDetails: false, suppressed: false });
    repository.toDetails.mockReturnValue(details);
    repository.saveStructured.mockResolvedValue(row);
    const structured = await new GenericAnalyzer().extract(details);
    repository.findUsedComparables.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({
      id: `comparable-${index}`, source: "olx", title: details.title, location: `Cidade ${index}`,
      price: 1_000, structured,
    })));
    repository.createAnalysis.mockImplementation(async (input) => ({
      id: "analysis-1", score: input.finalScore, advantages: [], risks: [], reason: input.analysis.reason,
      priceDifferencePercent: new Prisma.Decimal(-15), opportunity: input.opportunity,
    }));
    searchFacebook.mockResolvedValue([details]);
    await runner.run(searchFixture());
    expect(repository.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      searchId: "used-search", opportunity: expect.objectContaining({ classification: "opportunity", sampleSize: 5 }),
    }));
    expect(repository.claimNotification).not.toHaveBeenCalled();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it("retains matching used listings without a price as candidates", async () => {
    const { runner, repository, searchOlx } = setup();
    const details = listingFixture({ title: "Sofá usado", price: null });
    const row = { ...details, id: "no-price", category: "generic", fingerprint: "no-price", contentHash: null, updatedAt: new Date() };
    repository.upsertSummary.mockResolvedValue({ listing: row, isNew: true, contentChanged: true, needsDetails: false, suppressed: false });
    repository.toDetails.mockReturnValue(details);
    repository.saveStructured.mockResolvedValue(row);
    repository.createAnalysis.mockResolvedValue({ id: "analysis", score: 40, advantages: [], risks: [], reason: "Unknown price", priceDifferencePercent: null });
    searchOlx.mockResolvedValue([details]);
    await runner.run(searchFixture());
    expect(repository.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      opportunity: expect.objectContaining({ classification: "candidate", discountPercent: null }),
    }));
  });

  it("confirms a cached evaluation as current when criteria return to an earlier value", async () => {
    const { runner, repository, searchOlx } = setup();
    const details = listingFixture({ title: "Sofá usado" });
    const row = { ...details, id: "cached", category: "generic", fingerprint: "cached", contentHash: "same", updatedAt: new Date() };
    repository.upsertSummary.mockResolvedValue({ listing: row, isNew: false, contentChanged: false, needsDetails: false, suppressed: false });
    repository.toDetails.mockReturnValue(details);
    repository.saveStructured.mockResolvedValue(row);
    repository.findAnalysis.mockResolvedValue({ id: "original-evaluation", score: 40, advantages: [], risks: [], reason: "Original", priceDifferencePercent: null });
    searchOlx.mockResolvedValue([details]);
    await runner.run(searchFixture());
    expect(repository.setCurrentAnalysis).toHaveBeenCalledWith("used-search", "cached", "original-evaluation", expect.any(Object));
    expect(repository.createAnalysis).not.toHaveBeenCalled();
  });
});
