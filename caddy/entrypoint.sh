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

# Symlink into the default Caddy config path so `caddy run` picks it up.
ln -sf "$SRC" /etc/caddy/Caddyfile
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
