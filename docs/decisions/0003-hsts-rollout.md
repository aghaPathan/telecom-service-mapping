# ADR 0003 — HSTS and CSP posture

- **Status:** Accepted
- **Date:** 2026-04-24
- **Issue:** [#62](https://github.com/aghaPathan/telecom-service-mapping/issues/62)

## Context

The public-internet Caddyfile (`caddy/Caddyfile.acme`) imports
`caddy/snippets/security-headers.caddy`, which already emits HSTS, CSP, and
the rest of the baseline hardening headers on every HTTPS response. Slice 5
ops hardening revisited the posture rather than introducing it from zero.

HSTS is irreversible from the browser's perspective for `max-age` seconds:
once a browser pins the host, serving HTTP will be refused until the pin
expires. That makes the rollout of HSTS high-stakes — a misconfigured proxy
during the pinning window locks out every user whose browser saw the
header.

## Decision

1. **HSTS:** keep the current `max-age=31536000; includeSubDomains`. The
   app has been serving this value from `snippets/security-headers.caddy`
   since the Caddy snippet landed, Caddy auto-renews via ACME, and the home-
   server LAN routing has been stable through slice 4. We do not enable
   `preload` in this slice; preload requires committing to the HSTS preload
   list submission flow, which is a separate decision.
2. **CSP:** keep the current stricter-than-default directive:
   `default-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org;
   style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self';
   frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. Notable:
   `script-src 'self'` (no `'unsafe-inline'`). Inline styles are allowed only
   because Next.js ships inline `<style>` for CSS-in-JS; tighten once a
   per-request nonce pipeline lands.
3. **Supporting headers** (unchanged, documented here for the audit trail):
   `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(),
   microphone=(), geolocation=()`.
4. **Internal / LAN-only Caddyfiles** (`Caddyfile.http`, `Caddyfile.internal`,
   `Caddyfile.tailscale`) do **not** emit HSTS — those listeners can serve
   HTTP for CI smoke / internal-LAN use, and `Secure` / HSTS would lock the
   browser out. The `NEXTAUTH_URL`-scheme trick in `lib/session-cookie.ts`
   mirrors this split.

## Alternatives considered

- **Downgrade HSTS to `max-age=300` for a rollout period.** Rejected: the
  snippet has been in production since it landed; downgrading now would
  shorten the protection window without any corresponding safety gain.
- **Add `preload` to the HSTS header.** Rejected for this slice: preload
  submission is a separate operational commitment and needs its own
  sign-off. Revisit in a follow-up.
- **Re-enable `'unsafe-inline'` for `script-src`.** Rejected: the current
  stricter posture hasn't caused user-visible breakage; loosening it would
  be a regression.

## Consequences

- Browsers that have already received the header will refuse HTTP for
  `max-age` seconds. A misroute must be fixed inside that window or users
  will be locked out until the pin expires.
- Inline `<style>` remains allowed; inline `<script>` does not. New features
  introducing inline scripts must either move to a separate file or plumb a
  per-request nonce (see future work below).
- The LAN-only Caddyfiles are intentionally weaker. Do not copy headers
  from `Caddyfile.acme` into them without first checking that the listener
  actually terminates TLS.

## Rollback

Irreversibility caveat: you cannot "un-send" HSTS from a browser that saw
it. The rollback is "stop sending new HSTS headers so eventually-new
browsers don't re-pin":

1. Set `Strict-Transport-Security "max-age=0"` in
   `snippets/security-headers.caddy`. Browsers that re-fetch after the
   change will clear their pin.
2. Wait until the previous `max-age` elapses for the affected user
   population (one year is long; in an incident, contact users directly
   rather than wait).
3. Remove the header once confident no client is still pinned.

## Future work (out of scope)

- Per-request CSP nonce for `script-src` to remove the remaining
  `'unsafe-inline'` on styles.
- HSTS preload list submission.
- Subresource Integrity (SRI) on any third-party `<script>` or `<link>` if
  we ever add one.
