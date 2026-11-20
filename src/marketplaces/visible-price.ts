import { parseBRLPrice } from "../utils/normalization.js";

export function parseVisibleBrlPrice(text: string | null | undefined): number | null {
  const amount = text?.match(/\bR\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?)(?!\d|[.,]\d)/i)?.[1];
  return parseBRLPrice(amount);
}
