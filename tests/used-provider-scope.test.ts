import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/marketplaces/browser.js";
import { FacebookMarketplaceProvider } from "../src/marketplaces/facebook/provider.js";
import { mapFacebookDetails, parseFacebookSearchCard } from "../src/marketplaces/facebook/parser.js";
import { OlxProvider } from "../src/marketplaces/olx/provider.js";
import { mapOlxDetails } from "../src/marketplaces/olx/parser.js";
import type { ListingSummary } from "../src/marketplaces/types.js";

vi.mock("node:fs/promises", () => ({ access: async () => undefined }));
vi.mock("../src/marketplaces/browser.js", () => ({
  BrowserSession: class FakeBrowserSession {
    static page: () => Promise<unknown>;
    page() { return FakeBrowserSession.page(); }
    reloadOnNextPage() {}
  },
  progressiveScroll: vi.fn(),
}));

const logger = pino({ level: "silent" });
const scoped = { query: "camera", limit: 5, location: "Itajaí, SC", radiusKm: 50, verifyLocation: true };
const olympus: ListingSummary = {
  source: "facebook", url: "https://www.facebook.com/marketplace/item/123/", externalId: "123",
  title: "Câmera Olympus", location: "Navegantes, SC", price: 500, currency: "BRL", imageUrl: null,
};
const olxItem: ListingSummary = {
  ...olympus, source: "olx", url: "https://www.olx.com.br/item/camera-123456789", externalId: "123456789",
};

function evaluateFixture<T, Input>(html: string, callback: (input: Input) => T, input: Input): T {
  const $ = load(html);
  const order = $("*").toArray();
  const wrap = (node: AnyNode) => ({
    href: $(node).attr("href"),
    innerText: $(node).text(),
    textContent: $(node).text(),
    getAttribute: (name: string) => $(node).attr(name) ?? null,
    getClientRects: () => $(node).closest('[hidden], [aria-hidden="true"]').length ? [] : [{}],
    closest: (selector: string) => $(node).closest(selector).length > 0,
    compareDocumentPosition: (other: { node: AnyNode }) => order.indexOf(other.node) > order.indexOf(node) ? 4 : 0,
    node,
    querySelector: (selector: string) => $(node).find(selector).first().length ? wrap($(node).find(selector).first()[0]!) : null,
    querySelectorAll: (selector: string) => $(node).find(selector).toArray().map(wrap),
  });
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => $(selector).toArray().map(wrap),
    querySelector: (selector: string) => $(selector).first().length ? wrap($(selector).first()[0]!) : null,
  });
  vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  try { return callback(input); } finally { vi.unstubAllGlobals(); }
}

interface ElementFixture {
  role?: string;
  label: string;
  selector?: string;
  click?: () => void;
  fill?: (value: string) => void;
  options?: string[];
  inputValue?: () => string;
  selectOption?: (label: string) => void;
  children?: () => ElementFixture[];
}

class LocatorFixture {
  constructor(private readonly elements: () => ElementFixture[]) {}

  first() { return new LocatorFixture(() => this.elements().slice(0, 1)); }
  or(other: LocatorFixture) { return new LocatorFixture(() => [...new Set([...this.elements(), ...other.elements()])]); }
  and(other: LocatorFixture) {
    return new LocatorFixture(() => this.elements().filter((element) => other.elements().some((candidate) =>
      candidate.label === element.label && candidate.selector === element.selector)));
  }
  filter() { return this; }
  async count() { return this.elements().length; }
  async isVisible() { return this.elements().length > 0; }
  async waitFor(options: { state: string }) {
    if (options.state === "hidden" ? this.elements().length > 0 : this.elements().length === 0) throw new Error("fixture locator wait timed out");
  }
  async allTextContents() { return this.elements().map((element) => element.label); }
  async innerText() { return this.element().label; }
  async click() { this.element().click?.(); }
  async fill(value: string) { this.element().fill?.(value); }
  async pressSequentially(value: string) { this.element().fill?.(value); }
  async press(key: string) { if (key === "Escape") this.element().click?.(); }
  async inputValue() { return this.element().inputValue?.() ?? this.element().label; }
  async selectOption({ label }: { label: string }) { this.element().selectOption?.(label); }
  getByRole(role: string, options?: { name?: string | RegExp }) {
    return new LocatorFixture(() => this.elements().flatMap((element) => element.children?.() ?? []).filter((element) => element.role === role && matches(element.label, options?.name)));
  }
  getByText(name: string | RegExp) {
    return new LocatorFixture(() => this.elements().flatMap((element) => element.children?.() ?? []).filter((element) => matches(element.label, name)));
  }
  locator(selector: string) {
    if (selector === "option") return new LocatorFixture(() => this.elements().flatMap((element) => element.options ?? []).map((label) => ({ label })));
    if (selector === "option:checked") return new LocatorFixture(() => this.elements().map((element) => ({ label: element.inputValue?.() ?? "" })));
    return new LocatorFixture(() => this.elements().flatMap((element) => element.children?.() ?? []).filter((element) => element.selector && selector.includes(element.selector)));
  }
  private element() {
    const selected = this.elements();
    if (selected.length !== 1) throw new Error(`fixture expected one locator match, got ${selected.length}`);
    return selected[0]!;
  }
}

class DialogFixture implements ElementFixture {
  readonly role = "dialog";
  readonly label = "Alterar localização";
  constructor(readonly children: () => ElementFixture[], readonly click: () => void) {}
}

function matches(label: string, matcher: string | RegExp | undefined) {
  return matcher === undefined || (matcher instanceof RegExp ? matcher.test(label) : label === matcher);
}

function mockPages(...pages: PageFixture[]) {
  const browser = BrowserSession as unknown as { page: ReturnType<typeof vi.fn> };
  browser.page = vi.fn(async () => pages.shift());
  return browser.page;
}

class PageFixture {
  readonly visits: string[] = [];
  readonly scopeAtQuery: string[] = [];
  readonly dialogOpening = vi.fn();
  #url = "";
  #dialog = false;
  #entered = "";
  #selectedPlace = "";
  #selectedRadius = "";
  #dialogPlace = "";
  #dialogRadius = "";
  #radiusOpen = false;

  constructor(readonly options: {
    provider?: "facebook" | "olx";
    mode?: "result" | "empty" | "empty_with_suggestions" | "layout" | "unreadable" | "blocked";
    citySuggestion?: string;
    visibleLocationAfterApply?: string;
    visibleRadiusAfterApply?: string;
    driftOnQuery?: boolean;
    displayScope?: "full" | "city";
    fakeScopeText?: boolean;
    misleadingTitle?: boolean;
    resultsHtml?: string;
    unavailableMessage?: string;
    httpStatus?: number;
    portalControls?: boolean;
    redirectTo?: string;
    beforeFirstNavigation?: () => Promise<void>;
  } = {}) {}

  setDefaultTimeout() {}
  url() { return this.#url; }
  title() { return this.options.mode === "blocked" ? "Attention Required! | Cloudflare" : "Marketplace"; }
  async goto(url: string) {
    this.visits.push(url);
    if (this.visits.length === 1) await this.options.beforeFirstNavigation?.();
    this.#url = this.options.redirectTo ?? url;
    this.#dialog = false;
    if (new URL(url).searchParams.has("query")) {
      this.scopeAtQuery.push(`${this.#selectedPlace} · ${this.#selectedRadius}`);
      if (this.options.driftOnQuery) this.#selectedRadius = "10 km";
    }
    return { status: () => this.options.httpStatus ?? 200 };
  }
  async close() {}
  async evaluate<T, Input>(callback: (input: Input) => T, input: Input) {
    if (this.options.resultsHtml) return evaluateFixture(this.options.resultsHtml, callback, input);
    if (this.isItemPage()) {
      return { title: "Câmera Olympus", priceText: "R$ 500", text: "", description: null, sellerName: null, location: null, images: [], attributes: {}, publishedAt: null };
    }
    if (this.options.mode === "unreadable") {
      return [{ href: olympus.url, text: "", ariaLabel: null, image: null }];
    }
    return [{ href: olympus.url, text: "R$ 500\nCâmera Olympus\nNavegantes, SC", ariaLabel: null, image: null }];
  }
  locator(selector: string) {
    if (selector === ":not(a, a *, button, button *)") {
      return new LocatorFixture(() => this.elements().filter((element) => !element.selector?.startsWith("a") && element.role !== "button"));
    }
    return new LocatorFixture(() => this.elements().filter((element) => element.selector && selector.includes(element.selector)));
  }
  getByText(name: string | RegExp) {
    return new LocatorFixture(() => this.elements().filter((element) => matches(element.label, name)));
  }
  getByRole(role: string, options?: { name?: string | RegExp }) {
    return new LocatorFixture(() => this.elements().flatMap((element) => [element, ...(element.children?.() ?? [])])
      .filter((element) => element.role === role && matches(element.label, options?.name)));
  }
  private isItemPage(): boolean {
    const path = new URL(this.#url).pathname;
    return this.options.provider === "olx" ? /-\d{6,}\/?$/.test(path) : /^\/marketplace\/item\//.test(path);
  }
  private elements(): ElementFixture[] {
    if (this.isItemPage()) {
      return [
        { selector: this.options.provider === "olx" ? "h1" : "main", label: "Câmera Olympus" },
        ...(this.options.unavailableMessage ? [{ role: "heading", label: this.options.unavailableMessage }] : []),
      ];
    }
    const mode = this.options.mode ?? "result";
    const result = mode === "result" || mode === "unreadable" || mode === "empty_with_suggestions"
      ? [{
        selector: this.options.provider === "olx" ? "a.olx-adcard__link" : 'a[href*="/marketplace/item/"]',
        label: this.options.misleadingTitle ? "Nenhum resultado encontrado" : "Câmera Olympus",
      }] : [];
    const empty = mode === "empty" || mode === "empty_with_suggestions"
      ? [{ role: "heading", label: this.options.provider === "olx" ? "Nenhum anúncio encontrado" : "Nenhum resultado encontrado" }] : [];
    if (this.options.provider === "olx") return [...result, ...empty];
    const apply = () => {
      this.#selectedPlace = this.options.visibleLocationAfterApply ?? this.#dialogPlace;
      this.#selectedRadius = this.options.visibleRadiusAfterApply ?? this.#dialogRadius;
      this.#dialog = false;
    };
    const close = () => { this.#dialog = false; };
    const open = () => {
      this.dialogOpening();
      this.#dialog = true;
      this.#dialogPlace = this.#selectedPlace;
      this.#dialogRadius = this.#selectedRadius;
      this.#entered = "";
      this.#radiusOpen = false;
    };
    const suggestion = this.options.citySuggestion ?? "Itajaí, Santa Catarina, Brasil";
    const cityOption = {
      role: "option", selector: '[role="option"]',
      label: this.options.portalControls ? "Itajaí Cidade" : suggestion,
      click: () => {
        this.#dialogPlace = this.options.portalControls ? "Itajaí" : suggestion;
        this.#entered = "";
      },
    };
    const dialog = new DialogFixture(() => [
      { role: "textbox", selector: "input[type=text]", label: "Localização", fill: (value) => { this.#entered = value; }, inputValue: () => this.#dialogPlace },
      ...(this.options.portalControls ? [{
        role: "combobox", label: this.#dialogRadius || "Raio", click: () => { this.#radiusOpen = true; },
      }] : [{ selector: "select", label: "Raio", options: ["10 km", "50 km", "100 km"], inputValue: () => this.#dialogRadius, selectOption: (label: string) => { this.#dialogRadius = label; } }]),
      { role: "button", label: "Aplicar", click: apply },
      { role: "button", label: "Fechar", click: close },
      ...(this.#entered && !this.options.portalControls ? [cityOption] : []),
    ], close);
    return [
      {
        role: "button", click: open,
        label: this.#selectedPlace
          ? this.options.portalControls && this.scopeAtQuery.length > 0
            ? `Localização: ${this.#selectedPlace}, No raio de ${this.#selectedRadius}`
            : this.options.displayScope === "city" ? this.#selectedPlace.split(",")[0]! : `${this.#selectedPlace} · A ${this.#selectedRadius}`
          : "Localização",
      },
      ...(this.#dialog ? [dialog] : []),
      ...(this.#dialog && this.options.portalControls && /santa catarina/i.test(this.#entered)
        ? [{ role: "listbox", label: "Cidades", children: () => [cityOption] }] : []),
      ...(this.#dialog && this.options.portalControls && this.#radiusOpen ? [{
        role: "listbox", label: "Raios",
        children: () => [40, 60].map((radius) => ({
          role: "option", selector: '[role="option"]', label: `${radius} quilômetros`,
          click: () => { this.#dialogRadius = `${radius} quilômetros`; this.#radiusOpen = false; },
        })),
      }] : []),
      ...(this.#selectedPlace && this.options.fakeScopeText ? [{ label: "Itajaí, Santa Catarina · A 50 km" }, { label: "Itajaí" }] : []),
      ...result, ...empty,
    ];
  }
}

function facebook() { return new FacebookMarketplaceProvider("package.json", true, 10, 100, logger, false); }
function olx() { return new OlxProvider("package.json", true, 10, 100, logger, false); }

describe("Facebook Marketplace search scope", () => {
  it("selects a confirmed municipality and radius from pop-up listboxes outside the dialog", async () => {
    const page = new PageFixture({ portalControls: true });
    mockPages(page);
    await expect(facebook().search({ ...scoped, radiusKm: 40 })).resolves.toEqual([olympus]);
    expect(page.scopeAtQuery).toEqual(["Itajaí · 40 quilômetros"]);
  });

  it("rejects a city-only option when the requested state conflicts with the municipality", async () => {
    mockPages(new PageFixture({ portalControls: true }));
    await expect(facebook().search({ ...scoped, location: "Itajaí, PR", radiusKm: 40 }))
      .rejects.toMatchObject({ code: "facebook_scope_unverified" });
  });
  it("applies a city and radius before searching and accepts results from nearby cities", async () => {
    const page = new PageFixture();
    mockPages(page);

    await expect(facebook().search(scoped)).resolves.toEqual([olympus]);
    expect(page.scopeAtQuery).toEqual(["Itajaí, Santa Catarina, Brasil · 50 km"]);
    expect(new URL(page.visits.at(-1)!).searchParams.get("radius")).toBe("50");
  });

  it.each([
    { citySuggestion: "Itajaí, Paraná, Brasil" },
    { visibleLocationAfterApply: "Blumenau, Santa Catarina, Brasil" },
    { visibleRadiusAfterApply: "100 km" },
  ])("fails explicitly when the selected scope cannot be verified before querying (%o)", async (options) => {
    const page = new PageFixture(options);
    mockPages(page);

    await expect(facebook().search(scoped)).rejects.toMatchObject({ code: "facebook_scope_unverified" });
    expect(page.scopeAtQuery).toEqual([]);
  });

  it("rejects a search page whose active radius drifted after selection", async () => {
    mockPages(new PageFixture({ driftOnQuery: true }));

    await expect(facebook().search(scoped)).rejects.toMatchObject({ code: "facebook_scope_unverified" });
  });

  it("rejects a mismatched scope even when unrelated text contains the requested city and radius", async () => {
    const page = new PageFixture({ visibleLocationAfterApply: "Blumenau, Santa Catarina, Brasil", fakeScopeText: true });
    mockPages(page);

    await expect(facebook().search(scoped)).rejects.toMatchObject({ code: "facebook_scope_unverified" });
    expect(page.scopeAtQuery).toEqual([]);
  });

  it("verifies the saved location in the dialog when the page only labels the city", async () => {
    const page = new PageFixture({ displayScope: "city" });
    mockPages(page);

    await expect(facebook().search({ ...scoped, location: "Itajai, SC" })).resolves.toEqual([olympus]);
    expect(page.scopeAtQuery).toEqual(["Itajaí, Santa Catarina, Brasil · 50 km"]);
    expect(page.dialogOpening).toHaveBeenCalledTimes(3);
  });

  it("does not treat unrelated city text as a city-only location control", async () => {
    const page = new PageFixture({ displayScope: "city", visibleLocationAfterApply: "Blumenau, Santa Catarina", fakeScopeText: true });
    mockPages(page);

    await expect(facebook().search(scoped)).rejects.toMatchObject({ code: "facebook_scope_unverified" });
  });

  it("rejects unsupported radii without submitting the query", async () => {
    const page = new PageFixture();
    mockPages(page);

    await expect(facebook().search({ ...scoped, radiusKm: 55 })).rejects.toMatchObject({ code: "facebook_scope_unverified" });
    expect(page.scopeAtQuery).toEqual([]);
  });

  it("serializes scope changes and unscoped searches on the shared session", async () => {
    let release!: () => void;
    let firstNavigation!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstNavigation = resolve; });
    const firstPage = new PageFixture({ beforeFirstNavigation: async () => { firstNavigation(); await blocked; } });
    const secondPage = new PageFixture();
    const browserPage = mockPages(firstPage, secondPage);
    const provider = facebook();
    const first = provider.search(scoped);
    await firstStarted;
    const second = provider.search({ ...scoped, verifyLocation: false });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(browserPage).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    expect(secondPage.visits).toHaveLength(1);
    expect(secondPage.dialogOpening).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual([olympus]);
    await expect(second).resolves.toEqual([olympus]);
  });

  it("recognizes empty results after verifying the active scope", async () => {
    const page = new PageFixture({ mode: "empty_with_suggestions" });
    mockPages(page);

    await expect(facebook().search(scoped)).resolves.toEqual([]);
    expect(page.scopeAtQuery).toEqual(["Itajaí, Santa Catarina, Brasil · 50 km"]);
  });

  it("does not mistake a listing title for a provider empty-state message", async () => {
    mockPages(new PageFixture({ misleadingTitle: true }));

    await expect(facebook().search(scoped)).resolves.toEqual([olympus]);
  });

  it.each(["Results from farther away", "Resultados fora da sua pesquisa"])("keeps scoped primary cards and excludes the %s section", async (heading) => {
    mockPages(new PageFixture({
      resultsHtml: `
        <aside><a href="https://www.facebook.com/marketplace/item/999/" aria-label="Item em outro painel">R$ 350</a></aside>
        <main>
          <a href="${olympus.url}" aria-label="Câmera Olympus">R$ 500\nNavegantes, SC</a>
          <a hidden href="https://www.facebook.com/marketplace/item/456/" aria-label="Item oculto">R$ 100</a>
          <section><h2>${heading}</h2><a href="https://www.facebook.com/marketplace/item/789/" aria-label="Fora do raio">R$ 300</a></section>
        </main>`,
    }));

    await expect(facebook().search(scoped)).resolves.toEqual([olympus]);
  });

  it("reports a change in result markup as failure when cards cannot be parsed", async () => {
    mockPages(new PageFixture({ mode: "unreadable" }));

    await expect(facebook().search({ query: "camera", limit: 5 })).rejects.toMatchObject({ code: "facebook_search_failed" });
  });
});

describe("browser detail identity and pricing", () => {
  it.each([{ provider: "facebook" as const, listing: olympus, redirectTo: "https://www.facebook.com/marketplace/item/456/" },
    { provider: "olx" as const, listing: olxItem, redirectTo: "https://www.olx.com.br/item/outra-camera-987654321" }])
    ("rejects redirects to another $provider item", async ({ provider, listing, redirectTo }) => {
      mockPages(new PageFixture({ provider, redirectTo }));
      await expect((provider === "facebook" ? facebook() : olx()).getListingDetails(listing))
        .rejects.toMatchObject({ code: "listing_unavailable" });
    });

  it.each([
    { provider: "facebook" as const, listing: olympus, unavailableMessage: "Este anúncio não está mais disponível" },
    { provider: "olx" as const, listing: olxItem, unavailableMessage: "Este anúncio foi removido" },
  ])("rejects visible unavailable messages on the $provider item URL", async ({ provider, listing, unavailableMessage }) => {
    mockPages(new PageFixture({ provider, unavailableMessage }));
    await expect((provider === "facebook" ? facebook() : olx()).getListingDetails(listing))
      .rejects.toMatchObject({ code: "listing_unavailable" });
  });

  it("accepts an OLX canonical redirect that retains the requested item ID", async () => {
    mockPages(new PageFixture({ provider: "olx", redirectTo: "https://sc.olx.com.br/itajai/camera-olympus-123456789" }));
    await expect(olx().getListingDetails(olxItem)).resolves.toMatchObject({ title: "Câmera Olympus", externalId: "123456789" });
  });

  it("reports HTTP 404 item responses as unavailable", async () => {
    mockPages(new PageFixture({ provider: "olx", httpStatus: 404 }));
    await expect(olx().getListingDetails(olxItem)).rejects.toMatchObject({ code: "listing_unavailable" });
  });

  it("chooses a single monetary token from a Facebook card or detail", () => {
    expect(parseFacebookSearchCard({ href: olympus.url, text: "R$ 500 R$ 450\nCâmera Olympus", ariaLabel: null, image: null })?.price).toBe(500);
    expect(mapFacebookDetails(olympus, {
      title: null, priceText: "R$ 450 R$ 500", text: "", description: null, location: null, sellerName: null, images: [], attributes: {},
    }).price).toBe(450);
  });

  const detail = {
    title: null, description: null, priceText: null, location: null, sellerName: null, images: [], attributes: {}, publishedAt: null,
  };

  it("does not create a price from digits in OLX ad text", () => {
    expect(mapOlxDetails({ ...olxItem, price: null, currency: null }, {
      ...detail, priceText: "iPhone 13 usado — Preço a combinar",
    })).toMatchObject({ price: null, currency: null });
  });

  it("preserves the structured currency of an OLX offer", () => {
    expect(mapOlxDetails(olxItem, {
      ...detail, structuredData: ['{"@type":"Product","offers":{"price":400,"priceCurrency":"USD"}}'],
    })).toMatchObject({ price: 400, currency: "USD" });
  });

  it("leaves OLX structured price currency unknown without an explicit currency", () => {
    expect(mapOlxDetails(olxItem, {
      ...detail, structuredData: ['{"@type":"Product","offers":{"price":400}}'],
    })).toMatchObject({ price: 400, currency: null });
  });
});

describe("OLX national search", () => {
  it("queries Brasil and recognizes a provider-confirmed empty result", async () => {
    const page = new PageFixture({ provider: "olx", mode: "empty" });
    mockPages(page);

    await expect(olx().search({ query: "câmera digital", limit: 5, minPrice: 100, maxPrice: 600 })).resolves.toEqual([]);
    expect(page.visits).toEqual(["https://www.olx.com.br/brasil?q=c%C3%A2mera+digital&ps=100&pe=600"]);
  });

  it("rejects a geographic redirect even if the resulting location is empty", async () => {
    mockPages(new PageFixture({ provider: "olx", mode: "empty", redirectTo: "https://sc.olx.com.br/itajai?q=camera" }));

    await expect(olx().search({ query: "camera", limit: 5 })).rejects.toMatchObject({ code: "olx_scope_unverified" });
  });

  it("reports changed result markup as failure when there is no empty-result message", async () => {
    mockPages(new PageFixture({ provider: "olx", mode: "layout" }));

    await expect(olx().search({ query: "camera", limit: 5 })).rejects.toMatchObject({ code: "olx_search_failed" });
  });

  it("preserves challenge detection before verifying any result", async () => {
    mockPages(new PageFixture({ provider: "olx", mode: "blocked" }));

    await expect(olx().search({ query: "camera", limit: 5 })).rejects.toMatchObject({ code: "olx_access_blocked" });
  });
});

describe("provider condition and shipping evidence", () => {
  it("extracts Facebook visible condition and a pickup-only shipping statement", () => {
    const detail = {
      title: null, text: "Detalhes\nCondição: Usado — bom\nSomente retirada\nDescrição\nTexto",
      description: "Texto", priceText: null, location: null, sellerName: null, images: [], attributes: {},
    };

    expect(mapFacebookDetails(olympus, detail).attributes).toMatchObject({ "Condição": "Usado — bom", shipping: "pickup_only" });
  });

  it("extracts OLX condition and shipping from the selected item's structured offer", () => {
    const detail = {
      title: null, description: null, priceText: null, location: null, sellerName: null, images: [], attributes: {}, publishedAt: null,
      structuredData: [JSON.stringify({ "@graph": [{ "@type": "Product", name: "Olympus", offers: [
        { "@type": "Offer", price: 450, itemCondition: "https://schema.org/UsedCondition", shippingDetails: { "@type": "OfferShippingDetails", doesNotShip: false } },
      ] }] })],
    };
    const listing = mapOlxDetails({ ...olympus, source: "olx", url: "https://www.olx.com.br/item/camera-123456789" }, detail);

    expect(listing).toMatchObject({ title: "Olympus", price: 450, attributes: { itemCondition: "https://schema.org/UsedCondition", shipping: "available" } });
  });

  it("keeps shipping unknown for an offer with an explicit shipping restriction", () => {
    const detail = {
      title: null, description: null, priceText: null, location: null, sellerName: null, images: [], attributes: {}, publishedAt: null,
      structuredData: [JSON.stringify({ "@type": "Product", itemCondition: "https://schema.org/NewCondition", offers: {
        "@type": "Offer", shippingDetails: { "@type": "OfferShippingDetails", doesNotShip: true },
      } })],
    };
    const listing = mapOlxDetails({ ...olympus, source: "olx", url: "https://www.olx.com.br/item/camera-123456789" }, detail);

    expect(listing.attributes).toEqual({ itemCondition: "https://schema.org/NewCondition" });
  });
});
