export interface ProductCandidate {
  id: string;
  source: string;
  title: string;
  brand: string | null;
  mpn: string | null;
  gtin: string | null;
  condition: "new" | "used" | "unknown";
  currency: string | null;
}
export interface ProductComparison { leftId: string; rightId: string; confidence: "confirmed" | "possible"; reason: string }
const normalize = (value: string | null) => value?.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "") || null;
export function compareProducts(a: ProductCandidate, b: ProductCandidate): ProductComparison | null {
  if (a.id === b.id || a.source === b.source || !a.currency || a.currency !== b.currency) return null;
  if (a.condition !== "unknown" && b.condition !== "unknown" && a.condition !== b.condition) return null;
  const aGtin = normalize(a.gtin), bGtin = normalize(b.gtin);
  const aBrand = normalize(a.brand), bBrand = normalize(b.brand);
  const aModel = normalize(a.mpn), bModel = normalize(b.mpn);
  if (aGtin && bGtin && aGtin !== bGtin) return null;
  if (aBrand && bBrand && aBrand !== bBrand) return null;
  if (aModel && bModel && aModel !== bModel) return null;
  const sameGtin = !!aGtin && aGtin === bGtin && /^\d{8,14}$/.test(aGtin);
  const sameModel = !!aBrand && aBrand === bBrand && !!aModel && aModel === bModel;
  if (!sameGtin && !sameModel) return null;
  const knownCondition = a.condition !== "unknown" && b.condition !== "unknown";
  return { leftId: a.id, rightId: b.id, confidence: knownCondition ? "confirmed" : "possible", reason: sameGtin ? "Identificador de produto correspondente" : "Marca e código do fabricante correspondentes" };
}
