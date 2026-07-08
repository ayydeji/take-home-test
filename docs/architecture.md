# Architecture

Two views of the system: the **form lifecycle** (the status column is the work queue; every arrow is a
compare-and-swap transition that also writes a `form_events` row) and the **entity model**.

Schema and migrations live in [`src/db/schema.ts`](../src/db/schema.ts) and [`drizzle/`](../drizzle). Field
shapes are pinned by the provided source-of-truth types
[`src/forms/schemas/ingested_schema.ts`](../src/forms/schemas/ingested_schema.ts) and
[`src/forms/schemas/transformed_schema.ts`](../src/forms/schemas/transformed_schema.ts).

## Form lifecycle

`POST /ingest` stores the raw payload and dedupes it by `content_hash`; the pipeline **runner**
(fired-and-forgotten on ingest and retry) and the **sweeper** (crash recovery) then advance the status.
`GEOCODED → READY` writes the transformed row, the outbox email row, and the status flip in a single
transaction. `READY → DISPATCHED` is the FORM-BOT claim under `FOR UPDATE SKIP LOCKED`. Failures quarantine
and are replayed by `POST /forms/:id/retry`, which resets a form to the step that failed.

```mermaid
stateDiagram-v2
    direction LR

    [*] --> RECEIVED: POST /ingest
    [*] --> CONFLICT: provider_form_id collision

    RECEIVED --> VALIDATED: validate
    RECEIVED --> FAILED_VALIDATION: invalid

    VALIDATED --> GEOCODED: geocode + cache coords
    VALIDATED --> FAILED_GEOCODING: geocoder exhausted

    GEOCODED --> READY: transform (txn writes transformed_forms + outbox + event)
    GEOCODED --> FAILED_TRANSFORM: transform error

    READY --> DISPATCHED: POST /forms/ready (SKIP LOCKED)

    FAILED_VALIDATION --> RECEIVED: retry
    FAILED_GEOCODING --> VALIDATED: retry
    FAILED_TRANSFORM --> GEOCODED: retry

    READY --> [*]
    DISPATCHED --> [*]
    CONFLICT --> [*]

    note right of READY
        Outbox worker delivers the queued
        email to happyforms@bots.com at
        least once (pending to sent).
    end note
```

Terminal statuses: `READY` (terminal for the pipeline), `DISPATCHED`, `CONFLICT`, and the three `FAILED_*`
(terminal until retried).

## Entity model

`forms` is the spine; the other three tables hang off it. `content_hash` is the `UNIQUE` dedupe key;
`transformed_forms` is 1:1 (the FORM-BOT handoff body); `form_events` is the append-only audit trail;
`outbox` is the transactional-outbox table for the guaranteed email.

```mermaid
erDiagram
    forms ||--o| transformed_forms : "has one"
    forms ||--o{ form_events : "logs"
    forms ||--o{ outbox : "queues"

    forms {
        uuid id PK
        text provider_form_id "indexed"
        text content_hash UK "dedupe"
        jsonb raw_payload "stored before validation"
        enum status "form_status"
        text schema_version
        numeric latitude "geocode cache"
        numeric longitude "geocode cache"
        jsonb last_error "paths and codes only"
        timestamptz received_at
        timestamptz updated_at
    }

    transformed_forms {
        uuid id PK
        uuid form_id FK "UNIQUE"
        jsonb payload "FORM-BOT handoff body"
        timestamptz created_at
    }

    form_events {
        uuid id PK
        uuid form_id FK
        text from_status
        text to_status
        jsonb detail
        timestamptz created_at
    }

    outbox {
        uuid id PK
        uuid form_id FK
        text type
        jsonb payload "metadata only"
        text status "pending or sent (CHECK)"
        int attempts
        timestamptz next_attempt_at
        timestamptz sent_at
        timestamptz created_at
    }
```

All three background loops (`src/pipeline/run.ts`, `src/pipeline/sweeper.ts`, `src/outbox/worker.ts`,
started in `src/index.ts`) are plain Postgres pollers — there is no external queue or broker.
