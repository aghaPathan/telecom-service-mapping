# ADR 0002 — Manual ingestion trigger mechanism

- **Status:** Accepted
- **Date:** 2026-04-24
- **Issue:** [#62](https://github.com/aghaPathan/telecom-service-mapping/issues/62)

## Context

Slice 5 ops hardening required a real "Run now" button for admins, not the
`{ status: "queued" }` stub that `POST /api/ingestion/run` returned in slice
4. The ingestor already runs `node-cron` inside its own container with a
`hasRunningRun` mutex (`apps/ingestor/src/runs.ts`) that guards against
overlapping nightly runs. The admin UI and the cron scheduler live in
different processes, so they need a durable, coordinated handoff.

Constraints:

- Web and ingestor share the app Postgres; they do not share memory, queues,
  or IPC. The app has no Redis, no Kafka, no Celery.
- Multiple ingestor replicas are not on the roadmap — but the claim protocol
  must not rely on single-writer semantics, because a future HA scale-out
  should not reopen this decision.
- Latency expectation: "Run now" should surface a succeeded/failed status to
  the admin within one cron-tick window (default 60s).
- The nightly cron must keep working without modification.

## Decision

1. Add an `ingestion_triggers` table (migration `1700000000040`) with a
   `requested_by UUID` FK to `users`, `requested_at`, a nullable
   `claimed_at`, and a nullable `run_id` FK to `ingestion_runs`. A partial
   index on `(requested_at) WHERE claimed_at IS NULL` keeps the claim query
   cheap as history accumulates.
2. `POST /api/ingestion/run` (admin-only) inserts a row and returns its
   `trigger_id`. The API writes an `audit_log` entry with the trigger id as
   `target` so the provenance chain is "admin → trigger row → run row →
   audit row".
3. The ingestor's `tickCron` (`apps/ingestor/src/cron.ts`) claims the oldest
   unclaimed trigger via
   `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` inside a transaction, then
   runs `runFn`, then writes the returned `ingestion_runs.id` back onto the
   claimed trigger row. The existing `hasRunningRun` mutex runs first, so a
   manual trigger fired while the nightly run is mid-flight stays unclaimed
   and gets picked up on the next tick.
4. Admins poll `GET /api/ingestion/run/[id]` which LEFT-JOINs the trigger to
   its run and reports `pending` / `running` / `succeeded` / `failed`.

## Alternatives considered

- **Redis / BullMQ queue.** Rejected: adds a service we don't otherwise need.
  A queue is the right answer when N > 1 workers compete for work; we have
  one worker.
- **Postgres `LISTEN` / `NOTIFY`.** Rejected: requires a persistent
  ingestor-side subscriber and careful reconnection logic. The 60s polling
  latency is acceptable and drastically simpler.
- **Write directly from the web process.** Rejected: web doesn't have a
  Neo4j session configured, doesn't own the source DB driver lifecycle, and
  would race the nightly cron's mutex unless we reimplement it on the web
  side.

## Consequences

- Best-case latency from click to "status: running" is bounded by the cron
  expression (default 60s). Operators with tighter expectations would need
  to shorten `INGEST_CRON`.
- `SKIP LOCKED` makes the claim safe against future multi-ingestor
  deployments; no migration is needed to scale out.
- Audit chain is durable: the `audit_log` row's `target` is the trigger id,
  and the trigger's `run_id` points at the resulting `ingestion_runs` row.
- A `hasRunningRun=true` tick writes a `skipped` row to `ingestion_runs` but
  leaves the pending trigger unclaimed — the next tick picks it up. The
  skipped row is not counted as the admin's run.

## Rollback

1. Revert the API changes so `POST /api/ingestion/run` goes back to
   returning `{ status: "queued" }` without a DB write; the admin UI
   gracefully degrades to a no-op button.
2. `DROP TABLE ingestion_triggers;` (safe — no other table references it).
3. Revert `tickCron` to the pre-slice-5 signature (`runFn: () => Promise<void>`).

## Out of scope

- Cancellation of a pending trigger (none; admins just wait or re-issue).
- A UI affordance to replay a historical run (rendered as rows in the
  `/admin/ingestion` table, but no re-run action).
