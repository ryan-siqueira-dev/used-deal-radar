import { describe, it, expect, vi } from "vitest";
import { parseRetailSearch, parseRetailDetails } from "../src/marketplaces/retail/parser.js";
import { RetailProvider } from "../src/marketplaces/retail/provider.js";
import { isMarketplaceUrl } from "../src/marketplaces/types.js";

const product = { "@type": "Product", name: "Placa exemplo", sku: "123456", brand: { name: "Marca" }, mpn: "ABC-12", image: "https://images.example.com/1.jpg", description: "Descrição sintética", offers: { url: "https://www.kabum.com.br/produto/123456/placa", price: 999.9, priceCurrency: "BRL", availability: "https://schema.org/InStock" } };
const page = (data: unknown) => `<html><script type="application/ld+json">${JSON.stringify(data)}</script></html>`;
const criteria = { query: "placa", limit: 5 };

describe("retail structured data", () => {
  it("extracts valid products and ignores untrusted URLs and malformed entries", () => {
    const listings = parseRetailSearch("kabum", page([product, {...product, offers: {...product.offers, url:"https://evil.example/produto/123456"}}, {"@type":"Product"}]));
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({source:"kabum", externalId:"123456", title:"Placa exemplo", price:999.9, currency:"BRL"});
  });
  it("rejects zero, negative and malformed prices", () => {
    for (const price of [0, -10, "bad"]) {
      const item = {...product, offers:{...product.offers, price}};
      if (price === "bad") expect(parseRetailSearch("kabum", page(item))[0]?.price).toBeNull();
      else expect(() => parseRetailSearch("kabum", page(item))).toThrow();
    }
  });
  it("reads the current detail price, condition and manufacturer identifier", () => {
    const summary = parseRetailSearch("kabum", page(product))[0]!;
    const details = parseRetailDetails("kabum", summary, page({...product, offers:{...product.offers,price:850}, itemCondition:"https://schema.org/NewCondition"}));
    expect(details).toMatchObject({price:850, description:"Descrição sintética", attributes:{brand:"Marca",mpn:"ABC-12",condition:"new",availability:"InStock"}});
  });
  it("reports an unavailable product detail without treating it as an offer", () => {
    const summary = parseRetailSearch("kabum", page(product))[0]!;
    expect(() => parseRetailDetails("kabum", summary, page({...product, offers:{...product.offers, availability:"https://schema.org/OutOfStock"}}))).toThrow("Product is unavailable");
  });
  it("rejects invalid or changed formats rather than claiming an empty successful search", () => {
    expect(() => parseRetailSearch("kabum", "<html><p>layout diferente</p></html>")).toThrow(/no recognizable products/);
  });
  it("allows only expected store domains", () => {
    expect(isMarketplaceUrl("kabum", "https://www.kabum.com.br/produto/123/x")).toBe(true);
    expect(isMarketplaceUrl("terabyte", "https://www.terabyteshop.com.br/produto/123/x")).toBe(true);
    expect(isMarketplaceUrl("kabum", "https://kabum.com.br.evil.example/produto/123/x")).toBe(false);
  });
});

describe("retail provider", () => {
  it("searches and retrieves details from public structured data", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(page(product), {status:200,headers:{"content-type":"text/html"}}));
    const provider = new RetailProvider("kabum", 5, 5000, { fetcher, intervalMs: 0 });
    const results = await provider.search(criteria);
    expect(results).toHaveLength(1);
    expect((await provider.getListingDetails(results[0]!)).externalId).toBe("123456");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(provider.getStatus().status).toBe("working");
  });
  it("follows a same-store redirect and rejects redirects to other domains", async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response(null,{status:308,headers:{location:"/busca/ssd"}})).mockImplementationOnce(async () => new Response(page(product),{status:200}));
    const provider = new RetailProvider("kabum",5,5000,{fetcher,intervalMs:0});
    expect(await provider.search(criteria)).toHaveLength(1);
    const hostile = vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:"https://evil.example/"}}));
    await expect(new RetailProvider("kabum",5,5000,{fetcher:hostile,intervalMs:0}).search(criteria)).rejects.toMatchObject({code:"retail_untrusted_redirect"});
    expect(hostile).toHaveBeenCalledTimes(1);
  });
  it("stops on access denial without retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("blocked",{status:403}));
    const provider = new RetailProvider("terabyte", 5, 5000, {fetcher, intervalMs: 0});
    await expect(provider.search(criteria)).rejects.toMatchObject({code:"terabyte_access_blocked"});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(provider.getStatus()).toMatchObject({status:"blocked", error:"terabyte_access_blocked"});
    await expect(provider.search(criteria)).rejects.toMatchObject({code:"terabyte_access_blocked"});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Terabyte search cards", () => {
  it("parses available products using the cash price and ignores unavailable cards", () => {
    const html = `<div class="product-item" data-tss-estoque="1" data-tss-price="1234.9"><div class="product-item__box"><a class="product-item__name" href="/produto/123/placa">Placa sintética</a><div class="product-item__new-price">R$ 1.234,90 à vista no Pix</div><div>12x de R$ 120,00</div></div></div>
    <div class="product-item" data-tss-estoque="0" data-tss-price="100"><a class="product-item__name" href="/produto/124/esgotado">Esgotado</a></div>`;
    expect(parseRetailSearch("terabyte", html)).toEqual([expect.objectContaining({source:"terabyte",externalId:"123",price:1234.9,url:"https://www.terabyteshop.com.br/produto/123/placa"})]);
  });
  it("rejects invalid prices and untrusted URLs", () => {
    const html = `<div class="product-item" data-tss-estoque="1" data-tss-price="0"><a class="product-item__name" href="/produto/123/a">Produto</a></div><div class="product-item" data-tss-estoque="1" data-tss-price="10"><a class="product-item__name" href="https://evil.example/produto/124/a">Produto</a></div>`;
    expect(() => parseRetailSearch("terabyte",html)).toThrow();
  });
});
