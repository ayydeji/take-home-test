# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker compose up -d   # start Postgres (required for tests and dev)
npm run dev            # ts-node-dev with hot reload (development)
npm run build          # tsc compile to dist/
npm start              # run compiled dist/index.js
npm test               # vitest run (all tests)
npx vitest run tests/<file>.test.ts  # run a single test file
npm run lint            # eslint + prettier --check
npm run typecheck        # tsc --noEmit
```

## Git workflow

Do not commit or push changes without explicit direction from the user for that stage. The user reviews the code and diff themselves after each stage before deciding whether to commit and push. Never run `git commit` or `git push` speculatively, even after tests are green.

## Global context (include with every stage)

You are implementing one stage of a form ingestion service. Implement only the stage you are given.

**System summary.** The service ingests GP registration forms from an unreliable third-party provider via `POST /ingest`, stores raw payloads before any validation, processes them through validate, geocode, and transform as idempotent status transitions in Postgres, guarantees a notification email via a transactional outbox, and hands completed forms to a downstream consumer (FORM-BOT) at most once via an atomic claim endpoint. Failed forms are quarantined with stored errors and replayed via `POST /forms/:id/retry` after a code fix.

**Invariants.** Never violate these:

- Never lose data. The raw payload is persisted before validation. Failures are statuses, not rejections.
- Ingest is idempotent. Dedupe is enforced by a database unique constraint, never by application logic alone.
- FORM-BOT handoff is at-most-once. The claim and the status flip happen in one transaction.
- The email is at-least-once. The outbox row commits in the same transaction as the transform, and the worker retries until success.
- Every state change writes a `form_events` row.
- PII never appears in logs, error columns, or emails. Log form ids and statuses only. Error records store issue paths and codes, never received values.

**Stack, fixed, do not substitute:** TypeScript (strict), Express, Drizzle ORM with drizzle-kit migrations, Postgres 16 via docker-compose, Zod, Vitest, Testcontainers. Do not add Redis, message brokers, NestJS, Prisma, or any additional services.

**Status enum, fixed:** `RECEIVED`, `VALIDATED`, `GEOCODED`, `READY`, `DISPATCHED`, `CONFLICT`, `FAILED_VALIDATION`, `FAILED_GEOCODING`, `FAILED_TRANSFORM`. Terminal statuses: `READY` (terminal for the pipeline), `DISPATCHED`, `CONFLICT`, and the three `FAILED_*` (terminal until retried).

**Conventions:**

- Every status transition is a compare-and-swap update: `UPDATE forms SET status = $next, updated_at = now() WHERE id = $id AND status = $expected`. Zero rows updated means another process got there first. Treat it as a no-op, never as an error.
- Write the claim and outbox poll queries in raw SQL via drizzle's `sql` template so `FOR UPDATE SKIP LOCKED` is visible in the code.
- All integration tests run against real Postgres via the shared Testcontainers helper. Never mock the database. Pure functions get plain unit tests.
- Conventional commit messages. The body explains the decision being encoded, not a restatement of the diff.
- Do not refactor earlier stages unless the stage instructs it. Do not add features not listed. If something is ambiguous, pick the simplest option consistent with the invariants and note the choice in the commit body.
- Definition of done for every stage: typecheck clean, lint clean, all tests green, no skipped tests, CI green.

**Provided by the take-home, assume present:**

- `src/forms/schemas/ingested_schema.ts` (`IngestedFormSchema`) and `src/forms/schemas/transformed_schema.ts` (`TransformedFormSchema`) are the source of truth for field names and types. Derive the Zod validation schema from `IngestedFormSchema` and the Drizzle table schema from `TransformedFormSchema` — match their field names and types exactly. Do not invent new field names, rename fields, or change types; if the two files disagree with something elsewhere in this document, the schema files win.
- `src/providers/idealpostcodes.ts` (`lookupPostcode`, mock geocoding) and `src/providers/sendgrid.ts` (`sendEmail`, mock email) — both simulate async I/O and a 5% failure rate via `HttpResponse<T>`. Wrap these, never replace or reimplement their logic.

## Schema transformation notes

`IngestedFormSchema` → `TransformedFormSchema` key differences:

- `name: string` splits into `firstName` / `lastName`
- `gender: "other"` maps to `gender: "prefer-not-to-say"`
- `date_of_birth: string` → `dateOfBirth: Date`
- All snake_case fields → camelCase
- Address object flattens to top-level fields
- `longitude` / `latitude` are added from geocoding (not in ingest payload)

## Code quality standards

- No redundant comments — names should be self-documenting; only comment non-obvious invariants or workarounds
- No duplicated helpers — check existing providers/utilities before introducing new ones
- TypeScript strict mode is on; no `any` casts unless genuinely unavoidable
- Prefer narrowly-scoped functions over god-functions; each step (validate, geocode, transform, persist, notify) should be independently testable
