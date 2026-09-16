# Dashboard refresh — September 2026

The local dashboard leads with the interactive conveyor view directly below the
header, with a larger viewport to make the model the main focus. Asset condition,
live channels, open alarms and evaluated component coverage follow it. Section links,
responsive cards, clearer controls and consistent panel spacing support both
operator use and product presentations.

## Model and inspection

- Fullscreen control beside the camera presets. Uses browser fullscreen when
  available and an expanded page view otherwise. Exit with the same button or Esc.
  Camera position and selected component survive entry and exit.
- Zoom buttons and an annotation toggle. Hiding labels retains keyboard component
  targets. Existing drag, wheel, keyboard orbit, presets and inspection remain.
- Neutral steel lighting, an open tapered hopper, motor cooling fins, pulley hubs,
  casing bolts and a corrected longitudinal take-up screw.
- Material textures: brushed steel, fine rubber grain, painted-metal stipple and
  consistent surface detail. Textures remain on; there is no texture toggle.
  GPU textures follow model coordinates through orbit and zoom; the SVG fallback
  uses lighter shared patterns. No external texture downloads are needed.
  Texture contrast is reduced on components carrying a health colour, and joint
  status bands retain their exact colours.
- Component search and filters for attention or instrumented parts. Lost sensors
  are included in attention. Joint history remains accessible in fullscreen.

The model is reference geometry. Ore meshes are excluded from the dashboard. Its
shape does not claim to measure the installed machine. Colours and readings continue
to come from sensor and rule data. Unmonitored parts remain neutral, and the ML
baseline score remains separate from failure probability.

## Sensor inspection

- Only motor, conveyor belt and roller assemblies are selectable through the scene,
  keyboard targets, component chooser or roster. Structure stays visible as context.
- Roller detail includes `hall_rpm`, labeled Belt RPM (Hall), from the existing Hall
  sensor. It is a shared reading, not an independently measured speed for each roller.
- Positive `crack_length`, `opening` or `edge_separation` values in a joint's latest
  vision data add a clickable wear indicator and measured millimetre readings. Missing
  or zero damage values do not create a wear graphic. The scar is schematic, not a
  localized camera reconstruction. Joint history remains available from the detail.
- The vision feed still needs hardware integration; no synthetic damage is published.

## Data handling

- Signal history includes a sample count, minimum, maximum and latest value.
  Export CSV downloads the displayed samples with UTC timestamps and units.
- Superseded history responses cannot overwrite a newly selected signal. Failed
  requests clear the previous chart and disable export until data is available.
- Lost or stalled gateway updates invalidate live channel, component, node and
  overall health claims. Previously received values remain marked as historical.
- Urgent condition banners take priority over missing geometry guidance.
- Joint history requests ignore responses for a closed or superseded inspection.

## Validation and preview

Run `npm start` from the project directory, then open `http://localhost:8811`.

Automated checks:

```sh
npm test
node tools/test-scene3d.js
```

The test suite includes fullscreen state transitions, denied/unsupported API
fallback, focus restoration, background inert state, component filters and CSV
escaping, plus texture coordinate clipping, picking, status-colour preservation,
WebGL vertex-buffer layout, texture toggling and context recovery. The existing
SQLite migration test now closes its database before
removing its temporary directory on Windows.

The full client was additionally checked in a temporary DOM harness for no-data
startup, all 18 component targets, all five camera presets, search and inspection,
annotation toggling, fullscreen fallback, history races/errors and disconnection.
The SVG model was rendered and visually inspected. Native browser fullscreen,
GPU rendering and the final responsive page layout still require an on-screen
browser check; no connected browser was available during this pass.
