import { access } from "node:fs/promises";
import type { Logger } from "pino";
import type { Page } from "playwright";
import { BrowserSession, progressiveScroll } from "../browser.js";
import { waitForListingPage } from "../browser-listing-page.js";
import { hasSearchResults } from "../browser-search-results.js";
import { ProviderError, type MarketplaceProvider } from "../provider.js";
import { isMarketplaceUrl, type ListingDetails, type ListingSummary, type MarketplaceSearchCriteria } from "../types.js";
import { deduplicateListings } from "../../listings/deduplication.js";
import { FACEBOOK_SELECTORS } from "./selectors.js";
import { selectFacebookLocation, verifyFacebookLocation } from "./location.js";
import { mapFacebookDetails, parseFacebookExternalId, parseFacebookSearchCard, type FacebookDetailDocument, type FacebookSearchCard } from "./parser.js";

export class FacebookMarketplaceProvider implements MarketplaceProvider {
  readonly name = "facebook" as const;
  readonly #browser: BrowserSession;
  #searchTail: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly storageStatePath: string,
    headless: boolean,
    private readonly maxListings: number,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly storeRawData: boolean,
    executablePath?: string,
  ) {
    this.#browser = new BrowserSession({ headless, storageStatePath, ...(executablePath ? { executablePath } : {}) });
  }

  search(criteria: MarketplaceSearchCriteria): Promise<ListingSummary[]> {
    // The active Marketplace location is shared by pages in this session.
    const search = this.#searchTail.then(() => this.searchPage(criteria));
    this.#searchTail = search.catch(() => undefined);
    return search;
  }

  private async searchPage(criteria: MarketplaceSearchCriteria): Promise<ListingSummary[]> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const url = new URL("https://www.facebook.com/marketplace/search/");
      if (criteria.verifyLocation) {
        await this.withScopeVerification(criteria, async (location, radiusKm) => {
          await page.goto("https://www.facebook.com/marketplace/", { waitUntil: "domcontentloaded" });
          await this.assertAuthenticated(page);
          await selectFacebookLocation(page, location, radiusKm);
          const current = new URL(page.url());
          // Reuse a region path exposed by Marketplace after applying the UI filter.
          if (isMarketplaceUrl(this.name, current.href) && /^\/marketplace\/\d+\/?$/.test(current.pathname)) {
            url.pathname = `${current.pathname.replace(/\/$/, "")}/search/`;
          }
        });
      }
      url.searchParams.set("query", criteria.query);
      if (criteria.minPrice != null) url.searchParams.set("minPrice", String(Math.round(criteria.minPrice)));
      if (criteria.maxPrice != null) url.searchParams.set("maxPrice", String(Math.round(criteria.maxPrice)));
      if (criteria.radiusKm != null) url.searchParams.set("radius", String(criteria.radiusKm));
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await this.assertAuthenticated(page);
      if (criteria.verifyLocation) {
        await this.withScopeVerification(criteria, async (location, radiusKm) => {
          const current = new URL(page.url());
          if (!isMarketplaceUrl(this.name, current.href) || !/^\/marketplace\/(?:\d+\/)?search\/?$/.test(current.pathname)
            || current.searchParams.get("query") !== criteria.query) throw new Error("Facebook redirected away from the requested search");
          await verifyFacebookLocation(page, location, radiusKm);
        });
      }
      if (!await hasSearchResults(page, FACEBOOK_SELECTORS.resultLinks, FACEBOOK_SELECTORS.emptyResults)) return [];
      await progressiveScroll(page, 8, 900);
      const cards = await page.evaluate(({ selectors, scoped }): FacebookSearchCard[] => {
        const root = scoped ? document.querySelector(selectors.searchMain) : document;
        if (!root) return [];
        const links = selectors.resultLinks.join(",");
        const layout = {
          visible(element: Element) {
            return element.getClientRects().length > 0
              && element.checkVisibility?.({ visibilityProperty: true }) !== false
              && !element.closest('[hidden], [aria-hidden="true"]');
          },
        };
        const fallback = scoped ? [...root.querySelectorAll(selectors.fallbackLabels)].find((label) =>
          layout.visible(label) && !label.closest(links) && [label.getAttribute("aria-label"), label.textContent]
            .some((text) => selectors.fallbackResults.test(text?.replace(/\s+/g, " ").trim() ?? ""))) : undefined;
        // Marketplace appends broader matches below the primary local results.
        const elements = [...root.querySelectorAll<HTMLAnchorElement>(links)].filter((element) =>
          !scoped || (layout.visible(element) && !(fallback && (fallback.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))));
        return elements.map((element) => ({
          href: element.href,
          text: element.innerText,
          ariaLabel: element.getAttribute("aria-label"),
          image: element.querySelector("img")?.src ?? null,
        }));
      }, { selectors: FACEBOOK_SELECTORS, scoped: criteria.verifyLocation === true });
      const parsed = cards.map(parseFacebookSearchCard).filter((item): item is ListingSummary => item !== null);
      if (parsed.length === 0) throw new ProviderError("facebook_search_failed", "Facebook showed listing links whose cards could not be parsed", true);
      return deduplicateListings(parsed).slice(0, Math.min(criteria.limit, this.maxListings));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("facebook_search_failed", "Facebook Marketplace search failed; inspect the current layout", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  private async withScopeVerification(
    criteria: MarketplaceSearchCriteria,
    operation: (location: string, radiusKm: number) => Promise<void>,
  ): Promise<void> {
    try {
      if (!criteria.location || !criteria.radiusKm) throw new Error("Facebook needs a location and radius");
      await operation(criteria.location, criteria.radiusKm);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("facebook_scope_unverified", "Facebook Marketplace could not verify the requested location and radius", true, { cause: error });
    }
  }

  async getListingDetails(listing: ListingSummary): Promise<ListingDetails> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const response = await page.goto(listing.url, { waitUntil: "domcontentloaded" });
      await this.assertAuthenticated(page);
      await waitForListingPage(page, listing, {
        parseId: parseFacebookExternalId,
        readySelector: FACEBOOK_SELECTORS.detailMain.join(","),
        unavailableText: FACEBOOK_SELECTORS.detailUnavailable,
        status: response?.status(),
      });
      const detail = await page.evaluate((selectors): FacebookDetailDocument => {
        const main = document.querySelector<HTMLElement>(selectors.detailMain.join(","));
        const text = main?.innerText ?? "";
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        const metaTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? null;
        const title = metaTitle ?? document.querySelector("h1")?.textContent?.trim() ?? null;
        const priceText = lines.find((line) => /^R\$\s*[\d.]+(?:,\d{2})?/.test(line)) ?? null;
        const location = lines.find((line) => /,\s*[A-Z]{2}\b/.test(line)) ?? null;
        const descriptionIndex = lines.findIndex((line) => /^(descrição|description)$/i.test(line));
        const description = descriptionIndex >= 0 ? lines.slice(descriptionIndex + 1, descriptionIndex + 8).join("\n") : null;
        const sellerIndex = lines.findIndex((line) => /informações do vendedor|seller information/i.test(line));
        const sellerName = sellerIndex >= 0 ? lines[sellerIndex + 1] ?? null : null;
        const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
        const images = [...(main?.querySelectorAll<HTMLImageElement>('img[src^="https://"]') ?? [])]
          .map((image) => image.src)
          .filter((src) => !src.includes("emoji") && !src.includes("profile"));
        if (ogImage?.startsWith("https://")) images.unshift(ogImage);
        const structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .map((script) => script.textContent ?? "");
        return { title, text, description, priceText, location, sellerName, images, attributes: {}, structuredData };
      }, FACEBOOK_SELECTORS);
      return mapFacebookDetails(listing, detail, this.storeRawData);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      this.logger.warn({ event: "listing_details_failed", provider: this.name, url: listing.url, err: error }, "Facebook detail failed");
      throw new ProviderError("facebook_listing_details_failed", "Could not parse Facebook listing details", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async inspect(url: string, outputPath: string): Promise<void> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await this.assertAuthenticated(page);
      await page.screenshot({ path: outputPath, fullPage: true });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async close(): Promise<void> { await this.#browser.close(); }

  private async requireSession(): Promise<void> {
    try { await access(this.storageStatePath); }
    catch { throw new ProviderError("facebook_session_missing", `Run npm run facebook:login to create ${this.storageStatePath}`); }
  }

  private async assertAuthenticated(page: Page): Promise<void> {
    const onLoginUrl = /facebook\.com\/(login|checkpoint)/.test(page.url());
    const hasLoginForm = await page.locator(FACEBOOK_SELECTORS.loginMarkers.join(",")).first().isVisible().catch(() => false);
    if (onLoginUrl || hasLoginForm) {
      this.logger.warn({ event: "facebook_session_expired" }, "Facebook session expired");
      this.#browser.reloadOnNextPage();
      throw new ProviderError("facebook_session_expired", "Run npm run facebook:login to refresh the session");
    }
  }
}
