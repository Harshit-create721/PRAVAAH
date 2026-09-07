#!/usr/bin/env bash
# ============================================================================
# PRAVAAH - one-command launch for the USB-serial demo (macOS / Linux).
#
# Starts BOTH halves and holds them together:
#   1. the gateway  - MQTT broker, rules, database, dashboard on :8811
#   2. the bridge   - reads the ESP32 nodes over USB and republishes to MQTT
#
# start-beltguard.bat is the Windows launcher and starts only the gateway,
# because it predates the serial transport and assumes the nodes reach the
# broker over WiFi. This script is for the case where there is no usable WiFi
# and the nodes are on USB cables.
#
#   ./start-pravaah.sh              start everything, open the dashboard
#   ./start-pravaah.sh --no-open    don't open a browser
#   ./start-pravaah.sh --no-bridge  gateway only (nodes publish over WiFi)
#
# Ctrl+C stops both cleanly.
# ============================================================================
set -u
cd "$(dirname "$0")"

OPEN=1; BRIDGE=1
for a in "$@"; do
  case "$a" in
    --no-open)   OPEN=0 ;;
    --no-bridge) BRIDGE=0 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "  node is not installed - https://nodejs.org"; exit 1; }
MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$MAJOR" -ge 22 ] || { echo "  node $MAJOR is too old; this needs 22.5+"; exit 1; }

[ -d node_modules ] || { echo "  first run - installing dependencies..."; npm install --silent || exit 1; }

# The relay credentials live in a gitignored deploy/.env. Without them the
# gateway still serves the local dashboard perfectly well - it just cannot
# publish to api.sih.shubhang.dev, which is a confusing way to find out.
if [ -f deploy/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./deploy/.env
  set +a
fi

# Single instance. Killing stray `node` processes is not enough: another copy of
# THIS script would still be running its own supervision loop and would simply
# start a replacement gateway and bridge, leaving two of each fighting over the
# MQTT port and the USB ports. That failure looks like "0/3 live" with a bridge
# logging "Cannot lock port" forever, which is a miserable thing to debug.
LOCK_FILE="${TMPDIR:-/tmp}/pravaah-start.pid"
if [ -f "$LOCK_FILE" ]; then
  OTHER=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$OTHER" ] && [ "$OTHER" != "$$" ] && kill -0 "$OTHER" 2>/dev/null; then
    echo "  another PRAVAAH launcher is running (pid $OTHER) - stopping it first"
    # Kill its children too; the launcher's own trap may not fire in time.
    pkill -P "$OTHER" 2>/dev/null || true
    kill "$OTHER" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$OTHER" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$OTHER" 2>/dev/null || true
  fi
fi
echo $$ > "$LOCK_FILE"

# Nothing below can work if a previous run is still holding :1883 or the ports.
# pkill returns before the process has actually exited, and the next start then
# races it for the MQTT port - so wait for them to really be gone.
pkill -f "node server/index.js"      2>/dev/null || true
pkill -f "node tools/serial-bridge"  2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -f "node server/index.js" >/dev/null 2>&1 || pgrep -f "node tools/serial-bridge" >/dev/null 2>&1 || break
  sleep 0.25
done

PIDS=()
cleanup() {
  echo ""
  echo "  stopping..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  # Only clear the lock if it is still ours. A newer launcher that displaced us
  # has already written its own pid, and deleting that would defeat the guard.
  if [ -f "$LOCK_FILE" ] && [ "$(cat "$LOCK_FILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$LOCK_FILE"
  fi
  echo "  stopped."
}
trap cleanup INT TERM EXIT

echo ""
echo "  PRAVAAH"
echo "  ---------------------------------------------------------"
if [ -n "${RELAY_PUBLISH_SECRET:-}" ]; then
  echo "  relay      publishing to api.sih.shubhang.dev"
else
  echo "  relay      local only (no RELAY_PUBLISH_SECRET; see deploy/.env.example)"
fi

node server/index.js &
PIDS+=($!)

# Wait for the dashboard to answer before opening a browser at it, rather than
# sleeping a fixed guess and hoping.
for _ in $(seq 1 40); do
  curl -sf -o /dev/null http://localhost:8811/ && break
  sleep 0.25
done

if [ "$BRIDGE" -eq 1 ]; then
  PORTS=$(ls /dev/cu.usbserial* /dev/cu.usbmodem* /dev/cu.SLAB_USBtoUART* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PORTS" = "0" ]; then
    echo "  no USB serial ports found - the bridge will wait for sensor connections."
  else
    echo "  bridging $PORTS USB port(s):"
    ls /dev/cu.usbserial* /dev/cu.usbmodem* /dev/cu.SLAB_USBtoUART* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null \
      | sed 's|^|               |'
    [ "$PORTS" -lt 3 ] && echo "               (expecting 3 nodes - thermal, vibration, marker)"
  fi
  node tools/serial-bridge.js &
  PIDS+=($!)
fi

# A node needs a few frames before the gateway calls it live. Report what is
# actually up rather than leaving the dashboard to be read as broken.
if [ "$BRIDGE" -eq 1 ] && [ "${PORTS:-0}" != "0" ]; then
  echo ""
  echo "  waiting for nodes..."
  sleep 6
  node -e '
    fetch("http://localhost:8811/api/state")
      .then((r) => r.json())
      .then((d) => {
        const nodes = d.nodes ?? [];
        const live = nodes.filter((n) => n.state === "live");
        console.log(`  nodes      ${live.length}/${nodes.length || 3} live`);
        for (const n of nodes) console.log(`               ${n.state.padEnd(8)} ${n.node}`);
        if (!nodes.length) console.log("               none yet - is anything plugged in and flashed?");
      })
      .catch(() => console.log("  nodes      could not read /api/state"));
  ' 2>/dev/null || true
fi

if [ "$OPEN" -eq 1 ]; then
  (command -v open >/dev/null && open http://localhost:8811) \
    || (command -v xdg-open >/dev/null && xdg-open http://localhost:8811) \
    || true
fi

echo "  dashboard  http://localhost:8811"
echo "  Ctrl+C to stop"
echo ""
wait
