import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Application } from "../src/app.js";
import { createDashboardHandler } from "../src/dashboard/api.js";
import { createDashboardRepository } from "../src/dashboard/repository.js";
import { prisma } from "../src/db/client.js";

vi.mock("../src/db/client.js", () => ({
  prisma: {
    listing: { findMany: vi.fn() },
    listingAnalysis: { findMany: vi.fn() },
    search: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));

describe("dashboard listing history", () => {
  it("returns the latest snapshot for each linked search with its own settings revision", async () => {
    const settings = {
      purpose: "personal",
      minimumDiscountPercent: 15,
      minimumComparables: 5,
      facebookLocation: "Itajaí, SC",
      facebookRadiusKm: 50,
      costs: { fixed: null, feePercent: null },
    };
    const criteria = {
      query: "Sony a6000", category: "electronics", minPrice: null, maxPrice: null, minYear: null, maxYear: null,
      location: null, radiusKm: null, minimumScore: 70, providers: ["facebook", "olx"], forbiddenWords: [],
    };
    const resale = { ...settings, purpose: "resale" };
    const listingSnapshot = {
      contentHash: "listing-hash", fingerprint: "listing-fingerprint", price: 800,
      currency: "BRL", location: "Itajaí, SC", source: "olx",
    };
    const analysis = (id: string, searchId: string, classification: string, searchCriteriaSnapshot: unknown) => ({
      id, searchId, listingId: "listing-1", opportunity: { classification, searchCriteriaSnapshot, listingSnapshot },
    });
    const listing = {
      ...listingSnapshot,
      id: "listing-1",
      price: new Prisma.Decimal(800),
      analyses: [
        analysis("resale-evaluation", "resale", "candidate", { ...criteria, query: "Sony a6100", opportunitySettings: resale }),
        analysis("later-personal-evaluation", "personal", "candidate", { ...criteria, query: "Sony a6100", opportunitySettings: settings }),
        analysis("later-legacy-evaluation", "legacy", "candidate", { ...criteria, opportunitySettings: settings }),
      ],
      searches: [
        {
          searchId: "personal",
          listingId: "listing-1",
          search: { ...criteria, id: "personal", name: "Para usar", opportunitySettings: settings },
          currentAnalysis: analysis("personal-evaluation", "personal", "opportunity", { ...criteria, opportunitySettings: settings }),
        },
        { searchId: "resale", listingId: "listing-1", search: { ...criteria, id: "resale", name: "Para revender", opportunitySettings: resale } },
        {
          searchId: "legacy",
          listingId: "listing-1",
          currentAnalysis: analysis("last-used-legacy-evaluation", "legacy", "opportunity", { ...criteria, opportunitySettings: settings }),
          search: { id: "legacy", name: "Busca anterior", opportunitySettings: null },
        },
      ],
    };
    const legacyAnalysis = { id: "last-legacy-evaluation", listingId: "listing-1", searchId: "legacy", opportunity: null };
    vi.mocked(prisma.listing.findMany).mockResolvedValue([listing] as unknown as Awaited<ReturnType<typeof prisma.listing.findMany>>);
    vi.mocked(prisma.listingAnalysis.findMany).mockResolvedValue([legacyAnalysis] as Awaited<ReturnType<typeof prisma.listingAnalysis.findMany>>);
    const handle = createDashboardHandler(createDashboardRepository({} as Application));
    const response = await handle(new Request("http://localhost/api/listings"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({
      id: "listing-1",
      price: "800",
      analyses: [
        expect.objectContaining({ id: "resale-evaluation" }),
        expect.objectContaining({ id: "later-personal-evaluation" }),
        expect.objectContaining({ id: "later-legacy-evaluation" }),
      ],
      searches: [
        expect.objectContaining({
          searchId: "personal",
          search: { id: "personal", name: "Para usar", purpose: "personal" },
          analyses: [expect.objectContaining({ id: "personal-evaluation", current: true, opportunity: expect.objectContaining({ classification: "opportunity" }) })],
        }),
        expect.objectContaining({
          searchId: "resale",
          search: { id: "resale", name: "Para revender", purpose: "resale" },
          analyses: [expect.objectContaining({ id: "resale-evaluation", current: false, opportunity: expect.objectContaining({ classification: "candidate" }) })],
        }),
        expect.objectContaining({
          searchId: "legacy",
          search: { id: "legacy", name: "Busca anterior", purpose: null },
          analyses: [expect.objectContaining({ id: "last-legacy-evaluation", current: true, opportunity: null })],
        }),
      ],
    })]);
    expect(prisma.listing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ analyses: expect.objectContaining({ distinct: ["searchId"] }) }),
    }));

    vi.mocked(prisma.listing.findMany).mockResolvedValue([{ ...listing, price: new Prisma.Decimal(810) }] as unknown as Awaited<ReturnType<typeof prisma.listing.findMany>>);
    const afterPriceChange = await handle(new Request("http://localhost/api/listings"));
    expect(await afterPriceChange.json()).toEqual([expect.objectContaining({
      price: "810",
      searches: expect.arrayContaining([expect.objectContaining({
        searchId: "personal",
        analyses: [expect.objectContaining({ id: "personal-evaluation", current: false })],
      })]),
    })]);
  });
});

describe("dashboard run leases", () => {
  it("clears a run lease atomically with pausing a search", async () => {
    vi.mocked(prisma.search.updateMany).mockResolvedValue({ count: 1 });
    const paused = { id: "personal", active: false } as NonNullable<Awaited<ReturnType<typeof prisma.search.findUnique>>>;
    vi.mocked(prisma.search.findUnique).mockResolvedValue(paused);
    const handle = createDashboardHandler(createDashboardRepository({} as Application));
    const response = await handle(new Request("http://localhost/api/searches/personal", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    }));
    expect(response.status).toBe(200);
    expect(prisma.search.updateMany).toHaveBeenCalledWith({
      where: { id: "personal" },
      data: { active: false, runLeaseId: null, runLeaseExpiresAt: null },
    });
  });
});
