# S10 — Caddy TLS + deploy hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship Caddy as a reverse proxy with auto-TLS so the stack is safe over the internal LAN and over the public internet, with auth cookies correctly emitting `Secure` and security headers hardened. Mode chosen for this deploy: **(c) public Let's Encrypt via ACME HTTP-01**. Modes (a) LAN-internal-CA and (b) Tailscale are implemented too so a future operator can flip `CADDY_TLS_MODE` without code changes.

**Architecture:** One Caddy service, four mode-specific Caddyfiles under `caddy/`. Caddy's entrypoint symlinks `Caddyfile.${CADDY_TLS_MODE}` → `/etc/caddy/Caddyfile` at container start. `docker-compose.yml` publishes **only** Caddy on `:80` and `:443` (neo4j/web/postgres stay on the compose network). Auth cookies already derive `Secure` + `__Secure-` prefix from `NEXTAUTH_URL` scheme (`apps/web/lib/session-cookie.ts:12-15`) — switching to HTTPS `NEXTAUTH_URL` is sufficient. CI keeps a 4th `http` mode (current plain-HTTP behavior) so `pnpm --filter web test:e2e` inside Docker Compose still works.

**Tech Stack:** Caddy 2.8, Docker Compose, Next.js 14, Playwright, pnpm workspaces.

**Scope boundaries (read before starting):**
- This PR delivers the **ACME** mode end-to-end plus all three other modes wired. It does **not** provision a real domain or DNS — the operator fills `CADDY_DOMAIN` + `CADDY_ACME_EMAIL` in `.env` at deploy time.
- Acceptance criterion "Smoke test from a second host" is a **documented manual step** (README) — we cannot automate cross-host probes in CI. Call this out explicitly in the PR description.
- The HSTS header is only emitted on HTTPS modes; on the `http` CI mode it must stay off (HSTS over HTTP is silently ignored but still misleading).

**Files touched (final inventory):**
- Create: `docs/decisions/0003-tls-deployment-mode.md`
- Create: `caddy/Caddyfile.http` (renamed from current `caddy/Caddyfile`, used by CI + dev)
- Create: `caddy/Caddyfile.internal`
- Create: `caddy/Caddyfile.tailscale`
- Create: `caddy/Caddyfile.acme`
- Create: `caddy/snippets/security-headers.caddy` (shared HSTS/CSP/X-Frame-Options)
- Create: `caddy/entrypoint.sh`
- Delete: `caddy/Caddyfile` (replaced by `Caddyfile.http`)
- Modify: `docker-compose.yml` (add `443:443`, env vars, entrypoint, healthcheck)
- Modify: `docker-compose.ci.yml` (pin `CADDY_TLS_MODE=http` so smoke tests don't try TLS)
- Modify: `.env.example` (document `CADDY_TLS_MODE`, add `CADDY_ACME_EMAIL`)
- Modify: `README.md` (new **Deployment** section)
- Modify: `apps/web/playwright.config.ts` (accept self-signed certs when `PLAYWRIGHT_BASE_URL` is HTTPS)

---

### Task 1: ADR for TLS mode decision

**Files:**
- Create: `docs/decisions/0003-tls-deployment-mode.md`

**Step 1: Write ADR**

Write `0003-tls-deployment-mode.md` following the shape of `0001-auth-stack.md` / `0002-graph-viz-library.md`. Required sections: *Status* (Accepted, 2026-04-23), *Context* (three candidate modes + tradeoffs), *Decision* (ACME for this deployment, but all three modes shipped as selectable), *Consequences* (port 80 must be reachable for HTTP-01; cert rotation is automatic; downgrading to `internal` is a one-env-var flip).

**Step 2: Commit**

```bash
git add docs/decisions/0003-tls-deployment-mode.md
git commit -m "docs: ADR 0003 — TLS deployment mode (ACME default) (#11)"
```

---

### Task 2: Extract shared security-header snippet

**Files:**
- Create: `caddy/snippets/security-headers.caddy`

**Step 1: Write snippet**

```caddy
# HSTS + CSP + baseline hardening. Imported by every HTTPS Caddyfile.
# CSP is intentionally permissive for inline styles — Next.js ships many
# inline <style> tags for CSS-in-JS. Tighten once a nonce pipeline lands.
header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Content-Security-Policy "default-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    X-Frame-Options "DENY"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
}
```

**Step 2: Commit**

```bash
git add caddy/snippets/security-headers.caddy
git commit -m "feat(caddy): shared security-header snippet (HSTS + CSP) (#11)"
```

---

### Task 3: Rename existing Caddyfile → `Caddyfile.http` (CI fallback)

**Files:**
- Create: `caddy/Caddyfile.http`
- Delete: `caddy/Caddyfile`

**Step 1: `git mv`**

```bash
git mv caddy/Caddyfile caddy/Caddyfile.http
```

**Step 2: Leave content unchanged except a header comment update**

Update line 1 comment: `# Plain HTTP mode. Used by CI smoke tests and local dev where no cert is available.`

Do **not** add HSTS here (HSTS over HTTP is a misconfiguration).

**Step 3: Commit**

```bash
git add caddy/Caddyfile.http
git commit -m "refactor(caddy): rename Caddyfile to Caddyfile.http for mode selection (#11)"
```

---

### Task 4: `Caddyfile.internal` — LAN with Caddy's internal CA

**Files:**
- Create: `caddy/Caddyfile.internal`

**Step 1: Write it**

```caddy
# LAN mode: Caddy's internal CA issues a cert for $CADDY_DOMAIN.
# Operator installs the Caddy root CA on each client (README step).
{
    admin off
}

{$CADDY_DOMAIN} {
    tls internal

    encode zstd gzip
    import /etc/caddy/snippets/security-headers.caddy

    reverse_proxy web:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

**Step 2: Commit**

```bash
git add caddy/Caddyfile.internal
git commit -m "feat(caddy): internal-CA TLS mode for LAN deploys (#11)"
```

---

### Task 5: `Caddyfile.tailscale` — Tailscale HTTPS

**Files:**
- Create: `caddy/Caddyfile.tailscale`

**Step 1: Write it**

```caddy
# Tailscale mode: cert sourced from tailscaled via `tls` directive's
# get_certificate tailscale. Requires the host's Tailscale daemon to be
# reachable from inside the Caddy container — see README.
{
    admin off
}

{$CADDY_DOMAIN} {
    tls {
        get_certificate tailscale
    }

    encode zstd gzip
    import /etc/caddy/snippets/security-headers.caddy

    reverse_proxy web:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

**Step 2: Commit**

```bash
git add caddy/Caddyfile.tailscale
git commit -m "feat(caddy): Tailscale HTTPS mode (#11)"
```

---

### Task 6: `Caddyfile.acme` — Let's Encrypt

**Files:**
- Create: `caddy/Caddyfile.acme`

**Step 1: Write it**

```caddy
# Public mode: Let's Encrypt via HTTP-01. Port 80 must be reachable from
# the public internet for the challenge, and port 443 must be open for
# normal traffic. Caddy handles renewal automatically.
{
    admin off
    email {$CADDY_ACME_EMAIL}
}

{$CADDY_DOMAIN} {
    encode zstd gzip
    import /etc/caddy/snippets/security-headers.caddy

    reverse_proxy web:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

**Step 2: Commit**

```bash
git add caddy/Caddyfile.acme
git commit -m "feat(caddy): ACME (Let's Encrypt) TLS mode (#11)"
```

---

### Task 7: Entrypoint script that selects mode

**Files:**
- Create: `caddy/entrypoint.sh`

**Step 1: Write entrypoint**

```sh
#!/bin/sh
# Select Caddyfile based on CADDY_TLS_MODE. Fail fast on unknown modes.
set -eu

MODE="${CADDY_TLS_MODE:-http}"
SRC="/etc/caddy/Caddyfile.${MODE}"

if [ ! -f "$SRC" ]; then
    echo "caddy entrypoint: unknown CADDY_TLS_MODE='${MODE}' (no ${SRC})" >&2
    echo "valid modes: http | internal | tailscale | acme" >&2
    exit 1
fi

exec caddy run --config "$SRC" --adapter caddyfile
```

**Step 2: Make executable**

```bash
chmod +x caddy/entrypoint.sh
```

**Step 3: Commit**

```bash
git add caddy/entrypoint.sh
git commit -m "feat(caddy): entrypoint script selecting Caddyfile by CADDY_TLS_MODE (#11)"
```

---

### Task 8: Wire Caddy service in `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml` (caddy service block + volumes)

**Step 1: Update `caddy` service**

Replace the `caddy` block with:

```yaml
  caddy:
    image: caddy:2.8-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      CADDY_TLS_MODE: ${CADDY_TLS_MODE:-http}
      CADDY_DOMAIN: ${CADDY_DOMAIN:-localhost}
      CADDY_ACME_EMAIL: ${CADDY_ACME_EMAIL:-}
    volumes:
      - ./caddy:/etc/caddy:ro
      - caddy-data:/data
      - caddy-config:/config
    entrypoint: ["/etc/caddy/entrypoint.sh"]
    depends_on:
      web:
        condition: service_healthy
    healthcheck:
      # Probe through the front door. In http mode this is plain HTTP; in
      # HTTPS modes we accept any cert (including internal CA) with -k.
      test: ["CMD-SHELL", "wget --quiet --tries=1 --no-check-certificate --spider http://localhost/api/health || wget --quiet --tries=1 --no-check-certificate --spider https://localhost/api/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
```

**Step 2: Verify compose file still parses**

```bash
docker compose config --quiet
```

Expected: no output (success).

**Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(compose): publish 443, inject CADDY_TLS_MODE, use entrypoint (#11)"
```

---

### Task 9: Pin CI overlay to `http` mode

**Files:**
- Modify: `docker-compose.ci.yml`

**Step 1: Read existing overlay**

```bash
cat docker-compose.ci.yml
```

**Step 2: Add `caddy` service override**

Append (or extend existing `caddy` block):

```yaml
  caddy:
    environment:
      CADDY_TLS_MODE: http
```

Reason: CI / Playwright run HTTP-only; ACME would try to register against Let's Encrypt staging and fail with no public DNS.

**Step 3: Verify**

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml config --quiet
```

**Step 4: Commit**

```bash
git add docker-compose.ci.yml
git commit -m "ci(compose): pin caddy to http mode in CI overlay (#11)"
```

---

### Task 10: `.env.example` — document modes + add ACME email

**Files:**
- Modify: `.env.example`

**Step 1: Replace the existing Caddy block**

Replace lines starting at `# --- Caddy (auto-TLS reverse proxy) ---` with:

```
# --- Caddy (reverse proxy + TLS) ---
# Mode selects which Caddyfile is active at container start.
#   http      — plain :80 (dev, CI smoke tests). No TLS, no HSTS.
#   internal  — Caddy's internal CA. LAN deploys; install Caddy root CA on clients.
#   tailscale — cert sourced from the host's Tailscale daemon.
#   acme      — Let's Encrypt via HTTP-01. Requires public DNS and open :80/:443.
CADDY_TLS_MODE=acme

# Fully-qualified host the stack is reachable at. MUST match NEXTAUTH_URL host.
CADDY_DOMAIN=ts-mapping.example.com

# Contact email for Let's Encrypt registration + expiry warnings. Required for acme mode.
CADDY_ACME_EMAIL=ops@example.com
```

**Step 2: Ensure `NEXTAUTH_URL` example above uses `https://`**

Confirm `NEXTAUTH_URL=https://ts-mapping.example.com` (or similar). If still `.local`, update.

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document CADDY_TLS_MODE modes + CADDY_ACME_EMAIL (#11)"
```

---

### Task 11: README — Deployment section

**Files:**
- Modify: `README.md`

**Step 1: Add "Deployment" section after existing Quick Start**

Sections to include:
1. **Pick a TLS mode** — table mapping the 4 modes to network assumption + cert source.
2. **Mode (a) internal CA** — `CADDY_TLS_MODE=internal`, `CADDY_DOMAIN=ts-mapping.lan`, note about copying `data/caddy/pki/authorities/local/root.crt` from the volume and installing on each client. Explain `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./root.crt`.
3. **Mode (b) Tailscale** — prerequisites (Tailscale daemon on host, MagicDNS on, HTTPS feature enabled in admin console), note mounting the tailscaled socket is not required when using `get_certificate tailscale` over the Tailscale node, but is if using the funnel form; point to Tailscale docs.
4. **Mode (c) ACME / Let's Encrypt** — DNS A/AAAA must point to host, ports 80 + 443 open, set `CADDY_ACME_EMAIL`. Rate limits note (5 certs/week for staging escape).
5. **Cert rotation** — all three modes auto-renew; rotation is deleting `caddy-data` volume to force a fresh issuance.
6. **Tailscale auth rotation** — reissue host auth key from Tailscale admin; restart host daemon.
7. **Second-host smoke test (manual)** — `curl -I https://${CADDY_DOMAIN}/api/health` from a separate LAN / Tailscale / public host; expect `200` + `Strict-Transport-Security` header.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: deployment section covering all 4 TLS modes + cert rotation (#11)"
```

---

### Task 12: Playwright — accept self-signed cert over HTTPS

**Files:**
- Modify: `apps/web/playwright.config.ts`

**Step 1: Read config**

```bash
sed -n '1,80p' apps/web/playwright.config.ts
```

**Step 2: In the `use` block, add**

```ts
ignoreHTTPSErrors: true,
```

Reason: when run against `internal` mode in a future self-hosted CI, Playwright would reject Caddy's internal CA cert. `http` mode CI is unaffected.

**Step 3: Confirm `baseURL` reads from `PLAYWRIGHT_BASE_URL` env (likely already does)**

If hardcoded, change to `process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost"`.

**Step 4: Commit**

```bash
git add apps/web/playwright.config.ts
git commit -m "test(e2e): ignoreHTTPSErrors so Playwright works against internal CA (#11)"
```

---

### Task 13: Smoke-verify the CI path still works

**Files:** none (verification only)

**Step 1: Bring up the CI overlay**

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
```

Expected: all services reach `healthy`, caddy healthcheck passes over HTTP.

**Step 2: Hit the health endpoint through Caddy**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost/api/health
```

Expected: `200`.

**Step 3: Confirm hardening headers land**

```bash
curl -sS -I http://localhost/api/health | grep -iE "x-frame-options|x-content-type-options|referrer-policy"
```

Expected: all three present. HSTS should be **absent** (http mode).

**Step 4: Tear down**

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

**Step 5: No commit** (verification task).

---

### Task 14: Smoke-verify `internal` mode locally

**Files:** none (verification only)

**Step 1: Write a local `.env.internal.test`**

```
CADDY_TLS_MODE=internal
CADDY_DOMAIN=localhost
NEXTAUTH_URL=https://localhost
# … plus the usual secrets
```

**Step 2: Bring up**

```bash
docker compose --env-file .env.internal.test up -d --wait
```

**Step 3: Curl with `-k`**

```bash
curl -skI https://localhost/api/health | head -20
```

Expected: `200`, `strict-transport-security`, `content-security-policy`, `x-frame-options: DENY`.

**Step 4: Confirm neo4j/web/postgres are not exposed on host**

```bash
ss -tlnp 2>/dev/null | grep -E ":(3000|5432|7474|7687)" || echo "OK — not exposed"
```

Expected: `OK — not exposed` (only Caddy on 80/443).

**Step 5: Tear down + delete `.env.internal.test`**

```bash
docker compose down -v
rm .env.internal.test
```

**Step 6: No commit** (verification task).

---

### Task 15: Run integration + E2E suites to catch regressions

**Files:** none (verification only)

**Step 1: Typecheck workspace**

```bash
pnpm -r typecheck
```

Expected: no errors.

**Step 2: Run web integration tests**

```bash
pnpm --filter web test:int
```

Expected: green.

**Step 3: Run Playwright E2E against the CI-overlay stack**

```bash
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
PLAYWRIGHT_BASE_URL=http://localhost pnpm --filter web test:e2e
docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

Expected: all specs pass.

**Step 4: If any failures → STOP, do not proceed to PR.** Debug with `superpowers:systematic-debugging`.

---

### Task 16: Open PR + close issue

**Files:** none.

Follow `/issues-to-complete` Phase 6. PR title: `feat: Caddy TLS + deploy hardening — 4 modes, ACME default (#11)`. Body must:
- Enumerate each acceptance-criteria checkbox with its verification method (test name / manual step).
- Call out the manual "second-host smoke test" as documented-not-automated.
- List the 4 modes + which one is the deploy default.
