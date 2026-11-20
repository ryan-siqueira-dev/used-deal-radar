import { Prisma, type SearchRunStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { ProviderError } from "../marketplaces/provider.js";
import type { MarketplaceName } from "../marketplaces/types.js";

interface SourceRun {
  status: "running" | "success" | "empty" | "failed" | "disabled";
  error: string | null;
  count: number;
  detailFailures: number;
  scope: { location: string | null; radiusKm: number | null; verified: boolean };
}

/** One durable progress record for a leased search, independent of other searches. */
export class SearchRunTracker {
  private readonly sources: Partial<Record<MarketplaceName, SourceRun>> = {};
  private pipelineFailures = 0;
  private analyzed = 0;

  constructor(private readonly id: string, private readonly searchId: string) {}

  static async recoverInterrupted(now: Date): Promise<void> {
    await prisma.searchRun.updateMany({
      where: {
        status: "running",
        search: { OR: [{ runLeaseId: null }, { runLeaseExpiresAt: { lte: now } }] },
      },
      data: { status: "interrupted", finishedAt: now },
    });
  }

  async start(): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      // Updating the search locks its row until progress initialization commits.
      const owned = await transaction.search.updateMany({
        where: { id: this.searchId, runLeaseId: this.id, runLeaseExpiresAt: { gt: new Date() }, active: true },
        data: { runLeaseExpiresAt: new Date(Date.now() + 30 * 60_000) },
      });
      if (owned.count !== 1) throw new Error("search_run_lease_lost");
      await transaction.searchRun.updateMany({
        where: { searchId: this.searchId, status: "running", id: { not: this.id } },
        data: { status: "interrupted", finishedAt: new Date() },
      });
      await transaction.searchRun.create({
        data: { id: this.id, searchId: this.searchId, status: "running", providers: {} },
      });
    });
  }

  beginSource(source: MarketplaceName, location: string | null, radiusKm: number | null): void {
    this.sources[source] = {
      status: "running", error: null, count: 0, detailFailures: 0,
      scope: { location, radiusKm, verified: false },
    };
  }

  sourceSucceeded(source: MarketplaceName, count: number): void {
    const entry = this.sources[source];
    if (!entry) return;
    entry.status = count > 0 ? "success" : "empty";
    entry.count = count;
    entry.scope.verified = true;
  }

  sourceFailed(source: MarketplaceName, error: unknown, disabled = false): void {
    const entry = this.sources[source];
    if (!entry) return;
    entry.status = disabled ? "disabled" : "failed";
    entry.error = error instanceof ProviderError ? error.code : "provider_request_failed";
  }

  detailFailed(source: MarketplaceName): void {
    const entry = this.sources[source];
    if (entry) entry.detailFailures += 1;
  }

  analysisFailed(): void { this.pipelineFailures += 1; }
  analysisCompleted(): void { this.analyzed += 1; }

  async save(): Promise<void> {
    await prisma.searchRun.updateMany({
      where: { id: this.id, status: "running" },
      data: {
        providers: this.snapshot(),
        discovered: Object.values(this.sources).reduce((total, entry) => total + entry.count, 0),
        analyzed: this.analyzed,
      },
    });
  }

  async finish(discovered: number, analyzed: number, completed: boolean, stopped: boolean): Promise<void> {
    const entries = Object.values(this.sources);
    const successful = entries.filter((entry) => entry.status === "success" || entry.status === "empty").length;
    const hasFailures = this.pipelineFailures > 0 || entries.some((entry) => entry.detailFailures > 0);
    let status: SearchRunStatus = "success";
    if (stopped) status = "interrupted";
    else if (!completed || successful === 0) status = "failed";
    else if (successful < entries.length || hasFailures) status = "partial";
    const finishedAt = new Date();
    const result = await prisma.searchRun.updateMany({
      where: { id: this.id, status: "running", search: { runLeaseId: this.id, runLeaseExpiresAt: { gt: finishedAt } } },
      data: { status, providers: this.snapshot(), discovered, analyzed, finishedAt: new Date() },
    });
    if (result.count === 0) {
      await prisma.searchRun.updateMany({
        where: { id: this.id, status: "running" },
        data: { status: "interrupted", providers: this.snapshot(), discovered, analyzed, finishedAt },
      });
    }
  }

  private snapshot(): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(this.sources)) as Prisma.InputJsonValue;
  }
}
