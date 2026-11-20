import { setTimeout as delay } from "node:timers/promises";
import { ProviderError, type MarketplaceProvider } from "../provider.js";
import { isMarketplaceUrl, type ListingDetails, type ListingSummary, type MarketplaceSearchCriteria } from "../types.js";
import { parseRetailDetails, parseRetailSearch, type RetailName } from "./parser.js";

interface RetailOptions { fetcher?: typeof fetch; intervalMs?: number }
export class RetailProvider implements MarketplaceProvider {
  readonly name: RetailName;
  private readonly fetcher: typeof fetch;
  private readonly intervalMs: number;
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private status: { status: "configured_unverified" | "working" | "blocked" | "error"; error: string | null } = {status:"configured_unverified",error:null};
  private searchSucceeded = false;
  getStatus() { return { ...this.status }; }
  private failed(error: unknown): never {
    const code = error instanceof ProviderError ? error.code : "retail_request_failed";
    if (code === "retail_offer_unavailable") throw error;
    this.status = { status: code.endsWith("_access_blocked") ? "blocked" : "error", error: code };
    throw error;
  }
  constructor(name: RetailName, private readonly maxListings: number, private readonly timeoutMs: number, options: RetailOptions = {}) {
    this.name = name; this.fetcher = options.fetcher ?? fetch; this.intervalMs = options.intervalMs ?? 1000;
  }
  async search(criteria: MarketplaceSearchCriteria): Promise<ListingSummary[]> {
    const url = this.name === "kabum" ? new URL(`/busca/${encodeURIComponent(criteria.query.trim().replace(/\s+/g, "-"))}`, "https://www.kabum.com.br") : new URL("https://www.terabyteshop.com.br/busca");
    if (this.name === "terabyte") url.searchParams.set("str", criteria.query);
    try {
      const html = await this.request(url);
      const result = parseRetailSearch(this.name, html).slice(0, Math.min(criteria.limit, this.maxListings));
      this.searchSucceeded = true;
      this.status = { status:"configured_unverified", error:null };
      return result;
    } catch (error) { return this.failed(error); }
  }
  async getListingDetails(listing: ListingSummary): Promise<ListingDetails> {
    if (listing.source !== this.name || !isMarketplaceUrl(this.name, listing.url)) throw new ProviderError("retail_untrusted_url", "Invalid product URL");
    try {
      const result = parseRetailDetails(this.name, listing, await this.request(new URL(listing.url)));
      this.status = { status:this.searchSucceeded ? "working" : "configured_unverified", error:null };
      return result;
    } catch (error) { return this.failed(error); }
  }
  private request(url: URL): Promise<string> {
    const operation = this.queue.then(async () => {
      if (this.status.status === "blocked") throw new ProviderError(`${this.name}_access_blocked`, "Collection stopped after a previous access block");
      let current = url;
      let response: Response | null = null;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const wait = Math.max(0, this.lastRequestAt + this.intervalMs - Date.now());
        if (wait) await delay(wait);
        this.lastRequestAt = Date.now();
        response = await this.fetcher(current, { redirect:"manual", headers:{"user-agent":"AI-Deal-Finder/0.1 (personal research)", "accept":"text/html"}, signal:AbortSignal.timeout(this.timeoutMs) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3) throw new ProviderError("retail_redirect_limit", "Store redirect was missing or exceeded the limit");
        let next: URL;
        try { next = new URL(location, current); } catch { throw new ProviderError("retail_untrusted_redirect", "Invalid redirect destination"); }
        if (!isMarketplaceUrl(this.name, next.toString())) throw new ProviderError("retail_untrusted_redirect", "Store redirected outside its domain");
        current = next;
      }
      if (!response) throw new ProviderError("retail_empty_response", "Store returned no response");
      if ([401,403,429].includes(response.status)) { this.status = { status:"blocked", error:`${this.name}_access_blocked` }; await response.body?.cancel(); throw new ProviderError(`${this.name}_access_blocked`, `Store returned HTTP ${response.status}; collection stopped`); }
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`${this.name}_http_error`, `Store returned HTTP ${response.status}`, response.status >= 500); }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError(`${this.name}_empty_response`, "Store returned an empty response");
      let total = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 4_000_000) { await reader.cancel(); throw new ProviderError(`${this.name}_response_too_large`, "Store response is too large"); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const html = new TextDecoder().decode(Buffer.concat(chunks));
      if (/checking your browser|just a moment\.\.\.|captcha|access denied|attention required/i.test(html.slice(0, 30_000)) && !/application\/ld\+json/i.test(html)) throw new ProviderError(`${this.name}_access_blocked`, "Store returned a challenge or access block");
      return html;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
