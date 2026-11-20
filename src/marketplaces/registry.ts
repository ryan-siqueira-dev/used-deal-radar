import { ProviderError } from "./provider.js";
import type { MarketplaceProvider } from "./provider.js";
import type { MarketplaceName } from "./types.js";

export class MarketplaceRegistry {
  readonly #providers = new Map<MarketplaceName, MarketplaceProvider>();
  readonly #states = new Map<MarketplaceName, {status: "configured_unverified" | "working" | "blocked" | "error"; error: string | null; searched: boolean}>();
  getStatus(name: MarketplaceName) { const state = this.#states.get(name); return { status: state?.status ?? "configured_unverified", error: state?.error ?? null }; }
  recordSuccess(name: MarketplaceName, phase: "search" | "details"): void {
    const previous = this.#states.get(name);
    const searched = phase === "search" || previous?.searched === true;
    this.#states.set(name, { status: phase === "details" && searched ? "working" : "configured_unverified", error: null, searched });
  }
  recordFailure(name: MarketplaceName, error: unknown): void {
    const code = error instanceof ProviderError ? error.code : "provider_request_failed";
    this.#states.set(name, {status: /blocked|challenge|captcha/i.test(code) ? "blocked" : "error", error: code, searched: false});
  }

  register(provider: MarketplaceProvider): void {
    if (this.#providers.has(provider.name)) {
      throw new Error(`marketplace_provider_already_registered: ${provider.name}`);
    }
    this.#providers.set(provider.name, provider);
  }

  get(name: MarketplaceName): MarketplaceProvider {
    const provider = this.#providers.get(name);
    if (!provider) throw new Error(`marketplace_provider_not_registered: ${name}`);
    return provider;
  }

  has(name: MarketplaceName): boolean {
    return this.#providers.has(name);
  }

  list(): MarketplaceName[] {
    return [...this.#providers.keys()];
  }

  async close(): Promise<void> {
    const operations = [...this.#providers.values()].flatMap((provider) => provider.close ? [provider.close()] : []);
    const results = await Promise.allSettled(operations);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "marketplace_shutdown_failed");
  }
}
