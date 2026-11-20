import type { MatchCandidate } from "./cross-marketplace.js";
import { normalizeTitle } from "../utils/normalization.js";

type UsedMatchCandidate = MatchCandidate & { sellerName?: string | null; imageUrl?: string | null };

/** Shared model names and cities describe many independent used items. */
export function isStrongUsedDuplicate(a: UsedMatchCandidate, b: UsedMatchCandidate): boolean {
  if (a.price === null || b.price === null || a.price <= 0 || b.price <= 0) return false;
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  if (Math.abs(a.price - b.price) / Math.max(a.price, b.price) > 0.03) return false;
  const sameSeller = a.sellerName && b.sellerName && normalizeTitle(a.sellerName) === normalizeTitle(b.sellerName);
  const sameImage = a.imageUrl && b.imageUrl && a.imageUrl === b.imageUrl;
  return a.source === b.source ? Boolean(sameSeller && sameImage) : Boolean(sameSeller || sameImage);
}
