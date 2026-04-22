# Issue #7 — Auth.js v5 + Credentials + DB Sessions + create-admin CLI + RBAC

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` if executing in-session) to implement this plan task-by-task.
>
> Every task below ends in a TDD-shaped commit. Commits MUST reference `(#7)` and follow Conventional Commits.
>
> Source of truth for requirements: [GitHub issue #7](https://github.com/aghaPathan/telecom-service-mapping/issues/7).

**Goal:** Add Auth.js v5 Credentials-based auth with revocable DB sessions, three-role RBAC (`admin`/`operator`/`viewer`), an admin-only `/admin/users` UI, a stdin-driven `create-admin` CLI, and an `audit_log` — enforced by middleware on every non-public route.

**Architecture:**
- **Auth.js v5** (`next-auth@5.0.0-beta.*`) with `@auth/pg-adapter` on the app Postgres (`DATABASE_URL`). Credentials provider + `session: { strategy: "database" }` via the Credentials-adapter workaround (manually mint a session row in the `authorize` callback, then set a cookie referencing that row — this is the documented v5 pattern; plain Credentials+DB-session is not supported out of the box).
- **bcrypt** (`bcryptjs` — pure-JS, no native build needed in Alpine) at cost 12.
- **Migrations** via the existing `@tsm/db` + `node-pg-migrate` pipeline in `packages/db/migrations`.
- **CLI** at `apps/web/scripts/create-admin.ts`, run via `tsx` (added to web runtime deps) and exposed as `npm run create-admin` from `apps/web/package.json`.
- **Audit log** written synchronously at 5 hook points. A single helper `recordAudit()` accepts `(user_id, action, target, metadata)` and writes to `audit_log`.

**Tech Stack:** Next.js 14 App Router, Auth.js v5 beta, `@auth/pg-adapter`, `bcryptjs`, `zod`, Vitest + `testcontainers` (new to apps/web — ingestor already uses it), Playwright (existing).

---

## Pre-flight (do before Task 1)

- [ ] **Read** `CLAUDE.md` in repo root + issue #7 body + this whole plan.
- [ ] **Confirm branch:** `git rev-parse --abbrev-ref HEAD` → `feat/issue-7-authjs-rbac`.
- [ ] **Confirm `.env`** has `NEXTAUTH_SECRET` and `NEXTAUTH_URL` (CLAUDE.md Environment table lists them; the compose file already wires them through). If missing: add to `.env.example` as placeholders and ask user to populate `.env`.
- [ ] **No existing auth.** Verify `apps/web/middleware.ts` does not exist and `apps/web/package.json` has no `next-auth`.

## Known pitfalls (read before starting)

1. **Credentials + DB sessions is a v5 gotcha.** Vanilla setup sends JWT cookies even with `@auth/pg-adapter`. To get a revocable DB session you must manually `adapter.createSession()` inside `authorize()` *and* set the session cookie yourself, then return `{ id }` from `authorize` so `jwt`/`session` callbacks can resolve the row. Pattern is in the NextAuth v5 "advanced-initialization" docs. Plan Task 6 implements this explicitly — do not "simplify" it away.
2. **`bcryptjs` vs `bcrypt`.** The native `bcrypt` requires `node-gyp` + python in the Alpine builder. Use `bcryptjs` (pure JS). Cost 12 is identical semantically.
3. **Middleware runs on Edge.** `bcryptjs`, `pg`, `@auth/pg-adapter` all use Node APIs and **cannot** run in Edge middleware. Use the Next 14 pattern: `middleware.ts` calls `auth()` from `./auth` configured with **JWT-only session-lookup** (cookie presence + light validation), then the real session / DB check happens inside server components / route handlers via `auth()` from the full config. Concretely, we export `{ auth, handlers, signIn, signOut }` from `apps/web/auth.ts` (full) and a thin `apps/web/auth.config.ts` used by middleware that declares providers/pages/callbacks-without-adapter. This is the standard Next 14 + Auth.js v5 split.
4. **Static assets.** Middleware matcher must exclude `/_next/static`, `/_next/image`, `/favicon.ico`, `/public`. Use the canonical matcher from the Auth.js docs.
5. **`/api/health` must stay public** — compose healthcheck hits it anonymously.
6. **`/api/ingestion/run`** currently returns 403 hard-coded. Task 9 wires it to `requireRole("admin")` and deletes the stopgap comment. (Matches the TODO(#7) in that file.)
7. **Testcontainers Postgres image.** Use `postgres:13-alpine` to match production. Apply migrations via `@tsm/db`'s `migrate()` helper — do not hand-roll SQL in tests.
8. **Secure-cookie dev override.** Auth.js v5 auto-derives `__Secure-` cookie prefix from `NEXTAUTH_URL`'s protocol. We keep that behavior. Local dev without TLS uses `http://localhost:3000`, so cookies drop the `Secure` flag — document this and gate any other override behind `NODE_ENV !== "production"`.

## File map (what this plan creates / touches)

```
apps/web/
├── auth.ts                               CREATE  Auth.js v5 full config (handlers, auth, signIn, signOut)
├── auth.config.ts                        CREATE  Edge-safe subset for middleware
├── middleware.ts                         CREATE  matcher + auth() gate
├── lib/
│   ├── password.ts                       CREATE  hash/verify wrappers (bcryptjs cost=12)
│   ├── rbac.ts                           CREATE  requireRole(), Role type, hasRole()
│   ├── audit.ts                          CREATE  recordAudit()
│   └── session-cookie.ts                 CREATE  issueDbSessionCookie() used by authorize()
├── app/
│   ├── login/
│   │   ├── page.tsx                      CREATE  form (server-action) + error surface
│   │   └── actions.ts                    CREATE  signIn server action with zod-validated input
│   ├── _components/
│   │   └── logout-button.tsx             CREATE  form posting to signOut
│   ├── admin/
│   │   └── users/
│   │       ├── page.tsx                  CREATE  list + create + actions (server components)
│   │       ├── actions.ts                CREATE  createUser/deactivateUser/changeRole (requireRole admin)
│   │       └── user-row.tsx              CREATE  client component with confirm prompts
│   ├── layout.tsx                        MODIFY  render user pill + logout button in header (server comp reads session)
│   └── api/
│       ├── auth/[...nextauth]/route.ts   CREATE  export { GET, POST } = handlers
│       └── ingestion/run/route.ts        MODIFY  replace 403 with requireRole("admin") + recordAudit
├── scripts/
│   └── create-admin.ts                   CREATE  stdin email+password+confirm, upsert on conflict w/ --force
├── test/
│   ├── password.test.ts                  CREATE  unit — hash/verify roundtrip
│   ├── rbac.test.ts                      CREATE  unit — requireRole matrix
│   ├── create-admin.test.ts              CREATE  unit — CLI via child_process + stdin mocks
│   └── auth-flow.int.test.ts             CREATE  integration — testcontainers Postgres; login, wrong-pw, inactive, revocation
├── e2e/
│   ├── auth.spec.ts                      CREATE  login + redirect + landing
│   └── smoke.spec.ts                     MODIFY  wrap anon assertions behind login, keep /api/health anonymous
├── vitest.config.ts                      CREATE  unit (node env) + integration (node env, longer timeout)
├── package.json                          MODIFY  +next-auth beta, @auth/pg-adapter, bcryptjs, tsx, zod, @types/bcryptjs, vitest; +scripts create-admin, test, test:int
└── Dockerfile                            MODIFY  ensure tsx is present in runner stage for create-admin CLI

packages/db/migrations/
├── 1700000000010_auth-core.sql           CREATE  role enum + users + sessions + verification_tokens + audit_log
└── (existing migrations untouched)

docs/decisions/
└── 0001-auth-stack.md                    CREATE  short ADR: why Auth.js v5 beta + Credentials + bcryptjs + DB sessions via adapter workaround

.env.example                              MODIFY  ensure NEXTAUTH_SECRET / NEXTAUTH_URL documented; add AUTH_TRUST_HOST for compose
CLAUDE.md                                 MODIFY  remove "TODO(#7)" mentions once complete; link to ADR
```

---

## Task 1 — ADR: record the auth stack decision

**Files:** Create `docs/decisions/0001-auth-stack.md`.

**Step 1:** Write ADR with sections: Context, Decision, Consequences, Alternatives considered. Capture:
- Auth.js v5 beta (why beta: Next 14 App Router support; risks: API churn)
- Credentials provider with manual DB-session minting (workaround documented above)
- `bcryptjs` over `bcrypt` (Alpine compatibility)
- DB sessions for revocation (matches CLAUDE.md canonical decision)
- Secure cookies default on; dev-only HTTP override gated by `NODE_ENV !== "production"`

**Step 2:** Commit.
```bash
git add docs/decisions/0001-auth-stack.md
git commit -m "docs: ADR 0001 — auth stack (Auth.js v5 + bcryptjs + DB sessions) (#7)"
```

**Verifies criterion:** *foundation for* cookies/bcrypt/DB-sessions decisions (all criteria).

---

## Task 2 — Dependencies

**Files:** Modify `apps/web/package.json`.

**Step 1:** Add runtime deps:
```
next-auth@5.0.0-beta.22
@auth/pg-adapter@1.5.0
bcryptjs@2.4.3
zod@3.23.8
tsx@4.19.1
```
Add dev deps:
```
@types/bcryptjs@2.4.6
vitest@2.1.3
@vitest/coverage-v8@2.1.3
testcontainers@10.13.2
```
Add scripts:
```json
"create-admin": "tsx scripts/create-admin.ts",
"test": "vitest run --project unit",
"test:int": "vitest run --project integration",
"test:e2e": "playwright test"
```

**Step 2:** Install and snapshot lockfile.
```bash
pnpm install
pnpm --filter web typecheck
```
Expected: both succeed. `next-auth` resolves to a `5.0.0-beta.*` version.

**Step 3:** Commit.
```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore: add next-auth v5 + bcryptjs + testcontainers deps (#7)"
```

**Verifies criteria:** — (enables the rest).

---

## Task 3 — DB migration: role enum + users + sessions + verification_tokens + audit_log

**Files:** Create `packages/db/migrations/1700000000010_auth-core.sql`.

**Step 1 (RED):** Write integration test stub at `apps/web/test/auth-flow.int.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate, getPool, closePool } from "@tsm/db";

let pg: StartedPostgreSqlContainer;
beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();
}, 120_000);
afterAll(async () => { await closePool(); await pg.stop(); });

describe("auth schema", () => {
  it("creates users, sessions, verification_tokens, audit_log and role enum", async () => {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('users','sessions','verification_tokens','audit_log')
      ORDER BY tablename`);
    expect(rows.map(r => r.tablename)).toEqual(
      ["audit_log","sessions","users","verification_tokens"]);
    const e = await pool.query(`SELECT unnest(enum_range(NULL::user_role))::text AS v`);
    expect(e.rows.map(r => r.v).sort()).toEqual(["admin","operator","viewer"]);
  });
});
```

**Step 2:** Run test to watch it fail.
```bash
pnpm --filter web test:int -- auth-flow.int
```
Expected: FAIL — `relation "users" does not exist` (migration not written yet).

**Step 3 (GREEN):** Write migration. Key constraints:
- `CREATE TYPE user_role AS ENUM ('admin','operator','viewer');`
- `users (id UUID PK default gen_random_uuid(), email CITEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role user_role NOT NULL DEFAULT 'viewer', is_active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` — trigger to bump `updated_at`.
- `sessions (id TEXT PK, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TIMESTAMPTZ NOT NULL, session_token TEXT UNIQUE NOT NULL)` — matches `@auth/pg-adapter` schema.
- `verification_tokens (identifier TEXT NOT NULL, token TEXT NOT NULL, expires TIMESTAMPTZ NOT NULL, PRIMARY KEY (identifier, token))` — adapter schema.
- `audit_log (id BIGSERIAL PK, user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, target TEXT, metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, at TIMESTAMPTZ NOT NULL DEFAULT now())`. Index on `(at DESC)`.
- `CREATE EXTENSION IF NOT EXISTS citext;` — for case-insensitive email uniqueness.
- `CREATE EXTENSION IF NOT EXISTS pgcrypto;` — for `gen_random_uuid()`.
- Down migration drops tables, enum, extensions.

**Step 4:** Re-run integration test.
```bash
pnpm --filter web test:int -- auth-flow.int
```
Expected: PASS.

**Step 5:** Commit.
```bash
git add packages/db/migrations/1700000000010_auth-core.sql apps/web/test/auth-flow.int.test.ts apps/web/vitest.config.ts
git commit -m "feat(db): auth-core migration — users, sessions, tokens, audit, role enum (#7)"
```

**Verifies criteria:**
- [x] *Postgres schema: users(...), sessions, verification_tokens — managed by migrations*
- [x] *Role enum in Postgres*
- [x] *audit_log (...)*

---

## Task 4 — Password hashing helpers

**Files:** Create `apps/web/lib/password.ts`, `apps/web/test/password.test.ts`.

**Step 1 (RED):** Write test:
```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct-horse-battery-staple");
    expect(h).not.toContain("correct-horse");
    expect(h.startsWith("$2")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("rejects empty / short passwords", async () => {
    await expect(hashPassword("")).rejects.toThrow();
    await expect(hashPassword("1234567")).rejects.toThrow(/at least 8/);
  });
});
```

**Step 2:** Run, confirm fail.
```bash
pnpm --filter web test -- password
```
Expected: FAIL — module not found.

**Step 3 (GREEN):**
```ts
// apps/web/lib/password.ts
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;
const MIN_LEN = 8;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("password required");
  if (plaintext.length < MIN_LEN) throw new Error(`password must be at least ${MIN_LEN} chars`);
  return bcrypt.hash(plaintext, BCRYPT_COST);
}
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  return bcrypt.compare(plaintext, hash);
}
```

**Step 4:** Run; expect PASS.

**Step 5:** Commit.
```bash
git add apps/web/lib/password.ts apps/web/test/password.test.ts
git commit -m "feat(auth): bcryptjs password hash helpers (cost=12) (#7)"
```

**Verifies criteria:**
- [x] *bcrypt for password hashing, cost=12*
- [x] *Unit tests: password-hash roundtrip*

---

## Task 5 — RBAC helpers + Role type

**Files:** Create `apps/web/lib/rbac.ts`, `apps/web/test/rbac.test.ts`.

**Step 1 (RED):** Test:
```ts
import { hasRole, ROLES, type Role } from "@/lib/rbac";

describe("rbac", () => {
  const matrix: [Role, Role, boolean][] = [
    ["admin","admin",true],["admin","operator",true],["admin","viewer",true],
    ["operator","admin",false],["operator","operator",true],["operator","viewer",true],
    ["viewer","admin",false],["viewer","operator",false],["viewer","viewer",true],
  ];
  it.each(matrix)("hasRole(%s, %s) = %s", (u, req, exp) => {
    expect(hasRole(u, req)).toBe(exp);
  });
  it("exposes ordered ROLES", () => {
    expect(ROLES).toEqual(["admin","operator","viewer"]);
  });
});
```

**Step 2 (GREEN):**
```ts
// apps/web/lib/rbac.ts
import { redirect } from "next/navigation";
import { auth } from "@/auth"; // implemented in Task 6

export const ROLES = ["admin","operator","viewer"] as const;
export type Role = typeof ROLES[number];
const RANK: Record<Role, number> = { admin: 3, operator: 2, viewer: 1 };

export function hasRole(user: Role, required: Role): boolean {
  return RANK[user] >= RANK[required];
}

/** For server components / server actions / route handlers. Redirects to /login
    on anonymous, returns a 403 JSON on authenticated-but-insufficient-role. */
export async function requireRole(required: Role) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const userRole = (session.user as any).role as Role | undefined;
  if (!userRole || !hasRole(userRole, required)) {
    throw new Response("forbidden", { status: 403 });
  }
  return session;
}
```

`rbac.test.ts` only tests `hasRole` / `ROLES` (no `auth()` call). `requireRole` integration-tested via auth-flow test later.

**Step 3:** `pnpm --filter web test -- rbac` → PASS.

**Step 4:** Commit.
```bash
git add apps/web/lib/rbac.ts apps/web/test/rbac.test.ts
git commit -m "feat(auth): requireRole + hasRole helpers (#7)"
```

**Verifies criteria:**
- [x] *requireRole(role) helper*
- [x] *Unit tests: role-check helper*

---

## Task 6 — Auth.js v5 config + Credentials provider + manual DB session

**Files:** Create `apps/web/auth.ts`, `apps/web/auth.config.ts`, `apps/web/lib/session-cookie.ts`, `apps/web/app/api/auth/[...nextauth]/route.ts`.

**Step 1:** Implement `auth.config.ts` — edge-safe subset (no adapter, no bcrypt). Exports `{ providers: [], pages: { signIn: "/login" }, callbacks: { authorized }` — `authorized({ request, auth })` returns `false` for unauth'd access to anything except public routes (covered again by middleware matcher, but this is belt + suspenders).

**Step 2:** Implement `lib/session-cookie.ts`:
```ts
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { getPool } from "@/lib/postgres";

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days
const COOKIE_NAME = process.env.NODE_ENV === "production"
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

export async function issueDbSessionCookie(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_MAX_AGE_S * 1000);
  await getPool().query(
    `INSERT INTO sessions (id, user_id, session_token, expires)
     VALUES ($1, $2, $1, $3)`, [token, userId, expires]);
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  });
}
```

**Step 3:** Implement `auth.ts`:
```ts
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import PostgresAdapter from "@auth/pg-adapter";
import { z } from "zod";
import { getPool } from "@/lib/postgres";
import { verifyPassword } from "@/lib/password";
import { issueDbSessionCookie } from "@/lib/session-cookie";
import { recordAudit } from "@/lib/audit";
import authConfig from "./auth.config";
import type { Role } from "@/lib/rbac";

declare module "next-auth" {
  interface Session { user: { id: string; email: string; role: Role } & DefaultSession["user"]; }
}

const loginSchema = z.object({
  email: z.string().email().transform(s => s.toLowerCase().trim()),
  password: z.string().min(1),
});

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PostgresAdapter(getPool()),
  session: { strategy: "database", maxAge: 60 * 60 * 24 * 30 },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const { rows } = await getPool().query(
          `SELECT id, email, password_hash, role, is_active FROM users WHERE email=$1`, [email]);
        const user = rows[0];
        if (!user) return null;
        if (!user.is_active) {
          await recordAudit(user.id, "login_denied_inactive", "user:"+user.id, {});
          return null;
        }
        if (!(await verifyPassword(password, user.password_hash))) {
          await recordAudit(user.id, "login_failed", "user:"+user.id, {});
          return null;
        }
        await issueDbSessionCookie(user.id);
        await recordAudit(user.id, "login", "user:"+user.id, {});
        return { id: user.id, email: user.email, role: user.role };
      },
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (user) {
        (session.user as any).id = user.id;
        (session.user as any).role = (user as any).role;
      }
      return session;
    },
  },
});
```

> **Why the manual cookie issue:** Auth.js v5 with Credentials + DB-session strategy does not persist a session row automatically. We do it ourselves so `session.user` in server components resolves via the adapter's `getSessionAndUser(session_token)`.

**Step 4:** Wire handlers at `apps/web/app/api/auth/[...nextauth]/route.ts`:
```ts
export { GET, POST } from "@/auth";
// actually: export const { GET, POST } = handlers;
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

**Step 5:** Typecheck.
```bash
pnpm --filter web typecheck
```
Expected: PASS.

**Step 6:** Commit.
```bash
git add apps/web/auth.ts apps/web/auth.config.ts apps/web/lib/session-cookie.ts apps/web/app/api/auth/\[...nextauth\]
git commit -m "feat(auth): NextAuth v5 config — Credentials + PG adapter + manual DB session (#7)"
```

**Verifies criteria:**
- [x] *Auth.js v5 integrated with Credentials provider*
- [x] *Database sessions via Postgres adapter — admin can revoke immediately*
- [x] *Cookies: Secure + SameSite=Lax + HttpOnly; dev override gated by NODE_ENV*

---

## Task 7 — Audit log helper

**Files:** Create `apps/web/lib/audit.ts`. No new test file (covered by integration tests).

```ts
import { getPool } from "@/lib/postgres";
import { log } from "@/lib/logger";

export async function recordAudit(
  userId: string | null,
  action: string,
  target: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, target, metadata_json) VALUES ($1,$2,$3,$4)`,
      [userId, action, target, metadata]);
  } catch (err) {
    log("error", "audit_write_failed", { action, target, err: String(err) });
    // Never throw — auditing must not break the auth flow.
  }
}
```

**Commit:** `git commit -m "feat(auth): recordAudit helper (best-effort, never throws) (#7)"`.

**Verifies criteria:** (used by Tasks 6, 8, 11, 12).

---

## Task 8 — Middleware enforcing auth on every non-public route

**Files:** Create `apps/web/middleware.ts`.

**Step 1 (RED):** Add to `apps/web/e2e/auth.spec.ts` (placeholder — full content Task 14):
```ts
test("unauthenticated / redirects to /login", async ({ page }) => {
  const resp = await page.goto("/");
  expect(page.url()).toContain("/login");
});
test("/api/health stays anonymous", async ({ request }) => {
  const r = await request.get("/api/health");
  expect(r.status()).toBe(200);
});
```

**Step 2 (GREEN):**
```ts
// apps/web/middleware.ts
import NextAuth from "next-auth";
import authConfig from "./auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_EXACT = new Set(["/login", "/api/health"]);

export default auth((req) => {
  const { nextUrl } = req;
  if (PUBLIC_EXACT.has(nextUrl.pathname)) return;
  if (nextUrl.pathname.startsWith("/api/auth")) return;
  if (!req.auth) {
    const loginUrl = new URL("/login", nextUrl.origin);
    loginUrl.searchParams.set("next", nextUrl.pathname + nextUrl.search);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: [
    // Run on everything except Next internals + static files
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml)$).*)",
  ],
};
```

**Step 3:** Boot dev server + run E2E subset.
```bash
pnpm --filter web test:e2e -- auth.spec.ts
```
Expected: PASS.

**Step 4:** Commit.
```bash
git add apps/web/middleware.ts apps/web/e2e/auth.spec.ts
git commit -m "feat(auth): middleware — redirect anon to /login, keep /api/health public (#7)"
```

**Verifies criteria:**
- [x] *Middleware enforces auth on all routes except /login, /api/health, static assets*

---

## Task 9 — Wire ingestion/run to requireRole + recordAudit

**Files:** Modify `apps/web/app/api/ingestion/run/route.ts`.

**Step 1 (RED):** Update `smoke.spec.ts`:
- Existing test: `/api/ingestion/run denies unauthenticated POST` → **change** to expect 401/redirect now that middleware intercepts. Keep a new authenticated-but-viewer test in `auth.spec.ts` that expects 403.

**Step 2 (GREEN):** Replace file body:
```ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";

export async function POST() {
  const session = await requireRole("admin");
  await recordAudit(session.user.id, "ingestion_run_triggered", null, {});
  // TODO(#13): actually enqueue a run via trigger row / queue.
  return NextResponse.json({ status: "queued" });
}
```

**Step 3:** Typecheck + relevant E2E.

**Step 4:** Commit.
```bash
git commit -am "refactor(api): ingestion/run gated by requireRole(admin) (#7)"
```

**Verifies criteria:** (demonstrates requireRole in use; actual criterion is "requireRole helper" — Task 5).

---

## Task 10 — `/login` page + server action + logout button + header session

**Files:** Create `apps/web/app/login/page.tsx`, `apps/web/app/login/actions.ts`, `apps/web/app/_components/logout-button.tsx`. Modify `apps/web/app/layout.tsx`.

**Step 1:** `login/actions.ts`:
```ts
"use server";
import { signIn } from "@/auth";
import { AuthError } from "next-auth";

export async function loginAction(_prev: unknown, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: (formData.get("next") as string) || "/",
    });
    return { ok: true as const };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false as const, error: "Invalid email or password." };
    }
    throw err; // rethrow redirects
  }
}
```

**Step 2:** `login/page.tsx` — server component rendering a `<form action={loginAction}>` with email + password fields + hidden `next` input populated from search params. Use `useFormState` (client boundary for the error surface).

**Step 3:** `logout-button.tsx`:
```tsx
"use client";
import { signOut } from "next-auth/react";
// NOTE: v5 — prefer a server action `signOutAction` that calls `signOut()` from `@/auth`.
```
Actually do this as a server-action form (no client signOut import needed):
```tsx
// app/_components/logout-button.tsx
import { signOut } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { auth } from "@/auth";

export async function LogoutButton() {
  async function action() {
    "use server";
    const s = await auth();
    if (s?.user) await recordAudit((s.user as any).id, "logout", null, {});
    await signOut({ redirectTo: "/login" });
  }
  return <form action={action}><button className="...">Log out</button></form>;
}
```

**Step 4:** Modify `layout.tsx` to render a right-side user pill: `{session ? <UserPill email=... role=... /><LogoutButton/> : null}`. Session lookup via `await auth()` — since layout is a server component, this is fine.

**Step 5 (RED→GREEN):** E2E `auth.spec.ts` covers login happy path (Task 14 finalizes; add a minimal one now).

**Step 6:** Commit.
```bash
git add apps/web/app/login apps/web/app/_components/logout-button.tsx apps/web/app/layout.tsx
git commit -m "feat(auth): /login page, logout button, header session pill (#7)"
```

**Verifies criteria:**
- [x] *Login page (/login), logout button, session context available in server components*

---

## Task 11 — `create-admin` CLI

**Files:** Create `apps/web/scripts/create-admin.ts`, `apps/web/test/create-admin.test.ts`.

**Step 1 (RED):** Test drives behavior via `child_process.spawn` with piped stdin; asserts exit code and DB state:
```ts
it("inserts admin when new email", async () => { /* spawn tsx scripts/create-admin.ts, feed "new@ex.com\npass12345\npass12345\n", assert row exists with role=admin */ });
it("rejects when passwords mismatch (exit 2)", async () => { /* ... */ });
it("fails on conflict without --force (exit 3)", async () => { /* create row, re-run */ });
it("upserts on conflict when --force is passed", async () => { /* ... */ });
it("never echoes the password to stdout", async () => { /* capture stdout, assert no plaintext leak */ });
```
Use a testcontainers Postgres per test file; run migrations once via `beforeAll`.

**Step 2 (GREEN):** Implement CLI:
```ts
// apps/web/scripts/create-admin.ts
import readline from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { getPool } from "../lib/postgres";
import { hashPassword } from "../lib/password";

const force = argv.includes("--force");

async function promptHidden(rl: readline.Interface, label: string): Promise<string> {
  // Turn off echo: set rawMode or use a muted writable. Minimal reliable approach:
  process.stdout.write(label);
  const onData = (b: Buffer) => {
    // Overwrite any echoed chars with backspaces (TTY) — safety net.
    if (stdout.isTTY) stdout.write("\b \b".repeat(b.toString("utf8").replace(/\n/g, "").length));
  };
  stdin.on("data", onData);
  const answer = await rl.question("");
  stdin.off("data", onData);
  return answer;
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const email = (await rl.question("Email: ")).trim().toLowerCase();
  // Mute output for password prompts:
  // @ts-expect-error private API, but stable for years
  (rl as any).output.write = () => true;
  const password = await rl.question("Password: ");
  const confirm = await rl.question("Confirm: ");
  rl.close();
  if (password !== confirm) { console.error("passwords do not match"); exit(2); }
  if (password.length < 8) { console.error("password must be >= 8 chars"); exit(2); }

  const hash = await hashPassword(password);
  const pool = getPool();
  const existing = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
  if (existing.rowCount && !force) {
    console.error(`user exists: pass --force to upsert`); exit(3);
  }
  if (existing.rowCount) {
    await pool.query(
      `UPDATE users SET password_hash=$2, role='admin', is_active=true, updated_at=now() WHERE email=$1`,
      [email, hash]);
    console.log(`updated admin: ${email}`);
  } else {
    await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'admin')`,
      [email, hash]);
    console.log(`created admin: ${email}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); exit(1); });
```

**Step 3:** Run unit tests; expect PASS.

**Step 4:** Commit.
```bash
git add apps/web/scripts/create-admin.ts apps/web/test/create-admin.test.ts
git commit -m "feat(auth): create-admin CLI — stdin prompt, no-echo, --force upsert (#7)"
```

**Verifies criteria:**
- [x] *npm run create-admin CLI — reads email+password from stdin, never echoes password, inserts admin, upserts with --force*
- [x] *Unit tests: create-admin CLI (idempotent re-run, password confirmation mismatch)*

---

## Task 12 — `/admin/users` page + server actions

**Files:** Create `apps/web/app/admin/users/page.tsx`, `apps/web/app/admin/users/actions.ts`, `apps/web/app/admin/users/user-row.tsx`.

**Step 1:** `actions.ts` — every action begins with `await requireRole("admin")` and ends with `recordAudit`:
- `createUser({ email, role, password })` — zod validates, hashes, inserts, audits `user_created`
- `deactivateUser(id)` — sets `is_active=false`, **also** deletes all `sessions` for that user (immediate revocation), audits `user_deactivated`
- `changeRole(id, role)` — updates role, audits `role_changed` with `{ from, to }`
- `reactivateUser(id)` — flips back to `is_active=true`, audits `user_reactivated`

**Step 2:** `page.tsx` — server component:
```
await requireRole("admin");
// fetch users ORDER BY email, render table + a <CreateUserForm/>
```

**Step 3:** `user-row.tsx` — client component with confirm prompts on destructive actions.

**Step 4:** Integration test addition in `auth-flow.int.test.ts`:
- login as viewer → GET `/admin/users` returns 403 (redirect/throw).
- login as admin → actions succeed; audit rows appear.
- deactivating a user with an active session → next request from that session returns 401/redirect.

**Step 5:** Commit.
```bash
git add apps/web/app/admin
git commit -m "feat(auth): /admin/users — list, create, deactivate, change role (#7)"
```

**Verifies criteria:**
- [x] */admin/users page (admin-only): list, create, deactivate, change role*
- [x] *No self-signup anywhere* — only entry point is admin CLI + admin UI, both role-gated.
- [x] *Audit log written on user-create / role-change / user-deactivate*

---

## Task 13 — Integration tests (testcontainers — no mocks)

**Files:** Expand `apps/web/test/auth-flow.int.test.ts`.

Required scenarios:
1. Migration shape (Task 3 — already present).
2. `authorize()` returns user on valid credentials, null on wrong password.
3. `authorize()` returns null for `is_active=false` user; audit row `login_denied_inactive` present.
4. Session revocation: create session row for user → assert `auth()`-style lookup resolves → delete session row → lookup now returns no user.
5. `requireRole("admin")` throws 403 when user is viewer.
6. `recordAudit` failure-path: temporarily break the pool, assert the caller does not throw.

**Commit:** `git commit -am "test(auth): integration — login, wrong-pw, inactive, revocation via testcontainers (#7)"`.

**Verifies criteria:**
- [x] *Integration tests: login success, wrong-password fail, inactive-user denied, session revocation*

---

## Task 14 — E2E: seed admin → login → landing

**Files:** `apps/web/e2e/auth.spec.ts`.

**Flow:** `test.beforeAll` seeds an admin row directly via `pg` (NOT via CLI — CLI has its own tests). Tests:
1. GET `/` unauthenticated → redirects to `/login?next=/`.
2. POST `/login` with seed admin creds → redirected to `/`, header shows email.
3. Wrong password → stays on `/login`, error visible.
4. `/admin/users` → visible as admin.
5. Logout → back to `/login`.
6. `/api/health` remains anonymous (200 without session).

**Commit:** `git commit -am "test(auth): E2E — seed admin, login, landing, logout (#7)"`.

**Verifies criteria:**
- [x] *E2E: seed admin → login → reach landing page*

---

## Task 15 — Infra: Dockerfile + compose wiring

**Files:** Modify `apps/web/Dockerfile`, `docker-compose.yml`, `.env.example`.

**Step 1:** Dockerfile runner stage: ensure `tsx` is present. Because `pnpm deploy --prod` only keeps `dependencies`, and `tsx` is a runtime dep of the `create-admin` script, it must live under `dependencies` (not `devDependencies`). Task 2 already does this — verify.

**Step 2:** Compose: `web` environment already includes `NEXTAUTH_SECRET`/`NEXTAUTH_URL` (checked earlier). Add `AUTH_TRUST_HOST: "true"` — required by v5 when behind Caddy on compose.

**Step 3:** `.env.example`: ensure `NEXTAUTH_SECRET=<openssl rand -base64 32>` + `NEXTAUTH_URL=http://localhost` documented + `AUTH_TRUST_HOST=true`.

**Step 4:** Smoke: `docker compose build web && docker compose run --rm web npm run create-admin` (stdin from a pipe for smoke — actual interactive run done by operator).

**Step 5:** Commit.
```bash
git commit -am "chore(infra): wire NEXTAUTH env + AUTH_TRUST_HOST + tsx in web image (#7)"
```

**Verifies criteria:** enables `npm run create-admin` *inside the web image* (criterion).

---

## Task 16 — README + CLAUDE.md polish

**Files:** Modify `README.md` (add "Creating the first admin" section), `CLAUDE.md` (drop the TODO(#7) note in `/api/ingestion/run` — already handled in Task 9; note ADR 0001).

**Commit:** `git commit -am "docs: admin bootstrap + auth notes (#7)"`.

---

## Final verification — acceptance criteria sweep

Run sequentially on the feature branch from a clean tree:

```bash
git status                                    # clean
pnpm install
pnpm -r typecheck                              # PASS everywhere
pnpm --filter web test                         # vitest unit — PASS
pnpm --filter web test:int                     # vitest integration (testcontainers) — PASS
docker compose build web ingestor              # PASS
docker compose up -d --wait                    # stack healthy
echo -e "admin@example.com\nhunter2hunter2\nhunter2hunter2\n" | \
  docker compose run --rm -T web npm run create-admin  # creates admin
pnpm --filter web test:e2e                     # Playwright — PASS
docker compose down -v
```

Then confirm each box manually against the issue:

| # | Criterion | Verified by |
|---|-----------|-------------|
| 1 | Auth.js v5 + Credentials integrated | Tasks 2, 6 |
| 2 | bcrypt cost=12 | Task 4 + `password.test.ts` |
| 3 | DB sessions — admin can revoke immediately | Tasks 6, 12 + revocation integration test |
| 4 | users / sessions / verification_tokens migrations | Task 3 + `auth-core.sql` present in migration list |
| 5 | Role enum (admin/operator/viewer) | Task 3 + enum_range integration assertion |
| 6 | `npm run create-admin` stdin, no echo, upsert w/ --force | Task 11 + CLI tests |
| 7 | /login, logout, session in server components | Task 10 + E2E |
| 8 | Middleware enforces auth except /login, /api/health, static | Task 8 + E2E |
| 9 | `requireRole(role)` helper | Task 5 + Task 9 real usage |
| 10 | /admin/users admin-only (list/create/deactivate/change role) | Task 12 + integration test |
| 11 | Cookies Secure + SameSite=Lax + HttpOnly, dev override gated | Task 6 (`session-cookie.ts`) |
| 12 | audit_log written at 5 hook points | Tasks 6, 7, 9, 10, 12 + integration test greps audit rows |
| 13 | Unit tests: hash, role, CLI | Tasks 4, 5, 11 |
| 14 | Integration tests: login, wrong-pw, inactive, revocation | Task 13 |
| 15 | E2E: seed admin → login → landing | Task 14 |

If any row is "not verified", re-enter the relevant task.

---

## Commit cadence summary

~13 commits on `feat/issue-7-authjs-rbac`, all referencing `(#7)`. PR body template:

```
## Summary
- Auth.js v5 Credentials + bcryptjs + DB sessions via @auth/pg-adapter (manual cookie workaround for Credentials)
- users / sessions / verification_tokens / audit_log migrations; user_role enum
- /login, logout, /admin/users (admin-only), middleware gating all non-public routes
- npm run create-admin CLI (stdin, no echo, --force upsert)
- Unit + testcontainers integration + Playwright E2E

## Closes
Closes #7

## Parent PRD
#1

## Acceptance Criteria Verification
<paste the table from "Final verification — acceptance criteria sweep">
```

---

## Ambiguities / pre-reqs flagged

1. **`NEXTAUTH_SECRET` / `NEXTAUTH_URL`** must exist in `.env` before any auth flow works. `.env.example` needs both documented (Task 15). User must populate `.env` — don't generate and commit a real secret.
2. **`gen_random_uuid()`** requires `pgcrypto`. Migration enables it. If app Postgres is managed and the role lacks `CREATE EXTENSION`, fall back to `uuid-ossp` or app-side UUIDs — flag before migrating.
3. **Manual DB-session minting in `authorize`** is a conscious v5 workaround. If upstream NextAuth releases first-class Credentials+DB-session support, revisit the custom cookie logic in Task 6 (ADR captures this).
4. **Session revocation in deactivateUser** does `DELETE FROM sessions WHERE user_id=$1`. This is immediate but destroys all devices — matches the criterion "admin can revoke a user immediately".
5. **Auth.js v5 is beta.** Pin the exact version (Task 2). A patch-level bump may change APIs — do not bump casually.
6. **`/admin/users` route security.** Three layers: middleware redirects anon, `requireRole("admin")` in page + every action. All three required — do not trust a single layer.
7. **Rate-limiting login.** Out of scope for #7 (not a checkbox). Note as follow-up if desired but do not add silently — would be a scope creep violation.
