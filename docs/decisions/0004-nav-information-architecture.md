# ADR 0004 — Two-row navigation information architecture

- **Status:** Accepted
- **Date:** 2026-04-24
- **Issue:** [#58](https://github.com/aghaPathan/telecom-service-mapping/issues/58)

## Context

Before Slice 1 of V2 (PR #58), the application had 15 routes but no persistent
navigation. Six pages were unreachable except by typing the URL directly:
`/map`, `/topology`, `/impact`, `/ingestion`, `/admin/users`, and
`/summary/[role]`. The `/devices?site=` href emitted by the map popup resolved
to a 404 because the devices page had not been wired.

PRD #57 §"Navigation / Information Architecture" mandates that every route is
either:
1. Explicitly listed in the global nav (always visible or role-gated), or
2. Explicitly marked dev-only (environment-gated, blocked in production), or
3. Explicitly documented as a child route reached through a parent page action
   (not a standalone nav destination).

Without a canonical nav structure, future contributors have no clear contract
for where a new page belongs, and orphan routes accumulate silently.

## Decision

Introduce a two-row global `<Nav>` component (`apps/web/app/_components/nav.tsx`)
rendered unconditionally from the root layout (`apps/web/app/layout.tsx`) on all
authenticated pages.

**Row 1 — viewer+ (always visible to any authenticated user):**

| Label | Route |
|---|---|
| Home | `/` |
| Devices | `/devices` |
| Core | `/core` |
| Topology | `/topology` |
| Map | `/map` |
| Analytics | `/analytics` |
| Isolations | `/isolations` |
| Ingestion | `/ingestion` |

`/impact` is intentionally excluded from Row 1: there is no index route
(`/impact` alone returns a 404); the entry point is always `/impact/[deviceId]`,
reached from the device detail page's blast-radius action. Surfacing it in nav
without a landing page would confuse users.

**Row 2 — admin-only (visible only when `session.user.role === "admin"`):**

| Label | Route |
|---|---|
| Users | `/admin/users` |
| Audit | `/admin/audit` |

Row 2 is hidden entirely for `operator` and `viewer` roles. RBAC enforcement
remains server-side; the row being absent in the DOM is a UX affordance, not a
security control.

## Consequences

- **Inclusivity invariant:** every new page MUST be added to Row 1, Row 2
  (admin-only), or explicitly marked dev-only (environment-gated via the
  `NODE_ENV === "production"` guard in `middleware.ts`). A page that is none of
  these three is an orphan and must not be merged.
- **Removal parity:** removing a page also requires removing its nav entry in
  the same PR.
- **Admin row is UX-only:** admin-only actions still require server-side
  `requireRole("admin")` checks; hiding the row in nav does not substitute.
- **Impact entry point:** `/impact/[deviceId]` is reached from the device detail
  page's action button, not from nav. Document new action-based entry points in
  the relevant page's component rather than adding orphan nav items.
- **Dev-only pages** (`/design-preview`, `/graph-preview`) are blocked in
  production by the middleware env gate (Task 11 of issue #58) and are never
  listed in nav.

## Rollback

Delete `apps/web/app/_components/nav.tsx` and remove the `<Nav>` render call
from `apps/web/app/layout.tsx`. No data migration or schema change is involved.
Pages remain accessible by direct URL; the orphan problem returns but no data
is lost.

## References

- PRD #57 §"Navigation / Information Architecture"
- Issue [#58](https://github.com/aghaPathan/telecom-service-mapping/issues/58)
- `apps/web/app/_components/nav.tsx` — nav component implementation
- `apps/web/app/layout.tsx` — root layout that renders `<Nav>`
- `apps/web/middleware.ts` — dev-only page gate (Task 11)
