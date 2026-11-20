export const LISTING_PAGE_SIZE = 100;

export type ListingCursor = { lastSeenAt: Date; id: string };

export function listingCursor({ lastSeenAt, id }: { lastSeenAt: string; id: string }): string {
  return `${lastSeenAt}/${id}`;
}

export function parseListingCursor(value: string): ListingCursor | null {
  const separator = value.indexOf("/");
  if (separator < 0) return null;
  const date = value.slice(0, separator);
  const id = value.slice(separator + 1);
  const lastSeenAt = new Date(date);
  if (!id || !Number.isFinite(lastSeenAt.getTime()) || lastSeenAt.toISOString() !== date) return null;
  return { lastSeenAt, id };
}
