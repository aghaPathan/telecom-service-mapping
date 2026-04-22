# Issue #8 — Omnibox search

## Goal
One search box on the landing page that resolves against Neo4j in priority order
(exact CID → exact mobily_cid → exact device name → fulltext device), behind
the existing auth session, rate-limited, injection-safe.

## Resolver semantics
Cascade-stop-at-first (not union). A query matches exactly one category; the
first hit wins. Empty/whitespace-only input returns `{kind: "empty"}`.

Response shape (discriminated union, zod-validated):

```
{ kind: "empty" }
{ kind: "service", service: ServiceHit, endpoints: DeviceHit[] }  // service + its 1..2 TERMINATES_AT devices
{ kind: "device",  devices: DeviceHit[] }                         // len 1 for exact-name, len ≤20 for fulltext
```

- `DeviceHit`: `{ name, role, level, site, domain }`
- `ServiceHit`: `{ cid, mobily_cid, bandwidth, protection_type, region }`

## Injection safety
- Cypher uses `$q` parameters only. No string interpolation.
- Fulltext query: escape Lucene special chars `+ - ! ( ) { } [ ] ^ " ~ * ? : \ /` before calling `db.index.fulltext.queryNodes`.
- Unit test proves `foo:bar` does not throw.

## Input validation (zod)
- Trim, reject empty, cap length at 200 chars, cap fulltext results at 20.

## Rate limiting
- Per-user in-memory token bucket, ~20 req/10s. On exhaustion return 429.
- In-memory is acceptable for MVP (single web container).

## Files
New:
- `apps/web/lib/search.ts` — resolver, zod schemas, Lucene escape
- `apps/web/lib/rate-limit.ts` — token bucket
- `apps/web/app/api/search/route.ts` — route handler (`requireRole("viewer")`)
- `apps/web/app/_components/omnibox.tsx` — client component (debounced, kbd nav)
- `apps/web/app/device/[name]/page.tsx` — stub
- `apps/web/app/service/[cid]/page.tsx` — stub
- `apps/web/test/search.test.ts` — unit
- `apps/web/test/search.int.test.ts` — integration (testcontainer Neo4j)
- `apps/web/e2e/omnibox.spec.ts` — E2E

Modified:
- `apps/web/app/page.tsx` — mount the Omnibox

## Verification
- `pnpm --filter web test` — unit suite green
- `pnpm --filter web test:int` — integration green (needs Docker)
- `pnpm --filter web test:e2e` — E2E green (needs compose stack)
- `pnpm -r typecheck` — no type errors
