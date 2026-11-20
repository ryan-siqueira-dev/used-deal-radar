import { describe, expect, it, vi } from "vitest";
import { mapMercadoLivreWebDetails, isMercadoLivreUsedScope } from "../src/marketplaces/mercadolivre/web-parser.js";
import type { ListingSummary } from "../src/marketplaces/types.js";

const summary: ListingSummary = { source: "mercadolivre", externalId: "MLB1234567890", url: "https://produto.mercadolivre.com.br/MLB-1234567890-gpu-_JM", title: "GPU", price: 1200, currency: "BRL", location: null, imageUrl: null };
const detail = { title: "RX 6750 XT", description: "Usada funcionando", priceText: "R$ 1.399,90", condition: "Usado | 1 vendido", sellerName: "Vendedor", location: null, images: [], attributes: {}, shippingText: ["Envio para todo o país"], structuredData: [] };

describe("Mercado Livre used web parsing", () => {
  it("requires a Mercado Livre listing-search URL with an explicit used filter", () => {
    expect(isMercadoLivreUsedScope("https://lista.mercadolivre.com.br/rx-6750_ITEM*CONDITION_2230581_NoIndex_True")).toBe(true);
    expect(isMercadoLivreUsedScope("https://lista.mercadolivre.com.br/informatica/usado/rx-6750")).toBe(true);
    expect(isMercadoLivreUsedScope("https://lista.mercadolivre.com.br/rx-6750-usado")).toBe(false);
    expect(isMercadoLivreUsedScope("https://evil.example/rx_ITEM*CONDITION_2230581")).toBe(false);
  });
  it("retains condition and shipping evidence from the actual details", () => {
    expect(mapMercadoLivreWebDetails(summary, detail)).toMatchObject({ title: "RX 6750 XT", price: 1399.9, currency: "BRL", sellerName: "Vendedor", attributes: { condition: "Usado | 1 vendido", envio: "Envio para todo o país" } });
  });
  it("uses structured item condition and total price, without confusing installments", () => {
    const structuredData = [JSON.stringify({ "@type": "Product", name: "RX 6750 XT", offers: { price: 1500, priceCurrency: "BRL", itemCondition: "https://schema.org/UsedCondition" } })];
    expect(mapMercadoLivreWebDetails(summary, { ...detail, priceText: "12x R$ 125", structuredData })).toMatchObject({ price: 1500, attributes: { itemCondition: "https://schema.org/UsedCondition" } });
  });
  it("does not fall back to a stale summary price when detail price is missing", () => {
    expect(mapMercadoLivreWebDetails(summary, { ...detail, priceText: null })).toMatchObject({ price: null, currency: null });
  });
});

const runtime = vi.hoisted(() => ({ page: null as unknown }));
vi.mock("node:fs/promises", () => ({ access: async () => undefined, readFile: async () => '{"cookies":[]}' }));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: async () => ({ newPage: async () => runtime.page, close: async () => undefined }) } }));
vi.mock("../src/marketplaces/browser.js", () => ({ progressiveScroll: async () => undefined }));

import pino from "pino";
import { MercadoLivreWebProvider } from "../src/marketplaces/mercadolivre/web-provider.js";

function fakePage(options: { status?: number; redirect?: string; unavailable?: boolean; empty?: boolean } = {}) {
  let url = "";
  const locator = (visible = false): any => ({
    first() { return this; }, and() { return this; }, filter() { return this; }, or() { return this; },
    isVisible: async () => visible, waitFor: async () => undefined,
  });
  return {
    setDefaultTimeout() {}, close: async () => undefined, title: async () => "Mercado Livre",
    goto: vi.fn(async (value: string) => { url = options.redirect ?? value; return { status: () => options.status ?? 200 }; }),
    url: () => url,
    locator: () => locator(),
    getByText: (pattern: RegExp) => locator((options.unavailable && pattern.source.includes("Anúncio pausado")) || (options.empty && pattern.source.includes("Não há anúncios"))),
    evaluate: vi.fn(async () => detail),
  };
}
function provider(page: unknown) {
  runtime.page = page;
  return new MercadoLivreWebProvider("/tmp/ml-test", "/tmp/ml-state.json", true, 5, 100, pino({ level: "silent" }), { accessToken: undefined, clientId: undefined, clientSecret: undefined, tokenPath: "/tmp/ml-tokens", timeoutMs: 100 });
}

describe("Mercado Livre browser collection", () => {
  it("reports an access challenge even when HTTP 403 has an empty page title", async () => {
    const page = fakePage({ status: 403 });
    page.title = async () => "";
    await expect(provider(page).search({ query: "rx 6750 xt", condition: "used", limit: 5 })).rejects.toMatchObject({ code: "mercadolivre_web_challenge_required" });
  });
  it("rejects redirect losing the used filter", async () => {
    await expect(provider(fakePage({ redirect: "https://lista.mercadolivre.com.br/rx-6750-xt" })).search({ query: "rx 6750 xt", condition: "used", limit: 5 })).rejects.toMatchObject({ code: "mercadolivre_used_filter_unverified" });
  });
  it("accepts an explicit empty state with the used filter retained", async () => {
    const page = fakePage({ empty: true });
    await expect(provider(page).search({ query: "rx 6750 xt", condition: "used", limit: 5 })).resolves.toEqual([]);
    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining("_ITEM*CONDITION_2230581"), expect.anything());
  });
  it("reads actual browser details without requesting an API token", async () => {
    const page = fakePage();
    await expect(provider(page).getListingDetails(summary)).resolves.toMatchObject({ description: "Usada funcionando", price: 1399.9 });
    expect(page.evaluate).toHaveBeenCalledOnce();
  });
  it("rejects removed listings and identity redirects before parsing details", async () => {
    for (const options of [{ status: 404 }, { unavailable: true }, { redirect: "https://produto.mercadolivre.com.br/MLB-9876543210-other-_JM" }]) {
      const page = fakePage(options);
      await expect(provider(page).getListingDetails(summary)).rejects.toMatchObject({ code: "listing_unavailable" });
      expect(page.evaluate).not.toHaveBeenCalled();
    }
  });
});
