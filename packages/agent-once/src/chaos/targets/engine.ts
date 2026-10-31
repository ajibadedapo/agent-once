import type { Clock } from '../../time/clock.js';
import type { TargetName } from './catalog.js';
import { FaultInjector, type FaultPlan } from './faults.js';
import { EffectStore, type Commit, type Effect } from './store.js';

export type MutationOutcome = { kind: 'committed'; commit: Commit } | { kind: 'stale' } | { kind: 'dropped' };

export interface Mutation {
  target: TargetName;
  fields: Record<string, string>;
  clientRef: string | null;
  arrivalMs: number;
}

export class TargetsEngine {
  private readonly store: EffectStore;
  private readonly faults = new FaultInjector();
  private readonly pending = new Set<{ cancel(): void }>();
  private readonly generations = new Map<TargetName, number>();

  constructor(
    private readonly clock: Clock,
    honourIdempotencyKey: boolean,
  ) {
    this.store = new EffectStore(clock, honourIdempotencyKey);
  }

  mutate(mutation: Mutation): MutationOutcome {
    const fault = this.faults.next(mutation.target);
    switch (fault.kind) {
      case 'none':
        return { kind: 'committed', commit: this.commit(mutation) };
      case 'lost_response_after_commit':
        this.commit(mutation);
        return { kind: 'dropped' };
      case 'slow_commit':
        this.commitLater(mutation, mutation.arrivalMs + fault.holdMs);
        return { kind: 'dropped' };
      case 'timeout_before_commit':
        return { kind: 'dropped' };
      case 'stale_element':
        this.generations.set(mutation.target, this.generation(mutation.target) + 1);
        return { kind: 'stale' };
    }
  }

  generation(target: TargetName): number {
    return this.generations.get(target) ?? 1;
  }

  issueReference(): string {
    return this.store.issueReference();
  }

  list(target: TargetName): Effect[] {
    return this.store.list(target);
  }

  truth(): Record<TargetName, Effect[]> {
    return this.store.truth();
  }

  setFaults(plan: FaultPlan): void {
    this.faults.setPlan(plan);
  }

  pendingCommits(): number {
    return this.pending.size;
  }

  reset(): void {
    this.cancelPending();
    this.store.reset();
    this.faults.reset();
    this.generations.clear();
  }

  cancelPending(): void {
    for (const timer of this.pending) timer.cancel();
    this.pending.clear();
  }

  private commit(mutation: Mutation): Commit {
    return this.store.commit(mutation.target, mutation.fields, mutation.clientRef);
  }

  private commitLater(mutation: Mutation, dueMs: number): void {
    if (dueMs <= this.clock.nowMs()) {
      this.commit(mutation);
      return;
    }
    const timer = this.clock.setTimer(dueMs - this.clock.nowMs(), () => {
      this.pending.delete(timer);
      this.commit(mutation);
    });
    this.pending.add(timer);
  }
}
