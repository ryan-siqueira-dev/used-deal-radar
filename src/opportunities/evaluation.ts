import { Prisma } from "@prisma/client";
import type { MarketReference } from "../market-analysis/statistics.js";
import type { ListingDetails } from "../marketplaces/types.js";
import { inspectUsedListing, type UsedCondition, type UsedShipping } from "./condition.js";
import type { UsedSearchSettings } from "./settings.js";

export type OpportunityEvaluation = {
  classification: "opportunity" | "candidate" | "excluded";
  purpose: UsedSearchSettings["purpose"];
  reason: string;
  condition: UsedCondition;
  shipping: UsedShipping;
  warnings: string[];
  referencePrice: number | null;
  sampleSize: number;
  discountPercent: number | null;
  estimatedProfit: number | null;
  estimatedMarginPercent: number | null;
  totalCost: number | null;
  settingsSnapshot: UsedSearchSettings;
};

function isPositivePrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: Prisma.Decimal): number | null {
  const number = value.toNumber();
  return Number.isFinite(number) ? number : null;
}

export function evaluateOpportunity({ listing, settings, market }: {
  listing: ListingDetails;
  settings: UsedSearchSettings;
  market: Pick<MarketReference, "medianPrice" | "sampleSize"> | null;
}): OpportunityEvaluation {
  const { condition, shipping, warnings, defects } = inspectUsedListing(listing);
  warnings.push(...defects);

  const sampleSize = market && Number.isSafeInteger(market.sampleSize) && market.sampleSize > 0 ? market.sampleSize : 0;
  // The median of prices stored to two decimal places can have half-cent precision.
  const normalizedMedian = sampleSize >= settings.minimumComparables && isPositivePrice(market?.medianPrice)
    ? new Prisma.Decimal(market.medianPrice).toDecimalPlaces(3).toNumber() : null;
  const referencePrice = isPositivePrice(normalizedMedian) ? normalizedMedian : null;
  const price = isPositivePrice(listing.price) && listing.currency === "BRL" ? listing.price : null;
  const discount = referencePrice !== null && price !== null
    ? new Prisma.Decimal(referencePrice).minus(price).times(100).div(referencePrice) : null;
  const snapshot: Omit<OpportunityEvaluation, "classification" | "reason"> = {
    purpose: settings.purpose,
    condition,
    shipping,
    warnings,
    referencePrice,
    sampleSize,
    discountPercent: discount === null ? null : finiteNumber(discount),
    estimatedProfit: null,
    estimatedMarginPercent: null,
    totalCost: null,
    settingsSnapshot: { ...settings, costs: { ...settings.costs } },
  };

  const finish = (classification: OpportunityEvaluation["classification"], reason: string): OpportunityEvaluation => ({
    ...snapshot,
    classification,
    reason,
  });

  if (condition === "new") return finish("excluded", "O anúncio descreve um item novo.");
  if (condition === "refurbished") return finish("excluded", "O anúncio descreve um item recondicionado.");
  if (condition === "damaged") return finish("excluded", "O anúncio descreve um item com defeito ou avaria.");

  if (referencePrice === null) {
    warnings.push(sampleSize < settings.minimumComparables
      ? `Foram encontrados ${sampleSize} de ${settings.minimumComparables} comparáveis necessários.`
      : "O preço mediano dos comparáveis está indisponível.");
  }
  if (price === null) warnings.push("O preço de compra em reais está indisponível.");
  const { fixed, feePercent } = settings.costs;
  const hasResaleCosts = fixed !== null && Number.isFinite(fixed) && fixed >= 0
    && feePercent !== null && Number.isFinite(feePercent) && feePercent >= 0 && feePercent <= 100;
  if (settings.purpose === "resale" && !hasResaleCosts) warnings.push("Informe os custos fixos e a taxa de venda para estimar o lucro.");

  if (condition === "unknown") return finish("candidate", "A condição de usado ainda precisa ser confirmada.");
  if (referencePrice === null) return finish("candidate", "A referência de preço está indisponível.");
  if (price === null || discount === null || snapshot.discountPercent === null) {
    return finish("candidate", "O desconto ainda não pôde ser calculado.");
  }

  if (settings.purpose === "resale" && hasResaleCosts) {
    const fee = new Prisma.Decimal(referencePrice).times(feePercent).div(100);
    const totalCost = new Prisma.Decimal(price).plus(fixed).plus(fee);
    const estimatedProfit = new Prisma.Decimal(referencePrice).minus(totalCost);
    snapshot.totalCost = finiteNumber(totalCost);
    snapshot.estimatedProfit = finiteNumber(estimatedProfit);
    snapshot.estimatedMarginPercent = finiteNumber(estimatedProfit.div(totalCost).times(100));
  }

  if (discount.lt(settings.minimumDiscountPercent)) {
    return finish("candidate", "O desconto está abaixo do mínimo da pesquisa.");
  }
  if (settings.purpose === "personal") {
    return finish("opportunity", "O desconto atingiu o mínimo da pesquisa.");
  }
  if (snapshot.estimatedProfit === null || snapshot.totalCost === null || snapshot.estimatedMarginPercent === null) {
    return finish("candidate", "O lucro de revenda ainda não pôde ser estimado.");
  }
  if (snapshot.estimatedProfit <= 0) {
    return finish("candidate", "O lucro de revenda estimado é zero ou negativo.");
  }
  return finish("opportunity", "O desconto atingiu o mínimo da pesquisa e o lucro estimado é positivo.");
}
