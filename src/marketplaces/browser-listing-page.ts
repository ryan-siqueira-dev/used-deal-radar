import type { Page } from "playwright";
import { normalizeUrl } from "../utils/normalization.js";
import { ProviderError } from "./provider.js";
import { isMarketplaceUrl, type ListingSummary } from "./types.js";

export async function waitForListingPage(page: Page, listing: ListingSummary, options: {
  parseId: (url: string) => string | null;
  readySelector: string;
  unavailableText: RegExp;
  status: number | undefined;
}): Promise<void> {
  const expected = options.parseId(listing.url) ?? listing.externalId;
  const unavailable = page.getByText(options.unavailableText)
    .and(page.locator(":not(a, a *, button, button *)")).filter({ visible: true });
  const verify = async () => {
    const url = page.url();
    const sameItem = isMarketplaceUrl(listing.source, url)
      && (expected ? options.parseId(url) === expected : normalizeUrl(url) === normalizeUrl(listing.url));
    if (!sameItem || options.status === 404 || options.status === 410 || await unavailable.first().isVisible()) {
      throw new ProviderError("listing_unavailable", "Marketplace did not return the requested available listing");
    }
  };
  await verify();
  await page.locator(options.readySelector).or(unavailable).first().waitFor({ state: "attached" });
  await verify();
}
