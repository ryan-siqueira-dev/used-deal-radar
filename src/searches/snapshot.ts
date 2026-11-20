import type { Search } from "@prisma/client";
import { getUsedSearchSettings } from "../opportunities/settings.js";

/** Business criteria only. Lease heartbeats must not invalidate analysis history. */
export function searchCriteriaSnapshot(search: Search): Record<string, unknown> {
  return {
    query: search.query,
    category: search.category,
    minPrice: search.minPrice?.toNumber() ?? null,
    maxPrice: search.maxPrice?.toNumber() ?? null,
    minYear: search.minYear,
    maxYear: search.maxYear,
    location: search.location,
    radiusKm: search.radiusKm,
    minimumScore: search.minimumScore,
    providers: [...search.providers].sort(),
    forbiddenWords: [...search.forbiddenWords].sort(),
    opportunitySettings: getUsedSearchSettings(search.opportunitySettings),
  };
}

export function listingAnalysisSnapshot(listing: {
  contentHash: string | null;
  fingerprint: string;
  price: number | { toNumber(): number } | null;
  currency: string | null;
  location: string | null;
  source: string;
}): Record<string, unknown> {
  return {
    contentHash: listing.contentHash,
    fingerprint: listing.fingerprint,
    price: typeof listing.price === "object" && listing.price !== null ? listing.price.toNumber() : listing.price,
    currency: listing.currency,
    location: listing.location,
    source: listing.source,
  };
}
