// Shared conveyor geometry, camera, picking and SVG fallback. No dependencies.
// The main viewport uses webgl3d.js for per-pixel depth testing; SVG retains
// labels and keyboard targets, and renders the model if WebGL is unavailable.
//
// Model space: +x runs along the belt, +y is up, +z is across the belt.

const Scene3D = (() => {
  // ------------------------------------------------------------ vector math

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function norm(v) {
    const L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  }

  /** Face normal from the first three vertices, unnormalised length ignored. */
  const faceNormal = (p) => norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));

  // ------------------------------------------------------------------ colour

  // Anything unparseable falls back to mid grey rather than throwing. A single
  // malformed face must not be able to blank the whole scene - this is a
  // monitoring screen, and a missing part is far better than a missing picture.
  const FALLBACK = '#8a8a8a';

  function hex2rgb(h) {
    const s = String(h ?? '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return hex2rgb(FALLBACK);
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
  const rgb2hex = (c) =>
    '#' + c.map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');

  /**
   * Flat shading. A soft studio key from above and slightly in
   * front, with enough ambient that an unlit face is still readable rather
   * than black - an operator has to be able to see the whole machine.
   */
  const LIGHT = norm([-0.35, 0.86, 0.38]);
  const LIGHT_TINT = [220, 236, 247];

  function shade(hex, n, opts = {}) {
    const base = hex2rgb(hex);
    const lam = Math.max(0, dot(n, LIGHT));
    const amb = opts.ambient ?? 0.34;
    const i = amb + (1 - amb) * lam;
    // A subtle neutral highlight keeps steel distinct from the rubber belt.
    const w = 0.14 * lam;
    return rgb2hex(base.map((c, k) => c * i * (1 - w) + LIGHT_TINT[k] * w * i));
  }

  // ------------------------------------------------------------- projection

  /**
   * Model space -> camera space: rotate by yaw (about +y) then pitch (about
   * +x), then push away from the camera, which sits at the origin looking
   * along +z.
   *
   * A POSITIVE pitch lifts the camera ABOVE the machine. That sign matters
   * for more than framing: it decides which parts are nearer, and therefore
   * which parts the painter's sort draws last. Get it backwards and the
   * stringers and legs - the lowest things on a conveyor - are treated as the
   * closest and paint straight over the belt they hold up.
   */
  function toCam(p, cam) {
    p = sub(p, [cam.tx ?? 0, cam.ty ?? 0, cam.tz ?? 0]);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const x1 = p[0] * cy - p[2] * sy;
    const z1 = p[0] * sy + p[2] * cy;

    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return [x1, p[1] * cp + z1 * sp, z1 * cp - p[1] * sp + cam.dist];
  }

  /** Camera space -> screen, via the perspective divide. */
  function screen(pc, cam) {
    const f = cam.focal / Math.max(pc[2], 1);
    return [cam.cx + pc[0] * f, cam.cy - pc[1] * f, pc[2]];
  }

  /** Returns [screenX, screenY, cameraZ]. */
  const project = (p, cam) => screen(toCam(p, cam), cam);

  /** Rotate a direction (no translation, no divide) - used for culling.
   *  Must stay in lockstep with toCam or normals disagree with positions. */
  function rotate(v, cam) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const x1 = v[0] * cy - v[2] * sy;
    const z1 = v[0] * sy + v[2] * cy;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return [x1, v[1] * cp + z1 * sp, z1 * cp - v[1] * sp];
  }

  // -------------------------------------------------------------- geometry

  /** Axis-aligned box. `c` is the centre, `s` the full size. */
  function box(c, s, attrs) {
    const [x, y, z] = c, [w, h, d] = s.map((v) => v / 2);
    const v = [
      [x - w, y - h, z - d], [x + w, y - h, z - d], [x + w, y + h, z - d], [x - w, y + h, z - d],
      [x - w, y - h, z + d], [x + w, y - h, z + d], [x + w, y + h, z + d], [x - w, y + h, z + d],
    ];
    const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
    return q.map((idx) => ({ pts: idx.map((i) => v[i]), ...attrs }));
  }

  /**
   * Cylinder along +z (the cross-belt axis), which is every roller on this
   * machine: pulleys, idlers, the motor shaft.
   */
  function cylinderZ(c, r, len, segs, attrs) {
    const [x, y, z] = c, h = len / 2, faces = [];
    const ring = (zz) => Array.from({ length: segs }, (_, i) => {
      const a = (i / segs) * Math.PI * 2;
      return [x + r * Math.cos(a), y + r * Math.sin(a), zz];
    });
    const a0 = ring(z - h), a1 = ring(z + h);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      faces.push({ pts: [a0[i], a0[j], a1[j], a1[i]], ...attrs });
    }
    // Caps, wound so their normals face outward along -z and +z.
    faces.push({ pts: a0.slice().reverse(), ...attrs });
    faces.push({ pts: a1.slice(), ...attrs });
    return faces;
  }

  /**
   * Extrude a 2D profile (in the xy plane) across the belt width to make a
   * ribbon. This is how the belt loop itself is built: one closed profile,
   * swept along z.
   */
  function ribbon(profile, width, attrs, closed = true) {
    const h = width / 2, faces = [];
    const n = profile.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p = profile[i], q = profile[(i + 1) % n];
      faces.push({
        pts: [[p[0], p[1], -h], [q[0], q[1], -h], [q[0], q[1], h], [p[0], p[1], h]],
        ...attrs,
      });
    }
    return faces;
  }

  /** The closed stadium profile a belt makes around two pulleys. */
  function beltProfile(x0, x1, cy, r, segs = 14) {
    const pts = [[x0, cy + r], [x1, cy + r]];
    for (let i = 1; i < segs; i++) {
      const a = Math.PI / 2 - (Math.PI * i) / segs;
      pts.push([x1 + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    pts.push([x1, cy - r], [x0, cy - r]);
    for (let i = 1; i < segs; i++) {
      const a = -Math.PI / 2 - (Math.PI * i) / segs;
      pts.push([x0 + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }


  /**
   * Cylinder between two arbitrary points. Every roll on a troughing set sits
   * at the trough angle, so the axis-aligned helper above is not enough - a
   * wing roll is a cylinder from the end of the centre roll, tilted up and
   * out.
   *
   * `d` plays the part +z plays in cylinderZ, and (u, v, d) is built
   * right-handed so the winding - and therefore every face normal - matches.
   */
  function axisBasis(d) {
    const n = norm(d);
    // Any vector not parallel to the axis will do; pick the one that is most
    // perpendicular so the cross product stays well conditioned.
    const seed = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(n, seed));
    return [u, cross(n, u)];
  }

  function cylinderBetween(p0, p1, r, segs, attrs) {
    const [u, v] = axisBasis(sub(p1, p0));
    const ring = (p) => Array.from({ length: segs }, (_, i) => {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      return [
        p[0] + u[0] * c + v[0] * s,
        p[1] + u[1] * c + v[1] * s,
        p[2] + u[2] * c + v[2] * s,
      ];
    });
    const a0 = ring(p0), a1 = ring(p1), faces = [];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      faces.push({ pts: [a0[i], a0[j], a1[j], a1[i]], ...attrs });
    }
    faces.push({ pts: a0.slice().reverse(), ...attrs });
    faces.push({ pts: a1.slice(), ...attrs });
    return faces;
  }

  /**
   * Loft: stitch a run of cross-sections into a surface. Each section is an
   * open polyline of the same length, and consecutive sections are joined
   * quad by quad.
   *
   * This is what makes the belt a real belt rather than a flat strip. A
   * carrying run is TROUGHED - the wing idlers fold its edges up into a V -
   * and a monitoring picture that draws it flat is drawing a different
   * machine from the one in the pit.
   */
  function loft(sections, attrs, closed = false) {
    const faces = [];
    const n = sections.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const A = sections[i], B = sections[(i + 1) % n];
      const k = Math.min(A.length, B.length) - 1;
      for (let j = 0; j < k; j++) {
        faces.push({ pts: [A[j], A[j + 1], B[j + 1], B[j]], ...attrs });
      }
    }
    return faces;
  }

  /**
   * Stations around the closed belt path: the two straight runs and the two
   * pulley wraps, each carrying the surface normal and how troughed the belt
   * is there.
   *
   * Trough tapers to nothing as the belt approaches a pulley, because that is
   * what physically happens - the transition distance where the wings flatten
   * out is a real design parameter, and the joint most likely to fail is the
   * one repeatedly flexed through it.
   */
  function beltPath(o) {
    const { x0, x1, cy, r, wrapSegs = 12, runSegs = 22, taper = 70 } = o;
    const out = [];
    const troughAt = (x) => {
      const d = Math.min(x - x0, x1 - x);
      return Math.max(0, Math.min(1, d / taper));
    };

    // Carrying run, tail -> head, belt surface up.
    for (let i = 0; i <= runSegs; i++) {
      const x = x0 + ((x1 - x0) * i) / runSegs;
      out.push({ p: [x, cy + r], n: [0, 1], trough: troughAt(x) });
    }
    // Head wrap: +90 deg round to -90 deg, normal radial.
    for (let i = 1; i < wrapSegs; i++) {
      const a = Math.PI / 2 - (Math.PI * i) / wrapSegs;
      out.push({ p: [x1 + r * Math.cos(a), cy + r * Math.sin(a)], n: [Math.cos(a), Math.sin(a)], trough: 0 });
    }
    // Return run, head -> tail, belt surface down.
    for (let i = 0; i <= runSegs; i++) {
      const x = x1 - ((x1 - x0) * i) / runSegs;
      out.push({ p: [x, cy - r], n: [0, -1], trough: 0 });
    }
    // Tail wrap, closing the loop.
    for (let i = 1; i < wrapSegs; i++) {
      const a = -Math.PI / 2 - (Math.PI * i) / wrapSegs;
      out.push({ p: [x0 + r * Math.cos(a), cy + r * Math.sin(a)], n: [Math.cos(a), Math.sin(a)], trough: 0 });
    }
    return out;
  }

  /**
   * One cross-section of the belt at a station: a polyline across the width,
   * with the wings lifted along the surface normal by the trough profile.
   *
   * `lift` displaces the whole section along the normal, which is how the
   * load, the splice bands and the skirt line are placed a hair above the
   * rubber without z-fighting it.
   */
  function beltSection(st, o) {
    const { width, troughRise = 0.34, flat = 0.34, cols = 6, lift = 0, scale = 1 } = o;
    const hw = (width / 2) * scale;
    const [nx, ny] = st.n;
    const pts = [];
    for (let i = 0; i <= cols; i++) {
      const t = -1 + (2 * i) / cols;
      const a = Math.abs(t);
      const rise = a <= flat ? 0 : ((a - flat) / (1 - flat)) * troughRise * (width / 2);
      const d = lift + rise * st.trough;
      pts.push([st.p[0] + nx * d, st.p[1] + ny * d, t * hw]);
    }
    return pts;
  }

  // ---------------------------------------------------------------- render

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Clip the portion crossing the near plane instead of dropping a whole face.
  function clipNear(points, near = 1) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const insideA = a[2] >= near, insideB = b[2] >= near;
      if (insideA) out.push(a);
      if (insideA !== insideB) {
        const t = (near - a[2]) / (b[2] - a[2]);
        // Interpolate attached model coordinates as well as camera position.
        out.push(a.map((v, k) => k === 2 ? near : v + (b[k] - v) * t));
      }
    }
    return out;
  }

  const MATERIALS = { steel: 1, rubber: 2, coal: 3, paint: 4 };

  function prepare(faces, cam) {
    const out = [];
    for (const face of faces) {
      const cameraPoints = face.pts.map(p => toCam(p, cam));
      if (!cameraPoints.every(p => p.every(Number.isFinite))) continue;
      const normal = rotate(faceNormal(face.pts), cam);
      const back = dot(normal, cameraPoints[0]) > 0;
      if (!face.twoSided && back) continue;
      const clipped = clipNear(cameraPoints.map((p, i) => [...p, ...face.pts[i]]));
      const points = clipped.map(p => p.slice(0, 3));
      if (points.length < 3) continue;
      const lit = face.flat ? face.color : shade(face.color, back ? normal.map(v => -v) : normal, face);
      out.push({ points, projected: points.map(p => screen(p, cam)),
        modelPoints: clipped.map(p => p.slice(3, 6)),
        material: face.flat ? 0 : MATERIALS[face.material] ?? 0,
        textureStrength: face.textureStrength ?? 1,
        color: hex2rgb(lit).map(v => v / 255), comp: face.comp ?? null });
    }
    return out;
  }

  // Perspective-correct depth at the pointer, using the same triangles as WebGL.
  // Unselectable structure still occludes components behind it.
  function pick(prepared, x, y, selected = null) {
    let closest = Infinity, hit = null, selectedHit = false;
    for (const face of prepared) {
      for (let i = 1; i < face.projected.length - 1; i++) {
        const [a, b, c] = [face.projected[0], face.projected[i], face.projected[i + 1]];
        const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(det) < 1e-8) continue;
        const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
        const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
        const w = 1 - u - v;
        if (Math.min(u, v, w) < -1e-7) continue;
        const depth = 1 / (u / a[2] + v / b[2] + w / c[2]);
        const isSelected = selected !== null && face.comp === selected;
        if ((isSelected && !selectedHit) || (isSelected === selectedHit && depth < closest)) {
          closest = depth; hit = face.comp; selectedHit = isSelected;
        }
      }
    }
    return hit;
  }

  /**
   * Project, cull, sort and emit. Faces are returned as individual polygons
   * carrying `data-comp`, so hit testing is just event delegation.
   *
   * A face may set `twoSided` (the belt ribbon, seen from inside and out),
   * `flat` (skip shading - used for indicator bands that must keep their
   * exact status colour), and `glow`.
   */
  function render(faces, cam, textures = true) {
    const out = [];
    for (const f of faces) {
      const cs = clipNear(f.pts.map((p) => toCam(p, cam)));
      if (cs.length < 3) continue;

      const nr = rotate(faceNormal(f.pts), cam);
      // Back-face cull against the vector from the camera to the face, not
      // against the view axis. Under perspective those differ, and using the
      // axis lets faces near the edge of frame leak through.
      const c = cs.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
        .map((v) => v / cs.length);
      if (!f.twoSided && dot(nr, c) > 0) continue;

      const proj = cs.map((p) => screen(p, cam));
      const depth = cs.reduce((s, p) => s + p[2], 0) / cs.length;
      // A two-sided face seen from behind is lit by its flipped normal, so the
      // underside of the belt is shaded rather than left flat black.
      const lit = f.flat
        ? (f.color ?? FALLBACK)
        : shade(f.color, dot(nr, c) > 0 ? [-nr[0], -nr[1], -nr[2]] : nr, f);
      // `edge` outlines a face in a darker shade of its own colour. Two steel
      // parts touching at a shallow angle shade almost identically, and
      // without an edge they fuse into one blob - which matters here because
      // most of a conveyor is unmonitored and therefore all the same grey.
      const edge = f.edge ? rgb2hex(hex2rgb(lit).map((v) => v * 0.5)) : null;
      out.push({ f, proj, depth, lit, edge });
    }

    // Painter's algorithm: furthest first.
    out.sort((a, b) => b.depth - a.depth);

    // A lightweight stipple/grain treatment for machines without WebGL.
    // GPU rendering uses continuous model-space textures; SVG uses shared
    // patterns scaled with the camera so it remains useful at close range.
    const textured = textures && out.some(({ f }) => !f.flat && MATERIALS[f.material]);
    const origin = project([0, 0, 0], cam);
    const size = Math.max(0.4, cam.focal / cam.dist);
    const transform = `translate(${origin[0].toFixed(2)} ${origin[1].toFixed(2)}) scale(${size.toFixed(3)})`;
    const defs = textured ? `<defs>
      <pattern id="surface-steel" width="18" height="6" patternUnits="userSpaceOnUse" patternTransform="${transform}"><path d="M0 1h12M7 4h11" stroke="#fff" stroke-opacity=".25" stroke-width=".4"/><path d="M2 2h15M0 5h8" stroke="#000" stroke-opacity=".3" stroke-width=".4"/></pattern>
      <pattern id="surface-rubber" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="${transform}"><path d="M1 0v6" stroke="#000" stroke-opacity=".3" stroke-width=".7"/><circle cx="3" cy="2" r=".45" fill="#fff" fill-opacity=".2"/><circle cx="5" cy="5" r=".6" fill="#000" fill-opacity=".3"/></pattern>
      <pattern id="surface-coal" width="14" height="12" patternUnits="userSpaceOnUse" patternTransform="${transform}"><path d="m1 2 4-2 3 4-4 3-4-2Zm8 6 3-3 2 5-3 2Z" fill="#fff" fill-opacity=".18"/><path d="m0 10 4-3 3 4-2 1Z" fill="#000" fill-opacity=".35"/></pattern>
      <pattern id="surface-paint" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="${transform}"><circle cx="1" cy="2" r=".45" fill="#fff" fill-opacity=".2"/><circle cx="4" cy="4" r=".5" fill="#000" fill-opacity=".25"/></pattern>
    </defs>` : '';
    return defs + out.map(({ f, proj, lit, edge }) => {
      const pts = proj.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const attrs = [
        `points="${pts}"`,
        `fill="${lit}"`,
        f.stroke ? `stroke="${f.stroke}" stroke-width="${f.strokeWidth ?? 0.8}"`
          : edge ? `stroke="${edge}" stroke-width="0.5"` : 'stroke="none"',
        f.opacity !== undefined ? `opacity="${f.opacity}"` : '',
        f.comp ? `data-comp="${esc(f.comp)}"` : 'pointer-events="none"',
        f.dash ? `stroke-dasharray="${f.dash}"` : '',
        f.cls ? `class="${f.cls}"` : '',
      ].filter(Boolean).join(' ');
      const texture = textured && !f.flat && MATERIALS[f.material]
        ? `<polygon points="${pts}" fill="url(#surface-${f.material})" opacity="${(f.textureStrength ?? 1) * 0.45}" pointer-events="none"/>` : '';
      return `<polygon ${attrs}/>${texture}`;
    }).join('');
  }

  /** Screen-space bounding box of a set of model points, for label placement. */
  function bounds(pts, cam) {
    const p = pts.map((q) => project(q, cam));
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      depth: Math.min(...p.map((q) => q[2])),
    };
  }

  // ----------------------------------------------------------- orbit input

  /**
   * Drag to orbit. Pitch is clamped so the machine never flips over, which
   * would leave an operator looking at the underside wondering what happened.
   *
   * There is no auto-rotation on purpose: this sits on a wall display for a
   * whole shift, and something that never stops moving is something people
   * stop looking at.
   */
  function orbit(el, cam, onChange) {
    let drag = null;
    const PITCH_MIN = -0.15, PITCH_MAX = 1.2;
    const FOCAL_MIN = 650, FOCAL_MAX = 9000;

    // `onChange(true)` means "a gesture is in flight" - the caller is free to
    // drop detail until it ends. `onChange(false)` is the settled frame and is
    // always drawn at full quality, so what an operator finally looks at is
    // never the cheap version.
    let settle = null;
    const settleSoon = () => {
      clearTimeout(settle);
      settle = setTimeout(() => onChange(false), 140);
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      el.dataset.dragged = '';
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: 0 };

    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      if (drag.moved <= 4) return;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      cam.yaw = drag.yaw + dx * 0.008;
      cam.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, drag.pitch + dy * 0.006));
      onChange(true);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      el.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      // Tell the caller whether this was a drag or a click, so a click that
      // ended a rotation does not also open a drawer.
      el.dataset.dragged = moved > 4 || e.type === 'pointercancel' ? '1' : '';
      if (moved > 4) onChange(false);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);

    // Optical zoom leaves the camera outside the machine. Moving the camera
    // into its geometry was clipping away parts during close inspection.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 420 : 1);
      const k = Math.exp(-Math.max(-500, Math.min(500, pixels)) * 0.0011);
      cam.focal = Math.max(FOCAL_MIN, Math.min(FOCAL_MAX, cam.focal * k));
      onChange(true);
      settleSoon();
    }, { passive: false });

    // Keyboard orbit, so the view is reachable without a mouse.
    el.addEventListener('keydown', (e) => {
      const step = 0.12;
      if (e.key === 'ArrowLeft') cam.yaw -= step;
      else if (e.key === 'ArrowRight') cam.yaw += step;
      else if (e.key === 'ArrowUp') cam.pitch = Math.min(PITCH_MAX, cam.pitch + step * 0.6);
      else if (e.key === 'ArrowDown') cam.pitch = Math.max(PITCH_MIN, cam.pitch - step * 0.6);
      else if (e.key === '+' || e.key === '=') cam.focal = Math.min(FOCAL_MAX, cam.focal / 0.9);
      else if (e.key === '-' || e.key === '_') cam.focal = Math.max(FOCAL_MIN, cam.focal * 0.9);
      else return;
      e.preventDefault();
      onChange(false);
    });
  }

  return {
    box, cylinderZ, cylinderBetween, ribbon, loft, beltProfile, beltPath, beltSection,
    render, prepare, pick, clipNear, project, bounds, orbit, shade, faceNormal, norm, dot, cross, sub,
  };
})();

// Published explicitly: app.js is a module and reads this off the global.
globalThis.Scene3D = Scene3D;
