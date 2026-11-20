import type { ListingDetails, ListingSummary } from "../types.js";
import { nullableText } from "../../utils/normalization.js";
import { addShippingEvidence, getStructuredListing } from "../structured-listing.js";
import { parseVisibleBrlPrice } from "../visible-price.js";

export interface FacebookSearchCard {
  href: string;
  text: string;
  ariaLabel: string | null;
  image: string | null;
}

export function parseFacebookExternalId(url: string): string | null {
  return new URL(url).pathname.match(/^\/marketplace\/item\/(\d+)\/?$/)?.[1] ?? null;
}

export function parseFacebookSearchCard(card: FacebookSearchCard): ListingSummary | null {
  const lines = card.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const priceLine = lines.find((line) => parseVisibleBrlPrice(line) !== null);
  const price = parseVisibleBrlPrice(priceLine);
  const title = nullableText(card.ariaLabel)
    ?? lines.find((line) => line !== priceLine && !/^R\$/.test(line) && line.length > 2)
    ?? null;
  if (!title) return null;
  const location = lines.find((line) => /,\s*[A-Z]{2}\b/.test(line)) ?? null;
  return {
    source: "facebook",
    externalId: parseFacebookExternalId(card.href),
    title,
    price,
    currency: price === null ? null : "BRL",
    location,
    url: card.href,
    imageUrl: card.image && /^https?:\/\//i.test(card.image) ? card.image : null,
  };
}

export interface FacebookDetailDocument {
  title: string | null;
  text: string;
  description: string | null;
  priceText: string | null;
  location: string | null;
  sellerName: string | null;
  images: string[];
  attributes: Record<string, unknown>;
  structuredData?: string[];
}

function usableDetailTitle(value: string | null): string | null {
  const title = nullableText(value)?.replace(/\s*[|·]\s*Facebook(?: Marketplace)?\s*$/i, "").trim() ?? null;
  if (!title || /^(notifica[cç][oõ]es|notifications|facebook|marketplace)$/i.test(title)) return null;
  return title;
}

export function mapFacebookDetails(summary: ListingSummary, detail: FacebookDetailDocument, storeRawData = false): ListingDetails {
  const images = [...new Set(detail.images.filter((image) => /^https?:\/\//i.test(image)))].slice(0, 50);
  const { attributes: structuredAttributes } = getStructuredListing(detail.structuredData);
  const attributes: Record<string, unknown> = { ...structuredAttributes, ...detail.attributes };
  const lines = detail.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const keys = /^(ano|quilometragem|transmiss[aã]o|combust[ií]vel|condi[cç][aã]o|estado(?: do produto)?|condition|marca|modelo|entrega|envio|frete|shipping)$/i;
  // Condition and fulfillment labels precede the listing description.
  const descriptionIndex = lines.findIndex((line) => /^(descri[cç][aã]o|description)$/i.test(line));
  const metadata = descriptionIndex === -1 ? lines : lines.slice(0, descriptionIndex);
  for (const [index, line] of metadata.entries()) {
    const [key, ...inlineValue] = line.split(":");
    if (!key || !keys.test(key.trim())) continue;
    const value = inlineValue.join(":").trim() || metadata[index + 1];
    if (value && !keys.test(value)) attributes[key.trim()] = value;
  }
  addShippingEvidence(attributes, metadata);
  const price = parseVisibleBrlPrice(detail.priceText);
  return {
    ...summary,
    title: usableDetailTitle(detail.title) ?? summary.title,
    price: price ?? summary.price,
    currency: price === null ? summary.currency : "BRL",
    location: nullableText(detail.location) ?? summary.location,
    description: nullableText(detail.description)?.slice(0, 100_000) ?? null,
    sellerName: nullableText(detail.sellerName)?.slice(0, 500) ?? null,
    images,
    imageUrl: images[0] ?? summary.imageUrl,
    attributes: Object.fromEntries(Object.entries(attributes).slice(0, 200)),
    publishedAt: null,
    ...(storeRawData ? { rawData: { visibleText: detail.text.slice(0, 20_000) } } : {}),
  };
}
