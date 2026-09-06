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

# Nothing below can work if a previous run is still holding :1883 or the ports.
pkill -f "node server/index.js"      2>/dev/null
pkill -f "node tools/serial-bridge"  2>/dev/null
sleep 1

PIDS=()
cleanup() {
  echo ""
  echo "  stopping..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  echo "  stopped."
}
trap cleanup INT TERM EXIT

echo ""
echo "  PRAVAAH"
echo "  ---------------------------------------------------------"

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
    echo "  no USB serial ports found - the bridge would have nothing to read."
    echo "  Plug the ESP32 nodes in and restart, or use --no-bridge."
  else
    echo "  bridging $PORTS USB port(s)"
    node tools/serial-bridge.js &
    PIDS+=($!)
  fi
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
