import type { ListingAnalysis, Search } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { CategoryAnalyzer } from "../categories/analyzer.js";
import { detectCategory } from "../categories/detector.js";
import { CategoryAnalyzerRegistry } from "../categories/registry.js";
import { listingCategorySchema, type ListingCategory, type StructuredListing } from "../categories/types.js";
import { validateCategoryData } from "../categories/validation.js";
import type { DealAnalysis, ExtractedListingData, LLMProvider } from "../llm/types.js";
import {
  ListingRepository,
  listingFenceFor,
  type ComparableRecord,
  type ListingFence,
} from "../listings/repository.js";
import { deduplicateListings } from "../listings/deduplication.js";
import { MarketAnalysisService } from "../market-analysis/service.js";
import type { MarketStatistics } from "../market-analysis/statistics.js";
import { findCrossMarketplaceMatch } from "../matching/cross-marketplace.js";
import { isStrongUsedDuplicate } from "../matching/used-duplicates.js";
import { MarketplaceRegistry } from "../marketplaces/registry.js";
import { ProviderError } from "../marketplaces/provider.js";
import {
  listingSummarySchema,
  listingDetailsSchema,
  isMarketplaceUrl,
  marketplaceNameSchema,
  marketplaceSearchCriteriaSchema,
  type ListingDetails,
  type ListingSummary,
  type MarketplaceName,
} from "../marketplaces/types.js";
import { formatDealNotification, TelegramNotifier } from "../notifications/telegram.js";
import { applyDeterministicFilters } from "../scoring/filters.js";
import { calculateDeterministicScore, combineScores, verdictForScore } from "../scoring/hybrid.js";
import { mapWithConcurrency } from "../utils/collections.js";
import { listingContentHash, sha256, stableStringify } from "../utils/hash.js";
import { prisma } from "../db/client.js";
import { evaluateOpportunity } from "../opportunities/evaluation.js";
import { inspectUsedListing } from "../opportunities/condition.js";
import { getUsedSearchSettings } from "../opportunities/settings.js";
import { SearchRunTracker } from "./search-runs.js";
import { listingAnalysisSnapshot, searchCriteriaSnapshot } from "../searches/snapshot.js";

export interface SearchRunnerOptions {
  detailConcurrency: number;
  defaultLimit: number;
  comparableMaxAgeDays: number;
}

interface PreparedListing {
  listingId: string;
  listingFence: ListingFence;
  source: MarketplaceName;
  category: ListingCategory;
  details: ListingDetails;
  analyzer: CategoryAnalyzer;
  deterministic: StructuredListing;
  enriched: StructuredListing;
  extractionModel: string | null;
}

const ANALYSIS_PIPELINE_VERSION = 3;
const SEARCH_RUN_LEASE_MS = 30 * 60_000;
const SEARCH_RUN_HEARTBEAT_MS = 60_000;
const LLM_RETRY_BACKOFF_MS = 60 * 60_000;

interface AnalysisPipelineIdentity {
  pipelineVersion: number;
  extractionModel: string | null;
  analysisModel: string | null;
}

export function validateProviderDetails(summary: ListingSummary, value: unknown): ListingDetails {
  const parsed = listingDetailsSchema.safeParse(value);
  if (!parsed.success
    || parsed.data.source !== summary.source
    || (summary.externalId !== null && parsed.data.externalId !== summary.externalId)
    || !isMarketplaceUrl(summary.source, parsed.data.url)) {
    throw new Error("provider_listing_details_invalid");
  }
  return parsed.data;
}

export function analysisInputHash(
  search: Search,
  details: ListingDetails,
  deterministic: StructuredListing,
  enriched: StructuredListing,
  market: MarketStatistics,
  priceHistory: Array<{ price: number; observedAt: Date }>,
  pipeline: AnalysisPipelineIdentity,
  listingSnapshot?: Record<string, unknown>,
): string {
  return sha256(stableStringify({
    listing: {
      contentHash: listingContentHash(details),
      currency: details.currency,
      location: details.location,
      source: details.source,
    },
    deterministic,
    enriched,
    market,
    priceHistory,
    pipeline,
    search: analysisCriteriaSnapshot(search),
    ...(getUsedSearchSettings(search.opportunitySettings) && listingSnapshot ? { listingSnapshot } : {}),
  }));
}

function analysisCriteriaSnapshot(search: Search): Record<string, unknown> {
  const snapshot = searchCriteriaSnapshot(search);
  if (!getUsedSearchSettings(search.opportunitySettings)) delete snapshot["opportunitySettings"];
  return snapshot;
}

export class SearchRunner {
  readonly #marketAnalysis = new MarketAnalysisService();
  readonly #runs = new Map<string, SearchRunTracker>();
  #stopRequested = false;

  public constructor(
    private readonly marketplaces: MarketplaceRegistry,
    private readonly analyzers: CategoryAnalyzerRegistry,
    private readonly listings: ListingRepository,
    private readonly llm: LLMProvider | null,
    private readonly telegram: TelegramNotifier | null,
    private readonly logger: Logger,
    private readonly options: SearchRunnerOptions,
  ) {}

  requestStop(): void {
    this.#stopRequested = true;
  }

  async recoverInterruptedRuns(now: Date): Promise<void> {
    await SearchRunTracker.recoverInterrupted(now);
  }

  async run(search: Search): Promise<void> {
    if (this.#stopRequested) {
      this.logger.info({ event: "search_skipped_shutdown", searchId: search.id }, "Search skipped because shutdown has started");
      return;
    }
    const leaseId = randomUUID();
    if (!await this.acquireRunLease(search, leaseId)) {
      this.logger.info({ event: "search_skipped_leased", searchId: search.id }, "Search is already running or the scheduler snapshot is stale");
      return;
    }
    const startedAt = Date.now();
    const heartbeat = this.startRunLeaseHeartbeat(search.id, leaseId);
    this.logger.info({ event: "search_started", searchId: search.id, query: search.query }, "Search started");
    let discovered = 0;
    let analyzed = 0;
    let completed = false;
    const settings = getUsedSearchSettings(search.opportunitySettings);
    const run = settings ? new SearchRunTracker(leaseId, search.id) : null;
    try {
      if (run) {
        await run.start();
        this.#runs.set(leaseId, run);
      }
      const collected: ListingSummary[] = [];
      const searchCriteria = marketplaceSearchCriteriaSchema.parse({
        query: search.query,
        minPrice: search.minPrice?.toNumber() ?? null,
        maxPrice: search.maxPrice?.toNumber() ?? null,
        minYear: search.minYear,
        maxYear: search.maxYear,
        location: search.location,
        radiusKm: search.radiusKm,
        limit: this.options.defaultLimit,
      });

      for (const providerValue of search.providers) {
        if (this.#stopRequested) break;
        const parsedProvider = marketplaceNameSchema.safeParse(providerValue);
        const providerName = parsedProvider.success ? parsedProvider.data : null;
        const sourceCriteria = settings
          ? marketplaceSearchCriteriaSchema.parse({
            ...searchCriteria,
            location: providerName === "facebook" ? settings.facebookLocation : null,
            radiusKm: providerName === "facebook" ? settings.facebookRadiusKm : null,
            ...(providerName === "facebook" ? { verifyLocation: true } : {}),
            ...(providerName === "mercadolivre" ? { condition: "used" } : {}),
          })
          : searchCriteria;
        if (providerName) run?.beginSource(providerName, sourceCriteria.location ?? null, sourceCriteria.radiusKm ?? null);
        await run?.save();
        if (!parsedProvider.success || !this.marketplaces.has(parsedProvider.data)
          || (settings && providerName !== "olx" && providerName !== "facebook" && providerName !== "mercadolivre")) {
          if (providerName) {
            run?.sourceFailed(providerName, new ProviderError("provider_disabled", "Provider disabled", false), true);
            await run?.save();
          }
          this.logger.warn({ event: "provider_skipped", provider: providerValue, searchId: search.id }, "Provider is unknown or disabled");
          continue;
        }
        const provider = this.marketplaces.get(parsedProvider.data);
        await this.renewRunLease(search.id, leaseId);
        this.logger.info({ event: "provider_search_started", provider: provider.name, searchId: search.id }, "Provider search started");
        try {
          const rawSummaries = await provider.search(sourceCriteria);
          await this.renewRunLease(search.id, leaseId);
          const validSummaries: ListingSummary[] = [];
          for (const [index, rawSummary] of rawSummaries.entries()) {
            const parsed = listingSummarySchema.safeParse(rawSummary);
            if (!parsed.success || parsed.data.source !== provider.name || !isMarketplaceUrl(provider.name, parsed.data.url)) {
              this.logger.warn({
                event: "provider_listing_invalid",
                provider: provider.name,
                searchId: search.id,
                index,
                issues: parsed.success ? [parsed.data.source !== provider.name ? "source_mismatch" : "untrusted_marketplace_url"] : parsed.error.issues,
              }, "Provider returned an invalid listing");
              continue;
            }
            validSummaries.push(parsed.data);
          }
          const summaries = deduplicateListings(validSummaries);
          if (rawSummaries.length > 0 && summaries.length === 0) {
            throw new ProviderError("provider_results_invalid", "All returned listings were invalid", true);
          }
          this.marketplaces.recordSuccess(provider.name, "search");
          collected.push(...summaries);
          discovered += summaries.length;
          run?.sourceSucceeded(provider.name, summaries.length);
          this.logger.info({ event: "provider_search_completed", provider: provider.name, searchId: search.id, listings: summaries.length }, "Provider search completed");
        } catch (error) {
          run?.sourceFailed(provider.name, error);
          this.marketplaces.recordFailure(provider.name, error);
          this.logger.error({ event: "provider_search_failed", provider: provider.name, searchId: search.id, err: error }, "Provider search failed");
        }
        await run?.save();
      }

      const summaries = deduplicateListings(collected);
      const prepared = (await mapWithConcurrency(summaries, this.options.detailConcurrency, (summary, index) =>
        this.prepareListingSafely(search, summary, index, leaseId))).filter((item): item is PreparedListing => item !== null);

      const results = await mapWithConcurrency(prepared, this.options.detailConcurrency, (item, index) =>
        this.analyzeListingSafely(search, item, index, leaseId));
      analyzed = results.filter(Boolean).length;
      completed = true;
    } finally {
      this.#runs.delete(leaseId);
      try {
        await heartbeat.stop();
        await run?.finish(discovered, analyzed, completed, this.#stopRequested);
      } finally {
        await this.releaseRunLease(search.id, leaseId, completed && !this.#stopRequested);
      }
    }
    this.logger.info({ event: "search_completed", searchId: search.id, discovered, analyzed, durationMs: Date.now() - startedAt }, "Search completed");
  }

  private async prepareListingSafely(search: Search, summary: ListingSummary, index: number, leaseId: string): Promise<PreparedListing | null> {
    if (this.#stopRequested) return null;
    try {
      await this.renewRunLease(search.id, leaseId);
      return await this.prepareListing(search, summary, leaseId);
    }
    catch (error) {
      this.#runs.get(leaseId)?.detailFailed(summary.source);
      this.logger.error({
        event: "listing_preparation_failed",
        searchId: search.id,
        provider: summary.source,
        externalId: summary.externalId,
        index,
        err: error,
      }, "Listing preparation failed; remaining listings will continue");
      return null;
    }
  }

  private async prepareListing(search: Search, summary: ListingSummary, leaseId: string): Promise<PreparedListing | null> {
    const configuredCategory = listingCategorySchema.parse(search.category);
    const saved = await this.listings.upsertSummary(search.id, configuredCategory, summary);
    if (saved.suppressed) {
      this.logger.debug({ event: "listing_suppressed", listingId: saved.listing.id, source: summary.source }, "Suppressed listing was ignored");
      return null;
    }
    this.logger.debug({ event: saved.isNew ? "listing_discovered" : "listing_updated", listingId: saved.listing.id, source: summary.source }, "Listing persisted");
    let details = this.listings.toDetails(saved.listing);
    let currentFence = listingFenceFor(saved.listing);
    let contentChanged = saved.contentChanged;
    if (saved.needsDetails) {
      let fetchedDetails: ListingDetails | null = null;
      try {
        fetchedDetails = validateProviderDetails(summary, await this.marketplaces.get(summary.source).getListingDetails(summary));
        this.marketplaces.recordSuccess(summary.source, "details");
      } catch (error) {
        this.#runs.get(leaseId)?.detailFailed(summary.source);
        if (error instanceof ProviderError && ["retail_offer_unavailable", "listing_unavailable"].includes(error.code)) {
          await this.listings.markUnavailable(saved.listing.id, currentFence);
          this.logger.info({ event: "listing_unavailable", listingId: saved.listing.id }, "Unavailable retail offer skipped");
          return null;
        }
        this.marketplaces.recordFailure(summary.source, error);
        const checked = await this.listings.markDetailsChecked(saved.listing.id, currentFence);
        this.logger.warn({ event: "listing_details_failed", listingId: saved.listing.id, source: summary.source, err: error }, "Listing details unavailable; summary retained");
        if (!checked) return null;
        currentFence = listingFenceFor(checked);
      }
      if (fetchedDetails) {
        const detected = detectCategory(fetchedDetails, configuredCategory);
        const updated = await this.listings.updateDetails(saved.listing.id, detected, fetchedDetails, currentFence);
        if (!updated) return null;
        details = fetchedDetails;
        currentFence = listingFenceFor(updated.listing);
        contentChanged ||= updated.contentChanged;
        this.logger.debug({ event: "listing_details_fetched", listingId: saved.listing.id, source: summary.source }, "Listing details fetched");
      }
    }
    if (this.#stopRequested) return null;

    const category = detectCategory(details, configuredCategory);
    const analyzer = this.analyzers.get(category);
    this.logger.debug({ event: "listing_extraction_started", listingId: saved.listing.id, category }, "Listing extraction started");
    const deterministic = await analyzer.extract(details);
    const stored = await this.listings.getStructured(saved.listing.id);
    let enriched = deterministic;
    const storedMatchesContent = Boolean(stored?.enriched.category === category && !contentChanged);
    let extractionModel = storedMatchesContent ? stored?.extractionModel ?? null : null;
    let extractionAttemptModel = stored?.extractionAttemptModel ?? null;
    let extractionAttemptedAt = stored?.extractionAttemptedAt ?? null;
    const failedRecently = Boolean(
      this.llm
      && stored
      && stored.extractionModel !== this.llm.extractionModel
      && stored.extractionAttemptModel === this.llm.extractionModel
      && stored.extractionAttemptedAt
      && Date.now() - stored.extractionAttemptedAt.getTime() < LLM_RETRY_BACKOFF_MS,
    );
    const shouldAttemptExtraction = Boolean(this.llm
      && (saved.isNew || contentChanged || stored?.enriched.category !== category || stored?.extractionModel !== this.llm.extractionModel)
      && (!failedRecently || saved.isNew || contentChanged));
    if (this.llm && shouldAttemptExtraction) {
      extractionAttemptModel = this.llm.extractionModel;
      extractionAttemptedAt = new Date();
      const extraction = await this.enrichWithLlm(details, deterministic);
      if (extraction.succeeded) {
        enriched = extraction.structured;
        extractionModel = this.llm.extractionModel;
      } else if (storedMatchesContent && stored) {
        enriched = this.mergeSupplementalExtraction(deterministic, {
          data: stored.enriched.data,
          confidence: stored.enriched.extractionConfidence,
        });
      }
    } else if (storedMatchesContent && stored) {
      enriched = this.mergeSupplementalExtraction(deterministic, {
        data: stored.enriched.data,
        confidence: stored.enriched.extractionConfidence,
      });
    }
    await this.renewRunLease(search.id, leaseId);
    const structuredListing = await this.listings.saveStructured(
      saved.listing.id,
      enriched,
      deterministic,
      extractionModel,
      extractionAttemptModel,
      extractionAttemptedAt,
      listingContentHash(details),
      currentFence,
    );
    if (!structuredListing) return null;
    currentFence = listingFenceFor(structuredListing);
    this.logger.debug({ event: "listing_extraction_completed", listingId: saved.listing.id, category }, "Listing extraction completed");
    return { listingId: saved.listing.id, listingFence: currentFence, source: summary.source, category, details, analyzer, deterministic, enriched, extractionModel };
  }

  private async analyzeListingSafely(search: Search, prepared: PreparedListing, index: number, leaseId: string): Promise<boolean> {
    if (this.#stopRequested) return false;
    try {
      await this.renewRunLease(search.id, leaseId);
      const analyzed = await this.analyzeListing(search, prepared, leaseId);
      if (analyzed) this.#runs.get(leaseId)?.analysisCompleted();
      await this.#runs.get(leaseId)?.save();
      return analyzed;
    }
    catch (error) {
      this.#runs.get(leaseId)?.analysisFailed();
      this.logger.error({
        event: "listing_analysis_failed",
        searchId: search.id,
        listingId: prepared.listingId,
        provider: prepared.source,
        index,
        err: error,
      }, "Listing analysis failed; remaining listings will continue");
      return false;
    }
  }

  private async analyzeListing(search: Search, prepared: PreparedListing, leaseId: string): Promise<boolean> {
    const seenAfter = new Date(Date.now() - this.options.comparableMaxAgeDays * 24 * 60 * 60 * 1000);
    const settings = getUsedSearchSettings(search.opportunitySettings);
    const candidates = settings ? await this.listings.findUsedComparables(
      prepared.category,
      prepared.listingId,
      seenAfter,
      prepared.details.currency,
      async (details) => {
        if (inspectUsedListing(details).condition !== "used") return null;
        const structured = await prepared.analyzer.extract(details);
        return prepared.analyzer.isComparable(prepared.deterministic, structured) ? structured : null;
      },
    ) : (await this.listings.findComparables(
      prepared.category,
      prepared.listingId,
      seenAfter,
      prepared.details.currency,
    ))
      .filter((candidate) => candidate.structured.data["condition"] !== "damaged")
      .filter((candidate) => prepared.analyzer.isComparable(prepared.deterministic, candidate.structured));
    const withoutCurrentCrossPosts = await this.excludeCurrentCrossPosts(prepared, candidates, Boolean(settings));
    const comparable = await this.collapseProbableCrossPosts(withoutCurrentCrossPosts, Boolean(settings));
    const market = this.#marketAnalysis.calculate(comparable.map(({ id, source, price }) => ({ id, source, price })));
    this.logger.debug({ event: "market_reference_calculated", listingId: prepared.listingId, sampleSize: market.combined.sampleSize, confidence: market.combined.confidence }, "Market reference calculated");

    await this.matchCurrentListing(prepared.listingId, prepared.category, prepared.details);
    const priceHistory = await this.listings.getPriceHistory(prepared.listingId);
    const listingSnapshot = listingAnalysisSnapshot({
      ...prepared.details, contentHash: prepared.listingFence.contentHash, fingerprint: prepared.listingFence.fingerprint,
    });
    const inputHash = analysisInputHash(
      search,
      prepared.details,
      prepared.deterministic,
      prepared.enriched,
      market,
      priceHistory,
      {
        pipelineVersion: settings ? ANALYSIS_PIPELINE_VERSION : 2,
        extractionModel: prepared.extractionModel,
        analysisModel: this.llm?.analysisModel ?? null,
      },
      settings ? listingSnapshot : undefined,
    );
    const filter = applyDeterministicFilters({
      listing: prepared.details,
      structured: prepared.deterministic,
      criteria: {
        category: listingCategorySchema.parse(search.category),
        query: search.query,
        minPrice: search.minPrice?.toNumber() ?? null,
        maxPrice: search.maxPrice?.toNumber() ?? null,
        minYear: search.minYear,
        maxYear: search.maxYear,
        location: settings ? null : search.location,
        radiusKm: settings ? null : search.radiusKm,
        forbiddenWords: search.forbiddenWords,
      },
      alreadyAnalyzed: false,
      duplicate: false,
    });
    const filterReasons = settings ? filter.reasons.filter((reason) => reason !== "invalid_price") : filter.reasons;
    if (filterReasons.length) return false;

    const categoryAnalysis = await prepared.analyzer.analyze({
      listing: prepared.details,
      structured: prepared.deterministic,
      comparableListings: comparable.map((item) => item.structured),
      marketMedianPrice: market.combined.medianPrice,
      source: prepared.source,
    });
    const deterministicScore = calculateDeterministicScore(prepared.details, market, categoryAnalysis, search.maxPrice?.toNumber() ?? null);
    const opportunity = settings ? {
      ...evaluateOpportunity({ listing: prepared.details, settings, market: market.combined }),
      searchCriteriaSnapshot: searchCriteriaSnapshot(search),
      listingSnapshot,
      collectionScope: {
        location: prepared.source === "facebook" ? settings.facebookLocation : null,
        radiusKm: prepared.source === "facebook" ? settings.facebookRadiusKm : null,
        verified: true,
        distanceVerified: false,
      },
    } : null;
    const qualifiesForLlm = !settings && deterministicScore.score >= Math.max(40, search.minimumScore - 10) && market.combined.sampleSize >= 2;
    this.logger.debug({ event: "deal_candidate_selected", listingId: prepared.listingId, deterministicScore: deterministicScore.score, qualifiesForLlm }, "Candidate scored");
    const existing = await this.listings.findAnalysis(prepared.listingId, search.id, inputHash);
    const retryFailedLlm = Boolean(
      existing
      && this.llm
      && qualifiesForLlm
      && existing.analysisModel === null
      && Date.now() - (existing.llmAttemptedAt ?? existing.createdAt).getTime() >= LLM_RETRY_BACKOFF_MS,
    );
    if (existing && !retryFailedLlm) {
      await this.renewRunLease(search.id, leaseId);
      if (settings) await this.listings.setCurrentAnalysis(search.id, prepared.listingId, existing.id, prepared.listingFence);
      await this.notifyIfNeeded(search, prepared.details, prepared.listingFence, existing.id, this.dealAnalysisFromRecord(existing), market, existing.priceDifferencePercent?.toNumber() ?? null, leaseId);
      return false;
    }

    let analysis = this.fallbackAnalysis(deterministicScore.score, categoryAnalysis.advantages, categoryAnalysis.risks);
    if (opportunity) {
      analysis = {
        ...analysis,
        reason: opportunity.reason,
        risks: [...new Set([...analysis.risks, ...opportunity.warnings])],
      };
    }
    let analysisModel: string | null = null;
    let llmAttempted = false;
    if (this.llm && qualifiesForLlm) {
      llmAttempted = true;
      try {
        this.logger.info({ event: "llm_analysis_started", listingId: prepared.listingId }, "LLM deal analysis started");
        const llmResult = await this.llm.analyzeDeal({
          listing: prepared.details,
          structured: prepared.enriched,
          marketplace: prepared.source,
          market,
          priceHistory,
          deterministicScore: deterministicScore.score,
          searchCriteria: searchCriteriaSnapshot(search),
        });
        analysis = {
          ...llmResult,
          advantages: [...new Set([...categoryAnalysis.advantages, ...llmResult.advantages])].slice(0, 10),
          risks: [...new Set([...categoryAnalysis.risks, ...llmResult.risks])].slice(0, 10),
        };
        analysisModel = this.llm.analysisModel;
        this.logger.info({ event: "llm_analysis_completed", listingId: prepared.listingId }, "LLM deal analysis completed");
      } catch (error) {
        this.logger.error({ event: "llm_analysis_failed", listingId: prepared.listingId, err: error }, "LLM deal analysis failed; deterministic fallback used");
      }
    }
    const finalScore = this.llm && qualifiesForLlm && analysisModel ? combineScores(deterministicScore.score, analysis.score) : deterministicScore.score;
    analysis = { ...analysis, score: finalScore, verdict: verdictForScore(finalScore) };
    await this.renewRunLease(search.id, leaseId);
    const persistedAnalysis = await this.listings.createAnalysis({
      listingId: prepared.listingId,
      listingFence: prepared.listingFence,
      searchId: search.id,
      finalScore,
      deterministic: deterministicScore,
      analysis,
      market,
      analysisModel,
      llmAttempted,
      inputHash,
      ...(opportunity ? { opportunity } : {}),
    });
    if (!persistedAnalysis) return false;
    await this.renewRunLease(search.id, leaseId);
    await this.notifyIfNeeded(
      search,
      prepared.details,
      prepared.listingFence,
      persistedAnalysis.id,
      this.dealAnalysisFromRecord(persistedAnalysis),
      market,
      persistedAnalysis.priceDifferencePercent?.toNumber() ?? null,
      leaseId,
    );
    return true;
  }

  private async notifyIfNeeded(
    search: Search,
    details: ListingDetails,
    listingFence: ListingFence,
    analysisId: string,
    analysis: DealAnalysis,
    market: MarketStatistics,
    differencePercent: number | null,
    leaseId: string,
  ): Promise<void> {
    if (this.#stopRequested || getUsedSearchSettings(search.opportunitySettings) || !this.telegram || analysis.score < search.minimumScore) return;
    const current = await prisma.search.findUnique({ where: { id: search.id } });
    if (!current?.active || stableStringify(analysisCriteriaSnapshot(current)) !== stableStringify(analysisCriteriaSnapshot(search))) return;
    const claim = await this.listings.claimNotification({
      analysisId, channel: "telegram", listingFence, searchCriteria: searchCriteriaSnapshot(search), runLeaseId: leaseId,
    });
    if (!claim) return;
    const beforeDelivery = await prisma.search.findUnique({ where: { id: search.id } });
    if (!beforeDelivery?.active || beforeDelivery.runLeaseId !== leaseId || beforeDelivery.opportunitySettings !== null
      || stableStringify(analysisCriteriaSnapshot(beforeDelivery)) !== stableStringify(analysisCriteriaSnapshot(search))) {
      await this.listings.markNotificationFailed(claim, new Error("search_changed_before_delivery"));
      return;
    }
    try {
      await this.telegram.send(formatDealNotification(details, analysis.score, analysis, market, differencePercent));
      if (!await this.listings.markNotificationSent(claim)) {
        throw new Error("notification_claim_lost_after_send");
      }
    } catch (error) {
      await this.listings.markNotificationFailed(claim, error).catch((markError: unknown) => {
        this.logger.error({ event: "notification_failure_state_failed", analysisId, err: markError }, "Could not persist notification failure state");
      });
      throw error;
    }
    this.logger.info({ event: "notification_sent", analysisId, searchId: search.id }, "Telegram notification sent");
  }

  private dealAnalysisFromRecord(record: ListingAnalysis): DealAnalysis {
    return {
      score: record.score,
      verdict: verdictForScore(record.score),
      advantages: record.advantages,
      risks: record.risks,
      reason: record.reason,
    };
  }

  private async enrichWithLlm(
    details: ListingDetails,
    deterministic: StructuredListing,
  ): Promise<{ structured: StructuredListing; succeeded: boolean }> {
    if (!this.llm) return { structured: deterministic, succeeded: false };
    try {
      const extracted = await this.llm.extractListingData({ listing: details, category: deterministic.category, deterministicExtraction: deterministic });
      const structured = this.mergeSupplementalExtraction(deterministic, extracted);
      return { structured, succeeded: structured !== deterministic };
    } catch (error) {
      this.logger.warn({ event: "llm_extraction_failed", source: details.source, externalId: details.externalId, err: error }, "LLM extraction failed; deterministic extraction retained");
      return { structured: deterministic, succeeded: false };
    }
  }

  private mergeSupplementalExtraction(deterministic: StructuredListing, supplemental: ExtractedListingData): StructuredListing {
    const merged: Record<string, unknown> = { ...deterministic.data };
    for (const [key, proposed] of Object.entries(supplemental.data)) {
      const current = merged[key];
      if (current === null || current === undefined || current === "unknown") merged[key] = proposed;
      else if (Array.isArray(current) && Array.isArray(proposed)) merged[key] = [...new Set([...current, ...proposed])];
    }
    const validated = validateCategoryData(deterministic.category, merged);
    return validated
      ? { category: deterministic.category, data: validated, extractionConfidence: Math.max(deterministic.extractionConfidence, supplemental.confidence) }
      : deterministic;
  }

  private async collapseProbableCrossPosts(records: ComparableRecord[], usedOnly = false): Promise<ComparableRecord[]> {
    const excluded = new Set<string>();
    for (let left = 0; left < records.length; left += 1) {
      const a = records[left];
      if (!a || excluded.has(a.id)) continue;
      for (let right = left + 1; right < records.length; right += 1) {
        const b = records[right];
        if (!b || excluded.has(b.id)) continue;
        const match = findCrossMarketplaceMatch(a, b);
        if (usedOnly ? isStrongUsedDuplicate(a, b) : Boolean(match)) {
          excluded.add(b.id);
          if (match) await this.listings.saveCrossMatch(match.listingAId, match.listingBId, match.confidence, match.reasons);
        }
      }
    }
    return records.filter((record) => !excluded.has(record.id));
  }

  private async excludeCurrentCrossPosts(prepared: PreparedListing, records: ComparableRecord[], usedOnly = false): Promise<ComparableRecord[]> {
    const current = {
      id: prepared.listingId,
      source: prepared.source,
      title: prepared.details.title,
      price: prepared.details.price,
      location: prepared.details.location,
      sellerName: prepared.details.sellerName,
      imageUrl: prepared.details.imageUrl,
    };
    const retained: ComparableRecord[] = [];
    for (const candidate of records) {
      const match = findCrossMarketplaceMatch(current, candidate);
      if (!(usedOnly ? isStrongUsedDuplicate(current, candidate) : Boolean(match))) {
        retained.push(candidate);
        continue;
      }
      if (match) await this.listings.saveCrossMatch(match.listingAId, match.listingBId, match.confidence, match.reasons);
    }
    return retained;
  }

  private async matchCurrentListing(listingId: string, category: ListingCategory, details: ListingDetails): Promise<void> {
    for (const candidate of await this.listings.recentCrossMarketplaceCandidates(details.source, category, listingId)) {
      const match = findCrossMarketplaceMatch({ id: listingId, source: details.source, title: details.title, price: details.price, location: details.location }, candidate);
      if (match) await this.listings.saveCrossMatch(match.listingAId, match.listingBId, match.confidence, match.reasons);
    }
  }

  private fallbackAnalysis(score: number, advantages: string[], risks: string[]): DealAnalysis {
    return { score, verdict: verdictForScore(score), advantages, risks, reason: "Score calculado por regras determinísticas; análise LLM não executada." };
  }

  private async acquireRunLease(search: Search, leaseId: string): Promise<boolean> {
    const now = new Date();
    const claimed = await prisma.search.updateMany({
      where: {
        id: search.id,
        active: true,
        lastRunAt: search.lastRunAt,
        updatedAt: search.updatedAt,
        OR: [
          { runLeaseId: null, runLeaseExpiresAt: null },
          { runLeaseExpiresAt: { lte: now } },
        ],
      },
      data: { runLeaseId: leaseId, runLeaseExpiresAt: new Date(now.getTime() + SEARCH_RUN_LEASE_MS) },
    });
    return claimed.count === 1;
  }

  private startRunLeaseHeartbeat(searchId: string, leaseId: string): { stop(): Promise<void> } {
    let stopped = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) return;
      inFlight = inFlight
        .then(() => this.renewRunLease(searchId, leaseId))
        .catch((error: unknown) => {
          this.logger.error({ event: "search_run_lease_heartbeat_failed", searchId, err: error }, "Search run lease heartbeat failed");
        });
    }, SEARCH_RUN_HEARTBEAT_MS);
    timer.unref();
    return {
      stop: async (): Promise<void> => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  private async renewRunLease(searchId: string, leaseId: string): Promise<void> {
    const renewed = await prisma.search.updateMany({
      where: { id: searchId, runLeaseId: leaseId, active: true, runLeaseExpiresAt: { gt: new Date() } },
      data: { runLeaseExpiresAt: new Date(Date.now() + SEARCH_RUN_LEASE_MS) },
    });
    if (renewed.count !== 1) throw new Error("search_run_lease_lost");
  }

  private async releaseRunLease(searchId: string, leaseId: string, completed: boolean): Promise<void> {
    const released = await prisma.search.updateMany({
      where: { id: searchId, runLeaseId: leaseId, runLeaseExpiresAt: { gt: new Date() } },
      data: {
        runLeaseId: null,
        runLeaseExpiresAt: null,
        ...(completed ? { lastRunAt: new Date() } : {}),
      },
    });
    if (released.count !== 1) this.logger.warn({ event: "search_run_lease_release_missed", searchId }, "Search run lease was no longer owned during release");
  }
}
