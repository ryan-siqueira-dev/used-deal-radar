import { Prisma } from "@prisma/client";
import type { Application } from "../app.js";
import { prisma } from "../db/client.js";
import { getUsedSearchSettings } from "../opportunities/settings.js";
import { listingAnalysisSnapshot, searchCriteriaSnapshot } from "../searches/snapshot.js";
import type { SearchDefinition } from "../searches/validation.js";
import { stableStringify } from "../utils/hash.js";
import type { DashboardRepository } from "./api.js";
import { LISTING_PAGE_SIZE } from "./listing-pagination.js";
import { compareProducts, type ProductCandidate } from "./product-comparison.js";

function searchData({ opportunitySettings, ...fields }: SearchDefinition): Prisma.SearchCreateInput {
  return {
    ...fields,
    ...(opportunitySettings !== undefined ? { opportunitySettings: opportunitySettings ?? Prisma.DbNull } : {}),
  };
}

export function createDashboardRepository(app: Application): DashboardRepository {
  return {
    listSearches: () => prisma.search.findMany({ orderBy: { createdAt: "desc" } }),
    createSearch: (data) => prisma.search.create({ data: searchData(data) }),
    async updateSearch(id, data) {
      const fields = "active" in data ? data : searchData(data);
      const lease = "active" in data && data.active ? {} : { runLeaseId: null, runLeaseExpiresAt: null };
      const result = await prisma.search.updateMany({ where: { id }, data: { ...fields, ...lease } });
      return result.count ? prisma.search.findUnique({ where: { id } }) : null;
    },
    async runSearch(id) {
      const search = await prisma.search.findUnique({ where: { id } });
      if (!search) return "missing";
      if (!search.active) return "paused";
      void app.runner.run(search).catch((error: unknown) => app.logger.error({ event: "dashboard_run_failed", searchId: id, err: error }, "Dashboard search failed"));
      return "accepted";
    },
    async listListings(searchId, after) {
      const listings = await prisma.listing.findMany({
        where: {
          suppressedAt: null,
          active: true,
          ...(searchId ? { searches: { some: { searchId } } } : {}),
          ...(after ? { OR: [{ lastSeenAt: { lt: after.lastSeenAt } }, { lastSeenAt: after.lastSeenAt, id: { lt: after.id } }] } : {}),
        },
        orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
        take: LISTING_PAGE_SIZE,
        include: {
          priceHistory: { orderBy: { observedAt: "desc" }, take: 20 },
          analyses: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], distinct: ["searchId"] },
          searches: { include: { search: true, currentAnalysis: true } },
          matchesAsA: true,
          matchesAsB: true,
        },
      });
      const currentSettings = new Map(listings.flatMap(({ searches }) => searches.map(({ search }) => [search.id, getUsedSearchSettings(search.opportunitySettings)] as const)));
      const legacyLinks = listings.flatMap(({ id, analyses, searches }) => searches.flatMap(({ searchId }) => (
        !currentSettings.get(searchId) && analyses.some((analysis) => analysis.searchId === searchId && analysis.opportunity !== null)
          ? [{ listingId: id, searchId }] : []
      )));
      const legacyAnalyses = legacyLinks.length === 0 ? [] : await prisma.listingAnalysis.findMany({
        where: { opportunity: { equals: Prisma.AnyNull }, OR: legacyLinks },
        distinct: ["listingId", "searchId"],
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const analysisKey = ({ listingId, searchId }: { listingId: string; searchId: string }) => JSON.stringify([listingId, searchId]);
      const latestLegacy = new Map(legacyAnalyses.map((analysis) => [analysisKey(analysis), analysis]));
      return listings.map((listing) => {
        const analyses = new Map(listing.analyses.map((analysis) => [analysis.searchId, analysis]));
        const listingSnapshot = stableStringify(listingAnalysisSnapshot(listing));
        return {
          ...listing,
          searches: listing.searches.map(({ search, currentAnalysis, ...link }) => {
            const settings = currentSettings.get(search.id) ?? null;
            const pointedAnalysis = currentAnalysis?.searchId === link.searchId && currentAnalysis.listingId === link.listingId
              ? currentAnalysis : undefined;
            const analysis = (settings ? pointedAnalysis : latestLegacy.get(analysisKey(link))) ?? analyses.get(link.searchId);
            const opportunity = analysis?.opportunity;
            const current = opportunity && typeof opportunity === "object" && !Array.isArray(opportunity)
              ? settings !== null && listingSnapshot === stableStringify(opportunity.listingSnapshot)
                && stableStringify(searchCriteriaSnapshot(search)) === stableStringify(opportunity.searchCriteriaSnapshot)
              : settings === null;
            return {
              ...link,
              search: { id: search.id, name: search.name, purpose: settings?.purpose ?? null },
              analyses: analysis ? [{ ...analysis, current }] : [],
            };
          }),
        };
      });
    },
    listRuns: (searchId) => prisma.searchRun.findMany({
      ...(searchId ? { where: { searchId } } : {}),
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 100,
      include: { search: { select: { name: true } } },
    }),
    async listComparisons() {
      const listings = await prisma.listing.findMany({ where: { suppressedAt: null, active: true }, orderBy: { lastSeenAt: "desc" }, take: 100 });
      const candidate = (item: typeof listings[number]): ProductCandidate => {
        const attrs = item.attributes && typeof item.attributes === "object" && !Array.isArray(item.attributes) ? item.attributes : {};
        const field = (name: string) => typeof attrs[name] === "string" ? attrs[name] as string : null;
        const condition = field("condition");
        return { id: item.id, source: item.source, title: item.title, brand: field("brand"), mpn: field("mpn"), gtin: field("gtin"), condition: condition === "new" || condition === "used" ? condition : "unknown", currency: item.currency };
      };
      const results = [];
      for (let i = 0; i < listings.length; i++) for (let j = i + 1; j < listings.length; j++) {
        const a = listings[i], b = listings[j];
        if (!a || !b) continue;
        const match = compareProducts(candidate(a), candidate(b));
        if (match) results.push({ ...match, left: { title: a.title, source: a.source, price: a.price, url: a.url }, right: { title: b.title, source: b.source, price: b.price, url: b.url }, currency: a.currency });
      }
      return results;
    },
    listNotifications: () => prisma.notification.findMany({ orderBy: { claimedAt: "desc" }, take: 100, include: { listing: { select: { title: true } }, search: { select: { name: true } } } }),
    async listSources() {
      const current = (["mercadolivre", "olx", "facebook", "kabum", "terabyte"] as const).map((name) => {
        if (!app.marketplaces.has(name)) return { name, status:"disabled", error:null };
        return {name, ...app.marketplaces.getStatus(name)};
      });
      return current;
    },
  };
}
