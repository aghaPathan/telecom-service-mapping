# ADR 0003 — TLS deployment mode

- **Status:** Accepted
- **Date:** 2026-04-23
- **Issue:** [#11](https://github.com/aghaPathan/telecom-service-mapping/issues/11)

## Context

Slice S10 ships Caddy as the single ingress in front of the stack, so the
question is how Caddy obtains a TLS certificate. The deploy target for this
iteration is a home-server box that can be reached three different ways
depending on how the operator wires the LAN: directly on the public
internet (port-forwarded through the edge router), over a Tailscale tailnet,
or purely on the internal LAN with no public exposure. Each path has a
distinct certificate story.

Three candidate modes were considered:

- **(a) LAN internal CA.** Caddy mints its own root CA on first run and
  issues short-lived leaf certs for `$CADDY_DOMAIN` from it. No external
  dependencies, works offline, handles any hostname (including `*.lan` and
  bare hostnames). The cost is trust distribution: every client that needs
  to hit the stack has to install the Caddy root CA manually, and that root
  lives inside the `caddy-data` volume — re-creating the volume rotates the
  CA and invalidates every installed trust anchor.
- **(b) Tailscale HTTPS.** Caddy asks `tailscaled` for a cert via the
  `get_certificate tailscale` directive. The cert chains to Tailscale's
  public CA so every tailnet member trusts it out of the box. Requires
  Tailscale membership (only tailnet clients can reach the stack), MagicDNS
  enabled, and the HTTPS feature toggled on in the Tailscale admin console.
  Rotation is automatic; losing tailnet access means losing access to the
  app.
- **(c) Let's Encrypt ACME.** Caddy registers with Let's Encrypt and
  completes the HTTP-01 challenge on first boot, then auto-renews every
  ~60 days. Requires a publicly-resolvable DNS A/AAAA record for
  `$CADDY_DOMAIN`, port 80 open to the public internet for the challenge,
  and port 443 open for normal traffic. Certs chain to a publicly-trusted
  root, so any browser accepts them with no client-side setup. Free but
  subject to Let's Encrypt rate limits (5 duplicate certs / week) and
  revocation / outage risk from a third party.

## Decision

- **Deploy default:** ACME / Let's Encrypt (mode **(c)**). The home-server
  box already has a public DNS record and forwards 80/443, and we want
  operators to hit the stack from arbitrary laptops and phones without
  pre-installing a root CA.
- **All four modes ship.** `CADDY_TLS_MODE` selects which `Caddyfile.*` the
  entrypoint symlinks into `/etc/caddy/Caddyfile`. Modes **(a)** and
  **(b)** are fully wired so a future operator can flip one env var to
  switch networks without code changes.
- **A fourth `http` mode is retained** for CI smoke tests and local dev
  where no TLS is possible (no public DNS, no Tailscale, no local CA trust
  installed). HSTS is deliberately omitted from this mode — HSTS over HTTP
  is ignored by browsers but would be misleading in headers.

## Consequences

- Port 80 must remain publicly reachable on the deploy host for the
  HTTP-01 challenge, both on first issuance and on every renewal. If the
  edge router closes 80, renewal silently fails and the cert expires after
  ~60 days.
- Cert rotation is automatic in all three TLS modes; forcing a fresh
  issuance means deleting the `caddy-data` volume.
- Downgrading to `internal` is a one-env-var flip (`CADDY_TLS_MODE=internal`
  + redeploy). Clients then need the Caddy root CA installed; the README
  documents the `docker compose cp` recipe to extract it from the volume.
- Switching to `tailscale` is likewise one env var, conditional on the
  host's Tailscale daemon being reachable from inside the Caddy container.
- CI stays on `http` via the `docker-compose.ci.yml` overlay so Playwright
  tests don't try to register against Let's Encrypt or trust a
  volume-scoped CA that changes per run.
- Because all four Caddyfiles `import` the same
  `snippets/security-headers.caddy`, HSTS / CSP / framing / MIME-sniffing
  policy drifts together across modes; the `http` Caddyfile is the only
  one that omits the snippet (no HSTS over HTTP).

## Rejected alternatives

- **DNS-01 instead of HTTP-01 for ACME.** Would remove the "port 80 must
  be open" constraint but requires storing DNS-provider API credentials
  inside Caddy, and our DNS is parked at a provider without a stable
  Caddy module. Revisit if the edge router ever has to close 80.
- **Cloudflare tunnel + Cloudflare Origin CA.** Shifts the ingress outside
  Caddy entirely. Adds an external dependency and a second TLS termination
  point; out of scope for a home-server deploy.
- **Always-on `internal` mode for every deploy.** Simpler, no public
  exposure, but the root-CA install friction on every client (phones
  especially) makes routine operator access painful. Acceptable as a
  fallback, not as the default.

## Non-decisions (explicitly deferred)

- **mTLS for admin endpoints.** No client-cert gate in front of
  `/admin/*`; RBAC is enforced at the app layer. Revisit if a future
  threat model requires it.
- **Per-route CSP tightening.** The shared snippet uses one permissive
  CSP for all paths. A nonce pipeline for inline styles would let us drop
  `'unsafe-inline'`; deferred until the Next.js nonce story is less
  painful.
- **OCSP stapling toggles.** Caddy enables stapling by default; we have
  not tuned it per mode.
