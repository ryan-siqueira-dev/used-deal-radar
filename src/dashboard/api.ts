import { searchDefinitionSchema, type SearchDefinition } from "../searches/validation.js";
import { parseListingCursor, type ListingCursor } from "./listing-pagination.js";

export interface DashboardRepository {
  listSearches(): Promise<unknown>;
  createSearch(input: SearchDefinition): Promise<unknown>;
  updateSearch(id: string, input: SearchDefinition | { active: boolean }): Promise<unknown | null>;
  runSearch(id: string): Promise<"accepted" | "missing" | "paused">;
  listListings(searchId?: string, after?: ListingCursor): Promise<unknown>;
  listRuns?(searchId?: string): Promise<unknown>;
  listComparisons(): Promise<unknown>;
  listNotifications(): Promise<unknown>;
  listSources(): Promise<unknown>;
}

export function createDashboardHandler(repository: DashboardRepository): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    const origin = request.headers.get("origin");
    if (mutation && ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")) {
      return Response.json({ error: "origin_not_allowed" }, { status: 403 });
    }
    try {
      const searchId = url.searchParams.get("searchId") || undefined;
      if (request.method === "GET" && url.pathname === "/api/searches") return Response.json(await repository.listSearches());
      if (request.method === "GET" && url.pathname === "/api/comparisons") return Response.json(await repository.listComparisons());
      if (request.method === "GET" && url.pathname === "/api/listings") {
        const cursor = url.searchParams.get("after");
        if (cursor === null) return Response.json(await repository.listListings(searchId));
        const after = parseListingCursor(cursor);
        if (!after) return Response.json({ error: "invalid_listing_cursor" }, { status: 400 });
        return Response.json(await repository.listListings(searchId, after));
      }
      if (request.method === "GET" && url.pathname === "/api/runs") return Response.json(await repository.listRuns?.(searchId) ?? []);
      if (request.method === "GET" && url.pathname === "/api/notifications") return Response.json(await repository.listNotifications());
      if (request.method === "GET" && url.pathname === "/api/sources") return Response.json(await repository.listSources());
      if (mutation && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      if (request.method === "POST" && url.pathname === "/api/searches") {
        const parsed = searchDefinitionSchema.safeParse(await request.json());
        if (!parsed.success) return Response.json({ error: "invalid_search", issues: parsed.error.issues }, { status: 400 });
        return Response.json(await repository.createSearch(parsed.data), { status: 201 });
      }
      const run = /^\/api\/searches\/([^/]+)\/run$/.exec(url.pathname);
      if (request.method === "POST" && run?.[1]) {
        const result = await repository.runSearch(decodeURIComponent(run[1]));
        if (result === "missing") return Response.json({ error: "search_not_found" }, { status: 404 });
        if (result === "paused") return Response.json({ error: "search_paused" }, { status: 409 });
        return Response.json({ accepted: true }, { status: 202 });
      }
      const item = /^\/api\/searches\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && item?.[1]) {
        const body: unknown = await request.json();
        const activeOnly = typeof body === "object" && body !== null && Object.keys(body).length === 1 && "active" in body && typeof body.active === "boolean";
        const parsed = activeOnly ? { success: true as const, data: { active: (body as { active: boolean }).active } } : searchDefinitionSchema.safeParse(body);
        if (!parsed.success) return Response.json({ error: "invalid_search", issues: parsed.error.issues }, { status: 400 });
        const updated = await repository.updateSearch(decodeURIComponent(item[1]), parsed.data);
        return updated ? Response.json(updated) : Response.json({ error: "search_not_found" }, { status: 404 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof URIError) return Response.json({ error: "invalid_request" }, { status: 400 });
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}
