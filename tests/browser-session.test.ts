import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/marketplaces/browser.js";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

describe("BrowserSession shutdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts an already-closed browser during application termination", async () => {
    const context = { newPage: vi.fn().mockResolvedValue({}), close: vi.fn().mockRejectedValue(new Error("browserContext.close: Target page, context or browser has been closed")) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined), isConnected: () => false };
    mocks.launch.mockResolvedValue(browser);
    const session = new BrowserSession({ headless: false });
    await session.page();
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("preserves a genuine context-close failure while transport remains connected", async () => {
    const context = { newPage: vi.fn().mockResolvedValue({}), close: vi.fn().mockRejectedValue(new Error("unrelated close failure")) };
    mocks.launch.mockResolvedValue({ newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined), isConnected: () => true });
    const session = new BrowserSession({ headless: false });
    await session.page();
    await expect(session.close()).rejects.toThrow("browser_session_close_failed");
  });
});
