/**
 * Hero backdrop canvas — animated node-network visualization.
 *
 * Renders a constellation of nodes connected by gradient paths,
 * representing Selinow's multi-channel commerce pipeline. Particles
 * travel along connections to suggest data flow.
 *
 * Respects `prefers-reduced-motion: reduce` — draws a single static
 * frame and stops the animation loop.
 */

const BRAND_PRIMARY = "#6552E8";
const BRAND_SECONDARY = "#9C8BFF";

const TAU = Math.PI * 2;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function createScene(
  w: number,
  h: number,
  rand: () => number
): { nodes: Node[]; particles: Particle[] } {
  const nodeCount = Math.max(6, Math.floor((w * h) / 90000));
  const nodes: Node[] = [];

  // Place nodes in a loosely scattered distribution with padding
  const pad = 60;
  for (let i = 0; i < nodeCount; i++) {
    const x = pad + rand() * (w - pad * 2);
    const y = pad + rand() * (h - pad * 2);
    nodes.push({
      x,
      y,
      vx: (rand() - 0.5) * 0.15,
      vy: (rand() - 0.5) * 0.12,
      radius: 2.5 + rand() * 3,
      phase: rand() * TAU,
      connections: [],
    });
  }

  // Connect each node to its 1-3 nearest neighbors (no duplicates)
  const maxDist = Math.min(w, h) * 0.38;
  for (let i = 0; i < nodes.length; i++) {
    const currentNode = nodes[i];
    if (currentNode === undefined) continue;
    const distances: { index: number; dist: number }[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const other = nodes[j];
      if (other === undefined) continue;
      const dx = currentNode.x - other.x;
      const dy = currentNode.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxDist) distances.push({ index: j, dist });
    }
    distances.sort((a, b) => a.dist - b.dist);
    const count = 1 + Math.floor(rand() * 2.5);
    for (let k = 0; k < Math.min(count, distances.length); k++) {
      const entry = distances[k];
      if (entry === undefined) continue;
      const neighbor = entry.index;
      if (!currentNode.connections.includes(neighbor)) {
        currentNode.connections.push(neighbor);
      }
    }
  }

  // Spawn particles along connections
  const particles: Particle[] = [];
  const allEdges: [number, number][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const currentNode = nodes[i];
    if (currentNode === undefined) continue;
    for (const j of currentNode.connections) {
      if (j > i) allEdges.push([i, j]);
    }
  }
  const particleCount = Math.min(allEdges.length, Math.floor(allEdges.length * 0.6) + 3);
  for (let i = 0; i < particleCount; i++) {
    const edge = allEdges[i % allEdges.length];
    if (edge === undefined) continue;
    particles.push({
      from: edge[0],
      to: edge[1],
      progress: rand(),
      speed: 0.002 + rand() * 0.004,
      opacity: 0.3 + rand() * 0.5,
    });
  }

  return { nodes, particles };
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: Node[],
  particles: Particle[],
  time: number
): void {
  ctx.clearRect(0, 0, w, h);

  // Subtle radial ambient glow
  const ambientGrad = ctx.createRadialGradient(w * 0.15, h * 0.2, 0, w * 0.15, h * 0.2, w * 0.55);
  ambientGrad.addColorStop(0, "rgba(101,82,232,0.04)");
  ambientGrad.addColorStop(1, "rgba(101,82,232,0)");
  ctx.fillStyle = ambientGrad;
  ctx.fillRect(0, 0, w, h);

  const secondGlow = ctx.createRadialGradient(w * 0.85, h * 0.8, 0, w * 0.85, h * 0.8, w * 0.4);
  secondGlow.addColorStop(0, "rgba(156,139,255,0.035)");
  secondGlow.addColorStop(1, "rgba(156,139,255,0)");
  ctx.fillStyle = secondGlow;
  ctx.fillRect(0, 0, w, h);

  // Draw connections
  ctx.lineWidth = 1;
  for (const node of nodes) {
    for (const neighborIdx of node.connections) {
      const neighbor = nodes[neighborIdx];
      if (neighbor === undefined) continue;
      const dx = neighbor.x - node.x;
      const dy = neighbor.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = Math.min(w, h) * 0.38;
      const alpha = Math.max(0, 0.08 * (1 - dist / maxDist));

      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(neighbor.x, neighbor.y);
      ctx.strokeStyle = `rgba(101,82,232,${String(alpha)})`;
      ctx.stroke();
    }
  }

  // Draw particles traveling along connections
  for (const p of particles) {
    const fromNode = nodes[p.from];
    const toNode = nodes[p.to];
    if (fromNode === undefined || toNode === undefined) continue;
    const px = fromNode.x + (toNode.x - fromNode.x) * p.progress;
    const py = fromNode.y + (toNode.y - fromNode.y) * p.progress;

    const glow = ctx.createRadialGradient(px, py, 0, px, py, 6);
    glow.addColorStop(0, `rgba(156,139,255,${String(p.opacity * 0.7)})`);
    glow.addColorStop(1, "rgba(156,139,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(px - 6, py - 6, 12, 12);

    ctx.beginPath();
    ctx.arc(px, py, 1.5, 0, TAU);
    ctx.fillStyle = `rgba(192,183,255,${String(p.opacity)})`;
    ctx.fill();
  }

  // Draw nodes
  for (const node of nodes) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 0.001 + node.phase);
    const r = node.radius * (0.9 + 0.1 * pulse);

    // Outer glow
    const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 4);
    glow.addColorStop(0, `rgba(101,82,232,${String(0.06 * pulse)})`);
    glow.addColorStop(1, "rgba(101,82,232,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 4, 0, TAU);
    ctx.fill();

    // Core dot
    const coreGrad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r);
    coreGrad.addColorStop(0, BRAND_SECONDARY);
    coreGrad.addColorStop(1, BRAND_PRIMARY);
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, TAU);
    ctx.fillStyle = coreGrad;
    ctx.fill();

    // Bright center
    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 0.4, 0, TAU);
    ctx.fillStyle = `rgba(255,255,255,${String(0.4 * pulse)})`;
    ctx.fill();
  }
}

function init(canvas: HTMLCanvasElement): void {
  const ctxRaw = canvas.getContext("2d");
  if (ctxRaw === null) return;
  const ctx: CanvasRenderingContext2D = ctxRaw;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let nodes: Node[] = [];
  let particles: Particle[] = [];
  let animId = 0;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rand = seededRandom(42);
    const scene = createScene(w, h, rand);
    nodes = scene.nodes;
    particles = scene.particles;
  }

  function update(): void {
    const margin = 40;
    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;

      // Bounce off edges with padding
      if (node.x < margin || node.x > w - margin) node.vx *= -1;
      if (node.y < margin || node.y > h - margin) node.vy *= -1;
      node.x = Math.max(margin, Math.min(w - margin, node.x));
      node.y = Math.max(margin, Math.min(h - margin, node.y));
    }

    // Advance particles
    for (const p of particles) {
      p.progress += p.speed;
      if (p.progress >= 1) {
        p.progress = 0;
        // Reverse direction on loop
        const tmp = p.from;
        p.from = p.to;
        p.to = tmp;
      }
    }
  }

  function frame(time: number): void {
    if (!REDUCED_MOTION) update();
    drawFrame(ctx, w, h, nodes, particles, time);
    if (!REDUCED_MOTION) {
      animId = requestAnimationFrame(frame);
    }
  }

  resize();
  animId = requestAnimationFrame(frame);

  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(animId);
    resize();
    animId = requestAnimationFrame(frame);
  });
  ro.observe(canvas);

  // Cleanup on page navigation
  canvas._heroCanvasCleanup = () => {
    cancelAnimationFrame(animId);
    ro.disconnect();
  };
}

// Extend HTMLCanvasElement to store cleanup reference
declare global {
  interface HTMLCanvasElement {
    _heroCanvasCleanup?: () => void;
  }
}

// Auto-initialize on DOMContentLoaded
const canvas = document.querySelector<HTMLCanvasElement>("[data-hero-canvas]");
if (canvas) init(canvas);

export {};
