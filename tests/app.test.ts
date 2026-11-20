import { describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { MercadoLivreProvider } from "../src/marketplaces/mercadolivre/provider.js";
import { MercadoLivreWebProvider } from "../src/marketplaces/mercadolivre/web-provider.js";

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: "postgresql://user:pass@localhost:5432/deals",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

describe("application provider wiring", () => {
  it("keeps all marketplace providers opt-in by default", async () => {
    const app = createApplication(config());
    expect(app.marketplaces.has("mercadolivre")).toBe(false);
    expect(app.marketplaces.has("olx")).toBe(false);
    expect(app.marketplaces.has("facebook")).toBe(false);
    await app.shutdown();
  });

  it("registers the retail sources only when enabled", async () => {
    const app = createApplication(config({ KABUM_ENABLED: "true", TERABYTE_ENABLED: "true" }));
    expect(app.marketplaces.has("kabum")).toBe(true);
    expect(app.marketplaces.has("terabyte")).toBe(true);
    await app.shutdown();
  });

  it("wires each Mercado Livre mode only when explicitly enabled", async () => {
    const webApp = createApplication(config({ MERCADOLIVRE_ENABLED: "true", MERCADOLIVRE_MODE: "web" }));
    expect(webApp.marketplaces.get("mercadolivre")).toBeInstanceOf(MercadoLivreWebProvider);
    await webApp.shutdown();

    const apiApp = createApplication(config({ MERCADOLIVRE_ENABLED: "true", MERCADOLIVRE_MODE: "api" }));
    expect(apiApp.marketplaces.get("mercadolivre")).toBeInstanceOf(MercadoLivreProvider);
    await apiApp.shutdown();
  });
});
