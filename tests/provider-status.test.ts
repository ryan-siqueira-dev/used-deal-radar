import { describe, expect, it } from "vitest";
import { MarketplaceRegistry } from "../src/marketplaces/registry.js";
import { ProviderError } from "../src/marketplaces/provider.js";
describe("provider diagnostics", () => {
  it("records search and detail success and isolates failure by source", () => {
    const registry = new MarketplaceRegistry();
    registry.recordSuccess("olx", "search");
    expect(registry.getStatus("olx").status).toBe("configured_unverified");
    registry.recordSuccess("olx", "details");
    expect(registry.getStatus("olx").status).toBe("working");
    registry.recordFailure("olx", new ProviderError("olx_access_blocked", "blocked"));
    expect(registry.getStatus("olx")).toMatchObject({status:"blocked",error:"olx_access_blocked"});
    expect(registry.getStatus("facebook").status).toBe("configured_unverified");
  });
});
