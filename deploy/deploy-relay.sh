#!/usr/bin/env bash
# Build the relay locally, ship it to the droplet, and bring it up behind Caddy.
# Idempotent: safe to re-run for every deployment.
set -euo pipefail

HOST="${RELAY_HOST:-root@206.189.135.109}"
REMOTE_DIR=/opt/sih-relay
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> building image for linux/amd64"
# The droplet is amd64 and a developer Mac is arm64. Without --platform the
# image builds for the wrong architecture and fails at runtime with a confusing
# 'exec format error'.
docker build --platform linux/amd64 -t sih-relay:latest "$HERE/../relay"

echo "==> shipping image"
docker save sih-relay:latest | gzip | ssh "$HOST" 'gunzip | docker load'

echo "==> shipping compose and caddy config"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
scp "$HERE/docker-compose.yml" "$HOST:$REMOTE_DIR/docker-compose.yml"
scp "$HERE/sih-api.caddy" "$HOST:/etc/caddy/sites/sih-api.caddy"

echo "==> starting container"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --force-recreate"

echo "==> validating caddy BEFORE reload"
# Five production sites share this proxy. A bad fragment must be caught here,
# not by discovering the whole box stopped serving.
ssh "$HOST" 'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1' \
  || { echo "caddy config INVALID - not reloading"; exit 1; }
ssh "$HOST" 'systemctl reload caddy'

echo "==> verifying"
sleep 3
ssh "$HOST" 'curl -sf http://127.0.0.1:3040/health' && echo
curl -sf https://api.sih.shubhang.dev/health && echo
echo "==> deployed"
