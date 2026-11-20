import { describe, expect, it, vi } from "vitest";
import { createDashboardHandler } from "../src/dashboard/api.js";

const search = { id: "s1", name: "GPU", query: "RTX", active: true };
function setup() {
  const repository = {
    listSearches: vi.fn().mockResolvedValue([search]),
    createSearch: vi.fn().mockResolvedValue(search),
    updateSearch: vi.fn().mockResolvedValue(search),
    runSearch: vi.fn().mockResolvedValue("accepted"),
    listListings: vi.fn().mockResolvedValue([]),
    listComparisons: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    listSources: vi.fn().mockResolvedValue([{ name: "kabum", status: "unavailable" }]),
  };
  return { repository, handle: createDashboardHandler(repository) };
}

describe("dashboard API", () => {
  it("lists searches and source status", async () => {
    const { handle } = setup();
    expect(await (await handle(new Request("http://localhost/api/searches"))).json()).toEqual([search]);
    expect(await (await handle(new Request("http://localhost/api/sources"))).json()).toEqual([{ name: "kabum", status: "unavailable" }]);
  });
  it("returns product comparisons", async () => {
    const { handle, repository } = setup();
    repository.listComparisons.mockResolvedValue([{ confidence: "possible" }]);
    expect(await (await handle(new Request("http://localhost/api/comparisons"))).json()).toEqual([{ confidence: "possible" }]);
  });
  it("forwards the selected search when loading listings", async () => {
    const { handle, repository } = setup();
    repository.listListings.mockImplementation(async (id?: string) => id === "s/2" ? [{ id: "matching-listing" }] : []);
    const response = await handle(new Request("http://localhost/api/listings?searchId=s%2F2"));
    expect(await response.json()).toEqual([{ id: "matching-listing" }]);
  });
  it("forwards the listing page boundary without changing the array response", async () => {
    const { handle, repository } = setup();
    const lastSeenAt = new Date("2026-11-20T16:20:00.000Z");
    repository.listListings.mockImplementation(async (_id, after) => (
      after?.lastSeenAt.getTime() === lastSeenAt.getTime() && after.id === "older/id" ? [{ id: "following-page" }] : []
    ));
    const response = await handle(new Request("http://localhost/api/listings?after=2026-11-20T16%3A20%3A00.000Z%2Folder%2Fid"));
    expect(await response.json()).toEqual([{ id: "following-page" }]);
  });
  it("rejects invalid listing page boundaries", async () => {
    const { handle } = setup();
    const response = await handle(new Request("http://localhost/api/listings?after=today%2Ffirst"));
    expect(response.status).toBe(400);
  });
  it("reports source failures and verified scope in filtered run history", async () => {
    const { repository } = setup();
    const run = {
      id: "run-1",
      searchId: "s1",
      startedAt: "2026-11-20T16:00:00.000Z",
      finishedAt: "2026-11-20T16:01:00.000Z",
      status: "partial",
      discovered: 4,
      analyzed: 3,
      providers: {
        olx: { status: "success", error: null, count: 4, detailFailures: 1, scope: { location: null, radiusKm: null, verified: true } },
        facebook: { status: "failed", error: "scope_unverified", count: 0, detailFailures: 0, scope: { location: "Itajaí, SC", radiusKm: 50, verified: false } },
      },
      search: { name: "GPU" },
    };
    const handle = createDashboardHandler({
      ...repository,
      listRuns: async (id?: string) => id === "s1" ? [run] : [],
    });
    const response = await handle(new Request("http://localhost/api/runs?searchId=s1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([run]);
  });
  it("supports repositories with no run history", async () => {
    const { handle } = setup();
    const response = await handle(new Request("http://localhost/api/runs"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
  it("validates search definitions before creation", async () => {
    const { handle, repository } = setup();
    const response = await handle(new Request("http://localhost/api/searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "" }) }));
    expect(response.status).toBe(400);
    expect(repository.createSearch).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutations", async () => {
    const { handle, repository } = setup();
    const response = await handle(new Request("http://localhost/api/searches/s1/run", { method: "POST", headers: { origin: "https://elsewhere.example" } }));
    expect(response.status).toBe(403);
    expect(repository.runSearch).not.toHaveBeenCalled();
  });
  it("rejects an attempt to run a paused search", async () => {
    const { handle, repository } = setup();
    repository.runSearch.mockResolvedValue("paused");
    const response = await handle(new Request("http://localhost/api/searches/s1/run", { method: "POST", headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(409);
  });
  it("reports a missing search when running", async () => {
    const { handle, repository } = setup();
    repository.runSearch.mockResolvedValue("missing");
    expect((await handle(new Request("http://localhost/api/searches/missing/run", { method: "POST", headers: { "content-type": "application/json" } }))).status).toBe(404);
  });
});

describe("dashboard search updates", () => {
  it("accepts dashboard opportunity settings with unknown resale costs", async () => {
    const { handle, repository } = setup();
    const opportunitySettings = {
      purpose: "resale",
      minimumDiscountPercent: 15,
      minimumComparables: 5,
      facebookLocation: "Itajaí, SC",
      facebookRadiusKm: 50,
      costs: { fixed: null, feePercent: null },
    };
    const response = await handle(new Request("http://localhost/api/searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Câmera", query: "Sony a6000", category: "electronics", providers: ["olx", "facebook"],
        minPrice: null, maxPrice: null, minYear: null, maxYear: null, location: null, radiusKm: null,
        minimumScore: 70, intervalMinutes: 60, forbiddenWords: [], opportunitySettings,
      }),
    }));
    expect(response.status).toBe(201);
    expect(repository.createSearch).toHaveBeenCalledWith(expect.objectContaining({ opportunitySettings }));
  });
  it("updates active state without changing search fields", async () => {
    const { handle, repository } = setup();
    const response = await handle(new Request("http://localhost/api/searches/s1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: false }) }));
    expect(response.status).toBe(200);
    expect(repository.updateSearch).toHaveBeenCalledWith("s1", { active: false });
  });
  it("exposes alert delivery failures", async () => {
    const { handle, repository } = setup();
    repository.listNotifications = vi.fn().mockResolvedValue([{ status: "failed", lastError: "network" }]);
    const response = await handle(new Request("http://localhost/api/notifications"));
    expect(await response.json()).toEqual([{ status: "failed", lastError: "network" }]);
  });
});
