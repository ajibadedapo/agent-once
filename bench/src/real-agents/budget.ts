export class SpendBudget {
  private spent = 0;
  private largestRun = 0;
  private stopped = false;

  constructor(readonly limitUsd: number) {
    if (!(limitUsd > 0) || !Number.isFinite(limitUsd)) throw new Error(`a spend limit must be a positive number of dollars, got ${limitUsd}`);
  }

  get spentUsd(): number {
    return this.spent;
  }

  get stoppedAtLimit(): boolean {
    return this.stopped;
  }

  remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }

  canLaunch(): boolean {
    const fits = this.remainingUsd() > 0 && this.spent + this.largestRun <= this.limitUsd;
    if (!fits) this.stopped = true;
    return fits;
  }

  record(costUsd: number | null, runCapUsd: number): void {
    const charged = costUsd ?? runCapUsd;
    this.spent += charged;
    this.largestRun = Math.max(this.largestRun, charged);
  }
}
