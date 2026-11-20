import type { ListingDetails, ListingSummary } from "../types.js";
import { nullableText } from "../../utils/normalization.js";
import { getStructuredListing } from "../structured-listing.js";
import { parseVisibleBrlPrice } from "../visible-price.js";

export function isMercadoLivreUsedScope(value: string): boolean {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    return url.protocol === "https:" && url.hostname === "lista.mercadolivre.com.br"
      && (/_ITEM\*CONDITION_2230581(?:_|\/|$)/i.test(path) || /\/usado(?:\/|$)/i.test(path));
  } catch { return false; }
}

export interface MercadoLivreWebDetail {
  title: string | null;
  description: string | null;
  priceText: string | null;
  condition: string | null;
  sellerName: string | null;
  location: string | null;
  images: string[];
  attributes: Record<string, unknown>;
  shippingText: string[];
  structuredData: string[];
}

export function mapMercadoLivreWebDetails(summary: ListingSummary, detail: MercadoLivreWebDetail): ListingDetails {
  const { product, offer, attributes } = getStructuredListing(detail.structuredData);
  const amount = offer?.["price"];
  const structuredPrice = typeof amount === "number" ? amount
    : typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount) ? Number(amount) : null;
  const structuredCurrency = typeof offer?.["priceCurrency"] === "string" && /^[A-Z]{3}$/i.test(offer["priceCurrency"])
    ? offer["priceCurrency"].toUpperCase() : null;
  const visiblePrice = parseVisibleBrlPrice(detail.priceText);
  const price = structuredCurrency && structuredPrice !== null && Number.isFinite(structuredPrice) && structuredPrice >= 0
    ? structuredPrice : visiblePrice;
  const currency = price === null ? null : structuredCurrency && structuredPrice === price ? structuredCurrency : "BRL";
  const imageData = product?.["image"];
  const images = [...new Set([...(Array.isArray(imageData) ? imageData : [imageData]), ...detail.images])]
    .filter((image): image is string => typeof image === "string" && /^https?:\/\//i.test(image)).slice(0, 50);
  return {
    ...summary,
    title: nullableText(typeof product?.["name"] === "string" ? product["name"] : detail.title)?.slice(0, 1000) ?? summary.title,
    description: nullableText(detail.description ?? (typeof product?.["description"] === "string" ? product["description"] : null))?.slice(0, 100_000) ?? null,
    price, currency,
    sellerName: nullableText(detail.sellerName)?.slice(0, 500) ?? null,
    location: nullableText(detail.location)?.slice(0, 500) ?? summary.location,
    images, imageUrl: images[0] ?? summary.imageUrl,
    attributes: Object.fromEntries(Object.entries({ ...attributes, ...detail.attributes,
      ...(detail.condition ? { condition: detail.condition } : {}),
      ...(detail.shippingText.length ? { envio: detail.shippingText.join("\n") } : {}),
    }).slice(0, 200)),
    publishedAt: null,
  };
}

export interface MercadoLivreWebCard {
  href: string;
  title: string | null;
  priceText: string | null;
  image: string | null;
  location: string | null;
}

export function parseMercadoLivreWebExternalId(href: string): string | null {
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* Keep the original URL. */ }
  const match = decoded.match(/(?:item_id:|[?&#]wid=)(MLB-?\d{6,})/i)
    ?? decoded.match(/\b(MLB-?\d{6,})\b/i);
  return match?.[1]?.replace("-", "").toUpperCase() ?? null;
}

export function parseMercadoLivreWebCard(card: MercadoLivreWebCard): ListingSummary | null {
  const title = nullableText(card.title);
  const externalId = parseMercadoLivreWebExternalId(card.href);
  if (!title || !externalId) return null;
  const price = parseVisibleBrlPrice(card.priceText);
  return {
    source: "mercadolivre",
    externalId,
    title,
    price,
    currency: price == null ? null : "BRL",
    location: nullableText(card.location),
    url: card.href,
    imageUrl: card.image && /^https?:\/\//.test(card.image) ? card.image : null,
  };
}
