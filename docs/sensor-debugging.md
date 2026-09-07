# Live sensor debugging — 6 September 2026

**Current USB campaign firmware: 0.2.2 on all three boards.** Temperature,
vibration/acceleration and Hall speed are reaching the gateway. A later dataset
pilot uncovered and fixed a long-LOW Hall timestamp artefact; see the final
verification below. Intermittent ADXL read errors and laptop arrival gaps still
require dataset quality filtering. No mechanical healthy/fault baseline has
been independently labelled.

Continue with the [collection plan](dataset-collection-plan.md),
[recording guide](conveyor-recording.md) and [data dictionary](dataset-schema.md).

The operator initially reported the belt running, then confirmed a stop/restart
during debugging. Exact transition times are unknown; the captures contain
mixed operating states. The firmware was compiled with
ESP32 core 3.3.11 and flashed to all three boards; uploads verified flash hashes.
This is a measurement/debugging run, not an inspected healthy-machine baseline.
The initial fixes used USB firmware `pravaah-serial-node 0.2.1`; the later
dataset check below upgraded it to 0.2.2. WiFi firmware is unchanged.

## What failed and what changed

- **Hall speed:** half-second pulse counting quantized speed in approximately
  120 RPM steps for one magnet. A 30-second baseline capture reported 0–2880 RPM,
  including 27 zero frames out of 60, and 617 alleged joint passes. Most of the
  fast intervals were approximately 20 ms. Firmware now requires stable HIGH
  and LOW input phases of at least 2 ms and computes RPM from inter-pass time.
  The first pulse has no period, so it produces no RPM. Acquisition allows
  up to 60 seconds between the first two passes to support slow belt cycles.
  Once measured, timeout is three periods
  (minimum 5 seconds, maximum 60 seconds). In 0.2.1 a late pulse reduced the speed
  estimate; 0.2.2 replaces that behaviour as explained below.
  After timeout, another two passes are needed to measure a new period. Timer
  wraparound is covered by the native C++ tests. Version 0.2.1 queues GPIO
  transitions in the interrupt handler and validates complete pulse widths,
  so a pulse is retained even if it occurs during telemetry transmission.
- **Hall signal during the early capture:** a direct 25-second edge capture
  mostly showed glitches too short for the ISR to see LOW, with one 23.735 ms LOW
  pulse. The subsequent filtered capture had 110 raw edges and only one accepted
  pulse by its last frame. The later operator correction means this early
  capture alone cannot establish a mounting fault. A later recording contains
  eight clean periods of 2.833–2.850 seconds, yielding 21.05–21.18 cycles/minute
  with one magnet. After the operator reported another restart, the next
  30-second check again had no qualified passes (raw edges 232→238).
  Confirm the LED behaviour against actual magnet passes before concluding
  there is a physical fault.
  Check that the indicator changes at each physical magnet passage, the gap and
  magnet orientation, and secure the GPIO27/ground connections. The documented
  A3144 supply is currently 3.3 V, below the original part's specified minimum;
  do not feed a module's possible 5 V pull-up into the ESP32 input.
- **Speed meaning:** `hall_rpm` is Hall cycle rate using `MAGNETS_PER_CYCLE`
  (one magnet per loop, confirmed by the operator). It is no longer labelled motor
  RPM or emitted as a joint/splice measurement. The operator confirmed one taped magnet travelling with the belt.
  `MAGNETS_PER_CYCLE=1` and `HALL_ON_BELT=true`. `motor_rpm` is reserved for actual motor measurement.
  The operator confirmed 120 cm is the full loop, recorded as `beltLengthM: 1.2`.
  `belt_speed` is now calculated from the detected full-loop period.
- **Acceleration:** the ADXL345 was configured at 400 Hz but polled near 200 Hz.
  It now uses `BW_RATE=0x0B` (200 Hz) and stream FIFO, drains complete six-byte
  XYZ samples, verifies device ID and configuration, and rejects values outside
  the configured full-resolution ±8 g raw range. A corrupt, clipped, or overflowed
  window is marked faulty and its numbers are omitted. The old capture included
  12.649 and 13.3406 g RMS artefacts despite reporting healthy status.
- **Vibration calculation:** subtract each axis' window mean before combining
  dynamic acceleration. Subtracting the mean of acceleration magnitude could
  miss sideways motion. RMS is the three-axis dynamic vector RMS; crest is peak
  dynamic vector magnitude divided by RMS. Kurtosis is measured on the axis with
  greatest variance. Old and new vibration statistics are not interchangeable
  training features, and old absolute thresholds need a known-good rig baseline.
- **Acceleration display:** mean X/Y/Z and mean total acceleration are now
  explicit channels in g, labelled as including gravity. They are half-second
  summaries, not raw waveforms. Vibration RMS excludes the window's DC gravity
  component; total acceleration still includes gravity and sensor offset.
- **Temperature:** SMBus reads now verify PEC (CRC-8), the sensor error bit,
  repeated START and register-specific range. The installed Adafruit library
  ignored read PEC. Both temperature registers must succeed for healthy status.
  The former “Ambient” label now says “IR sensor temperature”: this is the die's
  temperature, not a separate room-temperature probe.
- **Gateway/UI:** fault-only frames update liveness and sensor health and clear
  affected old measurements. Health is merged across the three nodes instead
  of replaced by whichever node last published. Derived temperature delta uses
  the older source timestamp. Existing database rows are preserved while new
  Hall/acceleration columns are added. RPM displays one decimal place.

## Measured checks after flashing

| Check | Capture result |
|---|---|
| ADXL valid frames | 58 in approximately 30 s |
| Vibration RMS | 0.0407–0.0542 g; mean 0.0465 g |
| Total acceleration including gravity | 1.0606–1.0712 g |
| ADXL sampling | 99–100 samples per 500 ms frame |
| ADXL read errors / invalid samples / FIFO overruns | 0 / 0 / 0 |
| IR valid frames | 59 in approximately 30 s |
| Surface temperature | 33.29–34.55 °C; mean 33.79 °C |
| Sensor die temperature | 29.39–29.55 °C |
| IR read/checksum errors | 0 |
| Hall | Clean interval: 21.05–21.18 cycles/min with one magnet; subsequent intervals include no detected passes |

These validate communication, conversion and sample integrity. No independent
reference thermometer or stationary accelerometer calibration was supplied.
Raw captures are saved locally in `data/recordings/2026-09-06-sensor-debug/`.
Initial serial lines can contain partial frames left in the UART before the
monitor opens; only complete JSON lines were included in the summaries.

An earlier 20-second check after the operator's restart and the acquisition-timeout
fix received 40 frames from each board. Temperature ended at 35.19 °C, vibration
at 0.0616 g RMS, with zero temperature/ADXL read errors, invalid samples, FIFO
overruns or gateway rejects. Hall raw edges increased from 104 to 146, but no
qualified pass was detected; speed remained absent. See `latest-verification.json`.
The operator subsequently confirmed one taped magnet and a full 120 cm loop.
The frontend now labels the measurement Belt RPM (Hall), exposes the pass count
and measured loop period, and explains waiting for the first two passes. All 69 JavaScript
tests and the native C++ sensor calculation tests passed. All three final uploads
verified their flash hashes, and the gateway/bridge were left running.

The final 0.2.1 firmware capture (`calibrated-live.jsonl`) received 88 frames per
node over approximately 45 seconds. The final thermal frame was 35.97 °C surface
and 30.63 °C sensor temperature, with zero read/checksum errors. The final
acceleration frame had 100 samples, 0.0716 g dynamic RMS, and zero read errors,
invalid samples or FIFO overruns. Hall remained HIGH with zero complete LOW
pulses, zero accepted passes and zero queue overflows. A subsequent 60-second
check received 120 Hall frames with no additional edges or passes. These checks
do not prove physical sensor failure: the operator has stopped and restarted
the belt several times, and LED behaviour at an actual magnet pass still needs
confirmation.

The actual Chrome dashboard was refreshed and verified to show
`Belt RPM (Hall) WAITING`, `0 magnet passes`, all three nodes live on firmware
0.2.1, and live temperature/acceleration readings. The default trend now selects
a live channel; the history API returned 1,027 vibration samples in its 15-minute
window at verification. The geometry banner now reports the confirmed 1.20 m
loop and lists only the still-missing geometry measurements. Pulley diameter
and gear ratio are not required for this belt-mounted magnet's RPM or linear
speed. At that check, live numeric RPM was still unverified; the earlier clean
21.1 RPM interval was not presented as a current reading.

### Later confirmation: all three sensors live, 21:43 IST

After the operator requested another check, a fresh 20-second MQTT capture at
16:13:30–16:13:49 UTC (21:43:30–21:43:49 IST) received 40 frames from each board.
Hall accepted passes increased from 161 to 168, with 14 additional raw edges,
no queue overflows, and a final LOW pulse width of 23.734 ms. Belt RPM stayed
between 21.11 and 21.20, and belt speed between 0.4222 and 0.4240 m/s. The final
loop period was 2.831874 seconds. All three sensors are now producing live
measurements, including continuous Hall speed.

Surface temperature ranged from 33.03 to 34.15 °C, with sensor temperature
29.01–29.07 °C. Dynamic vibration RMS ranged from 0.0566 to 0.1215 g; the final
frame was 0.0593 g RMS and total acceleration including gravity was 1.0658 g.
Historical counters were nonzero (ADXL: 192 read errors, 39 invalid samples,
7 FIFO overruns; thermal: 79 read/checksum errors), but none increased during
this check. This confirms current operation, not an error-free history.

The actual Chrome dashboard independently showed `12/20 live`, all three nodes
live, `Belt RPM (Hall) LIVE 21.2 rpm`, `Belt speed LIVE 0.42 m/s`, and an advancing
pass counter with a 2.83-second loop. The remaining unconnected channels are
for sensors this rig does not currently supply. No firmware or calibration
change was needed for this successful check.

## Dataset pilot and final Hall correction: firmware 0.2.2

A 60-second acquisition pilot at 21:47 IST used the real session recorder:
`data/recordings/2026-09-06T16-17-09.797Z-9df8a0ea/`. It captured 120 telemetry
frames from each board, with no sequence gaps/resets or new sensor errors.
However, Hall LOW phases now occupied about 2.8 seconds of each approximately
2.83-second cycle. Qualified passes advanced by 21, while reported speed varied
from 10.76 to 20.71 RPM. This was a software timing artefact, despite the Hall
health field reporting healthy.

The old filter accepted a pulse on its rising edge but backdated the period/age
reference to the preceding falling edge. For a long LOW, the newly accepted
pulse was already nearly a lap old. The ageing calculation then invented a
slowdown between real passes. Version 0.2.2 uses the qualifying rising-edge
timestamp consistently and holds the last measured period until a new period
or the existing no-pulse timeout. It does not extrapolate deceleration from
elapsed time. A zero after timeout still cannot distinguish a stopped belt from
lost detection without operator evidence.

Native regression tests now cover both 24 ms and 2.8 s LOW phases on the same
2.83 s cycle, alongside stop/restart, unsigned timer wrap, slow acquisition,
noise filtering, vector vibration and MLX PEC checks. Tests passed. The sketch
compiled with ESP32 core 3.3.11, ArduinoJson 7.4.3 and Wire, then was flashed to
all three identified ports with flash hash verification. The prior full
JavaScript test run passed 69 tests; this correction changed sensor math and
the firmware version, with recorder help/configuration comments also updated.

The post-fix recording is
`data/recordings/2026-09-06T16-28-13.758Z-15088608/` (21:58–21:59 IST):

| Check | Observed result over 60 seconds |
|---|---|
| Telemetry delivery | 360 frames: 120 per board; 90 additional status messages |
| Sequence gaps / resets | 0 / 0 |
| Hall accepted passes / raw edges | +21 / +42; queue overflows +0 |
| Hall RPM / belt speed | 21.12–21.29 RPM / 0.4224–0.4258 m/s |
| RPM agreement with measured period | Maximum absolute difference 0.0045 RPM, within rounding |
| Surface / sensor temperature | 34.69–36.21 °C / 29.85–29.97 °C; zero read/checksum errors |
| ADXL valid windows | 118/120; two read-fault frames correctly omitted numeric values |
| Dynamic RMS on valid windows | 0.0603–0.1115 g |
| ADXL diagnostic increments | Read errors +2, invalid samples +0, FIFO overruns +0 |
| Longest laptop arrival gap | 2.18 s, despite no sequence loss; arrivals can be buffered/batched |
| Exclusions | Three retained startup status messages, expected; no joint events |

The Hall artefact is resolved in this check. The whole capture is **not** an
approved clean normal-training session: mechanical condition/load were unknown,
two ADXL windows were faulty, and arrival gaps exceed the proposed 1.5 s window
gate. Investigate acquisition/wiring and host scheduling if these recur; retain
all frames and reject affected training windows. Do not hide missing data with
forward filling or loosen thresholds solely to admit this capture.

Both pilots have `acquisition-review.json` sidecars. Source/build provenance and
manual annotations are preserved with the post-fix capture. The session recorder
does not yet automate this detailed quality review or generate training windows.
The seven recorder tests passed after the guide/help update. Documentation links
and JSON templates were validated, and all 29 entries in the post-fix capture's
SHA-256 inventory were verified. A final gateway check reported all three nodes
live on 0.2.2 and 12 live channels.
These runs are labelled `unlabelled` and remain acquisition evidence, not normal
or fault ground truth. Gateway and serial bridge were restored after flashing.

## Confirmed speed calibration

For N evenly spaced magnets and an inter-pass interval T seconds:

```
cycle_rpm = 60 / (N * T)
```

If the magnets are on the belt and 1.2 m is its full loop:

```
belt_speed_mps = 1.2 / (N * T) = cycle_rpm * 1.2 / 60
```

This rig is configured with `MAGNETS_PER_CYCLE=1` and `HALL_ON_BELT=true`,
following the operator's confirmation. A roller-mounted magnet needs the roller circumference to
calculate linear speed; the 1.2 m belt length cannot replace it. Neither belt
cycle RPM nor roller RPM is motor RPM. Do not enable a motor slip rule from the
same Hall signal used to derive belt speed.

## Reproduce validation and flash

From the repository root:

```sh
c++ -std=c++11 -Wall -Wextra -pedantic firmware/tests/sensor_math_test.cpp -o /tmp/pravaah-sensor-math-test
/tmp/pravaah-sensor-math-test
npm test
arduino-cli compile "$PWD/firmware/pravaah_serial_node" --fqbn esp32:esp32:esp32 --build-path /tmp/pravaah-sensor-fix-build --jobs 2
```

Stop the serial bridge before uploads and identify roles by received node IDs,
not by port suffix. In this session `usbserial-0001` was thermal, `usbserial-5`
was acceleration, and `usbserial-6` was Hall — different from the old wiring doc.

Manufacturer references: [ADXL345 data sheet, Tables 7 and 39, asynchronous reads](https://www.analog.com/media/en/technical-documentation/data-sheets/ADXL345.pdf)
and [MLX90614 documentation](https://www.melexis.com/en/documents/documentation/datasheets/datasheet-mlx90614).


## 2026-09-06 long recording: simultaneous USB silence

During recording `2026-09-06T17-29-57.647Z-a70e3e55`, all three streams stopped around 17:45:50 UTC (23:15:50 IST). The gateway, MQTT broker and timed recorder remained running. The dashboard correctly showed the absent data as offline. Arduino CLI and the macOS USB registry listed two CP2102 devices, with the third device absent; neither visible port produced serial bytes. A direct esptool attempt failed in termios configuration, and an explicit RTS/DTR reset/release received zero bytes over five seconds on each port. The cable, adapter, board power, and driver cause is not yet established; physical USB reconnection is needed next. No firmware was changed.

The bridge previously enumerated ports only on MQTT connect and retried obsolete names forever. It now scans every two seconds, handles renamed/reconnected ports, uses macOS callout device paths, and keeps only one owner per discovered port. A failed open has a bounded retry even without a close event. Broker reconnects no longer create duplicate port owners or heartbeat timers. Starting with zero USB devices now leaves the bridge waiting for connections.

Validation: seven serial discovery/retry/shutdown regression tests plus seven recorder tests passed (`node --test tools/serial-ports.test.js tools/record-session.test.js`); Node and shell syntax checks passed. Actual sensor recovery still requires verifying fresh frames after physical reconnection. The recording's original automatic stop deadline remains 01:29:57 IST on September 7. Outages remain gaps, with the acquisition code transition and diagnostic attempts documented in the session directory.

The manual reset attempt follows [Espressif's RTS/DTR and boot-mode documentation](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/boot-mode-selection.html).

Recovery verified after the operator reconnected all three USB boards (around 17:56 UTC): the running bridge discovered the new ports without a restart; Hall, MLX90614 and ADXL345 numeric frames reached the dashboard and the original recorder again. At verification, Hall measured about 20.53 belt RPM / 0.4106 m/s, surface temperature 35.75 °C, and vibration RMS 0.0651 g. Values are dated observations, not calibration references. Exact interruption boundaries are preserved in the session's `usb-reconnection-verification.json`. This confirms reconnection restored the feed; it does not identify the original electrical/driver cause.
