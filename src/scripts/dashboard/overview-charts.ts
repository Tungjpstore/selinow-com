/**
 * Overview Velocity Canvas Chart Engine
 * High-performance, anti-aliased 60fps HTML5 2D Canvas chart renderer.
 */

export type ChartDataPoint = {
  label: string;
  value: number;
};

type Point = {
  x: number;
  y: number;
};

export class VelocityChartRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: ChartDataPoint[] = [];
  private dpr: number = 1;
  private animationProgress: number = 0;
  private hoverIndex: number | null = null;

  constructor(canvas: HTMLCanvasElement, data: ChartDataPoint[]) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context not supported");
    this.ctx = context;
    this.data = data;
    this.dpr = window.devicePixelRatio || 1;

    this.setupCanvas();
    this.bindHover();
    this.animate();

    window.addEventListener("resize", () => {
      this.setupCanvas();
      this.draw(1);
    });
  }

  private setupCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
  }

  private bindHover(): void {
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const step = rect.width / Math.max(1, this.data.length - 1);
      const index = Math.min(this.data.length - 1, Math.max(0, Math.round(x / step)));
      if (this.hoverIndex !== index) {
        this.hoverIndex = index;
        this.draw(1);
      }
    });

    this.canvas.addEventListener("mouseleave", () => {
      this.hoverIndex = null;
      this.draw(1);
    });
  }

  public animate(): void {
    const startTime = performance.now();
    const duration = 800; // ms

    const step = (currentTime: number): void => {
      const elapsed = currentTime - startTime;
      this.animationProgress = Math.min(1, elapsed / duration);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - this.animationProgress, 3);
      this.draw(eased);

      if (this.animationProgress < 1) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }

  public draw(progress: number = 1): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const padding = { bottom: 24, left: 16, right: 16, top: 20 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    this.ctx.clearRect(0, 0, w, h);

    if (this.data.length < 2) return;

    const values = this.data.map((d) => d.value);
    const maxVal = Math.max(...values, 10);
    const minVal = 0;
    const range = maxVal - minVal;

    const getX = (i: number): number => padding.left + (i / (this.data.length - 1)) * chartW;
    const getY = (v: number): number => padding.top + chartH - ((v - minVal) / range) * chartH * progress;

    // Draw horizontal dashed grid lines
    this.ctx.strokeStyle = "rgba(227, 230, 239, 0.6)";
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    for (let i = 0; i <= 3; i++) {
      const gy = padding.top + (chartH / 3) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(padding.left, gy);
      this.ctx.lineTo(w - padding.right, gy);
      this.ctx.stroke();
    }
    this.ctx.setLineDash([]);

    // Create Bézier curve path
    const points: Point[] = this.data.map((d, i) => ({ x: getX(i), y: getY(d.value) }));
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];

    if (!firstPoint || !lastPoint) return;

    // Fill area gradient
    const gradient = this.ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
    gradient.addColorStop(0, "rgba(101, 82, 232, 0.22)");
    gradient.addColorStop(1, "rgba(101, 82, 232, 0.00)");

    this.ctx.beginPath();
    this.ctx.moveTo(firstPoint.x, h - padding.bottom);
    this.ctx.lineTo(firstPoint.x, firstPoint.y);

    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      if (curr && next) {
        const cpX = (curr.x + next.x) / 2;
        this.ctx.bezierCurveTo(cpX, curr.y, cpX, next.y, next.x, next.y);
      }
    }

    this.ctx.lineTo(lastPoint.x, h - padding.bottom);
    this.ctx.closePath();
    this.ctx.fillStyle = gradient;
    this.ctx.fill();

    // Stroke line
    this.ctx.beginPath();
    this.ctx.moveTo(firstPoint.x, firstPoint.y);
    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      if (curr && next) {
        const cpX = (curr.x + next.x) / 2;
        this.ctx.bezierCurveTo(cpX, curr.y, cpX, next.y, next.x, next.y);
      }
    }
    this.ctx.strokeStyle = getComputedStyle(this.canvas).getPropertyValue("--sln-soft-accent").trim() || "#7C6AF0";
    this.ctx.lineWidth = 2.5;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.stroke();

    // Draw active hover node
    if (this.hoverIndex !== null && this.hoverIndex >= 0 && this.hoverIndex < points.length) {
      const p = points[this.hoverIndex];
      const item = this.data[this.hoverIndex];

      if (p && item) {
        // Vertical guide line
        this.ctx.strokeStyle = "rgba(101, 82, 232, 0.35)";
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([2, 2]);
        this.ctx.beginPath();
        this.ctx.moveTo(p.x, padding.top);
        this.ctx.lineTo(p.x, h - padding.bottom);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        // Point halo
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        this.ctx.fillStyle = "rgba(101, 82, 232, 0.2)";
        this.ctx.fill();

        // Point center
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--sln-soft-accent").trim() || "#7C6AF0";
        this.ctx.fill();
        this.ctx.strokeStyle = "#FFFFFF";
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        // Tooltip pill
        const tooltipText = `${item.label}: ${item.value.toLocaleString("vi-VN")}`;
        this.ctx.font = "600 11px Inter, sans-serif";
        const textMetrics = this.ctx.measureText(tooltipText);
        const pillW = textMetrics.width + 16;
        const pillH = 24;
        let pillX = p.x - pillW / 2;
        if (pillX < 8) pillX = 8;
        if (pillX + pillW > w - 8) pillX = w - pillW - 8;
        const pillY = Math.max(4, p.y - 34);

        this.ctx.fillStyle = "#101828";
        this.ctx.beginPath();
        this.ctx.roundRect(pillX, pillY, pillW, pillH, 6);
        this.ctx.fill();

        this.ctx.fillStyle = "#FFFFFF";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(tooltipText, pillX + pillW / 2, pillY + pillH / 2);
      }
    }
  }
}

// Auto init canvas charts
if (typeof document !== "undefined") {
  const initCharts = (): void => {
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>("[data-velocity-chart]")) {
      try {
        const raw = canvas.dataset.chartData;
        const data: ChartDataPoint[] = raw ? (JSON.parse(raw) as ChartDataPoint[]) : [];
        if (data.length > 0) {
          new VelocityChartRenderer(canvas, data);
        }
      } catch (err) {
        console.error("Failed to render canvas chart", err);
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCharts);
  } else {
    initCharts();
  }
}
