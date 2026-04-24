# CLAUDE.md — Telecom Service Mapping

> Project north star for Claude Code sessions. Read before any non-trivial change.
> Global rules in `~/.claude/CLAUDE.md` still apply; this file adds project-specific constraints.
> Reference-only material has been moved to `.claude/references/*.md` — consult on demand, listed at the end.

---

## Purpose (one line)

Docker-composed internal web app that ingests LLDP adjacency data nightly from a source Postgres, models it in Neo4j with a configurable telecom hierarchy, and lets operators path-trace customers to the core, view blast-radius, and save named queries.

---

## Quick Start

```bash
pnpm install
pnpm --filter @tsm/db build      # build shared workspace package first
pnpm -r typecheck                # tsc --noEmit across workspace
pnpm --filter ingestor test      # vitest + testcontainers (needs Docker)
pnpm --filter web test           # unit tests (fast, no Docker)
pnpm --filter web test:int       # integration tests (needs Docker)
pnpm --filter web test:e2e       # Playwright against PLAYWRIGHT_BASE_URL (needs compose stack)
pnpm -r lint                     # web + db lint; ingestor is a placeholder (no ESLint wired yet)
```

### Compose stack

```bash
cp .env.example .env             # fill in secrets — never commit
docker compose build
docker compose up -d --wait      # Caddy on :80, other services internal
docker compose logs -f ingestor  # watch nightly cron ticks
```

### Ingestor CLI (`pnpm --filter ingestor dev` locally, or `node dist/index.js` in the container)

- `--dry-run` — run source → dedup → resolver, skip Neo4j write, record run row
- `--once` — run once and exit (no cron). Implied by `--dry-run`.
- no flag — long-lived `node-cron` scheduler (skipped when `INGEST_MODE=smoke`, which runs a one-shot seed and exits)

---

## Data sensitivity — **read first**

The source database contains **real operator production data** (Mobily / Saudi operator context: `mobily_cid`, real hostnames, customer circuit IDs).

**Hard rules:**

- **Never** read, echo, log, or commit the contents of `.env` or anything read from `DATABASE_URL_SOURCE`.
- **Never** paste real hostnames, customer IDs, CIDs, IPs, or MACs into issue descriptions, commit messages, or external tools (chat, pastebins, diagram renderers, web search).
- Any screenshot, demo, or export leaving the home-server LAN requires prior redaction. Replace site codes and role prefixes with preserved-shape placeholders (e.g. `PK-KHI-CORE-01` → `XX-YYY-CORE-01`).
- Source DB access must be via a read-only role (`lldp_readonly` with `default_transaction_read_only=on`). Never grant write.
- Secrets flow: `.env` (gitignored) → `docker-compose env_file` → `process.env.*`. Never inline.

When in doubt, redact or ask.

---

## Canonical decisions (changing these requires an ADR)

| Area | Decision |
|---|---|
| Ingest cadence | Nightly full-refresh (not incremental); staleness window accepted for MVP |
| Ingest host | Dedicated `ingestor` service (not inside Next.js runtime) |
| Dedup | Canonical unordered `{(device, interface)}` pair; merge both-direction rows; drop self-loops and NULL `device_b_name`; anomaly → keep latest `updated_at` |
| Hierarchy | `config/hierarchy.yaml` (configurable) — Core → Aggregation → CustomerAggregation → Transport (L3.5) → Access → Customer |
| Role resolution | `config/role_codes.yaml` (configurable) — priority: `type_column` → name prefix → `Unknown` |
| SW leveling | Dynamic post-ingest Cypher pass, based on topology |
| Auth | **Custom session layer** (not Auth.js at runtime) + bcrypt(cost=12) + DB-backed sessions (revocable via `DELETE FROM sessions` or `is_active=false`). See [ADR 0001](docs/decisions/0001-auth-stack.md) for why we pivoted away from Auth.js v5 beta's Credentials provider. |
| RBAC | Three roles: `admin` / `operator` / `viewer`. No domain/region filtering in MVP. |
| Provisioning | Admin-only via `pnpm --filter web create-admin` CLI — **no self-signup** |
| TLS | Caddy reverse-proxy with auto-TLS. Cookie flags (`Secure`, `__Secure-` prefix) derive from `NEXTAUTH_URL` scheme — HTTP deployments (CI, internal-LAN) drop both so browsers don't reject. |
| Path direction | `:CONNECTS_TO` stored direction is canonical (lesser→greater); treat as undirected when matching; "downstream" derived from `level`, not stored direction |

Configurable behavior (edit without redeploying code):

- `config/hierarchy.yaml` — level definitions, SW dynamic-leveling toggle, Unknown label
- `config/role_codes.yaml` — role-code → canonical role mappings, fallback, resolver priority

Both files are loaded fresh at the start of every ingest run.

---

## Development workflow

- **Never commit to `main`.** Feature branch per issue; PR with spec compliance + quality review. Branch names must match `{type}/{description}` (feat/fix/refactor/chore/docs/test/ci/perf/style/build/revert/hotfix) — enforced by a pre-commit hook.
- **TDD** for ingestor + web resolver logic: dedup, role resolver, hierarchy resolver, SW dynamic-pass, path trace, downstream — write failing test first.
- **Integration tests use testcontainers** (real Postgres 13 + Neo4j 5). **No mocks of the DB** — per global feedback-memory rule. Mirror existing patterns in `apps/web/test/*.int.test.ts`.
- **Fixtures**: 50-row synthetic fixture in `apps/ingestor/test/fixtures/`; E2E specs use `E2E-*` prefix. **Never** copy real production rows into fixtures.
- **`--dry-run` flag** on the ingestor CLI is mandatory before any schema-touching change lands.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Bug fixes carry `root cause: <desc>` + a linked failing test.

---

## Tools & skills (project-specific routing)

- **Code navigation**: Serena MCP (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`). Shared-module edit protocol applies.
- **Cross-domain features** (security + backend + frontend + infra): `orchestration-pipeline`.
- **Single-domain multi-step**: `orchestration-pipeline-light` or `superpowers:writing-plans` + `superpowers:subagent-driven-development`.
- **Implementing queued issues**: `issues-to-complete`. GitHub is the source of truth for what's open — don't cache status in this file.
- **Any Cypher change** → run it against a fresh testcontainer Neo4j first; mirror the patterns in `apps/web/test/path.int.test.ts` and `apps/web/test/search.int.test.ts`.

---

## Common pitfalls (future-Claude, don't repeat these)

> One-liner per pitfall: `Don't X — <reason>. <how to do it right, with file:line or grep>.` Drop entries only after a landed refactor makes the pitfall structurally impossible.

- **Don't parse `app_lldp` rows as if each row is a link.** 90% are one-directional; 10% are mirrored. Dedup via canonical pair.
- **Don't infer direction from `device_a` vs `device_b`.** Use `level` from hierarchy.
- **Don't filter `status` away.** `status=true` means "currently observed"; false means "deactivated by trigger on later poll".
- **Don't treat blank `type_*` as an error.** 33% of rows are blank; fall back to name-prefix resolver → `Unknown`.
- **Don't expose Neo4j or web ports to the host.** Only Caddy publishes (prod). The CI overlay `docker-compose.ci.yml` exposes both `postgres:5432` and `neo4j:7687` on `127.0.0.1` so Playwright (outside the compose network) can seed fixtures — production compose never includes this overlay.
- **Don't use JWT sessions.** Sessions are DB-backed so admins can revoke.
- **Don't add interface nodes** (`:Interface`) in MVP — interface is an edge property.
- **Don't trust the source DB's unique constraint alone.** It includes IP + MAC; a stale IP rotation produces duplicate logical links. Handle in ingestor.
- **Don't treat `ingestion_runs.skipped=true` as a failure.** It's a benign row written when the cron fires while a prior run is still `status='running'`. The freshness badge and history page intentionally filter skipped rows out of "last real refresh".
- **Don't remove `--ignore-scripts` in `apps/web/Dockerfile`.** It skips `testcontainers → ssh2 → cpu-features` native builds that would fail in `node:20-alpine`; those packages have pure-JS fallbacks.
- **Don't reintroduce Auth.js at runtime.** v5 beta's Credentials provider refuses `strategy: "database"` with `UnsupportedStrategy`, which blocks the revocation criterion. ADR 0001 documents the custom session layer (`apps/web/lib/session.ts`, `lib/session-cookie.ts`, `lib/authenticate.ts`) that replaces it. The `sessions` / `verification_token` / `accounts` tables stay in the migration (adapter-shaped) but are exercised only by our own code.
- **Don't key cookie flags off `NODE_ENV`.** CI and internal-LAN deployments run `NODE_ENV=production` behind HTTP-only Caddy; `Secure` / `__Secure-` cookies are silently dropped over HTTP. All three cookie sites (`lib/session-cookie.ts`, `middleware.ts`, `app/_components/logout-button.tsx`) must key off `NEXTAUTH_URL` scheme instead.
- **Don't filter MW in the traversal WHERE — filter it in the projection.** Downstream queries (`runDownstream` in `apps/web/lib/downstream.ts`) must traverse THROUGH `:MW` (level 3.5) to reach the RAN/Customer devices behind it; exclusion happens post-collection (`WHERE $include_transport OR dst.level <> 3.5`) unless the caller opts in.
- **Don't try to parameterize `*1..N` in Cypher.** Neo4j rejects `$maxDepth` inside variable-length relationship bounds. Zod-validate the integer (`.int().min(1).max(K)`) then interpolate it — see `MAX_PATH_HOPS` in `apps/web/lib/path.ts` and `MAX_DOWNSTREAM_DEPTH` in `apps/web/lib/downstream.ts`. Never make the cap configurable from user input or env without re-validation.
- **Don't filter by `:Core` label in Cypher.** The ingestor applies role strings from `config/hierarchy.yaml` verbatim as labels, which means the actual labels are uppercase role codes (`:CORE`, `:IRR`, `:VRR`) — `:Core` matches nothing. Filter by the `level` property (`WHERE core.level = 1`); it's hierarchy-config-agnostic and already indexed (`device_level`).
- **Don't pass hyphen/colon-containing strings raw to `db.index.fulltext.queryNodes`.** The standard analyzer lowercases and splits on non-alphanumerics at index time, so `PK-KHI-CORE-01` is stored as tokens `pk`, `khi`, `core`, `01`. Mirror that on the query side: split input the same way, escape Lucene specials per token (see `escapeLucene` in `apps/web/lib/search.ts`), add `*` per token, and AND-join.
- **Don't add a `.tsx` unit test without updating `apps/web/vitest.workspace.ts`.** The unit project's include/exclude globs must list `.test.{ts,tsx}`, and the unit project needs `esbuild: { jsx: "automatic" }` (tsconfig's `jsx: "preserve"` is for Next.js, not vitest). Prefer `renderToStaticMarkup` from `react-dom/server` for assertions — no jsdom dependency required. Integration project doesn't need the esbuild override (no JSX there).
- **Don't emit CSV cells without `csvEscape`.** `apps/web/lib/csv.ts` guards against formula injection (leading `= + - @ \t \r` → apostrophe-prefix + quote) and embedded-tab/quote/comma quoting. Filenames used in `Content-Disposition` must go through `sanitizeFilename` to block CRLF header injection and path traversal.
- **Don't add an export to `packages/db/src/*` without rebuilding `@tsm/db`.** The package's `exports` field points at `dist/`, so a new symbol in `src/` is invisible to the ingestor and web until `pnpm --filter @tsm/db build` runs. When adding cross-workspace code, build `@tsm/db` before running dependents' typecheck or tests.
- **Don't change `config/role_codes.yaml` `type_map` keys without updating `apps/ingestor/test/fixtures/lldp-50.ts`.** The 50-row fixture's `type_a`/`type_b` values are coupled to the map — the `ingest integration` test's `:CORE`/`:UPE` label assertions go to zero if the fixture codes no longer resolve. Update both in the same PR.
- **Don't rename a role in `config/hierarchy.yaml` in isolation.** The ingestor applies role strings as the `:Device` secondary label verbatim, so every Cypher `n:OldRole` predicate (SW dynamic-leveling in `apps/ingestor/src/graph/writer.ts`, integration-test seeds, e2e seeds, docs under `.claude/references/`) must be renamed in the same PR. Grep before merging: `rg -nP '(?::|")<OldRole>\b' apps/ .claude/ docs/`.
- **Don't import `react-leaflet` at module scope in a Next.js page.** Leaflet touches `window` on import, which crashes SSR. Mirror `apps/web/app/map/page.tsx`: `next/dynamic(() => import('./_components/MapClient'), { ssr: false })` + `export const dynamic = "force-dynamic"` on the page. The client component owns all Leaflet imports.
- **Don't pass `--fail-after` to `gh pr checks`.** That flag doesn't exist; the command errors out. Use plain `gh pr checks <N> --watch` — it exits when every check finishes, regardless of pass/fail.

---

## References (read on demand)

> These files are reference-only — not auto-loaded. Read only the rows whose "when to read" applies to your current task.

| File | When to read |
|---|---|
| `.claude/references/architecture.md` | Designing or debugging a cross-service flow; picking where a new feature lives |
| `.claude/references/neo4j-model.md` | Writing Cypher, adding a constraint/index, extending the graph schema |
| `.claude/references/source-schema.md` | Touching the ingestor source stage or source-DB queries |
| `.claude/references/project-layout.md` | Adding a new file — find the right directory |
| `.claude/references/env-vars.md` | Adding / renaming an env var, or tracing a config value |
| `.claude/references/planning.md` | Starting a PRD slice, writing an ADR, or checking issue conventions |
