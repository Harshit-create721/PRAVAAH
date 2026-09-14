// Depth-buffered conveyor viewport. Geometry, lighting and picking are shared
// with Scene3D; this file only rasterizes the prepared triangles.
// https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/depthFunc
globalThis.ConveyorViewport = class {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, depth: true });
    this.ready = false;
    if (!this.gl) return;
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.ready = false;
      onChange();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.init();
      onChange();
    });
    this.init();
  }

  init() {
    const gl = this.gl;
    const shader = (type, source) => {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(result);
        gl.deleteShader(result);
        throw new Error(message);
      }
      return result;
    };
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? 'highp' : 'mediump';
    const vertex = shader(gl.VERTEX_SHADER, `
      attribute vec3 position;
      attribute vec3 color;
      attribute vec3 modelPosition;
      attribute vec2 surface;
      uniform vec4 projection;
      varying mediump vec3 faceColor;
      varying ${precision} vec3 surfacePosition;
      varying mediump vec2 surfaceInfo;
      void main() {
        // +z is forward in the shared camera. Near=1, far=10000.
        gl_Position = vec4(position.x * projection.x + position.z * projection.z,
          position.y * projection.y + position.z * projection.w,
          1.00020002 * position.z - 2.00020002, position.z);
        faceColor = color;
        surfacePosition = modelPosition;
        surfaceInfo = surface;
      }
    `);
    const fragment = shader(gl.FRAGMENT_SHADER, `
      precision ${precision} float;
      varying mediump vec3 faceColor;
      varying ${precision} vec3 surfacePosition;
      varying mediump vec2 surfaceInfo;
      uniform float textureDetail;
      float hash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 19.19);
        return fract((p.x + p.y) * p.z);
      }
      float grain(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                       mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                       mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        float material = surfaceInfo.x;
        float variation = 0.0;
        // The coordinates belong to the model, so the grain never slides
        // across a component when orbiting, zooming or entering fullscreen.
        vec3 p = surfacePosition;
        if (material > 0.5) {
          float fine = grain(p * 1.6) - 0.5;
          if (material < 1.5) {
            float brushed = grain(p * vec3(0.06, 3.0, 3.0)) - 0.5;
            variation = (brushed * 0.24 + fine * 0.10) * textureDetail;
          } else if (material < 2.5) {
            float rib = sin(p.x * 2.8) * 0.5;
            variation = (fine * 0.30 + rib * 0.09) * textureDetail;
          } else if (material < 3.5) {
            float aggregate = grain(p * 0.48) - 0.5;
            variation = aggregate * 0.70 + fine * 0.28 * textureDetail;
          } else {
            variation = fine * 0.18 * textureDetail;
          }
        }
        // Brightness variation only: never introduce rust or damage colours,
        // and keep status bands exact by giving them material zero.
        gl_FragColor = vec4(clamp(faceColor * (1.0 + variation * surfaceInfo.y), 0.0, 1.0), 1.0);
      }
    `);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.buffer = gl.createBuffer();
    this.staticBuffers = [gl.createBuffer(), gl.createBuffer()];
    this.staticCache = null;
    this.position = gl.getAttribLocation(this.program, 'position');
    this.color = gl.getAttribLocation(this.program, 'color');
    this.modelPosition = gl.getAttribLocation(this.program, 'modelPosition');
    this.surface = gl.getAttribLocation(this.program, 'surface');
    this.textureDetail = gl.getUniformLocation(this.program, 'textureDetail');
    this.projection = gl.getUniformLocation(this.program, 'projection');
    this.ready = true;
  }

  draw(faces, cam, selected = null, textures = true, staticFaces = null) {
    if (!this.ready || this.gl.isContextLost()) return false;
    const gl = this.gl;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    // Match SVG's centered `xMidYMid meet` viewport, including letterboxing.
    const scale = Math.min(width / 872, height / 420);
    gl.uniform4f(this.projection, 2 * cam.focal * scale / width,
      2 * cam.focal * scale / height, 2 * (cam.cx - 436) * scale / width,
      -2 * (cam.cy - 210) * scale / height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // Fade fine grain when zoomed out instead of letting it become shimmer.
    gl.uniform1f(this.textureDetail, Math.min(1, cam.focal * scale / (cam.dist * ratio)));
    gl.enableVertexAttribArray(this.position);
    gl.enableVertexAttribArray(this.color);
    gl.enableVertexAttribArray(this.modelPosition);
    gl.enableVertexAttribArray(this.surface);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const draw = (items, dim, cached = null) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached?.buffer ?? this.buffer);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 44, 0);
      gl.vertexAttribPointer(this.color, 3, gl.FLOAT, false, 44, 12);
      gl.vertexAttribPointer(this.modelPosition, 3, gl.FLOAT, false, 44, 24);
      gl.vertexAttribPointer(this.surface, 2, gl.FLOAT, false, 44, 36);
      if (cached?.count !== undefined) {
        gl.drawArrays(gl.TRIANGLES, 0, cached.count);
        return;
      }
      const vertices = [];
      for (const face of items) {
        // Dim context as opaque surfaces. Alpha on every overlapping face
        // accumulated into dark patches and changed with the camera angle.
        const color = dim ? face.color.map((v, i) => v * 0.24 + [0.035, 0.06, 0.075][i]) : face.color;
        for (let i = 1; i < face.points.length - 1; i++) {
          for (const index of [0, i, i + 1]) {
            vertices.push(...face.points[index], ...color, ...(face.modelPoints?.[index] ?? [0, 0, 0]),
              textures ? face.material ?? 0 : 0, face.textureStrength ?? 1);
          }
        }
      }
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), cached ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
      if (cached) cached.count = vertices.length / 11;
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 11);
    };
    // The stationary model stays in GPU buffers across motion frames. Changing
    // camera, telemetry colours, texture settings or selection invalidates it.
    if (staticFaces && (this.staticCache?.faces !== staticFaces
      || this.staticCache.selected !== selected || this.staticCache.textures !== textures)) {
      this.staticCache = { faces: staticFaces, selected, textures,
        context: { buffer: this.staticBuffers[0], items: selected ? staticFaces.filter(f => f.comp !== selected) : staticFaces },
        selectedPart: { buffer: this.staticBuffers[1], items: selected ? staticFaces.filter(f => f.comp === selected) : [] } };
    }
    const moving = staticFaces ? faces.slice(staticFaces.length) : faces;
    const batch = (selectedPart) => {
      if (staticFaces) {
        const cached = selectedPart ? this.staticCache.selectedPart : this.staticCache.context;
        draw(cached.items, !!selected && !selectedPart, cached);
      }
      draw(selected ? moving.filter(f => (f.comp === selected) === selectedPart) : moving, !!selected && !selectedPart);
    };
    if (selected) {
      batch(false);
      // The inspected component is intentionally revealed through its context.
      // Its own faces still use depth testing, so it remains a solid object.
      gl.clear(gl.DEPTH_BUFFER_BIT);
      batch(true);
    } else batch(false);
    return true;
  }
};
