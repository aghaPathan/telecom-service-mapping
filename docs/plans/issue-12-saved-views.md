# Issue #12 — Saved views (per-user + share-with-role)

## Goal

Let authenticated users save named path-trace or downstream queries and re-open
them. Viewers save private views only; operators and admins can share to a role
at or below their own. Views store the *query*, not cached results — opening a
view re-executes the underlying query against the current graph.

## Scope split

Shipping in two PRs against issue #12:

- **PR A (backend)** — migration, zod schemas, visibility helper, five API
  routes, audit-log hooks, unit + integration tests. PR body: `Refs #12`.
- **PR B (frontend)** — Save-view button on `/path` + `/downstream`, "My views"
  header dropdown, E2E test. PR body: `Closes #12`.

Rationale: keeps the diff reviewable (~600 LOC each vs one 1,200-LOC blob),
de-risks the API contract before UI depends on it, and gives a clean rollback
boundary if either half regresses. Both halves must land for the AC to be met.

## Canonical decisions (confirmed with reporter)

1. **User deletion**: no hard-delete flow exists in product code (only test
   teardown). Use FK `ON DELETE CASCADE` on `saved_views.owner_user_id` as a
   safety net, plus a user-facing `deleted_at` column on `saved_views` for
   the view-level soft-delete (the DELETE endpoint). No user-cascade listener.
2. **List visibility (role inheritance)**: `admin` sees all `role:*` shares,
   `operator` sees `role:operator + role:viewer`, `viewer` sees `role:viewer`
   only. Owners always see their own regardless.
3. **`payload_json` schema**: discriminated union reusing canonical
   `PathQuery` (`lib/path.ts`) and `DownstreamQuery` (`lib/downstream.ts`) —
   imported, not re-declared.
4. **Share-up prevention**: enforced at API via role ordinal
   (`admin=3, operator=2, viewer=1`). Viewers restricted to `private`. A
   requester cannot set `visibility=role:X` where `rank[X] > rank[self]`.
5. **PATCH scope**: full — name, visibility, and payload all editable (only by
   owner). Visibility changes re-run the viewer-restriction + share-up checks.

## Data model (PR A migration)

New table, new migration `1700000000020_saved-views.sql`:

```sql
CREATE TYPE saved_view_kind AS ENUM ('path', 'downstream');
-- Visibility is an enum of literal strings per the AC. 'private' means
-- owner-only; 'role:<r>' means any user with rank[user] >= rank[r] sees it.
CREATE TYPE saved_view_visibility AS ENUM (
  'private', 'role:viewer', 'role:operator', 'role:admin'
);

CREATE TABLE saved_views (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  kind           saved_view_kind NOT NULL,
  payload_json   JSONB NOT NULL,
  visibility     saved_view_visibility NOT NULL DEFAULT 'private',
  deleted_at     TIMESTAMPTZ,               -- soft-delete (user-initiated)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique name per owner, ignoring soft-deleted rows.
CREATE UNIQUE INDEX saved_views_owner_name_uniq
  ON saved_views (owner_user_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX saved_views_visibility_idx
  ON saved_views (visibility)
  WHERE deleted_at IS NULL;

CREATE TRIGGER saved_views_set_updated_at
  BEFORE UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`set_updated_at()` already exists from the auth-core migration — reused.

## Zod schemas (PR A, `apps/web/lib/saved-views.ts`)

```ts
const PathPayload       = z.object({ kind: z.literal("path"),       query: PathQuery });
const DownstreamPayload = z.object({ kind: z.literal("downstream"), query: DownstreamQuery });
export const ViewPayload = z.discriminatedUnion("kind", [PathPayload, DownstreamPayload]);

export const Visibility = z.enum([
  "private", "role:viewer", "role:operator", "role:admin",
]);

export const CreateBody = z.object({
  name:       z.string().trim().min(1).max(120),
  payload:    ViewPayload,
  visibility: Visibility.default("private"),
});

export const UpdateBody = z.object({
  name:       z.string().trim().min(1).max(120).optional(),
  payload:    ViewPayload.optional(),
  visibility: Visibility.optional(),
});
```

## Visibility helper (PR A, `apps/web/lib/saved-views-visibility.ts`)

```ts
// Which visibility strings can a user of role R *see*?
export function visibleVisibilities(role: Role): Visibility[] {
  // admin sees role:admin + role:operator + role:viewer
  // operator sees role:operator + role:viewer
  // viewer sees role:viewer only
  // 'private' never appears here — owners get that via the separate owner clause.
}

// Can a user of role R *set* a given visibility on create/update?
export function canSetVisibility(role: Role, v: Visibility): boolean {
  // viewer: 'private' only
  // operator: 'private' | 'role:viewer' | 'role:operator'
  // admin: any
}
```

Both are pure, exhaustively unit-tested.

## API routes (PR A)

All require `requireRole("viewer")`. All mutations audit-log via existing
`audit_log` table (actions: `saved_view.create`, `.update`, `.delete`).

| Method | Path                | Behavior |
|--------|---------------------|----------|
| POST   | `/api/views`        | Create. `canSetVisibility(role, v)` gate. Unique `(owner, name)` among non-deleted rows — 409 on collision. |
| GET    | `/api/views`        | List. Returns owner's views + any non-deleted row whose visibility ∈ `visibleVisibilities(role)`. Ordered by `updated_at DESC`. |
| GET    | `/api/views/:id`    | Returns payload **and** executes the underlying query (calls `runPath` or `runDownstream`) and returns fresh results. 403 if not owner and visibility hides it. 404 if soft-deleted. |
| PATCH  | `/api/views/:id`    | Owner-only. Re-runs `canSetVisibility` on visibility changes. |
| DELETE | `/api/views/:id`    | Owner-only. Sets `deleted_at = now()`. Idempotent (second call = 404). |

Shared rate-limit bucket `views:<userId>` — 30 cap / 5 rps refill (light, since
this is user CRUD not hot-path graph queries).

## UI (PR B)

- `apps/web/app/_components/save-view-button.tsx` — modal: name + visibility
  select. Visibility options gated by `session.user.role` (via server-rendered
  form action or client fetch).
- `apps/web/app/_components/my-views-dropdown.tsx` — header dropdown; on click
  navigates to the right page (`/path` or `/downstream`) pre-populated with the
  saved query (via URL params that the existing pages already parse).
- Header integration: mount dropdown in `apps/web/app/_components` next to the
  existing `logout-button`.

## Tests

### Unit (vitest — no DB, pure)
- `apps/web/test/saved-views.test.ts` — zod schemas (valid path, valid
  downstream, wrong kind, extra fields rejected).
- `apps/web/test/saved-views-visibility.test.ts` — `visibleVisibilities` and
  `canSetVisibility` exhaustive matrix.

### Integration (vitest + testcontainers, real Postgres + Neo4j)
- `apps/web/test/saved-views.int.test.ts`:
  - Create/list/patch/delete full lifecycle
  - Viewer cannot set `role:*` (403)
  - Operator cannot set `role:admin` (403); can set `role:viewer` / `role:operator`
  - Unique `(owner, name)` enforced (409), re-usable after soft-delete
  - List visibility: operator sees their own private + their `role:operator` + viewer's `role:viewer`, NOT another operator's private
  - Non-owner cannot PATCH/DELETE (403)
  - GET `/:id` re-executes the query — returns fresh `PathResponse` / `DownstreamResponse`

### E2E (Playwright, PR B)
- `apps/web/e2e/saved-views.spec.ts` — login as operator, run path trace via
  omnibox on an `E2E-*` fixture device, click Save, set visibility to
  `role:viewer`, logout; login as viewer, open My Views, see the shared view,
  click → lands on `/path` with the same hops rendered.

Fixtures: reuse existing `E2E-*` synthetic fixture; do NOT invent real-data
circuits or hostnames.

## Files touched

### PR A (backend)

**New:**
- `packages/db/migrations/1700000000020_saved-views.sql`
- `apps/web/lib/saved-views.ts` (zod schemas + query helpers)
- `apps/web/lib/saved-views-visibility.ts`
- `apps/web/app/api/views/route.ts` (POST, GET list)
- `apps/web/app/api/views/[id]/route.ts` (GET, PATCH, DELETE)
- `apps/web/test/saved-views.test.ts`
- `apps/web/test/saved-views-visibility.test.ts`
- `apps/web/test/saved-views.int.test.ts`

**Modified:**
- `apps/web/vitest.workspace.ts` — confirm new tests match existing include globs (no JSX in backend; no change likely needed).

### PR B (frontend)

**New:**
- `apps/web/app/_components/save-view-button.tsx`
- `apps/web/app/_components/my-views-dropdown.tsx`
- `apps/web/e2e/saved-views.spec.ts`

**Modified:**
- `apps/web/app/_components/path-view.tsx` — mount Save button
- `apps/web/app/downstream/...` — mount Save button on downstream page
- Header component that renders logout-button — mount My Views dropdown

## TDD order (PR A)

Each step RED → GREEN → REFACTOR, one commit per step.

1. `test: saved-views zod schema discriminated union (#12)` — RED.
   Make green with `saved-views.ts` schema.
2. `test: visibility helper matrix (#12)` — RED.
   Green with `saved-views-visibility.ts`.
3. `test: saved-views int — CRUD happy path (#12)` — RED.
   Green with migration + POST/GET routes + list query.
4. `test: saved-views int — visibility enforcement (#12)` — RED.
   Green by wiring `canSetVisibility` + list filter + 403 responses.
5. `test: saved-views int — unique-name + soft-delete (#12)` — RED.
   Green with partial-unique index + DELETE route.
6. `test: saved-views int — GET :id re-executes query (#12)` — RED.
   Green by invoking `runPath` / `runDownstream` in GET handler.
7. `refactor: extract saved-views db helpers (#12)` — if repetition warrants;
   skip if code is already clean.

## Out of scope (defer or reject)

- No domain/region filtering on views (per PRD "no domain/region RBAC in MVP").
- No "share to a specific user" — visibility is role-level only per AC.
- No view-result caching — AC explicitly says re-execute on read.
- No reassign-on-delete — per decision (1).
- No bulk operations — YAGNI.

## Risks

- **Long integration test runtime** — int tests spin testcontainers; keep the
  suite focused (6 cases max).
- **Cross-user visibility bugs** — primary security concern. Integration test
  must assert a *negative* (another operator's private view is absent), not
  just the positive case.
- **Migration numbering collision** — grep `grep -l "1700000000020" packages/db`
  before writing.

## PR B landing notes (2026-04-23)

Frontend + E2E shipped on branch `feat/issue-12-saved-views-ui` per the
detail plan at `docs/plans/2026-04-23-issue-12-saved-views-frontend.md`:

- `SaveViewButton` mounted on `/device/[name]`, `/service/[cid]`, and
  `/device/[name]/downstream` (gated on `result.status === "ok"`).
- `MyViewsDropdown` mounted in the header (logged-in branch only; fetches
  lazily on first open).
- Pure URL-rebuilder helper (`lib/saved-views-url.ts`) replays a saved
  payload into the canonical route; viewer option list hard-capped to
  `["private"]` by `lib/saved-views-visibility-ui.ts`.
- Integration drift-guard (`test/saved-views-ui.int.test.ts`) asserts the
  `listViews` shape the dropdown consumes.
- Playwright spec (`e2e/saved-views.spec.ts`) covers the
  operator→viewer share-with-role round trip and the viewer-only-private
  option-list negative case.
