# Saved Views — Frontend Implementation Plan (Issue #12, PR B)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the UI half of issue #12 — a "Save view" button on path-trace and downstream pages, a "My views" dropdown in the header, and an E2E spec proving the share-with-role round-trip (operator saves → viewer opens).

**Architecture:** Backend is already merged (PR #25): `POST /api/views`, `GET /api/views`, `GET/PATCH/DELETE /api/views/:id`, RBAC-enforced visibility, zod-validated `ViewPayload` discriminated on `kind: "path" | "downstream"`. Frontend adds two client components that talk to those endpoints. Clicking a saved view rebuilds the canonical URL from the stored `payload` (no new server routes needed) and does a plain `router.push` so the existing server-rendered pages execute the query.

**Tech Stack:** Next.js 14 app-router, React server components for pages + client components for the interactive bits, Tailwind for styling, Playwright for E2E, existing `pg` + `neo4j-driver` seed helpers from `apps/web/e2e/path-trace.spec.ts`.

---

## Preflight (read once, do not skip)

- **Branch already exists:** `issue-12-*` may exist locally from PR #25's merge. Start from `main` with a new branch: `git checkout main && git pull && git checkout -b issue-12-saved-views-ui`.
- **Backend contract is frozen** — read `apps/web/lib/saved-views.ts` for request/response shapes, `apps/web/app/api/views/route.ts` and `apps/web/app/api/views/[id]/route.ts` for status codes (400/403/404/409/429/503). Do not change them from the frontend.
- **URL rebuild rules** — a saved view stores `{kind, query}`:
  - `kind: "path"`, `query.kind: "device"` → `/device/${encodeURIComponent(query.value)}`
  - `kind: "path"`, `query.kind: "service"` → `/service/${encodeURIComponent(query.value)}`
  - `kind: "downstream"` → `/device/${encodeURIComponent(query.device)}/downstream?include_transport=${query.include_transport}&max_depth=${query.max_depth}`
- **RBAC surface on the client:** the session pill in `app/layout.tsx` exposes `session.user.role`. Pass the role into `SaveViewButton` and `MyViewsDropdown` as a prop so they can (a) disable the visibility picker for viewers, (b) filter the visibility options operators can set.
- **Test conventions:** unit tests — `.test.tsx` in `apps/web/test/` (vitest workspace already wired for JSX per CLAUDE.md pitfall). E2E — `apps/web/e2e/saved-views.spec.ts`, follow existing `path-trace.spec.ts` for compose stack + fixture seeding.
- **Data sensitivity:** fixtures prefixed `E2E-SV-*`. Never use real hostnames.
- **Commits:** every commit ends with `(#12)`. TDD order = test commit first (RED), then impl (GREEN), optional refactor.

---

## Task 1 — URL rebuilder helper (pure function, easy to test)

**Files:**
- Create: `apps/web/lib/saved-views-url.ts`
- Create: `apps/web/test/saved-views-url.test.ts`

**Why first:** both `MyViewsDropdown` and the E2E depend on it; unit-testable without DOM.

### Step 1.1 — RED: write failing test

```ts
// apps/web/test/saved-views-url.test.ts
import { describe, it, expect } from "vitest";
import { savedViewToHref } from "@/lib/saved-views-url";

describe("savedViewToHref", () => {
  it("path/device → /device/:name", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "device", value: "E2E-SV-CSG" } }),
    ).toBe("/device/E2E-SV-CSG");
  });

  it("path/service → /service/:cid", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "service", value: "E2E-SV-CID" } }),
    ).toBe("/service/E2E-SV-CID");
  });

  it("path URL-encodes suspicious device names", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "device", value: "a/b c" } }),
    ).toBe("/device/a%2Fb%20c");
  });

  it("downstream → /device/:name/downstream with querystring", () => {
    expect(
      savedViewToHref({
        kind: "downstream",
        query: { device: "E2E-SV-UPE", include_transport: true, max_depth: 8 },
      }),
    ).toBe("/device/E2E-SV-UPE/downstream?include_transport=true&max_depth=8");
  });

  it("downstream encodes include_transport=false literally", () => {
    expect(
      savedViewToHref({
        kind: "downstream",
        query: { device: "X", include_transport: false, max_depth: 1 },
      }),
    ).toBe("/device/X/downstream?include_transport=false&max_depth=1");
  });
});
```

### Step 1.2 — verify RED

Run: `pnpm --filter web test saved-views-url -- --run`
Expected: FAIL — `Cannot find module '@/lib/saved-views-url'`.

### Step 1.3 — GREEN: minimal implementation

```ts
// apps/web/lib/saved-views-url.ts
import type { ViewPayload } from "@/lib/saved-views";

export function savedViewToHref(payload: ViewPayload): string {
  if (payload.kind === "path") {
    const { kind, value } = payload.query;
    const base = kind === "device" ? "/device" : "/service";
    return `${base}/${encodeURIComponent(value)}`;
  }
  const { device, include_transport, max_depth } = payload.query;
  const qs = new URLSearchParams({
    include_transport: String(include_transport),
    max_depth: String(max_depth),
  });
  return `/device/${encodeURIComponent(device)}/downstream?${qs.toString()}`;
}
```

### Step 1.4 — verify GREEN

Run: `pnpm --filter web test saved-views-url -- --run`
Expected: PASS (5/5).

### Step 1.5 — commit

```bash
git add apps/web/lib/saved-views-url.ts apps/web/test/saved-views-url.test.ts
git commit -m "test: saved-views URL rebuilder (#12)"
```

*(One commit — test + impl together is fine for a pure helper written red-then-green in the same task.)*

---

## Task 2 — Visibility options helper (client-facing mirror of server rules)

**Files:**
- Create: `apps/web/lib/saved-views-visibility-ui.ts`
- Create: `apps/web/test/saved-views-visibility-ui.test.ts`

**Why separate from `saved-views-visibility.ts`:** the server helper returns what a caller is *allowed* to request; the UI needs the list in the exact order shown in the picker, including the "private" option, and it must hard-cap viewers to `['private']` per AC. Keep server auth logic untouched.

### Step 2.1 — RED

```ts
// apps/web/test/saved-views-visibility-ui.test.ts
import { describe, it, expect } from "vitest";
import { visibilityOptions } from "@/lib/saved-views-visibility-ui";

describe("visibilityOptions", () => {
  it("viewer → only private", () => {
    expect(visibilityOptions("viewer")).toEqual(["private"]);
  });
  it("operator → private + role:viewer + role:operator", () => {
    expect(visibilityOptions("operator")).toEqual([
      "private",
      "role:viewer",
      "role:operator",
    ]);
  });
  it("admin → all four", () => {
    expect(visibilityOptions("admin")).toEqual([
      "private",
      "role:viewer",
      "role:operator",
      "role:admin",
    ]);
  });
});
```

### Step 2.2 — verify RED

Run: `pnpm --filter web test saved-views-visibility-ui -- --run`
Expected: FAIL (module not found).

### Step 2.3 — GREEN

```ts
// apps/web/lib/saved-views-visibility-ui.ts
import type { Visibility } from "@/lib/saved-views";
import type { Role } from "@/lib/rbac";

export function visibilityOptions(role: Role): Visibility[] {
  if (role === "viewer") return ["private"];
  if (role === "operator") return ["private", "role:viewer", "role:operator"];
  return ["private", "role:viewer", "role:operator", "role:admin"];
}
```

*(If `Role` is not exported from `lib/rbac`, grep first: `rg "export.*type Role|export type Role" apps/web/lib`. If missing, use `"admin" | "operator" | "viewer"` inline and DO NOT add an export in a module you don't own — leave that for a refactor task.)*

### Step 2.4 — verify GREEN

Run the test; all three pass.

### Step 2.5 — commit

```bash
git add apps/web/lib/saved-views-visibility-ui.ts apps/web/test/saved-views-visibility-ui.test.ts
git commit -m "test: saved-views visibility option list per role (#12)"
```

---

## Task 3 — `SaveViewButton` client component

**Files:**
- Create: `apps/web/app/_components/save-view-button.tsx`
- Create: `apps/web/test/save-view-button.test.tsx`

Render rules:
- Disabled + tooltip "Viewers can only save private views" when `role === "viewer"` **and** show the picker locked to `private` (don't hide it — per PR #25 AC, viewers CAN save private views).
- On submit: `POST /api/views` with `{name, payload, visibility}`. On 201, show inline success "Saved" + reset form. On 409 name_conflict, show "Name already used". On 403 forbidden, show "Not allowed at your role". On 429 rate limited, show "Try again in a moment". Network error → "Save failed. Try again."
- No modal — render a collapsible inline panel; AC says "button on path-trace and downstream pages". Keep it minimal.

### Step 3.1 — RED: static-markup test of disabled state + option list

```tsx
// apps/web/test/save-view-button.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveViewButton } from "@/app/_components/save-view-button";

const payload = {
  kind: "path" as const,
  query: { kind: "device" as const, value: "E2E-SV-CSG" },
};

describe("SaveViewButton", () => {
  it("renders open toggle with data-testid", () => {
    const html = renderToStaticMarkup(
      <SaveViewButton role="viewer" payload={payload} />,
    );
    expect(html).toMatch(/data-testid="save-view-toggle"/);
  });

  it("viewer sees only 'private' option in the rendered markup", () => {
    // Client components render their initial (closed) state server-side; we
    // only assert the visibility options that would be available once opened
    // by reading the component's exported helper. The open/close interaction
    // is covered in E2E, not unit.
    const html = renderToStaticMarkup(
      <SaveViewButton role="viewer" payload={payload} defaultOpen />,
    );
    expect(html).toMatch(/value="private"/);
    expect(html).not.toMatch(/value="role:operator"/);
    expect(html).not.toMatch(/value="role:admin"/);
    expect(html).not.toMatch(/value="role:viewer"/);
  });

  it("operator sees private + role:viewer + role:operator but NOT role:admin", () => {
    const html = renderToStaticMarkup(
      <SaveViewButton role="operator" payload={payload} defaultOpen />,
    );
    expect(html).toMatch(/value="private"/);
    expect(html).toMatch(/value="role:viewer"/);
    expect(html).toMatch(/value="role:operator"/);
    expect(html).not.toMatch(/value="role:admin"/);
  });
});
```

### Step 3.2 — verify RED

Run: `pnpm --filter web test save-view-button -- --run`
Expected: FAIL (module not found).

### Step 3.3 — GREEN: implementation

```tsx
// apps/web/app/_components/save-view-button.tsx
"use client";

import { useState } from "react";
import type { ViewPayload, Visibility } from "@/lib/saved-views";
import { visibilityOptions } from "@/lib/saved-views-visibility-ui";

type Role = "admin" | "operator" | "viewer";
type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function SaveViewButton({
  role,
  payload,
  defaultOpen = false,
}: {
  role: Role;
  payload: ViewPayload;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const options = visibilityOptions(role);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, payload, visibility }),
      });
      if (res.status === 201) {
        setStatus({ kind: "saved" });
        setName("");
        return;
      }
      const err = await res.json().catch(() => ({}));
      const msg =
        err.error === "name_conflict"
          ? "Name already used"
          : err.error === "forbidden"
            ? "Not allowed at your role"
            : err.error === "rate_limited"
              ? "Try again in a moment"
              : "Save failed. Try again.";
      setStatus({ kind: "error", message: msg });
    } catch {
      setStatus({ kind: "error", message: "Save failed. Try again." });
    }
  }

  return (
    <div className="inline-block">
      <button
        type="button"
        data-testid="save-view-toggle"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50"
      >
        Save view
      </button>
      {open && (
        <form
          onSubmit={onSubmit}
          data-testid="save-view-form"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white p-3 text-xs ring-1 ring-slate-100"
        >
          <label className="flex items-center gap-1">
            <span className="text-slate-600">Name</span>
            <input
              data-testid="save-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              className="w-48 rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-600">Visibility</span>
            <select
              data-testid="save-view-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
              className="rounded border border-slate-300 px-2 py-1"
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={status.kind === "saving"}
            data-testid="save-view-submit"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {status.kind === "saving" ? "Saving…" : "Save"}
          </button>
          {status.kind === "saved" && (
            <span data-testid="save-view-ok" className="text-green-700">
              Saved
            </span>
          )}
          {status.kind === "error" && (
            <span data-testid="save-view-error" className="text-red-700">
              {status.message}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
```

### Step 3.4 — verify GREEN

Run: `pnpm --filter web test save-view-button -- --run`
Expected: 3/3 PASS.

### Step 3.5 — commit

```bash
git add apps/web/app/_components/save-view-button.tsx apps/web/test/save-view-button.test.tsx
git commit -m "feat: SaveViewButton client component (#12)"
```

---

## Task 4 — Mount `SaveViewButton` on path pages

**Files:**
- Modify: `apps/web/app/device/[name]/page.tsx` — pass `role` from session + build `payload`
- Modify: `apps/web/app/service/[cid]/page.tsx` — same
- Modify: `apps/web/app/device/[name]/downstream/page.tsx` — same with `kind: "downstream"` payload

### Step 4.1 — inspect each page to find the right insertion point

Run: `grep -n "PathView\|runPath\|<main\|csvHref" apps/web/app/device/\[name\]/page.tsx apps/web/app/service/\[cid\]/page.tsx apps/web/app/device/\[name\]/downstream/page.tsx`

Pick a spot adjacent to the page header / export-CSV link so Save-view sits in the same visual cluster.

### Step 4.2 — update `device/[name]/page.tsx`

- Read `getSession()` at top (already imported elsewhere — check `grep -n "getSession" apps/web/app/device/\[name\]/page.tsx`; if not imported, add `import { getSession } from "@/lib/session";`).
- After the existing `requireRole("viewer")` call, fetch session: `const session = await getSession(); const role = session!.user.role;` (the `requireRole` call above guarantees non-null).
- Render `<SaveViewButton role={role} payload={{kind: "path", query: {kind: "device", value: name}}} />` next to the page header.

### Step 4.3 — update `service/[cid]/page.tsx`

Same pattern, with `query: {kind: "service", value: cid}`.

### Step 4.4 — update `device/[name]/downstream/page.tsx`

- In the happy-path render (after `parseDownstreamQuery`), render `<SaveViewButton role={role} payload={{kind: "downstream", query: parsed}} />` near the existing "Export CSV" link in `<Header>`.
- Thread `role` through `<Header>` props or render the button in the page body directly; the latter is simpler — do that.
- Only render the button when `result.status === "ok"` (saving a view of a not-found device has no value; matches `csvHref` gating).

### Step 4.5 — typecheck

Run: `pnpm -r typecheck`
Expected: clean.

### Step 4.6 — smoke: unit suite still green

Run: `pnpm --filter web test -- --run`
Expected: all pass (nothing broken).

### Step 4.7 — commit

```bash
git add apps/web/app/device/\[name\]/page.tsx apps/web/app/service/\[cid\]/page.tsx apps/web/app/device/\[name\]/downstream/page.tsx
git commit -m "feat: mount SaveViewButton on path + downstream pages (#12)"
```

---

## Task 5 — `MyViewsDropdown` client component

**Files:**
- Create: `apps/web/app/_components/my-views-dropdown.tsx`
- Create: `apps/web/test/my-views-dropdown.test.tsx`

Behavior:
- On mount (or on first open — prefer on-open to avoid a fetch per page render), call `GET /api/views` once.
- Render list: name + `kind` + `visibility` badge + relative owner indicator (`(yours)` if `owner_user_id === session.user.id`, else show owner email if the API returned it — **check API response shape first**).
- Click a row → `router.push(savedViewToHref(view.payload))` + close.
- Empty list → "No saved views".
- Loading state → "Loading…".
- Error state → "Couldn't load views".

### Step 5.1 — inspect `GET /api/views` response shape

Run: `grep -n "listViews\|SavedView\b" apps/web/lib/saved-views-db.ts`

Confirm the shape (`id`, `name`, `kind`, `visibility`, `payload`, `owner_user_id`, ...). If owner email is NOT returned, do NOT fabricate one — just show `(yours)` vs `(shared)`. Decide via comparison to `session.user.id` which the layout already has.

### Step 5.2 — RED

```tsx
// apps/web/test/my-views-dropdown.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MyViewsDropdown } from "@/app/_components/my-views-dropdown";

describe("MyViewsDropdown", () => {
  it("renders a button with data-testid='my-views-toggle'", () => {
    const html = renderToStaticMarkup(<MyViewsDropdown currentUserId="u-1" />);
    expect(html).toMatch(/data-testid="my-views-toggle"/);
  });

  it("dropdown hidden by default (no my-views-panel in initial markup)", () => {
    const html = renderToStaticMarkup(<MyViewsDropdown currentUserId="u-1" />);
    expect(html).not.toMatch(/data-testid="my-views-panel"/);
  });
});
```

(Deeper behavior — fetch, list render, click-to-navigate — is covered by E2E. Keep unit coverage to the static markup contract.)

### Step 5.3 — verify RED, then GREEN

```tsx
// apps/web/app/_components/my-views-dropdown.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { savedViewToHref } from "@/lib/saved-views-url";
import type { ViewPayload, Visibility } from "@/lib/saved-views";

type SavedViewDTO = {
  id: string;
  name: string;
  kind: "path" | "downstream";
  visibility: Visibility;
  payload: ViewPayload;
  owner_user_id: string;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; views: SavedViewDTO[] }
  | { kind: "error" };

export function MyViewsDropdown({ currentUserId }: { currentUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (!open || state.kind !== "idle") return;
    setState({ kind: "loading" });
    fetch("/api/views", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: { views: SavedViewDTO[] }) =>
        setState({ kind: "ok", views: body.views }),
      )
      .catch(() => setState({ kind: "error" }));
  }, [open, state.kind]);

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="my-views-toggle"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
      >
        My views
      </button>
      {open && (
        <div
          data-testid="my-views-panel"
          className="absolute right-0 z-10 mt-1 w-72 rounded-md border border-slate-200 bg-white p-2 text-xs shadow-lg ring-1 ring-slate-100"
        >
          {state.kind === "loading" && <div>Loading…</div>}
          {state.kind === "error" && (
            <div className="text-red-700">Couldn&apos;t load views</div>
          )}
          {state.kind === "ok" && state.views.length === 0 && (
            <div data-testid="my-views-empty" className="text-slate-500">
              No saved views
            </div>
          )}
          {state.kind === "ok" && state.views.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {state.views.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    data-testid="my-views-item"
                    onClick={() => {
                      router.push(savedViewToHref(v.payload));
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-slate-50"
                  >
                    <span className="truncate font-medium text-slate-800">
                      {v.name}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {v.kind} ·{" "}
                      {v.owner_user_id === currentUserId ? "yours" : "shared"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

### Step 5.4 — verify + commit

Run: `pnpm --filter web test my-views-dropdown -- --run` → 2/2 PASS.

```bash
git add apps/web/app/_components/my-views-dropdown.tsx apps/web/test/my-views-dropdown.test.tsx
git commit -m "feat: MyViewsDropdown client component (#12)"
```

---

## Task 6 — Mount `MyViewsDropdown` in header

**Files:**
- Modify: `apps/web/app/layout.tsx`

### Step 6.1 — edit

In the header, inside the logged-in branch (the block that currently renders session pill + LogoutButton), add `<MyViewsDropdown currentUserId={session.user.id} />` BEFORE the `<LogoutButton />`.

Import: `import { MyViewsDropdown } from "./_components/my-views-dropdown";`

### Step 6.2 — typecheck

Run: `pnpm -r typecheck`
Expected: clean.

### Step 6.3 — unit suite

Run: `pnpm --filter web test -- --run`
Expected: all pass.

### Step 6.4 — commit

```bash
git add apps/web/app/layout.tsx
git commit -m "feat: mount MyViewsDropdown in header (#12)"
```

---

## Task 7 — Integration test: dropdown calls the real API

**File:**
- Create: `apps/web/test/saved-views-ui.int.test.ts`

Scope: exercise `GET /api/views` with a seeded view and assert the shape `MyViewsDropdown` consumes (`id`, `name`, `kind`, `visibility`, `payload`, `owner_user_id`). Protects against backend shape drift.

**Pattern to mirror:** `apps/web/test/saved-views.int.test.ts` (already has the full testcontainers harness + session helper). Add one case:

```ts
it("GET /api/views returns fields consumed by MyViewsDropdown", async () => {
  // seed via createView() directly
  // call GET with the session cookie
  // assert view.payload.kind === "path" | "downstream"
  // assert typeof view.owner_user_id === "string"
});
```

### Step 7.1 — RED

Write the case; run `pnpm --filter web test:int saved-views-ui -- --run`.
Expected: test file missing → write it → FAIL only if shape drifts.

### Step 7.2 — GREEN

No production change expected. If the test fails it means the dropdown expects a field the API doesn't return — update the dropdown, NOT the API contract (backend is merged and shipped).

### Step 7.3 — commit

```bash
git add apps/web/test/saved-views-ui.int.test.ts
git commit -m "test: integration — API shape matches MyViewsDropdown (#12)"
```

---

## Task 8 — E2E: operator saves view with `role:viewer`, viewer opens it

**File:**
- Create: `apps/web/e2e/saved-views.spec.ts`

**Fixture:** linear chain `E2E-SV-CUST → E2E-SV-CSG → E2E-SV-UPE → E2E-SV-CORE`, same topology pattern as `path-trace.spec.ts`. Reuse its helpers (`withPg`, `neoDriver`, `loginViaForm`) by copy — **do NOT** extract a shared helper in this PR; that's a separate refactor PR to avoid broadening the diff. Note the existing E2E file as the canonical pattern and leave a one-line comment linking it.

### Step 8.1 — seed block (beforeAll)

- Create two users: `e2e-sv-op@example.com` (role=operator) and `e2e-sv-vw@example.com` (role=viewer), both with bcrypt(12) hashed passwords. Reuse the insert pattern from `path-trace.spec.ts`.
- Seed the 4-device chain into Neo4j: `(:Device {name, role, level})` nodes + `:CONNECTS_TO` edges with canonical direction (lesser→greater level).
- CLEAN UP in `afterAll`: delete users (cascade wipes their `saved_views`), delete the seeded devices. Again — mirror path-trace cleanup exactly.

### Step 8.2 — test body

```ts
test("operator saves with role:viewer → viewer opens and sees same hops", async ({ browser }) => {
  // --- Operator session ---
  const opCtx = await browser.newContext();
  const opPage = await opCtx.newPage();
  await loginViaForm(opPage, OP.email, OP.password);

  await opPage.goto(`/device/${CSG}`);
  // confirm the path rendered
  await expect(opPage.getByTestId("path-view")).toBeVisible();

  // open save panel, fill name, pick role:viewer, submit
  await opPage.getByTestId("save-view-toggle").click();
  await opPage.getByTestId("save-view-name").fill("E2E shared CSG path");
  await opPage.getByTestId("save-view-visibility").selectOption("role:viewer");
  await opPage.getByTestId("save-view-submit").click();
  await expect(opPage.getByTestId("save-view-ok")).toBeVisible();

  // capture operator-side hop names for cross-check
  const opHops = await opPage.getByTestId("path-hop-name").allInnerTexts();
  expect(opHops.length).toBeGreaterThan(0);

  await opCtx.close();

  // --- Viewer session ---
  const vwCtx = await browser.newContext();
  const vwPage = await vwCtx.newPage();
  await loginViaForm(vwPage, VW.email, VW.password);

  // go to any page — header has My Views
  await vwPage.goto("/");
  await vwPage.getByTestId("my-views-toggle").click();
  await vwPage.getByTestId("my-views-panel").waitFor();

  // click the shared view
  const item = vwPage.getByTestId("my-views-item").filter({ hasText: "E2E shared CSG path" });
  await item.click();

  // land on /device/E2E-SV-CSG with the same hops
  await expect(vwPage).toHaveURL(new RegExp(`/device/${CSG}$`));
  await expect(vwPage.getByTestId("path-view")).toBeVisible();
  const vwHops = await vwPage.getByTestId("path-hop-name").allInnerTexts();
  expect(vwHops).toEqual(opHops);

  await vwCtx.close();
});
```

### Step 8.3 — viewer negative case (inline, same spec)

```ts
test("viewer cannot set role:* visibility (option absent)", async ({ page }) => {
  await loginViaForm(page, VW.email, VW.password);
  await page.goto(`/device/${CSG}`);
  await page.getByTestId("save-view-toggle").click();
  const options = await page.getByTestId("save-view-visibility").locator("option").allInnerTexts();
  expect(options).toEqual(["private"]);
});
```

### Step 8.4 — run locally

Bring up compose first (the test expects PLAYWRIGHT_BASE_URL to resolve — default `http://localhost` through Caddy):

```bash
cp .env.example .env              # only if you don't already have one
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
pnpm --filter web build
pnpm --filter web test:e2e saved-views.spec.ts
```

Expected: both tests PASS.

### Step 8.5 — commit

```bash
git add apps/web/e2e/saved-views.spec.ts
git commit -m "test: e2e saved-views share-with-role round trip (#12)"
```

---

## Task 9 — Verification before completion

Before opening the PR, run fresh:

```bash
pnpm -r typecheck                        # must be clean
pnpm --filter web test -- --run          # unit, must be 100% pass
pnpm --filter web test:int -- --run      # integration, must be 100% pass
# E2E only if compose stack is up:
pnpm --filter web test:e2e saved-views.spec.ts
```

Update `docs/plans/issue-12-saved-views.md` (the original plan) by ticking the two remaining backend-AC checkboxes in a short "PR B landing notes" section at the bottom — do NOT rewrite history.

### Commit the doc update

```bash
git add docs/plans/issue-12-saved-views.md
git commit -m "docs: mark saved-views UI + E2E as shipped (#12)"
```

---

## Task 10 — PR

```bash
git push -u origin issue-12-saved-views-ui
gh pr create --title "feat: saved-views UI + E2E (#12)" --body "$(cat <<'EOF'
## Summary
- SaveViewButton client component on path (device + service) and downstream pages
- MyViewsDropdown in the site header; list is fetched lazily on open
- Pure URL-rebuilder helper replays a saved `payload` into the right route
- E2E: operator saves with `role:viewer` visibility → viewer opens and sees identical hops; viewer's visibility picker is hard-limited to `private`

## Closes
Closes #12

## Parent PRD
#1

## Acceptance Criteria Verification
- [x] UI: "Save view" button on path-trace and downstream pages — mounted in device/service/downstream pages
- [x] UI: "My views" dropdown in header — in app/layout.tsx
- [x] Viewers: visibility restricted to `private` only — enforced server-side (PR #25) and mirrored in the picker; E2E `viewer cannot set role:*` proves the option list
- [x] E2E: operator saves → viewer opens → same path — see `saved-views.spec.ts`

## Test Plan
- [ ] `pnpm -r typecheck`
- [ ] `pnpm --filter web test -- --run`
- [ ] `pnpm --filter web test:int -- --run`
- [ ] `pnpm --filter web test:e2e saved-views.spec.ts` (requires compose stack)

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After merge: GitHub auto-closes #12 via `Closes #12`. Remove `in-progress` label manually if still present.

---

## Out of scope (do not build)

- Edit / rename UI for saved views (AC only requires save + open; PATCH exists on the backend if we need it later).
- Delete UI for saved views — server route exists; a "Delete" affordance in the dropdown is a nice-to-have, not an AC item.
- Shared helper extraction across E2E specs — defer to a follow-up refactor PR.
- Per-view "last opened" indicator, sorting, search — YAGNI for MVP.

## Risks

- **Next.js client-component serialization** — `SaveViewButton` takes `payload: ViewPayload`. Zod-inferred types serialize fine; no Date/Map/Set inside. No action required.
- **Cache-busting the dropdown** — the dropdown fetches on open; a user who saves a view and doesn't re-open the panel won't see it immediately. Acceptable for MVP; document in PR.
- **Header presence on login page** — `app/layout.tsx` wraps login too; `MyViewsDropdown` only renders inside the logged-in branch, so this is safe. Verify by visiting `/login` during manual smoke.
- **Dev-HTTP cookies on localhost** — per CLAUDE.md pitfall, cookie flags derive from `NEXTAUTH_URL` scheme. E2E runs against Caddy on HTTP in CI; the same cookies work because we key off URL, not `NODE_ENV`.
