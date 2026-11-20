import { load } from "cheerio";
import { ProviderError } from "../provider.js";
import { isHttpUrl, isMarketplaceUrl, listingDetailsSchema, listingSummarySchema, type ListingDetails, type ListingSummary } from "../types.js";

export type RetailName = "kabum" | "terabyte";
type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const productType = (value: unknown): boolean => value === "Product" || (Array.isArray(value) && value.includes("Product"));
function products(html: string): RecordValue[] {
  const $ = load(html);
  const found: RecordValue[] = [];
  const walk = (input: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(input)) { for (const item of input.slice(0, 500)) walk(item, depth + 1); return; }
    const value = obj(input); if (!value) return;
    if (productType(value["@type"])) found.push(value);
    for (const key of ["@graph", "itemListElement", "item", "mainEntity"]) if (value[key]) walk(value[key], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_i, element) => { try { walk(JSON.parse($(element).text()), 0); } catch { /* malformed structured data is skipped */ } });
  return found;
}
function offerOf(product: RecordValue): RecordValue | null { const offers = product["offers"]; return obj(Array.isArray(offers) ? offers[0] : offers); }
function toSummary(source: RetailName, product: RecordValue, includeUnavailable = false): ListingSummary | null {
  const offer = offerOf(product);
  const url = str(offer?.["url"]) ?? str(product["url"]) ?? str(product["@id"]);
  if (!url || !isMarketplaceUrl(source, url)) return null;
  const pathId = new URL(url).pathname.match(/\/produto\/(\d+)(?:\/|$)/)?.[1];
  if (!pathId) return null;
  const priceValue = offer?.["price"];
  const price = typeof priceValue === "number" ? priceValue : typeof priceValue === "string" && /^\d+(?:\.\d+)?$/.test(priceValue) ? Number(priceValue) : null;
  if (price !== null && (!Number.isFinite(price) || price <= 0)) return null;
  const availability = str(offer?.["availability"]);
  if (!includeUnavailable && availability && /(?:OutOfStock|SoldOut|Discontinued)$/i.test(availability)) return null;
  const images = Array.isArray(product["image"]) ? product["image"] : [product["image"]];
  const image = images.map(str).find((item): item is string => item !== null && isHttpUrl(item)) ?? null;
  const result = listingSummarySchema.safeParse({source, externalId:pathId, title:str(product["name"]), price, currency:str(offer?.["priceCurrency"]), location:null, url, imageUrl:image});
  return result.success ? result.data : null;
}
function terabyteCards(html: string): ListingSummary[] {
  const $ = load(html);
  const entries: ListingSummary[] = [];
  $(".product-item").each((_index, element) => {
    const card = $(element);
    if (card.attr("data-tss-estoque") !== "1") return;
    const link = card.find("a.product-item__name").first();
    const href = link.attr("href");
    if (!href) return;
    let url: string;
    try { url = new URL(href, "https://www.terabyteshop.com.br").toString(); } catch { return; }
    if (!isMarketplaceUrl("terabyte", url)) return;
    const externalId = new URL(url).pathname.match(/\/produto\/(\d+)(?:\/|$)/)?.[1];
    const priceText = card.attr("data-tss-price");
    const price = priceText && /^\d+(?:\.\d+)?$/.test(priceText) ? Number(priceText) : null;
    if (!externalId || price === null || !Number.isFinite(price) || price <= 0) return;
    const imageUrl = card.find("a.product-item__image img").first().attr("src") ?? null;
    const parsed = listingSummarySchema.safeParse({ source:"terabyte", externalId, title:link.text().trim() || link.attr("title"), price, currency:"BRL", location:null, url, imageUrl: imageUrl && isHttpUrl(imageUrl) ? imageUrl : null });
    if (parsed.success) entries.push(parsed.data);
  });
  return entries;
}
export function parseRetailSearch(source: RetailName, html: string): ListingSummary[] {
  if (source === "terabyte") {
    const cards = terabyteCards(html);
    if (cards.length) return [...new Map(cards.map((item) => [item.externalId ?? item.url, item])).values()];
  }
  const values = products(html);
  if (!values.length) throw new ProviderError("retail_search_format_unrecognized", "Search page contains no recognizable products; it may have changed or have no results");
  const listings = values.map((item) => toSummary(source, item)).filter((item): item is ListingSummary => item !== null);
  if (!listings.length) throw new ProviderError("retail_search_format_unrecognized", "Search page did not contain valid product offers");
  return [...new Map(listings.map((item) => [item.externalId ?? item.url, item])).values()];
}
export function parseRetailDetails(source: RetailName, summary: ListingSummary, html: string): ListingDetails {
  for (const product of products(html)) {
    const parsed = toSummary(source, product, true);
    if (!parsed || parsed.externalId !== summary.externalId) continue;
    const offer = offerOf(product);
    if (/(?:OutOfStock|SoldOut|Discontinued)$/i.test(str(offer?.["availability"]) ?? "")) throw new ProviderError("retail_offer_unavailable", "Product is unavailable");
    const rawBrand = product["brand"];
    const brand = str(obj(rawBrand)?.["name"]) ?? str(rawBrand);
    const conditionValue = str(offer?.["itemCondition"]) ?? str(product["itemCondition"]);
    const condition = conditionValue?.endsWith("NewCondition") ? "new" : conditionValue?.endsWith("UsedCondition") ? "used" : "unknown";
    const availability = str(offer?.["availability"])?.split("/").pop() ?? null;
    const attrs = { brand, mpn:str(product["mpn"]), gtin:str(product["gtin"]) ?? str(product["gtin13"]), condition, availability };
    const images = Array.isArray(product["image"]) ? product["image"] : [product["image"]];
    const imageUrls = images.map(str).filter((item): item is string => item !== null && isHttpUrl(item)).slice(0,50);
    return listingDetailsSchema.parse({ ...summary, ...parsed, description:str(product["description"])?.slice(0,100_000) ?? null, sellerName:null, images:imageUrls, attributes:attrs });
  }
  throw new ProviderError("retail_details_format_unrecognized", "Product detail does not match the requested item");
}
