import { access, readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { Logger } from "pino";
import { deduplicateListings } from "../../listings/deduplication.js";
import { normalizeTitle } from "../../utils/normalization.js";
import { progressiveScroll } from "../browser.js";
import { ProviderError, type MarketplaceProvider } from "../provider.js";
import type { ListingDetails, ListingSummary, MarketplaceSearchCriteria } from "../types.js";
import type { MercadoLivreTokenManagerOptions } from "./auth.js";
import { waitForListingPage } from "../browser-listing-page.js";
import { hasSearchResults } from "../browser-search-results.js";
import { isMercadoLivreUsedScope, mapMercadoLivreWebDetails, parseMercadoLivreWebExternalId, parseMercadoLivreWebCard, type MercadoLivreWebCard, type MercadoLivreWebDetail } from "./web-parser.js";

export class MercadoLivreWebProvider implements MarketplaceProvider {
  readonly name = "mercadolivre" as const;
  #context: BrowserContext | null = null;
  #initializing: Promise<BrowserContext> | null = null;
  #sessionRestored = false;
  #closed = false;

  public constructor(
    private readonly profilePath: string,
    private readonly storageStatePath: string,
    private readonly headless: boolean,
    private readonly maxListings: number,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    _tokenOptions: MercadoLivreTokenManagerOptions,
    private readonly executablePath?: string,
  ) {
    // Keep the constructor compatible with the API provider configuration.
  }

  async search(criteria: MarketplaceSearchCriteria): Promise<ListingSummary[]> {
    await this.requireProfile();
    const page = await (await this.context()).newPage();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const slug = normalizeTitle(criteria.query).replace(/\s+/g, "-");
      const suffix = criteria.condition === "used" ? "_ITEM*CONDITION_2230581_NoIndex_True" : "";
      const response = await page.goto(`https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}${suffix}`, { waitUntil: "domcontentloaded" });
      await this.assertAccess(page, response?.status());
      this.assertScope(page, criteria);
      if (!await hasSearchResults(page, ["li.ui-search-layout__item a.poly-component__title", "li.ui-search-layout__item a.ui-search-link"], /Não há anúncios|Não encontramos anúncios|Nenhum resultado|Não encontramos resultados/i)) return [];

      await progressiveScroll(page, 6, 700);
      this.assertScope(page, criteria);
      const cards = await page.evaluate((): MercadoLivreWebCard[] =>
        [...document.querySelectorAll<HTMLElement>("li.ui-search-layout__item")].map((card) => {
          const link = card.querySelector<HTMLAnchorElement>("a.poly-component__title, a.ui-search-item__group__element");
          const amount = card.querySelector<HTMLElement>(".poly-price__amount, .andes-money-amount");
          const location = card.querySelector<HTMLElement>(".poly-component__location, [class*=location]");
          return {
            href: link?.href ?? "",
            title: link?.textContent ?? null,
            priceText: amount?.querySelector(".andes-money-amount__currency-symbol")?.textContent?.trim() === "R$" ? `R$ ${amount.querySelector(".andes-money-amount__fraction")?.textContent ?? ""}${amount.querySelector(".andes-money-amount__cents") ? `,${amount.querySelector(".andes-money-amount__cents")?.textContent}` : ""}` : null,
            image: card.querySelector<HTMLImageElement>("img")?.src ?? null,
            location: location?.textContent ?? null,
          };
        }));
      const valid = cards.map(parseMercadoLivreWebCard).filter((item): item is ListingSummary => item !== null);
      if (valid.length === 0) throw new ProviderError("mercadolivre_web_search_failed", "Mercado Livre result cards could not be parsed", true);
      const parsed = deduplicateListings(valid)
        .filter((item) => criteria.minPrice == null || item.price == null || item.price >= criteria.minPrice)
        .filter((item) => criteria.maxPrice == null || item.price == null || item.price <= criteria.maxPrice);
      return parsed.slice(0, Math.min(criteria.limit, this.maxListings));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("mercadolivre_web_search_failed", "Mercado Livre web search failed; refresh the browser profile if verification is requested", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  async getListingDetails(listing: ListingSummary): Promise<ListingDetails> {
    await this.requireProfile();
    const page = await (await this.context()).newPage();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      const response = await page.goto(listing.url, { waitUntil: "domcontentloaded" });
      await this.assertAccess(page, response?.status());
      await waitForListingPage(page, listing, {
        parseId: parseMercadoLivreWebExternalId,
        readySelector: "h1.ui-pdp-title",
        unavailableText: /Anúncio pausado|Anúncio finalizado|Este anúncio não está mais disponível|Publicação pausada|Publicação finalizada|Este produto não está disponível/i,
        status: response?.status(),
      });
      const detail = await page.evaluate((): MercadoLivreWebDetail => {
        const reader = { text(selector: string): string | null { return document.querySelector<HTMLElement>(selector)?.innerText?.trim() || null; } };
        const amount = document.querySelector<HTMLElement>(".ui-pdp-price__second-line .andes-money-amount, .ui-pdp-price .andes-money-amount");
        const fraction = amount?.querySelector(".andes-money-amount__fraction")?.textContent;
        const cents = amount?.querySelector(".andes-money-amount__cents")?.textContent;
        const attributes: Record<string, unknown> = {};
        for (const row of document.querySelectorAll(".ui-pdp-specs__table tr")) {
          const key = row.querySelector("th")?.textContent?.trim();
          const value = row.querySelector("td")?.textContent?.trim();
          if (key && value) attributes[key] = value;
        }
        return {
          title: reader.text("h1.ui-pdp-title"),
          description: reader.text(".ui-pdp-description__content"),
          priceText: fraction && amount?.querySelector(".andes-money-amount__currency-symbol")?.textContent?.trim() === "R$" ? `R$ ${fraction}${cents ? `,${cents}` : ""}` : null,
          condition: reader.text(".ui-pdp-subtitle"),
          sellerName: reader.text(".ui-pdp-seller__header__title, .ui-pdp-seller__link-trigger, .ui-pdp-seller__header__info"),
          location: reader.text(".ui-pdp-seller__location"),
          images: [...document.querySelectorAll<HTMLImageElement>(".ui-pdp-gallery__figure img")].map((image) => image.getAttribute("data-zoom") ?? image.src),
          attributes,
          shippingText: [...document.querySelectorAll<HTMLElement>(".ui-pdp-shipping, .ui-pdp-media__title, .ui-pdp-media__subtitle")].map((element) => element.innerText?.trim()).filter(Boolean),
          structuredData: [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent ?? ""),
        };
      });
      return mapMercadoLivreWebDetails(listing, detail);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("mercadolivre_listing_details_failed", "Could not read Mercado Livre listing details", true, { cause: error });
    } finally {
      await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); });
    }
  }

  private assertScope(page: Page, criteria: MarketplaceSearchCriteria): void {
    if (criteria.condition === "used" && !isMercadoLivreUsedScope(page.url())) {
      throw new ProviderError("mercadolivre_used_filter_unverified", "Mercado Livre redirected away from the requested used-item filter", true);
    }
  }

  private async assertAccess(page: Page, status: number | undefined): Promise<void> {
    const title = await page.title();
    if (status === 401 || status === 403 || status === 429
      || /seguridad|security|entrar|login|attention required/i.test(title)
      || /\/(captcha|login|gz\/account-verification)(?:\/|\?|$)/i.test(page.url())
      || await page.getByText(/Confirme que você é humano|Verifique se você é humano|Digite os caracteres que você vê/i).first().isVisible().catch(() => false)) {
      throw new ProviderError("mercadolivre_web_challenge_required", "Mercado Livre requires a manual browser verification. Run npm run mercadolivre:web-login.");
    }
    if (status !== undefined && status >= 500) throw new ProviderError("mercadolivre_web_http_error", `Mercado Livre returned HTTP ${status}`, true);
  }

  async inspect(url: string, outputPath: string): Promise<void> {
    await this.requireProfile();
    const page = await (await this.context()).newPage();
    try {
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.screenshot({ path: outputPath, fullPage: true });
    } finally { await page.close().catch((error: unknown) => { this.logger.warn({ event: "browser_page_close_failed", provider: this.name, err: error }, "Browser page could not be closed cleanly"); }); }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#initializing?.catch(() => undefined);
    const context = this.#context;
    this.#context = null;
    this.#initializing = null;
    this.#sessionRestored = false;
    await context?.close();
  }

  private async requireProfile(): Promise<void> {
    try { await access(this.profilePath); }
    catch { throw new ProviderError("mercadolivre_web_profile_missing", `Run npm run mercadolivre:web-login to create ${this.profilePath}`); }
  }

  private async context(): Promise<BrowserContext> {
    if (this.#closed) throw new ProviderError("mercadolivre_web_provider_closed", "Mercado Livre web provider is closed");
    if (this.#context) return this.#context;
    if (!this.#initializing) {
      this.#initializing = this.createContext().finally(() => { this.#initializing = null; });
    }
    return this.#initializing;
  }

  private async createContext(): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(this.profilePath, {
      headless: this.headless,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    });
    if (this.#closed) {
      await context.close().catch(() => undefined);
      throw new ProviderError("mercadolivre_web_provider_closed", "Mercado Livre web provider is closed");
    }
    this.#context = context;
    if (!this.#sessionRestored) {
      try {
        const state = JSON.parse(await readFile(this.storageStatePath, "utf8")) as {
          cookies?: Parameters<BrowserContext["addCookies"]>[0];
        };
        if (Array.isArray(state.cookies) && state.cookies.length > 0) await context.addCookies(state.cookies);
      } catch (error) {
        this.logger.warn({ event: "mercadolivre_web_session_restore_failed", err: error }, "Mercado Livre web cookies could not be restored");
      }
      this.#sessionRestored = true;
    }
    return context;
  }
}
