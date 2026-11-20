import { access } from "node:fs/promises";
import type { Logger } from "pino";
import type { Page } from "playwright";
import { BrowserSession, progressiveScroll } from "../browser.js";
import { waitForListingPage } from "../browser-listing-page.js";
import { hasSearchResults } from "../browser-search-results.js";
import { ProviderError, type MarketplaceProvider } from "../provider.js";
import type { ListingDetails, ListingSummary, MarketplaceSearchCriteria } from "../types.js";
import { deduplicateListings } from "../../listings/deduplication.js";
import { OLX_SELECTORS } from "./selectors.js";
import { mapOlxDetails, parseOlxExternalId, parseOlxSearchCard, type OlxDetailDocument, type OlxSearchCard } from "./parser.js";

export class OlxProvider implements MarketplaceProvider {
  readonly name = "olx" as const;
  readonly #browser: BrowserSession;

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

  async search(criteria: MarketplaceSearchCriteria): Promise<ListingSummary[]> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const url = new URL("https://www.olx.com.br/brasil");
      url.searchParams.set("q", criteria.query);
      if (criteria.minPrice != null) url.searchParams.set("ps", String(Math.round(criteria.minPrice)));
      if (criteria.maxPrice != null) url.searchParams.set("pe", String(Math.round(criteria.maxPrice)));
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await this.assertNotBlocked(page);
      this.assertBrazilWide(page, criteria.query);
      if (!await hasSearchResults(page, OLX_SELECTORS.resultLinks, OLX_SELECTORS.emptyResults)) {
        this.assertBrazilWide(page, criteria.query);
        return [];
      }
      await progressiveScroll(page, 8);
      this.assertBrazilWide(page, criteria.query);
      const cards = await page.evaluate((selectors): OlxSearchCard[] => {
        const elements = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLAnchorElement>(selector)]);
        return [...new Set(elements)].map((element) => {
          const card = element.closest<HTMLElement>("section.olx-adcard") ?? element;
          return {
            href: element.href,
            title: element.querySelector("h2")?.textContent ?? element.getAttribute("title"),
            text: card.innerText,
            image: card.querySelector("img")?.src ?? null,
          };
        });
      }, [...OLX_SELECTORS.resultLinks]);
      const parsed = cards.map(parseOlxSearchCard).filter((item): item is ListingSummary => item !== null);
      if (parsed.length === 0) throw new ProviderError("olx_search_failed", "OLX showed listing links whose cards could not be parsed", true);
      return deduplicateListings(parsed).slice(0, Math.min(criteria.limit, this.maxListings));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("olx_search_failed", "OLX web search failed; inspect current layout", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async getListingDetails(listing: ListingSummary): Promise<ListingDetails> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const response = await page.goto(listing.url, { waitUntil: "domcontentloaded" });
      await this.assertNotBlocked(page);
      await waitForListingPage(page, listing, {
        parseId: parseOlxExternalId,
        readySelector: ['script[type="application/ld+json"]', ...OLX_SELECTORS.detailTitle, ...OLX_SELECTORS.detailDescription].join(","),
        unavailableText: OLX_SELECTORS.detailUnavailable,
        status: response?.status(),
      });
      const detail = await page.evaluate((selectors): OlxDetailDocument => {
        const reader = { firstText(candidates: readonly string[]): string | null {
          for (const selector of candidates) {
            const text = document.querySelector(selector)?.textContent?.trim();
            if (text) return text;
          }
          return null;
        } };
        const structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')]
          .map((script) => script.textContent ?? "");
        const attributes: Record<string, unknown> = {};
        const shippingText: string[] = [];
        for (const element of document.querySelectorAll(selectors.detailAttributes.join(","))) {
          const text = element.textContent?.trim();
          if (!text) continue;
          shippingText.push(text);
          const [key, ...rest] = text.split(":");
          const value = element.tagName === "DT" && element.nextElementSibling?.tagName === "DD"
            ? element.nextElementSibling.textContent?.trim() : rest.join(":").trim();
          if (key && value) attributes[key.trim()] = value;
        }
        return {
          title: reader.firstText(selectors.detailTitle),
          description: reader.firstText(selectors.detailDescription),
          priceText: reader.firstText(selectors.detailPrice),
          location: reader.firstText(["[aria-label*=Localização]", "[class*=location]"]),
          sellerName: reader.firstText(selectors.detailSeller),
          images: [...document.querySelectorAll<HTMLImageElement>("main img")].map((image) => image.src).filter((src) => /^https:\/\//.test(src)),
          attributes,
          publishedAt: null,
          structuredData,
          shippingText,
        };
      }, OLX_SELECTORS);
      return mapOlxDetails(listing, detail, this.storeRawData);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      this.logger.warn({ event: "listing_details_failed", provider: this.name, url: listing.url, err: error }, "OLX detail failed");
      throw new ProviderError("olx_listing_details_failed", "Could not parse OLX listing details", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async inspect(url: string, outputPath: string): Promise<void> {
    await this.requireSession();
    const page = await this.#browser.page();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.screenshot({ path: outputPath, fullPage: true });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async close(): Promise<void> { await this.#browser.close(); }

  private async requireSession(): Promise<void> {
    try { await access(this.storageStatePath); }
    catch { throw new ProviderError("olx_session_missing", `Run npm run olx:login to create ${this.storageStatePath}`); }
  }

  private assertBrazilWide(page: Page, query: string): void {
    const url = new URL(page.url());
    if (url.origin !== "https://www.olx.com.br" || !/^\/brasil\/?$/.test(url.pathname) || url.searchParams.get("q") !== query) {
      throw new ProviderError("olx_scope_unverified", "OLX redirected away from the requested Brazil-wide search", true);
    }
  }

  private async assertNotBlocked(page: Page): Promise<void> {
    const title = await page.title();
    const blocked = /cloudflare|attention required/i.test(title)
      || await page.getByText(/sorry, you have been blocked|unable to access olx\.com\.br/i).first().isVisible().catch(() => false);
    if (blocked) {
      this.logger.warn({ event: "provider_access_blocked", provider: this.name }, "OLX blocked this host; no bypass will be attempted");
      this.#browser.reloadOnNextPage();
      throw new ProviderError("olx_access_blocked", "OLX/Cloudflare blocked this host. Use an authorized normal-access environment; bypass is intentionally not implemented.");
    }
  }
}
