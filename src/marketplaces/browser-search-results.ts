import type { Page } from "playwright";

export async function hasSearchResults(page: Page, resultSelectors: readonly string[], emptyMessage: RegExp): Promise<boolean> {
  const links = page.locator(resultSelectors.map((selector) => `${selector}:visible`).join(","));
  const empty = page.getByText(emptyMessage)
    .and(page.locator(":not(a, a *, button, button *)")).filter({ visible: true });
  await links.or(empty).first().waitFor({ state: "visible" });
  // Marketplace pages may render suggested listings below a true empty state.
  return !await empty.first().isVisible();
}
