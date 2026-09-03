/**
 * hero-canvas.ts — LP editorial hero backdrop (LP1).
 *
 * WebGL2 fragment shader painting a slow domain-warped "silk" field in the
 * Selinow palette behind the hero copy. Degrades to a Canvas2D gradient
 * field when WebGL2 is unavailable. Decorative only: the canvas is
 * aria-hidden and nothing about it gates content visibility.
 *
 * Contract (browser gate + MOTION doc):
 * - prefers-reduced-motion: draw exactly one deterministic frame (t = 0)
 *   and never start the rAF loop.
 * - Pause when the hero is offscreen or the tab is hidden; cap devicePixelRatio.
 * - No console output, no external resources, CSP-safe (bundled module).
 */

const HERO_CANVAS_SELECTOR = "[data-hero-canvas]";

function readColor(root: HTMLElement, name: string, fallback: [number, number, number]): [number, number, number] {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (raw.startsWith("#") && (raw.length === 7 || raw.length === 4)) {
    const digits = raw.length === 4
      ? raw.slice(1).split("").map((char) => `${char}${char}`).join("")
      : raw.slice(1);
    const value = Number.parseInt(digits, 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }
  return fallback;
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_ivory;
uniform vec3 u_violet;
uniform vec3 u_indigo;
uniform vec3 u_teal;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.55;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(11.7, 5.3);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = v_uv;
  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 p = (uv - 0.5) * aspect;

  float t = u_time * 0.045;
  vec2 warp = vec2(
    fbm(p * 1.4 + vec2(t, -t * 0.6)),
    fbm(p * 1.4 + vec2(-t * 0.7, t) + 4.7)
  );
  float field = fbm(p * 1.9 + warp * 1.35 + vec2(0.0, t * 0.35));

  // Three brand-hued ribbons flowing through the silk field — visible but
  // airy on the light premium canvas (v3).
  float ribbon1 = smoothstep(0.52, 0.78, field);
  float ribbon2 = smoothstep(0.60, 0.86, fbm(p * 1.15 - warp * 1.1 + vec2(t * 0.5, 0.0)));
  float ribbon3 = smoothstep(0.66, 0.92, fbm(p * 2.6 + warp * 0.8));

  vec3 color = u_ivory;
  color = mix(color, u_indigo, ribbon1 * 0.34);
  color = mix(color, u_violet, ribbon2 * 0.28);
  color = mix(color, u_teal, ribbon3 * 0.15);

  // Soft vignette so the headline side stays calm and readable.
  float shade = smoothstep(1.25, 0.15, length((uv - vec2(0.32, 0.55)) * aspect));
  color = mix(color, u_ivory, shade * 0.48);

  // Gentle grain keeps large gradients from banding.
  float grain = (hash(uv * u_resolution.xy + fract(u_time)) - 0.5) * 0.028;
  outColor = vec4(clamp(color + grain, 0.0, 1.0), 1.0);
}`;

interface SilkRenderer {
  draw(timeSeconds: number): void;
  dispose(): void;
}

function widenNullable<T>(value: T): T | null {
  return value;
}

function createWebglRenderer(canvas: HTMLCanvasElement): SilkRenderer | null {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (gl === null) return null;

  const compile = (kind: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(kind);
    if (shader === null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  if (vertexShader === null || fragmentShader === null) return null;

  // Context loss can still yield null at runtime even where platform types
  // claim otherwise; widen the type so the guard stays meaningful.
  const program = widenNullable(gl.createProgram());
  if (program === null) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, "u_resolution");
  const time = gl.getUniformLocation(program, "u_time");
  const ivory = gl.getUniformLocation(program, "u_ivory");
  const violet = gl.getUniformLocation(program, "u_violet");
  const indigo = gl.getUniformLocation(program, "u_indigo");
  const teal = gl.getUniformLocation(program, "u_teal");

  const root = document.documentElement;
  const colorIvory = readColor(root, "--mk-ed-canvas", [0.98, 0.976, 0.965]);
  const colorViolet = readColor(root, "--mk-ed-accent-strong", [0.41, 0.34, 0.87]);
  const colorIndigo = readColor(root, "--sln-brand-indigo", [0.36, 0.36, 0.92]);
  const colorTeal = readColor(root, "--sln-brand-teal", [0.08, 0.72, 0.65]);

  gl.uniform3fv(ivory, colorIvory);
  gl.uniform3fv(violet, colorViolet);
  gl.uniform3fv(indigo, colorIndigo);
  gl.uniform3fv(teal, colorTeal);

  const resize = (): boolean => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    return true;
  };
  resize();
  gl.uniform2f(resolution, canvas.width, canvas.height);

  return {
    draw(timeSeconds: number) {
      if (resize()) gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, timeSeconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    },
  };
}

function createCanvas2dRenderer(canvas: HTMLCanvasElement): SilkRenderer {
  const context = canvas.getContext("2d");
  if (context === null) {
    return { draw() {}, dispose() {} };
  }
  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  };
  resize();
  const draw = (timeSeconds: number): void => {
    resize();
    const { width, height } = canvas;
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--mk-ed-accent").trim() || "#7C6AF0";
    const indigo = styles.getPropertyValue("--sln-brand-indigo").trim() || "#5B5CEB";
    const teal = styles.getPropertyValue("--sln-brand-teal").trim() || "#14B8A6";
    context.fillStyle = styles.getPropertyValue("--mk-ed-canvas").trim() || "#FAF9F6";
    context.fillRect(0, 0, width, height);
    const drift = timeSeconds * 0.05;
    const blobs: Array<[string, number, number, number]> = [
      [accent, 0.72 + Math.sin(drift) * 0.04, 0.34 + Math.cos(drift * 0.8) * 0.05, 0.55],
      [indigo, 0.94 + Math.cos(drift * 0.7) * 0.04, 0.72 + Math.sin(drift) * 0.05, 0.5],
      [teal, 0.16 + Math.sin(drift * 0.5) * 0.04, 0.8 + Math.cos(drift * 0.9) * 0.04, 0.42],
    ];
    for (const [color, x, y, radius] of blobs) {
      const gradient = context.createRadialGradient(x * width, y * height, 0, x * width, y * height, radius * Math.max(width, height) * 0.6);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "rgba(250, 249, 246, 0)");
      context.globalAlpha = 0.14;
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    context.globalAlpha = 1;
  };
  return { draw, dispose() {} };
}

function bootHeroCanvas(canvas: HTMLCanvasElement): void {
  // Reduced motion: never create a GL context (driver noise during capture,
  // wasted GPU) — hide the canvas and let the CSS aurora backdrop show.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    canvas.dataset.heroCanvasState = "off";
    return;
  }

  const renderer = createWebglRenderer(canvas) ?? createCanvas2dRenderer(canvas);

  let frame = 0;
  let visible = true;
  const start = performance.now();
  const loop = (): void => {
    if (!visible) return;
    renderer.draw((performance.now() - start) / 1000);
    frame = window.requestAnimationFrame(loop);
  };

  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      const wasVisible = visible;
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible && !wasVisible) frame = window.requestAnimationFrame(loop);
      if (!visible && frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    }, { threshold: 0.02 });
    observer.observe(canvas);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    } else {
      frame = window.requestAnimationFrame(loop);
    }
  });
  frame = window.requestAnimationFrame(loop);
}

for (const canvas of [...document.querySelectorAll<HTMLCanvasElement>(HERO_CANVAS_SELECTOR)]) {
  bootHeroCanvas(canvas);
}
