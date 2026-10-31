import type { Clock } from '../../time/clock.js';
import { TARGET_NAMES, TARGETS, type TargetName } from './catalog.js';

export interface Effect {
  id: string;
  target: TargetName;
  fields: Record<string, string>;
  clientRef: string | null;
  atMs: number;
}

export interface Commit {
  effect: Effect;
  duplicate: boolean;
}

function emptyTruth(): Record<TargetName, Effect[]> {
  return Object.fromEntries(TARGET_NAMES.map((target) => [target, []])) as unknown as Record<TargetName, Effect[]>;
}

function copy(effect: Effect): Effect {
  return { ...effect, fields: { ...effect.fields } };
}

export class EffectStore {
  private effects = emptyTruth();
  private nextReference = 1;

  constructor(
    private readonly clock: Clock,
    private readonly honourIdempotencyKey: boolean,
  ) {}

  commit(target: TargetName, fields: Record<string, string>, clientRef: string | null): Commit {
    const existing = this.effects[target];
    if (this.honourIdempotencyKey && clientRef !== null) {
      const earlier = existing.find((effect) => effect.clientRef === clientRef);
      if (earlier !== undefined) return { effect: copy(earlier), duplicate: true };
    }
    const effect: Effect = { id: `${TARGETS[target].idPrefix}-${existing.length + 1}`, target, fields: { ...fields }, clientRef, atMs: this.clock.nowMs() };
    existing.push(effect);
    return { effect: copy(effect), duplicate: false };
  }

  list(target: TargetName): Effect[] {
    return this.effects[target].map(copy);
  }

  truth(): Record<TargetName, Effect[]> {
    return Object.fromEntries(TARGET_NAMES.map((target) => [target, this.list(target)])) as unknown as Record<TargetName, Effect[]>;
  }

  issueReference(): string {
    return `F-${this.nextReference++}`;
  }

  reset(): void {
    this.effects = emptyTruth();
    this.nextReference = 1;
  }
}
