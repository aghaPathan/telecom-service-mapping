# Environment variables (reference — `.env.example` is source of truth)

`.env.example` in the repo root is the authoritative list. Update it whenever you add a var; this file is a quick-reference glossary.

| Var | Purpose |
|---|---|
| `DATABASE_URL_SOURCE` | Read-only conn string to the source Postgres (LLDP data). Never grant write. |
| `DATABASE_URL` | App Postgres (users, sessions, saved_views, audit_log, ingestion_runs). |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j connection. |
| `NEXTAUTH_URL` | Base URL. **Session cookie name + `Secure` flag derive from its scheme** (http → plain `authjs.session-token`; https → `__Secure-authjs.session-token`). Do not key cookie flags off `NODE_ENV`. |
| `NEXTAUTH_SECRET`, `AUTH_TRUST_HOST` | Legacy placeholders from the Auth.js attempt — no runtime code reads them today. Kept in `.env.example` for historical compatibility; safe to remove in a future cleanup. |
| `INGEST_CRON` | Cron expression for nightly ingest (default `0 2 * * *`). |
| `INGEST_MODE` | `full` (default — real source + cron) / `smoke` (CI tracer: one-shot seed of `:Device {name:'seed-01'}`, then exit). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | App Postgres container bootstrap. |
| `CADDY_DOMAIN` | Hostname Caddy serves (`localhost` in CI). |
| `CADDY_TLS_MODE` | `internal` / `tailscale` / `acme`. |

## Rules

- Real secrets live in `.env` (gitignored). Never read, echo, log, or commit `.env`.
- `.env.example` is updated whenever a new var is added.
- Never inline a secret — always reference via `process.env.X`.
- If you find what looks like a real secret in code/logs/tests, stop and flag it; don't copy it elsewhere.
