# PRAVAAH mobile

React Native / Expo app for the existing PRAVAAH conveyor gateway. Android is
the primary target. It uses the deployed relay at
`wss://api.sih.shubhang.dev/subscribe`; no backend deployment is needed.

## Run it

Requirements: Node 22.13+ and npm. Native Android builds also need JDK 17,
Android SDK platform/build tools 36, and an emulator or USB-connected phone.

```sh
cd PRAVAAH/mobile
npm ci
npm run android
```

`npm run android` generates the native project, builds a development app and
starts Metro. For subsequent sessions, run `npm start` and open the installed
development app. Expo Go cannot run the background monitoring service.

For a browser preview:

```sh
npm run web
```

The browser preview is read-only and does not support background notifications.
It connects directly to the same relay and shows real data, including recorded
history. It does not store a write token.

## First connection

1. Keep the default relay address, or enter your own HTTPS/WSS relay.
2. Enter your operator name. The write token is optional for viewing.
3. Tap **Connect to conveyor**.
4. On Android, return to connection settings and enable background monitoring
   if you want alarm notifications while the app is backgrounded. Allow the
   notification permission when Android asks.

Use the deployment's **write token**, not its publish secret. The Android app
saves it with Expo SecureStore and sends it as an `Authorization: Bearer`
WebSocket handshake header. No credentials are embedded in source, logs or
URLs. Changes to the token take effect when you save and reconnect.

For LAN fallback, enter a local gateway address such as
`http://192.168.1.10:8811`. After three failed relay attempts the app tries it.
The phone must share the gateway's network. The relay token is never sent to
the LAN endpoint. LAN reads use `/ws`; actions and history use the gateway's
existing HTTP APIs. A working LAN connection remains active until reconnect.
The local gateway's existing open-write policy is unchanged.

## Screens

- **Overview:** selectable conveyor, risk, live channel/node coverage, open alarm
  count, sensor channels grouped using gateway metadata, and the highest-priority
  alarm. Missing measurements are `NO SIGNAL`; measured zero remains zero.
  The separate **ML condition** card reads `conveyors[].ml` from the updated gateway.
  It compares full ten-second windows with the recorded operating baseline and
  clears scores when readings expire or the gateway connection drops. It does not
  estimate failure probability. See [ML setup and input contract](../ML/SIH-2026/README.md).
- **Alarms:** open alarms ordered by severity and time, with acknowledged and
  unacknowledged filters. Snapshots replace the open set so alarms closed on the
  dashboard disappear here too.
- **Alarm detail:** rule, family, joint, measured evidence and acknowledgement.
  Closure requires an outcome, technician and notes. Success appears only after
  the backend confirms it. Closed alarms remain in the gateway's maintenance
  record; the deployed relay does not expose closed-alarm history.
- **Trends:** one channel over 15 or 60 minutes, real sample timestamps, min/max/
  average, refresh and visible loading/error/empty states. Outages split the line.
- **Nodes:** reported state, last seen, health, firmware, IP, uptime and RSSI.
  The current gateway does not expose transport type, so the app says “not
  reported” rather than guessing USB/Wi-Fi from an absent IP.
- **Connection:** relay, optional LAN fallback, operator credentials and Android
  monitoring controls.

## Android APK

The September 7 build with the ML condition card is available locally at
`builds/pravaah-ml-2026-09-07.apk`. Its packaged bundle was checked after the
release build. APKs and generated native directories are excluded from Git;
use the build commands below to reproduce them from this source.

A local arm64 APK was built successfully and is available at
`builds/pravaah-preview-arm64.apk` (internal testing, development signing key).
It includes the JavaScript bundle and does not need Metro. This covers current
arm64 Android phones; build without an architecture override for other CPUs.

Local build, with the SDK and JDK configured:

```sh
npx expo prebuild --platform android --no-clean
npm run build:apk
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.
The local Expo template uses its development signing key; this APK is for
internal testing. Configure your own signing credentials for distribution.

EAS profiles are also included:

```sh
npx eas-cli build --platform android --profile development
npx eas-cli build --platform android --profile preview
```

The preview profile produces a standalone APK with its JavaScript bundled.
EAS requires your Expo account/project setup. No EAS project has been created
or published by this implementation.

## Verification

```sh
npm run check               # strict TypeScript + Jest logic/component suites
npm run test:integration    # isolated real relay + publisher + temporary SQLite
PRAVAAH_LIVE_TEST=1 npm run test:integration  # also read the deployed relay
npm run export:android      # bundle the native JS graph
npx expo export --platform web
```

The integration suite reuses `relay/src/fixtures/thermal-alarm.jsonl`. It checks
command correlation, authenticated/unauthenticated writes, recorded history,
the alarm's original evidence, SQLite acknowledgement and maintenance records,
and gateway disconnection/reconnection. Its writes only touch a temporary test
database. The optional live test performs reads only.

The Jest suites cover the no-React boundary, absent versus measured-zero
readings, staleness boundaries, clock skew, malformed frames, retry jitter and
caps, half-open sockets, credential isolation on fallback, notification dedupe,
timeouts, backpressure on commands and disabled offline/read-only actions.

Validated on 2026-09-06: TypeScript, all 50 Jest tests, both integration tests
(including the read-only deployed-relay check), web export, Android Hermes
export and a local arm64 release APK build. The APK installed and launched on
an Android 36 emulator with no AndroidRuntime or ReactNativeJS errors logged.
The browser UI was checked against live gateway readings and recorded history.
Device/OEM background behavior
requires the acceptance checks below.

September 7 follow-up: TypeScript checking, all 52 Jest tests, Android bundle
export and the release APK build passed after adding the ML condition card.
The updated APK was not installed on a phone during that verification pass.

## Implementation details and corrections to the original plan

`src/gateway` and `src/domain` have no React, React Native or Expo imports.
Platform adapters live in `src/platform`; Zustand connects the pure client to
the screens. Native navigation uses Expo Router's native stack and native tabs.

The backend code and live responses override the plan's illustrative types:

- The actual snapshot includes `server.now`, `server.site`, `conveyors`, and
  top-level nodes; channels have five states: live, stale, late, offline, never.
- React Native **does** support WebSocket headers via its third constructor
  argument. The deployed relay understands `Authorization`, not the bearer
  subprotocol suggested in the old plan.
- The public relay has no `/api/contract` route or `contract` command. Every
  snapshot already includes the canonical label, unit and group, which the app
  uses directly. It does not duplicate the channel table or invent ranges.
- Sensor and node timestamps use the gateway clock, and relay health uses the
  relay clock. Both are corrected against their own timestamps. Cached snapshot
  age is included so replaying a stale snapshot cannot reset a sensor's age.
- Freshness windows match current `server/config.js`: 3/10/30 seconds. If these
  become configurable on the gateway, expose them in the protocol and update
  `src/domain/staleness.ts` together.
- Relay commands are limited locally to 4/sec, burst 4, at most 6 in flight and
  32 outstanding. Offline and unconfirmed writes fail explicitly and are never
  replayed automatically. LAN requests are aborted when their connection ends.

## Background monitoring and remaining device checks

Expo Notifications displays alarm notifications. Notifee supplies the Android
foreground service and its persistent status notification. It is registered
at the app entry point, shares one connection with the UI, and stops via the
notification action or app settings. Notification deduplication persists the
last 512 event identities; reconnect snapshots never trigger notifications.

The foreground service is declared as `dataSync`. Android 15+ limits background
dataSync services to six hours, so the app ends a monitoring session after
5½ hours. Returning the app to the foreground resets Android's time budget.
Foreground services can still be stopped by the OS or OEM battery managers;
this app does not claim guaranteed alarm delivery or continuous 24-hour
monitoring. iOS background monitoring is not implemented.

Expo Doctor currently flags `@notifee/react-native` as unmaintained in React
Native Directory. The warning has not been suppressed. Review or replace this
dependency before a production rollout. npm also reports upstream moderate
issues in Expo tooling and the router dependency tree; do not use `npm audit
fix --force`, which proposes downgrading Expo to an incompatible major version.

Before relying on this on a phone, verify:

- Background the installed Android build for 30 minutes, trigger a real
  `thermal_delta` alarm, and check that one notification contains its values.
- Repeat on the intended OEM/device with its normal battery settings.
- Toggle airplane mode and confirm visible disconnection and automatic recovery.
- Stop the gateway and confirm that readings degrade and actions disable.
- Acknowledge/close a test alarm and verify the change in the web dashboard.
- Stop monitoring from the persistent notification and confirm the service ends.

Reference: [React Native WebSocket implementation](https://github.com/facebook/react-native/blob/main/packages/react-native/Libraries/WebSocket/WebSocket.js),
[Notifee foreground services](https://notifee.app/react-native/docs/android/foreground-service/),
[Android foreground-service time limits](https://developer.android.com/develop/background-work/services/fgs/timeout).
