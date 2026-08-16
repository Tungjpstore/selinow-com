/**
 * Landing v4 hero scene — aurora gradient mesh + commerce particle network.
 *
 * The aurora layer renders at 1/6 resolution on an offscreen canvas so the
 * soft additive gradients stay cheap; upscaling gives free blur. The node
 * network keeps the Selinow "commerce pipeline" story: nodes are channels and
 * services, particles are verified transactions flowing between them.
 *
 * Runtime guards:
 * - DPR capped at 2.
 * - rAF loop pauses when the hero leaves the viewport or the tab is hidden.
 * - `prefers-reduced-motion: reduce` draws a single static frame and stops.
 */

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;

/** Selinow aurora spectrum — see LANDING_V4_DESIGN_DIRECTION.md §3. */
const rgb = {
  violet: [124, 58, 237],
  indigo: [101, 82, 232],
  blue: [59, 130, 246],
  bright: [156, 139, 255],
} as const;

const rgba = (color: readonly number[], alpha: number): string =>
  `rgba(${String(color[0])},${String(color[1])},${String(color[2])},${String(alpha)})`;

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface AuroraBlob {
  anchorX: number;
  anchorY: number;
  radius: number;
  orbit: number;
  speed: number;
  phase: number;
  color: readonly number[];
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
  connections: number[];
}

interface Particle {
  from: number;
  to: number;
  progress: number;
  speed: number;
  opacity: number;
}

interface Star {
  x: number;
  y: number;
  radius: number;
  phase: number;
}

interface Scene {
  blobs: AuroraBlob[];
  nodes: Node[];
  particles: Particle[];
  stars: Star[];
}

function createScene(w: number, h: number, rand: () => number): Scene {
  const blobs: AuroraBlob[] = [
    { anchorX: 0.18, anchorY: 0.12, radius: 0.5, orbit: 0.06, speed: 0.00013, phase: rand() * TAU, color: rgb.violet },
    { anchorX: 0.82, anchorY: 0.2, radius: 0.42, orbit: 0.05, speed: 0.0001, phase: rand() * TAU, color: rgb.blue },
    { anchorX: 0.55, anchorY: 0.92, radius: 0.55, orbit: 0.07, speed: 0.00008, phase: rand() * TAU, color: rgb.indigo },
    { anchorX: 0.35, anchorY: 0.55, radius: 0.3, orbit: 0.04, speed: 0.00016, phase: rand() * TAU, color: rgb.bright },
  ];

  const stars: Star[] = [];
  const starCount = Math.min(90, Math.floor((w * h) / 20000));
  for (let i = 0; i < starCount; i++) {
    stars.push({ x: rand() * w, y: rand() * h, radius: 0.6 + rand() * 1.1, phase: rand() * TAU });
  }

  const nodeCount = Math.max(8, Math.min(26, Math.floor((w * h) / 46000)));
  const nodes: Node[] = [];
  const pad = 56;
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      x: pad + rand() * (w - pad * 2),
      y: pad + rand() * (h - pad * 2),
      vx: (rand() - 0.5) * 0.16,
      vy: (rand() - 0.5) * 0.12,
      radius: 2 + rand() * 2.6,
      phase: rand() * TAU,
      connections: [],
    });
  }

  const maxDist = Math.min(w, h) * 0.4;
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (current === undefined) continue;
    const distances: { index: number; dist: number }[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const other = nodes[j];
      if (other === undefined) continue;
      const dist = Math.hypot(current.x - other.x, current.y - other.y);
      if (dist < maxDist) distances.push({ index: j, dist });
    }
    distances.sort((a, b) => a.dist - b.dist);
    const count = 1 + Math.floor(rand() * 2.5);
    for (let k = 0; k < Math.min(count, distances.length); k++) {
      const entry = distances[k];
      if (entry === undefined) continue;
      if (!current.connections.includes(entry.index)) current.connections.push(entry.index);
    }
  }

  const edges: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (current === undefined) continue;
    for (const j of current.connections) if (j > i) edges.push([i, j]);
  }
  const particles: Particle[] = [];
  const particleCount = Math.min(edges.length, Math.floor(edges.length * 0.55) + 3);
  for (let i = 0; i < particleCount; i++) {
    const edge = edges[i % Math.max(edges.length, 1)];
    if (edge === undefined) continue;
    particles.push({ from: edge[0], to: edge[1], progress: rand(), speed: 0.0022 + rand() * 0.004, opacity: 0.35 + rand() * 0.5 });
  }

  return { blobs, nodes, particles, stars };
}

function drawAurora(target: CanvasRenderingContext2D, scene: Scene, w: number, h: number, time: number): void {
  target.clearRect(0, 0, w, h);
  target.globalCompositeOperation = "lighter";
  for (const blob of scene.blobs) {
    const cx = blob.anchorX * w + Math.cos(time * blob.speed + blob.phase) * blob.orbit * w;
    const cy = blob.anchorY * h + Math.sin(time * blob.speed * 1.3 + blob.phase) * blob.orbit * h;
    const radius = blob.radius * Math.max(w, h) * 0.5;
    const gradient = target.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, rgba(blob.color, 0.52));
    gradient.addColorStop(0.55, rgba(blob.color, 0.16));
    gradient.addColorStop(1, rgba(blob.color, 0));
    target.fillStyle = gradient;
    target.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  target.globalCompositeOperation = "source-over";
}

function drawNetwork(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number, time: number): void {
  const { nodes, particles, stars } = scene;

  ctx.lineWidth = 1;
  const maxDist = Math.min(w, h) * 0.4;
  for (const node of nodes) {
    for (const neighborIndex of node.connections) {
      const neighbor = nodes[neighborIndex];
      if (neighbor === undefined) continue;
      const dist = Math.hypot(neighbor.x - node.x, neighbor.y - node.y);
      const alpha = Math.max(0, 0.22 * (1 - dist / maxDist));
      ctx.strokeStyle = rgba(rgb.bright, alpha);
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(neighbor.x, neighbor.y);
      ctx.stroke();
    }
  }

  for (const star of stars) {
    const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(time * 0.0009 + star.phase));
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, TAU);
    ctx.fillStyle = `rgba(233,236,246,${String(0.5 * twinkle)})`;
    ctx.fill();
  }

  for (const particle of particles) {
    const fromNode = nodes[particle.from];
    const toNode = nodes[particle.to];
    if (fromNode === undefined || toNode === undefined) continue;
    const px = fromNode.x + (toNode.x - fromNode.x) * particle.progress;
    const py = fromNode.y + (toNode.y - fromNode.y) * particle.progress;
    const glow = ctx.createRadialGradient(px, py, 0, px, py, 9);
    glow.addColorStop(0, rgba(rgb.bright, particle.opacity * 0.62));
    glow.addColorStop(1, rgba(rgb.bright, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(px - 9, py - 9, 18, 18);
    ctx.beginPath();
    ctx.arc(px, py, 1.8, 0, TAU);
    ctx.fillStyle = `rgba(222,216,255,${String(Math.min(1, particle.opacity + 0.15))})`;
    ctx.fill();
  }

  for (const node of nodes) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 0.0011 + node.phase);
    const r = node.radius * (0.92 + 0.08 * pulse);
    const halo = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 4.6);
    halo.addColorStop(0, rgba(rgb.indigo, 0.18 * pulse));
    halo.addColorStop(1, rgba(rgb.indigo, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 4.6, 0, TAU);
    ctx.fill();

    const core = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r);
    core.addColorStop(0, "#CDC5FF");
    core.addColorStop(1, "#6552E8");
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, TAU);
    ctx.fillStyle = core;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 0.42, 0, TAU);
    ctx.fillStyle = `rgba(255,255,255,${String(0.6 * pulse)})`;
    ctx.fill();
  }
}

function updateNetwork(scene: Scene, w: number, h: number): void {
  const margin = 40;
  for (const node of scene.nodes) {
    node.x += node.vx;
    node.y += node.vy;
    if (node.x < margin || node.x > w - margin) node.vx *= -1;
    if (node.y < margin || node.y > h - margin) node.vy *= -1;
    node.x = Math.max(margin, Math.min(w - margin, node.x));
    node.y = Math.max(margin, Math.min(h - margin, node.y));
  }
  for (const particle of scene.particles) {
    particle.progress += particle.speed;
    if (particle.progress >= 1) {
      particle.progress = 0;
      const previous = particle.from;
      particle.from = particle.to;
      particle.to = previous;
    }
  }
}

function init(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  // Low-resolution offscreen buffer: the aurora only needs soft gradients.
  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d");
  if (offCtx === null) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = 8;
  let w = 0;
  let h = 0;
  let scene: Scene = createScene(1, 1, seededRandom(42));
  let animId = 0;
  let running = false;
  let inView = true;

  const renderFrame = (time: number): void => {
    ctx.clearRect(0, 0, w, h);
    drawAurora(offCtx, scene, off.width, off.height, time);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, w, h);
    drawNetwork(ctx, scene, w, h, time);
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(animId);
  };

  const start = (): void => {
    if (running || REDUCED_MOTION || !inView || document.hidden) return;
    running = true;
    const frame = (time: number): void => {
      if (!running) return;
      updateNetwork(scene, w, h);
      renderFrame(time);
      animId = requestAnimationFrame(frame);
    };
    animId = requestAnimationFrame(frame);
  };

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    off.width = Math.max(2, Math.ceil(w / scale));
    off.height = Math.max(2, Math.ceil(h / scale));
    scene = createScene(w, h, seededRandom(42));
    if (REDUCED_MOTION || !running) renderFrame(performance.now());
  };

  resize();

  if (REDUCED_MOTION) {
    renderFrame(0);
    return;
  }

  const io = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) start();
    else stop();
  }, { rootMargin: "80px" });
  io.observe(canvas);

  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const ro = new ResizeObserver(() => {
    resize();
  });
  ro.observe(canvas);

  start();

  canvas._heroSceneCleanup = () => {
    stop();
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

declare global {
  interface HTMLCanvasElement {
    _heroSceneCleanup?: () => void;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("[data-hero-canvas]");
if (canvas !== null) init(canvas);

export {};
