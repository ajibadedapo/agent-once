import { isTargetName, TARGET_NAMES, type TargetName } from './catalog.js';

export type FaultKind = 'none' | 'lost_response_after_commit' | 'connection_reset_after_commit' | 'slow_commit' | 'timeout_before_commit' | 'stale_element';

export type FaultPlan = { target: TargetName; nth: number; kind: FaultKind; holdMs: number }[];

export interface Fault {
  kind: FaultKind;
  holdMs: number;
}

export const FAULT_KINDS: readonly FaultKind[] = ['none', 'lost_response_after_commit', 'connection_reset_after_commit', 'slow_commit', 'timeout_before_commit', 'stale_element'];

const NO_FAULT: Fault = Object.freeze({ kind: 'none', holdMs: 0 });

export class FaultPlanError extends Error {
  override readonly name: string = 'FaultPlanError';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseFaultPlan(raw: unknown): FaultPlan {
  if (!Array.isArray(raw)) throw new FaultPlanError('a fault plan must be an array');
  return raw.map((entry: unknown, index) => {
    const fail = (problem: string): never => {
      throw new FaultPlanError(`fault ${index}: ${problem}`);
    };
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return fail('expected an object');
    const fields = entry as Record<string, unknown>;
    if (!isTargetName(fields.target)) return fail(`unknown target ${JSON.stringify(fields.target)}; expected one of ${TARGET_NAMES.join(', ')}`);
    if (!isNonNegativeInteger(fields.nth) || fields.nth < 1) return fail('nth must be a positive integer');
    const kind = fields.kind;
    if (typeof kind !== 'string' || !(FAULT_KINDS as readonly string[]).includes(kind)) {
      return fail(`unknown kind ${JSON.stringify(kind)}; expected one of ${FAULT_KINDS.join(', ')}`);
    }
    const holdMs = fields.holdMs ?? 0;
    if (!isNonNegativeInteger(holdMs)) return fail('holdMs must be a non-negative integer');
    return { target: fields.target, nth: fields.nth, kind: kind as FaultKind, holdMs };
  });
}

export class FaultInjector {
  private plan: FaultPlan = [];
  private readonly counts = new Map<TargetName, number>();

  setPlan(plan: FaultPlan): void {
    this.plan = parseFaultPlan(plan);
    this.counts.clear();
  }

  reset(): void {
    this.plan = [];
    this.counts.clear();
  }

  next(target: TargetName): Fault {
    const nth = (this.counts.get(target) ?? 0) + 1;
    this.counts.set(target, nth);
    const entry = this.plan.find((fault) => fault.target === target && fault.nth === nth);
    return entry === undefined ? NO_FAULT : { kind: entry.kind, holdMs: entry.holdMs };
  }
}
