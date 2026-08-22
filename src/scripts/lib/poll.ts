/**
 * poll.ts — the EX freshness protocol (plan §5.3): poll a GET endpoint on a
 * budget, pause while the tab is hidden (resume with an immediate fetch),
 * back off after consecutive failures, and stamp `data-fresh-at` so the UI
 * can show real freshness instead of a decorative "online" badge.
 */

export type PollOptions = {
  /** Consecutive failures before doubling the interval (default 2). */
  backoffAfter?: number;
  intervalMs: number;
  /** Pause polling while the document is hidden (default true). */
  pauseWhenHidden?: boolean;
};

export type PollHandle = { freshAt: () => string | null; stop: () => void };

class PollRuntime {
  private failures = 0;
  private lastFreshAt: string | null = null;
  private scheduled = false;
  private stoppedFlag = false;

  private isStopped(): boolean { return this.stoppedFlag; }
  private timer = 0;

  constructor(private readonly fetcher: () => Promise<boolean>, private readonly options: PollOptions) {}

  private stamp(): void {
    this.lastFreshAt = new Date().toISOString();
    for (const host of document.querySelectorAll<HTMLElement>("[data-fresh-at]")) {
      host.dataset.freshAt = this.lastFreshAt;
    }
  }

  private schedule(): void {
    if (this.isStopped()) return;
    const backoffAfter = this.options.backoffAfter ?? 2;
    const delay = this.failures >= backoffAfter ? this.options.intervalMs * 2 : this.options.intervalMs;
    this.scheduled = true;
    this.timer = window.setTimeout(() => { void this.tick(); }, delay);
  }

  private async tick(): Promise<void> {
    this.scheduled = false;
    if (this.isStopped()) return;
    if ((this.options.pauseWhenHidden ?? true) && document.hidden) {
      this.schedule();
      return;
    }
    try {
      const fresh = await this.fetcher();
      if (this.isStopped()) return;
      if (fresh) {
        this.failures = 0;
        this.stamp();
      } else {
        this.failures += 1;
      }
    } catch {
      if (!this.isStopped()) this.failures += 1;
    }
    this.schedule();
  }

  start(): void {
    document.addEventListener("visibilitychange", this.onVisible);
    void this.tick();
  }

  private readonly onVisible = (): void => {
    if (document.hidden || this.isStopped() || this.scheduled) return;
    void this.tick();
  };

  freshAt(): string | null {
    return this.lastFreshAt;
  }

  stop(): void {
    this.stoppedFlag = true;
    if (this.scheduled) window.clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
  }
}

export function startPolling(fetcher: () => Promise<boolean>, options: PollOptions): PollHandle {
  const runtime = new PollRuntime(fetcher, options);
  runtime.start();
  return { freshAt: () => runtime.freshAt(), stop: () => { runtime.stop(); } };
}
