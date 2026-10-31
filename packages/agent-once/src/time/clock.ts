export interface Clock {
  nowMs(): number;
  setTimer(ms: number, fn: () => void): { cancel(): void };
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  setTimer(ms, fn) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

interface PendingTimer {
  dueMs: number;
  order: number;
  fn: () => void;
}

export class ManualClock implements Clock {
  private currentMs: number;
  private nextOrder = 0;
  private readonly pending = new Set<PendingTimer>();

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimer(ms: number, fn: () => void): { cancel(): void } {
    const timer: PendingTimer = { dueMs: this.currentMs + Math.max(0, ms), order: this.nextOrder++, fn };
    this.pending.add(timer);
    return { cancel: () => this.pending.delete(timer) };
  }

  advance(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`ManualClock cannot advance by ${ms} ms`);
    const targetMs = this.currentMs + ms;
    for (let timer = this.earliestDueBy(targetMs); timer !== undefined; timer = this.earliestDueBy(targetMs)) {
      this.pending.delete(timer);
      this.currentMs = timer.dueMs;
      timer.fn();
    }
    this.currentMs = targetMs;
  }

  private earliestDueBy(limitMs: number): PendingTimer | undefined {
    let earliest: PendingTimer | undefined;
    for (const timer of this.pending) {
      if (timer.dueMs > limitMs) continue;
      if (earliest === undefined || timer.dueMs < earliest.dueMs || (timer.dueMs === earliest.dueMs && timer.order < earliest.order)) {
        earliest = timer;
      }
    }
    return earliest;
  }
}
