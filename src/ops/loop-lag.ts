/**
 * Event-loop health. Everything the bot decides runs on one thread, so a
 * synchronous computation that takes seconds is invisible to every other
 * signal: the ingest stream reads as silent, Telegram as frozen, the fire
 * as late. The 2026-09-21 blocks (an uncapped selector run walking to $1M
 * one dollar at a time) took hours to attribute because nothing measured
 * the loop itself. Two instruments:
 *
 *  - EventLoopMonitor: `perf_hooks.monitorEventLoopDelay` for the delay
 *    distribution plus a 1 s heartbeat whose drift is the largest single
 *    block since the last snapshot (the histogram's max can miss one very
 *    long stall between samples).
 *  - JobTimer: `timed(name, fn)` wraps every periodic job and the candidate
 *    refresh, keeping last/max/mean per job and the slowest job in the
 *    current window — so a block has a name, not just a duration.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface LoopSnapshot {
  /** Delay percentiles (ms) since the last snapshot. */
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Heartbeat drift: the largest gap between 1 s ticks since the last snapshot. */
  worstBlockMs: number;
  /** Ticks whose drift exceeded `blockThresholdMs` since the last snapshot. */
  blocks: number;
}

export class EventLoopMonitor {
  private readonly histogram: IntervalHistogram;
  private timer: NodeJS.Timeout | null = null;
  private lastTickMs = 0;
  private worstBlockMs = 0;
  private blocks = 0;
  /** Lifetime worst block, for the status surface. */
  worstEverMs = 0;
  worstEverAt: number | null = null;

  constructor(
    private readonly opts: { blockThresholdMs?: number; heartbeatMs?: number; now?: () => number } = {},
  ) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
  }

  start(): void {
    this.histogram.enable();
    const period = this.opts.heartbeatMs ?? 1_000;
    const now = this.opts.now ?? Date.now;
    this.lastTickMs = now();
    this.timer = setInterval(() => this.tick(now()), period);
    this.timer.unref?.();
  }

  /** Exposed for tests: account one heartbeat at `nowMs`. */
  tick(nowMs: number): void {
    const period = this.opts.heartbeatMs ?? 1_000;
    const drift = Math.max(0, nowMs - this.lastTickMs - period);
    this.lastTickMs = nowMs;
    if (drift > this.worstBlockMs) this.worstBlockMs = drift;
    if (drift > (this.opts.blockThresholdMs ?? 1_000)) this.blocks++;
    if (drift > this.worstEverMs) {
      this.worstEverMs = drift;
      this.worstEverAt = nowMs;
    }
  }

  /** Read and reset the window. */
  snapshot(): LoopSnapshot {
    const h = this.histogram;
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : 0);
    const out: LoopSnapshot = {
      p50Ms: ms(h.percentile(50)),
      p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max),
      worstBlockMs: Math.round(this.worstBlockMs),
      blocks: this.blocks,
    };
    h.reset();
    this.worstBlockMs = 0;
    this.blocks = 0;
    return out;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram.disable();
  }
}

export interface JobStats {
  count: number;
  lastMs: number;
  maxMs: number;
  meanMs: number;
  /** Slowest run in the current window (reset by `window()`). */
  windowMaxMs: number;
}

export class JobTimer {
  private readonly jobs = new Map<string, JobStats>();

  constructor(private readonly opts: { now?: () => number; onSlow?: (name: string, ms: number, budgetMs: number) => void } = {}) {}

  /** Time a synchronous or async job; `budgetMs` fires `onSlow` when exceeded. */
  async timed<T>(name: string, fn: () => T | Promise<T>, budgetMs = 1_000): Promise<T> {
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    try {
      return await fn();
    } finally {
      this.record(name, now() - t0, budgetMs);
    }
  }

  /** Synchronous variant: no promise hop, so the measured time is the block itself. */
  timedSync<T>(name: string, fn: () => T, budgetMs = 1_000): T {
    const now = this.opts.now ?? Date.now;
    const t0 = now();
    try {
      return fn();
    } finally {
      this.record(name, now() - t0, budgetMs);
    }
  }

  private record(name: string, ms: number, budgetMs: number): void {
    const s = this.jobs.get(name) ?? { count: 0, lastMs: 0, maxMs: 0, meanMs: 0, windowMaxMs: 0 };
    s.count++;
    s.lastMs = ms;
    s.meanMs = s.meanMs + (ms - s.meanMs) / s.count;
    if (ms > s.maxMs) s.maxMs = ms;
    if (ms > s.windowMaxMs) s.windowMaxMs = ms;
    this.jobs.set(name, s);
    if (ms > budgetMs) this.opts.onSlow?.(name, ms, budgetMs);
  }

  /** All jobs, rounded for a status surface. */
  stats(): Record<string, JobStats> {
    return Object.fromEntries(
      [...this.jobs.entries()].map(([k, s]) => [k, { ...s, lastMs: Math.round(s.lastMs), maxMs: Math.round(s.maxMs), meanMs: Math.round(s.meanMs), windowMaxMs: Math.round(s.windowMaxMs) }]),
    );
  }

  /** The slowest job in the current window, then reset the window. */
  window(): { name: string; ms: number } | null {
    let worst: { name: string; ms: number } | null = null;
    for (const [name, s] of this.jobs) {
      if (s.windowMaxMs > 0 && (!worst || s.windowMaxMs > worst.ms)) worst = { name, ms: Math.round(s.windowMaxMs) };
      s.windowMaxMs = 0;
    }
    return worst;
  }
}
