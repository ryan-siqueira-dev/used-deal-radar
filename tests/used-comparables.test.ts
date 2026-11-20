import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenericAnalyzer } from "../src/categories/generic/analyzer.js";
import { ListingRepository } from "../src/listings/repository.js";
import { inspectUsedListing } from "../src/opportunities/condition.js";
import { listingFixture } from "./fixtures/listings.js";

const database = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../src/db/client.js", () => ({ prisma: { listing: { findMany: database.findMany } } }));

function row(id: string, title: string, description = "Item usado") {
  return { ...listingFixture({ title, description, attributes: {} }), id, price: new Prisma.Decimal(1_000) };
}

describe("used comparable selection", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("finds relevant used ads beyond a full unrelated category page", async () => {
    database.findMany
      .mockResolvedValueOnce(Array.from({ length: 250 }, (_, index) => row(`unrelated-${index}`, "Mesa usada")))
      .mockResolvedValueOnce([row("sofa", "Sofá 3 lugares")]);
    const analyzer = new GenericAnalyzer();
    const target = await analyzer.extract(listingFixture({ title: "Sofá 3 lugares" }));
    const records = await new ListingRepository().findUsedComparables("generic", "current", new Date(), "BRL", async (listing) => {
      if (inspectUsedListing(listing).condition !== "used") return null;
      const structured = await analyzer.extract(listing);
      return analyzer.isComparable(target, structured) ? structured : null;
    });
    expect(records.map((record) => record.id)).toEqual(["sofa"]);
    expect(database.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: { id: "unrelated-249" }, skip: 1,
      where: expect.objectContaining({ source: { in: ["olx", "facebook", "mercadolivre"] }, id: { not: "current" } }),
    }));
  });

  it("rechecks legacy condition from raw ad evidence", async () => {
    database.findMany.mockResolvedValueOnce([
      row("unknown", "Sofá 3 lugares", "Bom estado"),
      row("new", "Sofá 3 lugares", "Produto novo"),
      row("used", "Sofá 3 lugares", "Produto seminovo"),
    ]);
    const analyzer = new GenericAnalyzer();
    const records = await new ListingRepository().findUsedComparables("generic", "current", new Date(), "BRL", async (listing) => {
      return inspectUsedListing(listing).condition === "used" ? analyzer.extract(listing) : null;
    });
    expect(records.map((record) => record.id)).toEqual(["used"]);
  });

  it("does not compare unknown currencies", async () => {
    const records = await new ListingRepository().findUsedComparables("generic", "current", new Date(), null,
      async (listing) => new GenericAnalyzer().extract(listing));
    expect(records).toEqual([]);
    expect(database.findMany).not.toHaveBeenCalled();
  });
});
