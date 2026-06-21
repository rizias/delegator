import type { BudgetSpec } from './types.js';

export interface CheckpointerOpts {
  checkpointMs: number;
  stallMs: number;
  silenceKillMs: number;
  budget: BudgetSpec;
  getDiffHash: () => string;
  getLastEventTs: () => number;
  onKill: (reason: 'timeout' | 'no-progress', diagnosis: string) => void;
}

export class Checkpointer {
  private readonly opts: CheckpointerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private prevHash = '';
  private noProgressCount = 0;
  private hashHistory: string[] = [];
  private oscillationCount = 0;
  private killed = false;

  constructor(opts: CheckpointerOpts) {
    this.opts = opts;
  }

  start(): void {
    this.startTime = Date.now();
    this.prevHash = '';
    this.noProgressCount = 0;
    this.hashHistory = [];
    this.oscillationCount = 0;
    this.killed = false;

    const tick = (): void => {
      if (this.killed) return;

      const { budget, stallMs, silenceKillMs, getDiffHash, getLastEventTs, onKill } =
        this.opts;

      const elapsed = Date.now() - this.startTime;

      // 1. Wall-clock budget
      if (elapsed > budget.wallClockMs) {
        this.fireKill(
          onKill,
          'timeout',
          `wall-clock budget ${budget.wallClockMs}ms exceeded (elapsed ${elapsed}ms)`,
        );
        return;
      }

      // 2. Hard silence: worker emits nothing at all for too long (hung call).
      const silence = Date.now() - getLastEventTs();
      if (silence > silenceKillMs) {
        this.fireKill(
          onKill,
          'no-progress',
          `worker produced no output for ${Math.round(silence / 1000)}s (silence limit ${Math.round(silenceKillMs / 1000)}s)`,
        );
        return;
      }

      // 3. No-progress detection: diff frozen AND heartbeat stale.
      const hash = getDiffHash();
      const stale = silence > stallMs;
      if (hash === this.prevHash && stale) {
        this.noProgressCount++;
      } else {
        this.noProgressCount = 0;
      }

      // 4. Oscillation: the diff KEEPS CHANGING but cycles through previously
      // seen states (the "add a letter, remove a letter" failure mode).
      if (hash !== this.prevHash && this.hashHistory.includes(hash)) {
        this.oscillationCount++;
      }
      this.hashHistory.push(hash);
      if (this.hashHistory.length > 8) this.hashHistory.shift();
      this.prevHash = hash;

      if (this.noProgressCount >= 2) {
        this.fireKill(
          onKill,
          'no-progress',
          `worktree diff unchanged for ${this.noProgressCount} consecutive checkpoints and no worker output for >${stallMs}ms`,
        );
        return;
      }
      if (this.oscillationCount >= 2) {
        this.fireKill(
          onKill,
          'no-progress',
          'worktree diff is oscillating between previously seen states (cycle detected) - the worker is undoing its own work',
        );
      }
    };

    this.timer = setInterval(tick, this.opts.checkpointMs);
    // Allow the process to exit even if this timer is still active
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private fireKill(
    onKill: CheckpointerOpts['onKill'],
    reason: 'timeout' | 'no-progress',
    diagnosis: string,
  ): void {
    if (this.killed) return;
    this.killed = true;
    this.stop();
    onKill(reason, diagnosis);
  }
}
