import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { Guard } from '../src/guard/guard.js';
import type { GuardResult, ReconcileOutcome, ToolOutcome } from '../src/guard/types.js';
import type { GuardPolicy } from '../src/ledger/types.js';
import { MemoryLedgerStore } from '../src/ledger/memory-store.js';
import { ManualClock } from '../src/time/clock.js';
import { RecordingSink, START_MS, guardedCall } from './guard-harness.js';

const SETTLE_WINDOW_MS = 10_000;
const LANDING_DELAY_MS = 4_321;
const MAX_INTENTS = 3;
const REPEAT_REASONS = new Set(['deliberate_repeat', 'failed_after_window']);
const PROPERTY_CONFIG = { seed: 1_761_912_345, numRuns: Number(process.env.AGENT_ONCE_PROPERTY_RUNS ?? 500) };

const FAULTS = ['none', 'lost_after_commit', 'timeout_before_commit', 'slow_commit_then_land', 'not_dispatched'] as const;
type Fault = (typeof FAULTS)[number];

type Command =
  | { kind: 'call'; intent: number; fault: Fault }
  | { kind: 'advance'; ms: number }
  | { kind: 'resolve'; intent: number };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('call' as const), intent: fc.integer({ min: 0, max: MAX_INTENTS - 1 }), fault: fc.constantFrom(...FAULTS) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 200_000 }) }),
  fc.record({ kind: fc.constant('resolve' as const), intent: fc.integer({ min: 0, max: MAX_INTENTS - 1 }) }),
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
    commands: fc.array(commandArb, { maxLength: 40 }),
  });

function toolFor(intent: number): string {
  return `create_ticket_${intent}`;
}

class World {
  readonly clock = new ManualClock(START_MS);
  readonly evidence = new RecordingSink();
  readonly guard = new Guard({
    store: new MemoryLedgerStore(this.clock),
    clock: this.clock,
    runInstance: 'run-1',
    evidence: this.evidence,
    settleWindowMs: SETTLE_WINDOW_MS,
    humanResolver: { resolve: async () => 'unresolved' },
  });
  readonly effects: number[];
  readonly done: boolean[];
  readonly doubts: Array<string | undefined>;

  constructor(private readonly scenario: Scenario) {
    this.effects = new Array<number>(scenario.intents).fill(0);
    this.done = new Array<boolean>(scenario.intents).fill(false);
    this.doubts = new Array<string | undefined>(scenario.intents).fill(undefined);
  }

  async call(intent: number, fault: Fault): Promise<GuardResult> {
    const reconciler = this.scenario.withReconciler ? async (): Promise<ReconcileOutcome> => this.truth(intent) : undefined;
    const call = guardedCall({ tool: toolFor(intent), args: { intent }, policy: this.scenario.policy, ...(reconciler === undefined ? {} : { reconciler }) });
    const result = await this.guard.run(call, async () => this.perform(intent, fault));
    if ((result.status === 'executed' && result.outcome.kind === 'ok') || result.status === 'replayed') {
      this.done[intent] = true;
      this.doubts[intent] = undefined;
    }
    if (result.status === 'in_doubt' || result.status === 'blocked') this.doubts[intent] = result.doubt.actionId;
    return result;
  }

  resolve(intent: number): void {
    const doubt = this.doubts[intent];
    if (doubt === undefined) return;
    const outcome = this.truth(intent).outcome === 'happened' ? 'happened' : 'not_happened';
    const resolved = this.guard.resolve(doubt, outcome, 'agent');
    if (!resolved.ok) return;
    this.doubts[intent] = undefined;
    if (outcome === 'happened') this.done[intent] = true;
  }

  repeatsDecided(intent: number): number {
    return this.evidence.events.filter(
      (event) =>
        event.kind === 'decision' &&
        event.tool === toolFor(intent) &&
        event.detail.decision === 'execute' &&
        REPEAT_REASONS.has(String(event.detail.reason)),
    ).length;
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
    if (command.kind === 'advance') {
      world.clock.advance(command.ms);
      continue;
    }
    const intent = command.intent % scenario.intents;
    if (command.kind === 'resolve') world.resolve(intent);
    else if (!(stopWhenDone && world.done[intent])) await world.call(intent, command.fault);
  }
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
            await world.call(intent, 'none');
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
