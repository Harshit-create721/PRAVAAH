# MC-120 Blender model integration

PRAVAAH's default mining view now uses the actual MC-120 geometry created in
Blender: **652 individually named mesh/text parts and 16,790 polygon faces**.
The six studio/control objects in the 658-object Blender scene are omitted.
The bench view remains available via `model: 'bench'`.

## Run and inspect

- `npm run demo:recording` starts the existing isolated BeltData replay at
  **http://localhost:8812**, with the recorded-playback label and segment gaps.
- `npm start` serves the live gateway at **http://localhost:8811**.
- Click a model surface to inspect that individual Blender part. The health
  roster still selects whole monitoring assemblies.
- Expand **Inspect individual model parts** to search and select any of the
  652 parts, including belt sections, rollers, motor fins, bolts and ore pieces.
- The existing orbit, zoom, camera presets, reset, labels, textures, fullscreen,
  pause/resume, sensor callouts, joint markers and joint-history actions work
  with the imported model. SVG remains the fallback when WebGL is unavailable.

## Motion and measurements

`belt-motion.js` remains the clock and validity gate. For the imported model,
measured `belt_speed` divided by the model's **23.456 m** loop sets visual laps
per second. One measured metre advances the model by one metre: at 0.41 m/s,
a visual lap takes about 57 seconds. The original sensor rig's 1.20 m loop
remains calibration metadata; it does not set the larger model's visual lap
period. The procedural bench view retains its measured-loop timing.

`mining-model.js` converts traveled distance into the original belt wrap, drum,
roller, coupling and ore trajectories. Parent-mounted grip ribs and travel marks
move with their belt section; drum witness bars move with the drum. Static
geometry remains cached between motion frames. No Blender add-on, external
service, Python execution or additional browser dependency is required.

All motion holds on pause, zero speed, invalid/stale speed, an offline speed node,
recording gaps or an unavailable gateway. Reduced-motion and visibility handling
are retained. Pausing the animation does not stop monitoring or hardware.

Ore paths and shaft rotation are illustrations; they do not measure throughput,
shaft RPM, absolute splice position, direction, loading or physical interactions.
The modeled emergency stop is an inspectable part, not a hardware command.

## Monitoring mapping

| Model assembly | Existing monitoring ID / behavior |
| --- | --- |
| Head drum and shaft | `drive_pulley`: slip-related status |
| Motor body, cooling fins, terminal box | `drive_motor`: existing drive channels |
| Head bearing housings/cartridges/foot bolts | `drive_bearing`: vibration findings |
| Fourth carry-roller station | `idlers`: single IR reading shown schematically; confirm the actual rig target |
| Fixed belt guides | `training_idler`: existing alignment rule ID, labeled **Belt alignment zone** |
| Moving belt sections / backing | `belt_tracking` / `belt_carcass` |
| Reducer and couplings | `gearbox` |
| Tail drum / bearings / screws | `tail_pulley` / `tail_bearing` / `takeup` |
| Carry / return rollers | `carry_idlers` / `return_idlers` |
| Hopper and skirts / scraper | `loading_chute` / `head_scraper` |
| Frame, discharge, bin, walkway, local controls, ore | Separate unmonitored assemblies |
| Joint status bands | Existing dynamic `joint:<id>` objects and history |

Alarm ownership, rule IDs, thresholds, channel values and history semantics are
retained. Individual mesh inspection inherits its assembly's monitoring scope;
it does not claim a sensor on each bolt or increment alarm/coverage counts.
Unmonitored parts keep their material colors. The roster and detail panel state
their monitoring status explicitly.

The model has no snub pulley, bend pulley, impact-idler set or pull-cord. Those
unmonitored legacy entries are removed from the mining roster. The alignment
rule ID is retained without claiming a self-aligning pivot idler exists.

## Files and regeneration

- `assets/MiningConveyor.blend`: preserved editable source.
- `web/assets/mining-conveyor.js`: generated indexed geometry, materials,
  Blender names, monitoring IDs, motion metadata and source SHA-256.
- `tools/export-mining-model.py`: exporter; omits bevel detail for browser
  performance while preserving plate thickness and individual parts.
- `web/mining-model.js`: transforms and monitoring adapter.

Regenerate from the project directory with Blender 5.1:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe' --background assets/MiningConveyor.blend --python tools/export-mining-model.py
```

The exporter does not save changes to the source file. When editing the source,
retain part names or update `monitoring()` and motion classification in the exporter.

## Verification

- `npm test`: 68 gateway/tool tests and 49 relay tests passed.
- `node tools/test-scene3d.js`: 84 geometry/camera/picking checks passed.
- `node tools/test-model-browser.js`: isolated headless Chrome checks against
  a running local replay; screenshots and results are saved in
  `_snapshots/blender-model-verification/`. Controlled browser fixtures never
  publish to MQTT or write alarms/history to the gateway.
- Asset tests verify source-file hash, all 652 part mappings, belt-loop
  continuity, parented ribs, ore motion, roller direction, fault ownership,
  independent picking and SVG inspection ordering.

Before-change backup: `_snapshots/2026-09-15_before-blender-model.zip`.
