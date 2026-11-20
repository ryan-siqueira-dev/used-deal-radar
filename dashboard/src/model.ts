import type { OpportunityEvaluation } from "../../src/opportunities/evaluation.js";
import type { UsedSearchSettings } from "../../src/opportunities/settings.js";

export type { UsedSearchSettings };

export type Definition = {
  name: string;
  query: string;
  category: string;
  providers: string[];
  minPrice: number | null;
  maxPrice: number | null;
  minYear: number | null;
  maxYear: number | null;
  location: string | null;
  radiusKm: number | null;
  minimumScore: number;
  intervalMinutes: number;
  forbiddenWords: string[];
  opportunitySettings: UsedSearchSettings | null;
};

export type Search = Omit<Definition, "minPrice" | "maxPrice"> & {
  id: string;
  minPrice: string | null;
  maxPrice: string | null;
  active: boolean;
  lastRunAt: string | null;
};

export type Analysis = {
  id: string;
  score: number;
  reason: string;
  risks: string[];
  createdAt: string;
  opportunity: (OpportunityEvaluation & { listingSnapshot?: { price: number | null; currency: string | null; location: string | null } }) | null;
  current?: boolean;
};

export type SearchLink = {
  searchId: string;
  lastMatchedAt: string;
  search: { id: string; name: string; purpose: UsedSearchSettings["purpose"] | null };
  analyses: Analysis[];
};

export type Listing = {
  id: string;
  title: string;
  source: string;
  url: string;
  price: string | null;
  currency: string | null;
  location: string | null;
  lastSeenAt: string;
  priceHistory: { price: string; observedAt: string }[];
  analyses: Analysis[];
  searches: SearchLink[];
};

export type Source = { name: string; status: string; error?: string | null };

export type SourceRun = {
  status: "running" | "success" | "empty" | "failed" | "disabled";
  error: string | null;
  count: number;
  detailFailures: number;
  scope: { location: string | null; radiusKm: number | null; verified: boolean };
};

export type Run = {
  id: string;
  searchId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed" | "interrupted";
  providers: Record<string, SourceRun>;
  discovered: number;
  analyzed: number;
  search: { name: string };
};

type Offer = { title: string; source: string; price: string | null; url: string };
export type Comparison = {
  leftId: string;
  rightId: string;
  confidence: "confirmed" | "possible";
  reason: string;
  currency: string;
  left: Offer;
  right: Offer;
};

export type Notice = { id: string; status: string; lastError: string | null; listing: { title: string } };

export const sourceNames: Record<string, string> = {
  mercadolivre: "Mercado Livre",
  olx: "OLX",
  facebook: "Facebook Marketplace",
  kabum: "KaBuM!",
  terabyte: "Terabyte",
};

export const purposeLabels = { personal: "Uso pessoal", resale: "Revenda" };

export function sourceName(name: string) {
  return sourceNames[name] ?? name;
}

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const percentFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export function dateTime(value: string) {
  return dateFormat.format(new Date(value));
}

export function percent(value: number) {
  return `${percentFormat.format(value)}%`;
}

export function money(value: number | string, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(Number(value));
}
