import type { ListingDetails, ListingSummary } from "../types.js";
import { nullableText, parseBRLPrice } from "../../utils/normalization.js";
import { addShippingEvidence, getStructuredListing } from "../structured-listing.js";
import { parseVisibleBrlPrice } from "../visible-price.js";

export interface OlxSearchCard {
  href: string;
  title: string | null;
  text: string;
  image: string | null;
}

export function parseOlxExternalId(url: string): string | null {
  const match = new URL(url).pathname.match(/-(\d{6,})(?:\/)?$/);
  return match?.[1] ?? null;
}

export function parseOlxSearchCard(card: OlxSearchCard): ListingSummary | null {
  const title = nullableText(card.title) ?? nullableText(card.text.split("\n")[0]);
  if (!title) return null;
  const price = parseVisibleBrlPrice(card.text);
  const locationLines = card.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const location = locationLines.find((line) => /\b[A-Z]{2}\b/.test(line) && !line.includes("R$")) ?? null;
  return {
    source: "olx",
    externalId: parseOlxExternalId(card.href),
    title,
    price,
    currency: price === null ? null : "BRL",
    location,
    url: card.href,
    imageUrl: card.image && /^https?:\/\//i.test(card.image) ? card.image : null,
  };
}

export interface OlxDetailDocument {
  title: string | null;
  description: string | null;
  priceText: string | null;
  location: string | null;
  sellerName: string | null;
  images: string[];
  attributes: Record<string, unknown>;
  publishedAt: string | null;
  structuredData?: string[];
  shippingText?: string[];
}

export function mapOlxDetails(summary: ListingSummary, detail: OlxDetailDocument, storeRawData = false): ListingDetails {
  const { structuredData, shippingText, ...visible } = detail;
  const { product, offer, attributes: structuredAttributes } = getStructuredListing(structuredData);
  const title = typeof product?.["name"] === "string" ? product["name"] : visible.title;
  const description = typeof product?.["description"] === "string" ? product["description"] : visible.description;
  const priceData = offer?.["price"];
  const priceText = typeof priceData === "string" || typeof priceData === "number" ? String(priceData) : visible.priceText;
  const structuredPrice = typeof priceData === "number" ? parseBRLPrice(priceData)
    : typeof priceData === "string" && /^\d+(?:\.\d+)?$/.test(priceData.trim()) ? parseBRLPrice(Number(priceData)) : null;
  const offerCurrency = typeof offer?.["priceCurrency"] === "string" ? offer["priceCurrency"].trim().toUpperCase() : "";
  const structuredCurrency = /^[A-Z]{3}$/.test(offerCurrency) ? offerCurrency : null;
  const visiblePrice = parseVisibleBrlPrice(visible.priceText);
  const selectedPrice = structuredPrice !== null && structuredCurrency !== null ? { price: structuredPrice, currency: structuredCurrency }
    : visiblePrice !== null ? { price: visiblePrice, currency: "BRL" }
    : structuredPrice !== null ? { price: structuredPrice, currency: summary.price === structuredPrice ? summary.currency : null }
    : { price: summary.price, currency: summary.currency };
  const publishedAt = typeof product?.["datePosted"] === "string" ? product["datePosted"] : visible.publishedAt;
  const parsedDate = publishedAt ? new Date(publishedAt) : null;
  const imageData = product?.["image"];
  const structuredImages = (Array.isArray(imageData) ? imageData : [imageData]).filter((item): item is string => typeof item === "string");
  const images = [...new Set([...structuredImages, ...detail.images].filter((image) => /^https?:\/\//i.test(image)))].slice(0, 50);
  const attributes = { ...structuredAttributes, ...visible.attributes };
  addShippingEvidence(attributes, shippingText ?? []);
  return {
    ...summary,
    title: nullableText(title) ?? summary.title,
    ...selectedPrice,
    location: nullableText(detail.location) ?? summary.location,
    description: nullableText(description)?.slice(0, 100_000) ?? null,
    sellerName: nullableText(detail.sellerName)?.slice(0, 500) ?? null,
    images,
    imageUrl: images[0] ?? summary.imageUrl,
    attributes: Object.fromEntries(Object.entries(attributes).slice(0, 200)),
    publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    ...(storeRawData ? { rawData: structuredData || shippingText ? { ...visible, title, description, priceText, publishedAt, images, attributes } : detail } : {}),
  };
}
