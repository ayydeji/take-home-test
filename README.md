# Form ingestion service

[![CI](https://github.com/ayydeji/take-home-test/actions/workflows/ci.yml/badge.svg)](https://github.com/ayydeji/take-home-test/actions/workflows/ci.yml)

Ingests GP registration forms from an unreliable third-party provider, storing every raw payload before it is validated so nothing is ever lost. Each form is processed — validate, geocode, transform — as idempotent status transitions in Postgres, guarantees a notification email through a transactional outbox, and is handed to the downstream consumer (FORM-BOT) at most once. Forms that fail any step are quarantined with their error and replayed through `POST /forms/:id/retry` after a code or schema fix.

## The six invariants

These are the properties the system never violates. Each is enforced by a database mechanism, not by hope, and each has a test that proves it.

1. **Never lose data.** The raw payload is persisted before any validation runs; failures are recorded as statuses, never as rejected requests. — `tests/app.test.ts`, `tests/journeys/schema-drift-retry.test.ts` (renamed-field payload survives verbatim).
2. **Ingest is idempotent.** Deduplication is enforced by a `UNIQUE` constraint on a canonical content hash — never by application logic alone. — `tests/app.test.ts` (10-way concurrent race → one row), `tests/journeys/duplicate-delivery.test.ts`.
3. **FORM-BOT handoff is at most once.** The claim and the `READY → DISPATCHED` flip happen in one transaction under `FOR UPDATE SKIP LOCKED`. — `tests/claim.test.ts`, `tests/journeys/claim-race.test.ts` (two bots, disjoint sets).
4. **The email is at least once.** The outbox row commits in the same transaction as the transform, and the worker retries forever until the send succeeds. — `tests/transformStep.test.ts` (atomicity), `tests/outbox.test.ts` (failing mailer, crash rollback).
5. **Every state change writes a `form_events` row.** The events table is an append-only audit trail of every transition. — asserted across `tests/validate.test.ts`, `tests/geocode.test.ts`, `tests/transformStep.test.ts`, `tests/retry.test.ts`.
6. **PII never appears in logs, error columns, or emails.** Logs carry form ids and statuses only; error records store issue paths and codes, never received values; the outbox email is metadata only. — `tests/auth.test.ts` (log capture), `tests/validate.test.ts` (sanitised `last_error`), `tests/transformStep.test.ts` (outbox payload).

## Architecture

The `status` column is the work queue. The pipeline **runner** (fired-and-forgotten on ingest and retry)
and the **sweeper** (crash recovery) advance a form through validate → geocode → transform; `GEOCODED →
READY` writes the transformed row, the outbox email row, and the status flip in one transaction; `READY →
DISPATCHED` is the FORM-BOT claim under `FOR UPDATE SKIP LOCKED`; and the **outbox worker** delivers the
guaranteed email. All three loops are plain Postgres pollers — no external queue. `forms` is the spine, with
`transformed_forms` (1:1), `form_events` (1:N audit), and `outbox` (1:N) hanging off it.

**→ See [docs/architecture.md](docs/architecture.md) for the rendered lifecycle diagram and ERD.**

## Form lifecycle

The `form_status` enum has nine values. Every transition is a compare-and-swap (`UPDATE … WHERE id = $id AND status = $expected`); zero rows updated means another process got there first and is treated as a no-op.

| Status                                                        | Meaning                                                                        | Next                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `RECEIVED`                                                    | raw payload stored, not yet processed                                          | → `VALIDATED` / `FAILED_VALIDATION` |
| `VALIDATED`                                                   | parsed against the current versioned schema                                    | → `GEOCODED` / `FAILED_GEOCODING`   |
| `GEOCODED`                                                    | coordinates resolved (and cached on the row)                                   | → `READY` / `FAILED_TRANSFORM`      |
| `READY`                                                       | transformed, outbox email queued — **terminal for the pipeline**               | → `DISPATCHED` (claim)              |
| `DISPATCHED`                                                  | handed to FORM-BOT — **terminal**                                              | —                                   |
| `CONFLICT`                                                    | same `provider_form_id`, different content — parked for a human — **terminal** | —                                   |
| `FAILED_VALIDATION` / `FAILED_GEOCODING` / `FAILED_TRANSFORM` | quarantined with `last_error` — **terminal until retried**                     | → predecessor status via `/retry`   |

Retry mapping is fixed: `FAILED_VALIDATION → RECEIVED`, `FAILED_GEOCODING → VALIDATED`, `FAILED_TRANSFORM → GEOCODED` — so a fixed form resumes at the step that failed, never re-running the ones that already succeeded.

## Decisions and their consequences

- **Accept, then validate.** `POST /ingest` writes the raw payload to `forms` before Zod ever runs (`src/ingest/ingestForm.ts`). Consequence: a schema the provider changed without telling us cannot cost us the data — the form quarantines with its payload intact and is replayable.
- **Constraint-level dedupe.** A canonical (recursively key-sorted) SHA-256 of the payload (`src/ingest/canonicalHash.ts`) is a `UNIQUE` column; ingest is `INSERT … ON CONFLICT DO NOTHING`. Consequence: duplicate and reordered-key deliveries collapse to one row even under a concurrent race, with no application-level "have I seen this?" check to get wrong.
- **Postgres is the queue.** The `status` column _is_ the work queue; the runner and sweeper poll and advance it (`src/pipeline/run.ts`, `src/pipeline/sweeper.ts`). Consequence: no separate broker to run, and a crash mid-pipeline is just a form left in a non-terminal status that the sweeper picks back up.
- **Transactional outbox.** The `outbox` row is inserted in the _same_ transaction as `transformed_forms` and the `READY` flip (`src/pipeline/steps/transform.ts`). Consequence: the guaranteed email can never diverge from the transform — either both commit or neither does — and a separate worker delivers it at least once.
- **`SKIP LOCKED` claim.** `POST /forms/ready` selects `READY` rows `FOR UPDATE SKIP LOCKED` and flips them to `DISPATCHED` in one transaction (`src/forms/claimReadyForms.ts`). Consequence: any number of FORM-BOT workers can poll at once and each form is delivered exactly once, with the lock — not luck — doing the arbitration.
- **Versioned, lenient schemas.** Ingested schemas live in a registry keyed by version, each `.passthrough()` (`src/schemas/ingested/`). Consequence: when the provider drifts, you register a `v2` that understands the change and point the current version at it — quarantined forms retry straight through, no redeploy of the parser needed.
- **Geocode cache.** Resolved `latitude`/`longitude` are persisted on the form; the geocode step skips the API when they are already set (`src/pipeline/steps/geocode.ts`). Consequence: a retry or replay of a form that already has coordinates does zero redundant third-party calls (`tests/journeys/geocoder-outage.test.ts`).
- **Scoped API keys.** Three keys — provider, bot, ops — are compared with a length-safe constant-time hash and gated per route (`src/auth.ts`). Consequence: the provider key cannot claim forms and the bot key cannot ingest; a valid key on the wrong route is a 403, a missing/unknown key a 401. Authorization, not just authentication.

## Deliberately excluded

- **Redis** — the status column plus `SKIP LOCKED` is the queue; nothing here needs a second datastore.
- **Message brokers (Kafka/RabbitMQ)** — the transactional outbox already gives at-least-once delivery without one.
- **Deployment / IaC** — no Dockerfile or infra config; the take-home is the service, and the shape of a production deploy is sketched below.

## Production notes

- **HMAC request signing for the provider webhook.** In production the provider would sign each request body with a shared secret; we'd verify the signature to authenticate the _source_, above the coarse API key.
- **Idempotent ingest is replay protection.** Because dedupe is a `content_hash` constraint, a replayed (or maliciously re-sent) signed request is already a no-op — replay resistance falls out of invariant 2 for free.
- **pg-boss before external brokers.** If the status-column queue is outgrown, the next step is [pg-boss](https://github.com/timgit/pg-boss) — a job queue that stays inside Postgres — before reaching for Redis or Kafka and a second thing to operate.
- **EU-region managed Postgres.** This is patient data; it should run on managed Postgres pinned to an EU region for residency, with backups and PITR handled by the provider.
- **Retention is a DPO question.** How long to keep `raw_payload` and other PII is a data-protection-officer / policy decision, not an engineering default — the schema keeps it isolated in one column so a retention job is straightforward once that policy exists.

## Running & testing

Prerequisites: Node ≥ 20 and a running Docker daemon. The suite needs no configuration — each test file
spins up its own throwaway Postgres via Testcontainers:

```bash
npm ci
npm test          # 21 files, 83 tests — including the tests/journeys/* stories
```

More documentation:

- **[docs/running.md](docs/running.md)** — full setup from a fresh clone: prerequisites, running the server, the scoped-key / environment reference, and troubleshooting.
- **[docs/api.md](docs/api.md)** — endpoint reference with real, verified request/response examples.
- **[docs/architecture.md](docs/architecture.md)** — the rendered lifecycle diagram and ERD.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm ci → lint → typecheck → test` on every push and PR.
