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

## What this system does

Form ingestion pipeline for healthcare registration data. A third-party provider POSTs forms to `/ingest`. The system must:

1. Validate against `IngestedFormSchema` (third party may silently change this schema)
2. Deduplicate — `session_id` or `application_reference` identifies a form uniquely; FORM-BOT must never receive the same form twice
3. Geocode the postcode via `lookupPostcode` (mock: 95% success, 1s latency)
4. Transform to `TransformedFormSchema` and persist
5. Email `happyforms@bots.com` via `sendEmail` (mock: 95% success, 1s latency) — must be guaranteed delivery
6. Expose a `/retry` endpoint so failed forms can be reprocessed after a code fix is deployed

## Schema transformation notes

`IngestedFormSchema` → `TransformedFormSchema` key differences:

- `name: string` splits into `firstName` / `lastName`
- `gender: "other"` maps to `gender: "prefer-not-to-say"`
- `date_of_birth: string` → `dateOfBirth: Date`
- All snake_case fields → camelCase
- Address object flattens to top-level fields
- `longitude` / `latitude` are added from geocoding (not in ingest payload)

## Providers

`src/providers/idealpostcodes.ts` and `src/providers/sendgrid.ts` are mock implementations — do not replace them. Both simulate async I/O and non-deterministic failure (5% failure rate) via `HttpResponse<T>`. Retry logic for email delivery must be built on top of these mocks.

## Architecture constraints

- **Database required**: schema design is evaluated. Use a real DB (Postgres recommended). Store raw ingested payload alongside transformed record so failed forms can be retried without data loss.
- **Idempotency**: the third party does not guarantee exactly-once delivery. Deduplication must be enforced at the DB layer, not just in application logic.
- **Resilience**: schema validation failures should be persisted (with the raw payload) so they can be retried after a code fix — not silently dropped.
- **Email guarantee**: `sendEmail` can fail; use a retry/queue strategy, not fire-and-forget.

## Code quality standards

- No redundant comments — names should be self-documenting; only comment non-obvious invariants or workarounds
- No duplicated helpers — check existing providers/utilities before introducing new ones
- TypeScript strict mode is on; no `any` casts unless genuinely unavoidable
- Prefer narrowly-scoped functions over god-functions; each step (validate, geocode, transform, persist, notify) should be independently testable
