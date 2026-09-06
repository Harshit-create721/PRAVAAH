#!/usr/bin/env bash
# Build the relay locally, ship it to the droplet, and bring it up behind Caddy.
# Idempotent: safe to re-run for every deployment.
set -euo pipefail

HOST="${RELAY_HOST:-root@206.189.135.109}"
REMOTE_DIR=/opt/sih-relay
CADDY_FRAGMENT=/etc/caddy/sites/sih-api.caddy
HERE="$(cd "$(dirname "$0")" && pwd)"

# Tracks whether the fragment has been copied onto the droplet, and whether
# Caddy has successfully reloaded with it. If we exit for any reason with the
# fragment installed but not yet reloaded, the trap below removes it - the
# live Caddyfile does `import /etc/caddy/sites/*.caddy`, so a stray bad
# fragment left on disk is a landmine for the next restart of the caddy
# service (reboot, unattended-upgrades, an unrelated deploy), even though the
# currently-running Caddy process is unaffected.
FRAGMENT_INSTALLED=0
RELOADED=0

cleanup() {
  if [ "$FRAGMENT_INSTALLED" = "1" ] && [ "$RELOADED" != "1" ]; then
    echo "==> cleanup: removing un-activated caddy fragment from droplet"
    ssh "$HOST" "rm -f $CADDY_FRAGMENT" || true
  fi
}
trap cleanup EXIT ERR

echo "==> building image for linux/amd64"
# The droplet is amd64 and a developer Mac is arm64. Without --platform the
# image builds for the wrong architecture and fails at runtime with a confusing
# 'exec format error'.
docker build --platform linux/amd64 -t sih-relay:latest "$HERE/../relay"

echo "==> shipping image"
docker save sih-relay:latest | gzip | ssh "$HOST" 'gunzip | docker load'

echo "==> shipping compose file"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
scp "$HERE/docker-compose.yml" "$HOST:$REMOTE_DIR/docker-compose.yml"

echo "==> starting container"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --force-recreate"

echo "==> waiting for backend readiness"
# Nothing touches Caddy until the container answers on its own. Without this,
# a crash-looping container would still get exposed publicly the moment we
# reload, because the only backend check used to happen AFTER the reload.
ssh "$HOST" '
  for i in $(seq 1 20); do
    if curl -sf http://127.0.0.1:3040/health >/dev/null 2>&1; then
      exit 0
    fi
    sleep 1
  done
  echo "relay backend never became healthy on 127.0.0.1:3040" >&2
  exit 1
'

echo "==> shipping caddy config"
scp "$HERE/sih-api.caddy" "$HOST:$CADDY_FRAGMENT"
FRAGMENT_INSTALLED=1

echo "==> validating caddy BEFORE reload"
# Five production sites share this proxy. A bad fragment must be caught here,
# not by discovering the whole box stopped serving - and it must not survive
# on disk for some future restart to trip over.
if ! ssh "$HOST" 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1'; then
  echo "caddy config INVALID - removing fragment and aborting"
  ssh "$HOST" "rm -f $CADDY_FRAGMENT"
  exit 1
fi

ssh "$HOST" 'systemctl reload caddy'
RELOADED=1

echo "==> verifying"
sleep 3
ssh "$HOST" 'curl -sf http://127.0.0.1:3040/health' && echo
curl -sf https://api.sih.shubhang.dev/health && echo
echo "==> deployed"
