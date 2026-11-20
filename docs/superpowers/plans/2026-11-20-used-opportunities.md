# Used Opportunities Implementation Plan

> **For agentic workers:** Use subagent-driven-development with exclusive file ownership. Track progress in this plan's SDD workspace.

**Goal:** Monitor used items on OLX nationally and Facebook around Itajaí, SC (50 km), with personal-use and resale evaluation in the dashboard.

**Architecture:** Extend the existing TypeScript/Prisma pipeline and React dashboard. Optional, validated opportunity settings opt searches into the new workflow while legacy searches retain compatible data contracts. Store evaluation snapshots per search/listing and durable run/source outcomes.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Playwright, React/Vite, Vitest.

**Spec:** The proposed plan approved in this chat on 2026-11-20, captured below.

## Global Constraints

- User-defined terms, any category, automated scheduling, dashboard delivery.
- OLX nationwide; Facebook Itajaí, SC, 50 km by default, verified using the site's supported controls.
- Used/seminovo items only; exclude explicit new/refurbished/damaged items, retain unknown condition as candidates with warnings.
- At least five recent comparable used items, excluding duplicates/current item. Median is an asking-price reference.
- Default minimum discount 15%, minimum comparables 5, interval 60 minutes; configurable per search.
- Personal opportunities require the discount threshold. Resale also requires known costs and positive estimated profit.
- Fixed costs and sale fee percentage may be unknown; do not invent zero costs.
- Maintain existing data, legacy contracts and provider opt-in. New workflow never sends Telegram.
- No deployment, purchase automation, bypassing challenges, or modification of existing user secrets.

## Interfaces and ownership

- Domain agent owns `prisma/schema.prisma`, new migration, `src/opportunities/*`, `src/searches/validation.ts`, generic condition extraction and its tests.
- Provider agent owns Facebook/OLX providers/parsers/selectors, `src/marketplaces/types.ts`, provider-specific helpers/tests.
- Dashboard agent owns `src/dashboard/*`, `dashboard/*`, dashboard tests.
- Coordinator owns runner, listing repository, CLI compatibility, integration tests, docs and final validation.
- `Search.opportunitySettings Json?` stores validated `UsedSearchSettings`. Legacy null is supported.
- Settings shape `{ purpose: "personal" | "resale", minimumDiscountPercent: number, minimumComparables: number, facebookLocation: string, facebookRadiusKm: number, costs: { fixed: number | null, feePercent: number | null } }`.
- `src/opportunities/settings.ts` exports schema, type, defaults and `getUsedSearchSettings(value: unknown): UsedSearchSettings | null`.
- `src/opportunities/condition.ts` exports `inspectUsedListing(listing: ListingDetails)` returning `{ condition, shipping, defects: string[], warnings: string[], evidence: string[] }`. Conditions `new|used|refurbished|damaged|unknown`; shipping `available|pickup_only|unknown`.
- `src/opportunities/evaluation.ts` exports `evaluateOpportunity({ listing, settings, market })` returning JSON-serializable snapshot with `classification: opportunity|candidate|excluded`, purpose, reason, condition, shipping, warnings, referencePrice, sampleSize, discountPercent, estimatedProfit, estimatedMarginPercent, totalCost and settingsSnapshot.
- `ListingAnalysis.opportunity Json?` stores that snapshot. Profit = referencePrice - purchase - fixed - referencePrice * feePercent / 100. Margin = profit / totalCost * 100.
- `SearchRun` stores `id` (lease id), `searchId`, `startedAt`, `finishedAt`, `status`, `providers Json`, `discovered`, `analyzed`. Status `running|success|partial|failed|interrupted`. Search exposes runs relation.
- Source run entries store status, error code, count, scope, details failures. Empty status requires provider-confirmed absence.
- Dashboard listing endpoint returns listings with `searches` links and latest analysis per associated search, including the opportunity snapshot. Keep existing listing fields. Add `/api/runs` and optional `listRuns` repository method for compatibility.

## Review Focus

- A condition of seminovo must never become new through substring matching.
- Facebook radius must not discard neighboring cities through legacy same-city filters.
- Unknown costs and insufficient comparisons must not produce profit opportunities.
- Latest evaluation must belong to the selected search and settings revision.
- Shared Facebook sessions, interrupted runs and total source failures must retain truthful state.

## Task 1 — Domain and persistence contracts

- [ ] Write and run failing tests for defaults/validation, condition evidence/negations, five-comparable thresholds and margin formulas.
- [ ] Implement shared modules, optional settings validation, schema additions and additive migration.
- [ ] Run targeted tests and Prisma generation/validation.

## Task 2 — Source scope and extraction

- [ ] Write/run regressions for Facebook scope verification/serialization, OLX national URL, explicit empty results and condition/shipping extraction.
- [ ] Implement supported scope selection and fail explicitly when scope cannot be verified; preserve login/challenge handling.
- [ ] Run provider tests and report any live validation dependency.

## Task 3 — Search pipeline integration

- [ ] Write/run regressions for per-source criteria, criteria hash, no Telegram, run outcomes and comparable selection beyond a global category cap.
- [ ] Integrate domain evaluation, persist snapshots with listing fences, normalize comparables from raw legacy listings, retain existing legacy analysis path.
- [ ] Persist run lifecycle and recover expired runs with lease fencing, capturing source/detail failures.
- [ ] Run targeted integration suites.

## Task 4 — Dashboard

- [ ] Extend creation/editing for purpose, source scope, reference thresholds and optional resale costs.
- [ ] Display per-search opportunities/candidates, warnings, reference sample and source run statuses; refresh while monitoring.
- [ ] Keep legacy history accessible; update API tests and build dashboard.

## Task 5 — Integration and verification

- [ ] Independently review changed domain, provider and dashboard contracts, fix integration issues.
- [ ] Test additive migrations against clean and legacy fixture databases when PostgreSQL is available.
- [ ] Run full coverage, typecheck, backend/dashboard builds, Prisma validation, diff check.
- [ ] Attempt live validation only with available configured sessions, report concrete unverified portions.
- [ ] Update operational docs, review whole change and deliver concise results.
