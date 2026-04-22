# ADR 0001 — Authentication stack

- **Status:** Accepted
- **Date:** 2026-04-22
- **Issue:** [#7](https://github.com/aghaPathan/telecom-service-mapping/issues/7)

## Context

The MVP needs operator-facing login with three roles (`admin` / `operator` / `viewer`),
admin-only user provisioning (no self-signup), and revocable sessions so an admin
can kick a compromised account. The app runs in Alpine-based Docker images on a
home-server LAN, is fronted by Caddy with auto-TLS, and is never exposed directly
to the host. Users and sessions live in the app Postgres (`DATABASE_URL`), which
is separate from the read-only source LLDP database.

We are on Next.js 14 (App Router) and want a well-maintained library that
understands server components, server actions, and Edge middleware.

## Decision

- **Library:** `next-auth@5.0.0-beta.22` (Auth.js v5). v5 is the first release
  line with first-class App Router + server-action support; the v4 line is in
  maintenance. We accept the "beta" label because the API surface we touch
  (Credentials provider, adapter interface, `auth()` helper, middleware split)
  has been stable across the last several beta tags.
- **Adapter:** `@auth/pg-adapter@1.5.0` against the app Postgres.
- **Provider:** Credentials only. No OAuth / magic links in MVP.
- **Session strategy:** `database` — sessions are rows in `sessions`, so an
  admin can revoke by deleting the row.
- **Credentials + DB-session workaround:** Auth.js v5 does not wire
  Credentials to the database adapter out of the box (vanilla setup mints a
  JWT even when an adapter is present). We follow the documented v5 pattern:
  inside the `authorize()` callback we call `adapter.createSession()`
  manually and set the session cookie ourselves, then return `{ id }` so the
  `jwt`/`session` callbacks can resolve the session row. This is the
  officially-documented escape hatch, not a hack — but it is load-bearing
  and must not be "simplified" away.
- **Password hashing:** `bcryptjs@2.4.3` at cost 12. Chosen over native
  `bcrypt` because the native package requires `node-gyp` + Python in the
  Alpine builder stage, which bloats the image and breaks reproducible
  builds. `bcryptjs` is pure JS, cost-12 is semantically identical, and the
  throughput difference is irrelevant at login-path volume.
- **Cookies:** Auth.js v5 auto-derives the `__Secure-` cookie prefix from
  `NEXTAUTH_URL`'s protocol. We keep that behavior — cookies are `Secure` by
  default. Local HTTP dev (`http://localhost:3000`) naturally drops the flag;
  any other override is gated behind `NODE_ENV !== "production"`.
- **Middleware split:** `auth.config.ts` (Edge-safe, no adapter / bcryptjs /
  pg) is imported by `middleware.ts`; `auth.ts` is the full Node config used
  by server components and route handlers. Standard Next 14 + Auth.js v5
  pattern — documented here so a future reader does not try to unify them.

## Consequences

- We carry a beta dependency. Upgrading to `5.0.0` GA is a tracked follow-up;
  the beta tag is pinned exactly to avoid surprise churn on `pnpm install`.
- Sessions are revocable but each request pays one Postgres round-trip in
  server components that call `auth()`. Acceptable for an internal tool.
- `bcryptjs` keeps the Alpine runner slim; no `node-gyp` / Python in the
  image.
- The Credentials+DB-session workaround adds ~40 lines of bespoke cookie
  code. It is covered by integration tests (testcontainers) so regressions
  are caught early.

## Alternatives considered

- **Auth.js v4.** Rejected — App Router support is partial and server-action
  ergonomics are poor; the migration path forward is v5 regardless.
- **Lucia.** Lighter, but we would reimplement adapters and CSRF handling
  ourselves. Not worth it for an internal tool.
- **Custom session table + hand-rolled cookies.** Minimum-viable but loses
  CSRF, cookie-prefix, and middleware integration we get for free.
- **JWT sessions.** Rejected explicitly in CLAUDE.md canonical decisions:
  revocation is a requirement, and JWT revocation is either a lie or a
  database lookup that defeats the point.
- **Native `bcrypt`.** Rejected — Alpine + `node-gyp` friction, no
  throughput benefit at our scale.
