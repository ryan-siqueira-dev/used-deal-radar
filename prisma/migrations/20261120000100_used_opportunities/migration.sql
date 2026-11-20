BEGIN;

ALTER TABLE "Search" ADD COLUMN "opportunitySettings" JSONB;
ALTER TABLE "ListingAnalysis" ADD COLUMN "opportunity" JSONB;

CREATE TYPE "SearchRunStatus" AS ENUM ('running', 'success', 'partial', 'failed', 'interrupted');

CREATE TABLE "SearchRun" (
  "id" TEXT NOT NULL,
  "searchId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "status" "SearchRunStatus" NOT NULL,
  "providers" JSONB NOT NULL,
  "discovered" INTEGER NOT NULL DEFAULT 0,
  "analyzed" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SearchRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SearchRun_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SearchRun_searchId_startedAt_idx" ON "SearchRun"("searchId", "startedAt");
CREATE INDEX "SearchRun_startedAt_idx" ON "SearchRun"("startedAt");

ALTER TABLE "SearchListing" ADD COLUMN "currentAnalysisId" TEXT;
ALTER TABLE "SearchListing" ADD CONSTRAINT "SearchListing_currentAnalysisId_fkey"
  FOREIGN KEY ("currentAnalysisId") REFERENCES "ListingAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SearchListing_currentAnalysisId_idx" ON "SearchListing"("currentAnalysisId");

COMMIT;
