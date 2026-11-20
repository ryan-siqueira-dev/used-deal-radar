import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListingRepository, listingFenceFor } from "../src/listings/repository.js";
import { normalizeUrl } from "../src/utils/normalization.js";
import { listingFixture } from "./fixtures/listings.js";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  createListing: vi.fn(),
  updateListing: vi.fn(),
  linkSearch: vi.fn(),
  createPrice: vi.fn(),
  lockRow: vi.fn(),
  findStructured: vi.fn(),
  upsertStructured: vi.fn(),
  retryDelay: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.retryDelay }));

vi.mock("../src/db/client.js", () => {
  const transaction = {
    $queryRaw: mocks.lockRow,
    listing: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      create: mocks.createListing,
      update: mocks.updateListing,
    },
    searchListing: { upsert: mocks.linkSearch },
    listingPriceHistory: { create: mocks.createPrice },
    structuredListingData: {
      findUnique: mocks.findStructured,
      upsert: mocks.upsertStructured,
    },
  };
  return {
    prisma: {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    },
  };
});

function storedListing(change: Record<string, unknown> = {}) {
  const summary = listingFixture();
  return {
    id: "listing-1",
    source: summary.source,
    category: "gpu",
    externalId: summary.externalId,
    fingerprint: "fingerprint",
    title: summary.title,
    description: null,
    price: summary.price === null ? null : new Prisma.Decimal(summary.price),
    currency: summary.currency,
    location: summary.location,
    sellerName: null,
    url: summary.url,
    normalizedUrl: normalizeUrl(summary.url),
    imageUrl: summary.imageUrl,
    images: [],
    attributes: {},
    publishedAt: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    lastCheckedAt: new Date(),
    active: true,
    suppressedAt: null,
    rawData: null,
    contentHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...change,
  };
}

describe("ListingRepository marketplace identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryDelay.mockReset().mockResolvedValue(undefined);
    mocks.findUnique.mockResolvedValue(null);
    mocks.findFirst.mockResolvedValue(null);
    mocks.lockRow.mockResolvedValue([{ id: "listing-1" }]);
    mocks.createListing.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(storedListing(data)));
    mocks.updateListing.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(storedListing({
      ...data,
      updatedAt: new Date("2026-08-09T12:00:01.000Z"),
    })));
    mocks.linkSearch.mockResolvedValue({});
    mocks.createPrice.mockResolvedValue({});
    mocks.findStructured.mockResolvedValue(null);
    mocks.upsertStructured.mockResolvedValue({});
  });

  it("marks an unavailable offer inactive only if its identity has not changed", async () => {
    const listing = storedListing();
    mocks.findUnique.mockResolvedValue(listing);
    await new ListingRepository().markUnavailable(listing.id, listingFenceFor(listing));
    expect(mocks.updateListing).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({active: false})}));
    mocks.updateListing.mockClear();
    await new ListingRepository().markUnavailable(listing.id, {...listingFenceFor(listing), fingerprint: "stale"});
    expect(mocks.updateListing).not.toHaveBeenCalled();
  });

  it("refreshes details when a previously unavailable offer reappears", async () => {
    const listing = storedListing({active:false});
    mocks.findUnique.mockResolvedValue(listing);
    const result = await new ListingRepository().upsertSummary("search-1", "gpu", listingFixture());
    expect(result.needsDetails).toBe(true);
  });

  it("never attaches a summary without an external ID to an arbitrary explicit ID", async () => {
    const summary = listingFixture({ externalId: null });
    const result = await new ListingRepository().upsertSummary("search-1", "gpu", summary);

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { source: summary.source, normalizedUrl: normalizeUrl(summary.url), externalId: null },
    });
    expect(mocks.createListing).toHaveBeenCalledOnce();
    expect(result.suppressed).toBe(false);
  });

  it("keeps a user-suppressed marketplace identity out of future searches", async () => {
    const summary = listingFixture();
    mocks.findUnique.mockResolvedValue(storedListing({ suppressedAt: new Date("2026-08-09T12:00:00Z") }));

    const result = await new ListingRepository().upsertSummary("search-1", "gpu", summary);

    expect(result.suppressed).toBe(true);
    expect(mocks.updateListing).not.toHaveBeenCalled();
    expect(mocks.linkSearch).not.toHaveBeenCalled();
    expect(mocks.createPrice).not.toHaveBeenCalled();
  });

  it("adds a newly discovered external ID to an anonymous tombstone", async () => {
    const summary = listingFixture({ externalId: "new-external-id" });
    const tombstone = storedListing({ externalId: null, suppressedAt: new Date("2026-08-09T12:00:00Z") });
    mocks.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(tombstone);
    mocks.findFirst.mockResolvedValue(tombstone);
    mocks.updateListing.mockResolvedValue({ ...tombstone, externalId: summary.externalId });

    const result = await new ListingRepository().upsertSummary("search-1", "gpu", summary);

    expect(mocks.updateListing).toHaveBeenCalledWith({
      where: { id: tombstone.id },
      data: { externalId: summary.externalId },
    });
    expect(result.suppressed).toBe(true);
    expect(result.listing.externalId).toBe(summary.externalId);
    expect(mocks.linkSearch).not.toHaveBeenCalled();
  });

  it("clears detail-only data when a new summary generation arrives", async () => {
    const summary = listingFixture({ title: "RTX 3060 com novo titulo" });
    const existing = storedListing({
      title: "RTX 3060",
      description: "description from the previous generation",
      sellerName: "old seller",
      images: ["https://http2.mlstatic.com/old-image.jpg"],
      attributes: { memory: "12 GB" },
      publishedAt: new Date("2026-08-08T12:00:00.000Z"),
      rawData: { old: true },
      contentHash: "old-content",
    });
    mocks.findUnique.mockResolvedValue(existing);

    await new ListingRepository().upsertSummary("search-1", "gpu", summary);

    expect(mocks.updateListing).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: existing.id },
      data: expect.objectContaining({
        description: null,
        sellerName: null,
        images: summary.imageUrl ? [summary.imageUrl] : [],
        attributes: {},
        publishedAt: null,
        rawData: Prisma.DbNull,
        contentHash: null,
      }),
    }));
  });

  it("refuses to persist an extraction produced from stale listing content", async () => {
    const listing = storedListing({ contentHash: "current-content", fingerprint: "current-fingerprint" });
    mocks.findUnique.mockResolvedValue(listing);

    const persisted = await new ListingRepository().saveStructured(
      listing.id,
      { category: "gpu", data: { model: "RTX 3060" }, extractionConfidence: 0.8 },
      { category: "gpu", data: { model: "RTX 3060" }, extractionConfidence: 0.8 },
      "extractor-v1",
      "extractor-v1",
      new Date("2026-08-09T12:00:00Z"),
      "stale-content",
      listingFenceFor(listing),
    );

    expect(persisted).toBeNull();
    expect(mocks.findStructured).not.toHaveBeenCalled();
    expect(mocks.upsertStructured).not.toHaveBeenCalled();
    expect(mocks.updateListing).not.toHaveBeenCalled();
  });

  it("does not replace a successful extraction with a later failed attempt for the same content", async () => {
    const listing = storedListing({ contentHash: "same-content", fingerprint: "same-fingerprint" });
    mocks.findUnique.mockResolvedValue(listing);
    mocks.findStructured.mockResolvedValue({
      listingId: listing.id,
      category: "gpu",
      data: {
        model: "RTX 3060 Ti",
        extractionConfidence: 0.95,
        deterministicData: { model: "RTX 3060" },
        deterministicExtractionConfidence: 0.8,
        extractionModel: "successful-model",
        extractionAttemptModel: "successful-model",
        extractionAttemptedAt: "2026-08-09T11:00:00.000Z",
        sourceContentHash: "same-content",
      },
    });

    const persisted = await new ListingRepository().saveStructured(
      listing.id,
      { category: "gpu", data: { model: "RTX 3060" }, extractionConfidence: 0.8 },
      { category: "gpu", data: { model: "RTX 3060" }, extractionConfidence: 0.8 },
      null,
      "failed-model",
      new Date("2026-08-09T12:00:00Z"),
      "same-content",
      listingFenceFor(listing),
    );

    expect(persisted).toBe(listing);
    const update = mocks.upsertStructured.mock.calls[0]?.[0].update;
    expect(update.data).toMatchObject({
      model: "RTX 3060 Ti",
      extractionModel: "successful-model",
      extractionAttemptModel: "failed-model",
      sourceContentHash: "same-content",
    });
  });

  it("rejects stale detail writes and stale failed-fetch check-ins", async () => {
    const listing = storedListing({
      contentHash: "current-content",
      fingerprint: "current-fingerprint",
      updatedAt: new Date("2026-08-09T12:00:01.000Z"),
    });
    mocks.findUnique.mockResolvedValue(listing);
    const staleFence = {
      ...listingFenceFor(listing),
      updatedAt: new Date("2026-08-09T12:00:00.000Z"),
      fingerprint: "prior-fingerprint",
      contentHash: "prior-content",
    };

    await expect(new ListingRepository().updateDetails(
      listing.id,
      "gpu",
      listingFixture(),
      staleFence,
    )).resolves.toBeNull();
    await expect(new ListingRepository().markDetailsChecked(listing.id, staleFence)).resolves.toBeNull();

    expect(mocks.updateListing).not.toHaveBeenCalled();
    expect(mocks.createPrice).not.toHaveBeenCalled();
  });

  it("returns the renewed listing generation after a fenced failed-fetch check-in", async () => {
    const listing = storedListing({ updatedAt: new Date("2026-08-09T12:00:00.000Z") });
    const renewed = storedListing({ updatedAt: new Date("2026-08-09T12:00:01.000Z") });
    mocks.findUnique.mockResolvedValue(listing);
    mocks.updateListing.mockResolvedValue(renewed);

    await expect(new ListingRepository().markDetailsChecked(listing.id, listingFenceFor(listing))).resolves.toBe(renewed);
    expect(mocks.updateListing).toHaveBeenCalledWith({
      where: { id: listing.id },
      data: { lastCheckedAt: expect.any(Date) },
    });
  });

  it("allows concurrent sightings of identical content without discarding another search", async () => {
    const listing = storedListing({ contentHash: "same-content" });
    const fence = listingFenceFor(listing);
    mocks.findUnique.mockResolvedValue({ ...listing, updatedAt: new Date(listing.updatedAt.getTime() + 1_000) });
    await expect(new ListingRepository().markDetailsChecked(listing.id, fence)).resolves.not.toBeNull();
  });

  it("rejects currency changes even when the numeric price and content hash are unchanged", async () => {
    const listing = storedListing({ contentHash: "same-content", currency: "BRL" });
    const fence = listingFenceFor(listing);
    mocks.findUnique.mockResolvedValue({ ...listing, currency: "USD" });
    await expect(new ListingRepository().markDetailsChecked(listing.id, fence)).resolves.toBeNull();
  });

  it.each([
    { code: "P2034", meta: {} },
    { code: "P2010", meta: { code: "40001" } },
    { code: "P2010", meta: { code: "40P01" } },
  ])("backs off for transaction conflicts $code $meta before retrying", async ({ code, meta }) => {
    let release!: () => void;
    mocks.retryDelay.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    mocks.createListing.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("serialization conflict", {
      code, meta, clientVersion: "test",
    }));
    const operation = new ListingRepository().upsertSummary("search-1", "generic", listingFixture());
    await vi.waitFor(() => expect(mocks.retryDelay).toHaveBeenCalled());
    expect(mocks.createListing).toHaveBeenCalledTimes(1);
    release();
    await expect(operation).resolves.toMatchObject({ isNew: true });
  });
});
