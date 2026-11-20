import { containsDefect } from "../categories/helpers.js";
import type { ListingDetails } from "../marketplaces/types.js";
import { normalizeTitle } from "../utils/normalization.js";

export type UsedCondition = "new" | "used" | "refurbished" | "damaged" | "unknown";
export type UsedShipping = "available" | "pickup_only" | "unknown";

const conditionKeys = new Set([
  "condition", "item condition", "itemcondition", "condicao", "condicao do item", "condicao do produto",
  "estado", "estado de conservacao", "estado do item", "estado do produto",
]);
const shippingKeys = new Set(["entrega", "envio", "frete", "fulfillment", "shipping"]);
const textConditions = {
  damaged: /\b(?:com (?:algumas? |varias? )?avarias?|para (?:(?:retirada|aproveitamento) de )?pecas|nao liga|(?:liga|funciona) nao$|(?:danificad|trincad|rachad)[oa]s?)\b/,
  refurbished: /\b(?:recondicionad[oa]s?|remanufaturad[oa]s?)\b/,
  new: /\b(?:nov[oa]s?|lacrad[oa]s?|sem (?:nenhum )?uso|zero (?:km|quilometros))\b/,
  used: /\b(?:usad[oa]s?|seminov[oa]s?|segunda mao|pouco uso|\d+ (?:dias?|mes(?:es)?|anos?) de uso)\b/,
};
const shippingDenial = /\b(?:sem (?:envio|entrega|frete)|nao (?:envio|enviamos|entrego|entregamos|(?:faco|fazemos|aceito|ofereco) (?:o |a )?(?:envio|entrega|frete)))\b(?: (gratis|por|pelos?|pelas?|via|para|fora)(?: (?!e\b|mas\b)[a-z0-9]+)*)?/g;
// Explicit exclusions take precedence if a structured field conflicts with the seller's text.
const conditionOrder = ["damaged", "refurbished", "new", "used"] as const;
type ExplicitCondition = typeof conditionOrder[number];

function conditionClaims(value: string, structured: boolean): ExplicitCondition[] {
  const text = value
    .replace(/\bsemi nov([oa]s?)\b/g, "seminov$1")
    .replace(/\b(?:se|caso) (?:o (?:aparelho|produto|item) )?nao (?:liga|funciona)\b/g, "")
    .replace(/\b(?:sem|nenhum(?:a)?|nao (?:tem|possui|apresenta)) (?:qualquer |nenhum(?:a)? )?(?:pecas?|telas?|vidros?|carcacas?|tampas?) (?:esta |estao )?(?:quebrad|danificad|avariad|trincad|rachad)[oa]s?(?: (?:ou|nem) (?:quebrad|danificad|avariad|trincad|rachad)[oa]s?)*\b/g, "")
    .replace(/\b(?:nao (?:tem|possui|apresenta))(?: qualquer| nenhum(?:a)?)? (?:defeitos?|avarias?|problemas?)\b/g, "")
    .replace(/\b(?:nao|nem) (?:(?:foi|esta|e|sao|sendo) )*(?:(?:lacrad|recondicionad|remanufaturad|seminov|nov|quebrad|avariad|defeituos|danificad|trincad|rachad)[oa]s?|com avarias?|para pecas)\b/g, "")
    .replace(/\b(?:nao|nem) (?:(?:foi|foram|esta|e|sao|sendo) )*usad[oa]s?\b/g, "")
    .replace(/\bnunca (?:foi |foram )?usad[oa]s?\b(?=$| (?:e|nem)\b)/g, "sem uso")
    .replace(/\bnunca (?:foi |foram )?usad[oa]s?\b/g, "")
    .replace(/\b(?:como|igual a|aparencia de|estado de|parece|praticamente) nov[oa]s?\b/g, "")
    .replace(/\b(?:baterias?|caixas?|cabos?|carregadores?|pneus?|telas?) (?:nov[oa]s?|lacrad[oa]s?)\b/g, "");

  const matches = {
    damaged: containsDefect(text) || textConditions.damaged.test(text),
    refurbished: textConditions.refurbished.test(text),
    new: textConditions.new.test(text),
    used: textConditions.used.test(text),
  };
  return conditionOrder.filter((condition) => matches[condition] || (structured && (
    text === condition || text.endsWith(`org ${condition}condition`)
    || text === `${condition}condition` || (condition === "used" && /^used (?:like new|good|fair)$/.test(text))
  )));
}

function shippingClaim(value: string, structured: boolean): UsedShipping {
  let shippingUnavailable = false;
  const text = value.replace(shippingDenial, (statement: string, restriction: string | undefined) => {
    if (!restriction && !statement.endsWith("frete")) shippingUnavailable = true;
    return "";
  }).trim();
  if (shippingUnavailable || /\b(?:so|somente|apenas|exclusivamente) (?:retirada|em maos)\b/.test(text)
    || (structured && ["pickup only", "retirada", "retirada em maos", "em maos"].includes(text))) {
    return "pickup_only";
  }
  if (/\b(?:envio (?:disponivel|para|pelos?|pelas?|via|por|a combinar)|(?:faco|ofereco|aceito|com) envio|enviamos|frete gratis|olx entrega|entrega facil|entrego (?:para|em)|entrega (?:disponivel|via|a domicilio))\b/.test(text)
    || (structured && ["available", "sim", "disponivel", "envio", "entrega"].includes(text))) {
    return "available";
  }
  return "unknown";
}

export function inspectUsedListing(listing: ListingDetails): {
  condition: UsedCondition;
  shipping: UsedShipping;
  defects: string[];
  warnings: string[];
  evidence: string[];
} {
  const claims: Partial<Record<ExplicitCondition, string>> = {};
  const shippingEvidence = new Map<UsedShipping, string>();
  const addConditionClaims = (value: string, structured: boolean) => {
    for (const claim of conditionClaims(value, structured)) claims[claim] ??= value;
  };
  const addShippingClaim = (value: string, structured: boolean) => {
    const claim = shippingClaim(value, structured);
    if (claim !== "unknown" && !shippingEvidence.has(claim)) shippingEvidence.set(claim, value);
  };

  for (const [key, rawValue] of Object.entries(listing.attributes)) {
    const name = normalizeTitle(key);
    if (typeof rawValue === "string") {
      const value = normalizeTitle(rawValue);
      if (conditionKeys.has(name)) addConditionClaims(value, true);
      if (shippingKeys.has(name)) addShippingClaim(value, true);
    } else if (shippingKeys.has(name) && rawValue === true) {
      addShippingClaim("disponivel", true);
    }
  }
  for (const part of [listing.title, ...(listing.description?.split(/[.!?;\r\n,]+/) ?? [])]) {
    const value = normalizeTitle(part);
    addConditionClaims(value, false);
    addShippingClaim(value, false);
  }

  const condition = conditionOrder.find((claim) => claims[claim]) ?? "unknown";
  const shipping = shippingEvidence.has("pickup_only") ? "pickup_only"
    : shippingEvidence.has("available") ? "available" : "unknown";
  const evidence = [
    ...conditionOrder.flatMap((claim) => claims[claim] ? [`Condição (${claim}): ${claims[claim]}`] : []),
    ...[...shippingEvidence.values()].map((value) => `Entrega: ${value}`),
  ];
  const warnings: string[] = [];
  if (condition === "unknown") warnings.push("O anúncio não informa a condição do item.");
  if (conditionOrder.filter((claim) => claims[claim]).length > 1) warnings.push("O anúncio contém indicações conflitantes sobre a condição.");
  if (shipping === "unknown") warnings.push("O anúncio não confirma as opções de entrega.");
  if (shippingEvidence.size > 1) warnings.push("O anúncio contém indicações conflitantes sobre a entrega.");
  const defects = condition === "damaged" ? ["O anúncio menciona defeito ou avaria"] : [];
  return { condition, shipping, defects, warnings, evidence };
}
