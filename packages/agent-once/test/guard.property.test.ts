import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Guard } from '../src/guard/guard.js';
import type { GuardResult, ReconcileOutcome, ToolOutcome } from '../src/guard/types.js';
import type { GuardPolicy } from '../src/ledger/types.js';
import { MemoryLedgerStore } from '../src/ledger/memory-store.js';
import { ManualClock } from '../src/time/clock.js';
import { RecordingSink, START_MS, deferred, guardedCall } from './guard-harness.js';

const SETTLE_WINDOW_MS = 10_000;
const LANDING_DELAY_MS = 4_321;
const MAX_INTENTS = 3;
const GUARDS = 2;
const PROPERTY_CONFIG = { seed: 1_761_912_345, numRuns: Number(process.env.AGENT_ONCE_PROPERTY_RUNS ?? 500) };

const FAULTS = ['none', 'lost_after_commit', 'timeout_before_commit', 'slow_commit_then_land', 'not_dispatched'] as const;
type Fault = (typeof FAULTS)[number];

type Command =
  | { kind: 'call' | 'start'; guard: number; intent: number; fault: Fault }
  | { kind: 'release'; slot: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'resolve'; guard: number; intent: number };

const guardArb = fc.integer({ min: 0, max: GUARDS - 1 });
const intentArb = fc.integer({ min: 0, max: MAX_INTENTS - 1 });

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('call' as const), guard: guardArb, intent: intentArb, fault: fc.constantFrom(...FAULTS) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('start' as const), guard: guardArb, intent: intentArb, fault: fc.constantFrom(...FAULTS) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('release' as const), slot: fc.nat({ max: 7 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 200_000 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('resolve' as const), guard: guardArb, intent: intentArb }) },
);

interface Scenario {
  intents: number;
  policy: GuardPolicy;
  withReconciler: boolean;
  commands: Command[];
}

const scenarioArb = (withReconciler: fc.Arbitrary<boolean>): fc.Arbitrary<Scenario> =>
  fc.record({
    intents: fc.integer({ min: 1, max: MAX_INTENTS }),
    policy: fc.constantFrom<GuardPolicy>('guard', 'block-on-doubt'),
    withReconciler,
    commands: fc.array(commandArb, { maxLength: 40, size: 'max' }),
  });

function toolFor(intent: number): string {
  return `create_ticket_${intent}`;
}

interface Gated {
  release: () => void;
  settled: Promise<void>;
}

class World {
  readonly clock = new ManualClock(START_MS);
  readonly evidence = new RecordingSink();
  readonly store = new MemoryLedgerStore(this.clock);
  readonly guards: Guard[];
  readonly effects: number[];
  readonly done: boolean[];
  readonly doubts: Array<string | undefined>;
  private readonly gated: Gated[] = [];
  private readonly waiting: Array<Promise<void>> = [];
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly scenario: Scenario) {
    this.guards = Array.from(
      { length: GUARDS },
      (_, index) =>
        new Guard({
          store: this.store,
          clock: this.clock,
          runInstance: `proc-${index}`,
          evidence: this.evidence,
          settleWindowMs: SETTLE_WINDOW_MS,
          humanResolver: { resolve: async () => ({ outcome: 'unresolved' }) },
        }),
    );
    this.effects = new Array<number>(scenario.intents).fill(0);
    this.done = new Array<boolean>(scenario.intents).fill(false);
    this.doubts = new Array<string | undefined>(scenario.intents).fill(undefined);
  }

  async call(guardIndex: number, intent: number, fault: Fault, start: boolean): Promise<void> {
    const guard = this.guards[guardIndex % GUARDS];
    if (guard === undefined) throw new Error('no guard');
    const key = `${guardIndex}:${intent}`;
    const gate = deferred<void>();
    const dispatched = deferred<void>();
    const reconciler = this.scenario.withReconciler ? async (): Promise<ReconcileOutcome> => this.truth(intent) : undefined;
    const call = guardedCall({ tool: toolFor(intent), args: { intent }, policy: this.scenario.policy, ...(reconciler === undefined ? {} : { reconciler }) });
    const joinsGated = (this.inFlight.get(key) ?? 0) > 0;
    const gated = start && !joinsGated;
    if (gated) this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    const settled = guard
      .run(call, async () => {
        const outcome = this.perform(intent, fault);
        dispatched.resolve();
        if (gated) await gate.promise;
        return outcome;
      })
      .then((result) => {
        if (gated) this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
        this.observe(intent, result);
      });
    if (gated) {
      this.gated.push({ release: () => gate.resolve(), settled });
      await Promise.race([settled, dispatched.promise]);
    } else if (joinsGated) this.waiting.push(settled);
    else await settled;
  }

  async release(slot: number): Promise<void> {
    if (this.gated.length === 0) return;
    const [entry] = this.gated.splice(slot % this.gated.length, 1);
    if (entry === undefined) return;
    entry.release();
    await entry.settled;
  }

  async releaseAll(): Promise<void> {
    while (this.gated.length > 0) await this.release(0);
    await Promise.all(this.waiting.splice(0));
  }

  resolve(guardIndex: number, intent: number): void {
    const doubt = this.doubts[intent];
    const guard = this.guards[guardIndex % GUARDS];
    if (doubt === undefined || guard === undefined) return;
    const outcome = this.truth(intent).outcome === 'happened' ? 'happened' : 'not_happened';
    const resolved = guard.resolve(doubt, outcome, 'agent');
    if (!resolved.ok) return;
    this.doubts[intent] = undefined;
    if (outcome === 'happened') this.done[intent] = true;
  }

  repeatsDecided(intent: number): number {
    const happened = new Set<number>();
    let count = 0;
    for (const event of this.evidence.events) {
      if (event.tool !== toolFor(intent)) continue;
      const occurrence = Number(event.detail.occurrence);
      const state = event.detail.state;
      if (event.kind === 'state' && (state === 'confirmed' || (state === 'reconciled' && event.detail.outcome === 'happened'))) happened.add(occurrence);
      if (event.kind !== 'decision' || event.detail.decision !== 'execute') continue;
      if (event.detail.reason === 'deliberate_repeat') count += 1;
      if (event.detail.reason === 'failed_after_window' && !happened.has(occurrence - 1)) count += 1;
    }
    return count;
  }

  private observe(intent: number, result: GuardResult): void {
    if ((result.status === 'executed' && result.outcome.kind === 'ok') || result.status === 'replayed') {
      this.done[intent] = true;
      this.doubts[intent] = undefined;
    }
    if (result.status === 'in_doubt' || result.status === 'blocked') this.doubts[intent] = result.doubt.actionId;
  }

  private truth(intent: number): ReconcileOutcome {
    return (this.effects[intent] ?? 0) > 0 ? { outcome: 'happened', result: { intent } } : { outcome: 'not_happened' };
  }

  private perform(intent: number, fault: Fault): ToolOutcome {
    const land = () => {
      this.effects[intent] = (this.effects[intent] ?? 0) + 1;
    };
    switch (fault) {
      case 'none':
        land();
        return { kind: 'ok', result: { intent } };
      case 'lost_after_commit':
        land();
        return { kind: 'transport_error', error: 'connection reset after commit' };
      case 'timeout_before_commit':
        return { kind: 'transport_error', error: 'timed out before commit' };
      case 'slow_commit_then_land':
        this.clock.setTimer(LANDING_DELAY_MS, land);
        return { kind: 'transport_error', error: 'timed out, commit still in flight' };
      case 'not_dispatched':
        return { kind: 'not_dispatched', error: 'stale element ref' };
    }
  }
}

async function play(world: World, scenario: Scenario, stopWhenDone: boolean): Promise<void> {
  for (const command of scenario.commands) {
    switch (command.kind) {
      case 'advance':
        world.clock.advance(command.ms);
        break;
      case 'release':
        await world.release(command.slot);
        break;
      case 'resolve':
        world.resolve(command.guard, command.intent % scenario.intents);
        break;
      case 'call':
      case 'start': {
        const intent = command.intent % scenario.intents;
        if (!(stopWhenDone && world.done[intent])) await world.call(command.guard, intent, command.fault, command.kind === 'start');
        break;
      }
    }
  }
  await world.releaseAll();
}

describe('Guard properties', () => {
  test('effects per intent never exceed one within the expiry window unless a deliberate repeat was decided', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb(fc.boolean()), async (scenario) => {
        const world = new World(scenario);
        await play(world, scenario, false);
        world.clock.advance(SETTLE_WINDOW_MS);
        for (let intent = 0; intent < scenario.intents; intent += 1) {
          expect(world.effects[intent]).toBeLessThanOrEqual(1 + world.repeatsDecided(intent));
        }
      }),
      PROPERTY_CONFIG,
    );
  });

  test('with retries continued past the settle window every intent ends with exactly one effect', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb(fc.constant(true)), async (scenario) => {
        const world = new World(scenario);
        await play(world, scenario, true);
        for (let intent = 0; intent < scenario.intents; intent += 1) {
          for (let attempt = 0; attempt < 4 && !world.done[intent]; attempt += 1) {
            world.clock.advance(SETTLE_WINDOW_MS);
            await world.call(0, intent, 'none', false);
          }
        }
        world.clock.advance(SETTLE_WINDOW_MS);
        expect(world.done).toEqual(new Array<boolean>(scenario.intents).fill(true));
        expect(world.effects).toEqual(new Array<number>(scenario.intents).fill(1));
      }),
      PROPERTY_CONFIG,
    );
  });
});
