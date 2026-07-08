# Setup, running & testing

A step-by-step guide from a fresh clone to a running server and a green test suite.

## Prerequisites

- **Node.js ≥ 20** — `node --version`. (`.nvmrc` is not shipped; any 20.x/22.x works. The engine is pinned in `package.json`.)
- **Docker** with the daemon running — `docker info` should succeed. Used two ways: `docker compose` for the local dev database, and [Testcontainers](https://testcontainers.com/) (which the test suite drives automatically) for throwaway per-test databases.
- **git** to clone.

No global installs are needed beyond Node and Docker — Postgres runs in a container, and everything else is a project dependency.

## 1. Clone and install

```bash
git clone https://github.com/ayydeji/take-home-test.git
cd take-home-test
npm ci            # clean, reproducible install from package-lock.json
```

## 2. Run the tests (zero configuration)

The fastest way to confirm the checkout is healthy. The suite needs **no database setup and no environment variables**: each test file starts its own disposable Postgres via Testcontainers, applies the migrations, and tears it down. Auth is off unless a test injects keys.

```bash
npm test
```

Expected: `Test Files 21 passed (21)`, `Tests 83 passed (83)`, including the four `tests/journeys/*` stories. The first run pulls the `postgres:16-alpine` image (a few seconds); later runs reuse it.

> Docker must be running. If `npm test` hangs or errors on container startup, check `docker info`.

## 3. Run the server

The server needs a real Postgres and the three API keys.

### 3a. Start Postgres

```bash
docker compose up -d          # Postgres 16 on localhost:5432 (user/pass/db = postgres/postgres/forms)
```

Wait for it to be healthy (the compose file has a healthcheck):

```bash
docker compose ps             # STATUS should show "healthy"
```

### 3b. Apply the database schema

```bash
npm run db:migrate            # applies drizzle/*.sql → forms, transformed_forms, form_events, outbox
```

### 3c. Set the scoped API keys

Config is read from the environment (there is no auto-loaded `.env`). For local use, export any values — they just need to be non-empty. Protected routes **fail closed** (401/403) if a key is unset; `GET /health` stays open regardless.

```bash
export PROVIDER_API_KEY=dev-provider-key
export BOT_API_KEY=dev-bot-key
export OPS_API_KEY=dev-ops-key
```

[`.env.example`](../.env.example) lists every variable (keys, DB URL, and the geocoder/sweeper/outbox tuning knobs) with its default. To load it from a file instead of exporting, use a tool like `direnv` or prefix the command: `env $(grep -v '^#' .env.example | xargs) npm run dev` (after filling in the keys).

### 3d. Start it

```bash
npm run dev                   # ts-node-dev with hot reload → http://localhost:3000
```

You should see `Server is running on http://localhost:3000`. Three background loops also start: the pipeline **sweeper** (crash recovery) and the **outbox worker** (email delivery) poll on intervals; the per-request **runner** processes each ingested form.

### 3e. Verify it works

```bash
curl localhost:3000/health                                   # {"status":"ok"}

# Ingest a form (provider scope). It processes to READY in the background.
curl -X POST localhost:3000/ingest -H 'content-type: application/json' \
  -H 'x-api-key: dev-provider-key' --data-binary @tests/fixtures/valid-form.json
# -> {"id":"<uuid>"}

# Watch its status (ops scope); it reaches READY within ~1s.
curl localhost:3000/forms/<uuid> -H 'x-api-key: dev-ops-key'

# Hand it to FORM-BOT (bot scope); flips it to DISPATCHED.
curl -X POST localhost:3000/forms/ready -H 'x-api-key: dev-bot-key'
```

See **[api.md](api.md)** for the full endpoint reference with real request/response examples.

### Shutting down

```bash
# Ctrl-C the dev server, then:
docker compose down           # stop Postgres (add -v to also delete its data volume)
```

## Environment variables

| Variable                                                                  | Default                                             | Purpose                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PORT`                                                                    | `3000`                                              | HTTP port                                                                    |
| `DATABASE_URL`                                                            | `postgres://postgres:postgres@localhost:5432/forms` | Postgres connection (matches `docker-compose.yml`)                           |
| `PROVIDER_API_KEY` / `BOT_API_KEY` / `OPS_API_KEY`                        | _(unset)_                                           | scoped keys; unset ⇒ that scope's routes fail closed                         |
| `RATE_LIMIT_PER_MINUTE`                                                   | `300`                                               | per-key request ceiling                                                      |
| `GEOCODER_TIMEOUT_MS` / `GEOCODER_ATTEMPTS` / `GEOCODER_BACKOFF_MS`       | `3000` / `3` / `100`                                | geocoder client timeout, retry budget, backoff base                          |
| `SWEEP_INTERVAL_MS` / `SWEEP_STALENESS_MS`                                | `15000` / `60000`                                   | sweeper tick interval; how stale a non-terminal form must be to be re-driven |
| `OUTBOX_INTERVAL_MS` / `OUTBOX_BACKOFF_BASE_MS` / `OUTBOX_BACKOFF_CAP_MS` | `5000` / `1000` / `300000`                          | outbox worker tick; email retry backoff base and cap                         |

## npm scripts

| Script                        | Does                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `npm run dev`                 | run with hot reload (`ts-node-dev`)                      |
| `npm test`                    | full Vitest suite against real Postgres (Testcontainers) |
| `npm run lint`                | ESLint + Prettier check                                  |
| `npm run typecheck`           | `tsc --noEmit` (strict)                                  |
| `npm run db:migrate`          | apply Drizzle migrations to `DATABASE_URL`               |
| `npm run db:generate`         | generate a new migration from `src/db/schema.ts`         |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server             |

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `npm ci → lint → typecheck → test` on every push and PR.

## Troubleshooting

- **`npm test` fails at container startup** — the Docker daemon isn't running (`docker info`), or the machine can't pull `postgres:16-alpine`.
- **Every protected route returns 401** — the API keys aren't exported in the shell running `npm run dev` (see 3c). `GET /health` still works.
- **`npm run db:migrate` can't connect** — Postgres isn't up yet (`docker compose ps` → healthy), or `DATABASE_URL` points elsewhere.
- **Port already in use** — `5432` (Postgres) or `3000` (server) is taken; stop the other process or set `PORT` / edit `docker-compose.yml`.
