# TypeScript

```bash
npm install agent-once
```

Node.js 22.13 or later. One package, with subpath exports:

| Import | Contents |
|---|---|
| `agent-once` | The core: `Guard`, ledgers, identity, evidence sinks, `guardedFetch`, clocks |
| `agent-once/mcp` | The proxy as a library: `createGuardedProxy`, config parsing, browser rules, resolvers |
| `agent-once/claude-agent-sdk` | Claude Agent SDK helpers ([claude-agent-sdk.md](claude-agent-sdk.md)) |
| `agent-once/playwright-mcp` | `playwrightMcpServer()`, a guarded Playwright MCP server command |
| `agent-once/chaos` | Chaos targets, scenarios and the runner ([chaos.md](chaos.md)) |
| `agent-once/vitest` | vitest matchers and `startChaosTargets` ([ci.md](ci.md)) |

The ledger uses `node:sqlite`. Loading it wraps `process.emitWarning` for the life of the process so Node's ExperimentalWarning about `node:sqlite` is not printed; every other warning passes through unchanged.

## A guard

```ts
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Guard, JsonlEvidenceSink, SqliteLedgerStore, defaultLedgerPath, systemClock } from 'agent-once';

const store = SqliteLedgerStore.open(defaultLedgerPath(process.env, homedir()), systemClock);
export const guard = new Guard({
  store,
  clock: systemClock,
  runInstance: randomUUID(),
  evidence: new JsonlEvidenceSink('agent-once-events.jsonl'),
});
```

`GuardDeps`:

| Option | Default | Meaning |
|---|---|---|
| `store` | required | `SqliteLedgerStore.open(path, clock, { busyTimeoutMs })` or `new MemoryLedgerStore(clock)` |
| `clock` | required | `systemClock`, or `new ManualClock(startMs)` in tests |
| `runInstance` | required | One id per run. Reruns use a new id; that is how replays of crashed runs are told apart from deliberate repeats. |
| `evidence` | required | An `EvidenceSink` (below) |
| `humanResolver` | none | Asked for `block-on-doubt` actions in doubt |
| `retryWindowMs` | `120000` | A failure retried inside this window is held as in doubt |
| `expiryMs` | `86400000` | Ledger event lifetime |
| `settleWindowMs` | `10000` | Minimum age before `not_happened` is accepted |
| `storeArgs` | `true` | Store arguments in the ledger (`false` keeps only hashes) |
| `maxResultBytes` | `262144` | Larger results are stored as a truncated marker |
| `onEvidenceError` | write to stderr | Called when an evidence sink throws; the call itself is unaffected |

`settleWindowMs` must not exceed `retryWindowMs`, or the constructor throws a `RangeError`. With the default settle window that means `retryWindowMs` must be at least `10000`; lower both together.

## Wrapping a function

`guard.wrap` returns a function with the same arguments that returns the result, replays the recorded result, or throws:

```ts
import { ActionInDoubtError, Guard, MemoryLedgerStore, systemClock } from 'agent-once';

const guard = new Guard({ store: new MemoryLedgerStore(systemClock), clock: systemClock, runInstance: 'run-1', evidence: { emit: () => {} } });

const sendInvoice = guard.wrap(
  { tool: 'send_invoice', sessionKey: 'billing-run-7', sessionExplicit: true, policy: 'block-on-doubt', toolClass: 'irreversible' },
  async (args: { customer: string; amountCents: number }) => ({ sent: true, customer: args.customer }),
);

try {
  await sendInvoice({ customer: 'c_42', amountCents: 1999 });
} catch (error) {
  if (error instanceof ActionInDoubtError) console.error(`ask a person: ${error.doubt.actionId}, blocked: ${error.blocked}`);
  else throw error;
}
```

It throws `ActionInDoubtError` (with `doubt` and `blocked`) when the call is in doubt or blocked, the function's own error when it threw, and `GuardedCallFailedError` for an error outcome or an unavailable ledger.

## Running a call

`guard.run` gives you the full `GuardResult` and lets your code report success, an error result, or "not dispatched":

```ts
import { Guard, MemoryLedgerStore, systemClock, type GuardedCall, type ToolOutcome } from 'agent-once';

const guard = new Guard({ store: new MemoryLedgerStore(systemClock), clock: systemClock, runInstance: 'run-1', evidence: { emit: () => {} } });

const call: GuardedCall = {
  tool: 'book_slot',
  args: { slot: '2026-11-03 10:00', name: 'Sam Rivers' },
  sessionKey: 'assistant-session-3',
  sessionExplicit: true,
  policy: 'guard',
  toolClass: 'standard',
};

const result = await guard.run(call, async ({ actionId, idempotencyKey }): Promise<ToolOutcome> => {
  const reply = await fetch('https://booking.example.com/api/book', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey ?? '' },
    body: JSON.stringify(call.args),
  });
  if (reply.status === 409) return { kind: 'not_dispatched', error: 'slot form was stale' };
  const body = await reply.text();
  return reply.ok ? { kind: 'ok', result: { actionId: actionId ?? null, body } } : { kind: 'error_result', result: { status: reply.status, body } };
});

switch (result.status) {
  case 'executed':
  case 'passed':
    console.log(result.outcome);
    break;
  case 'replayed':
    console.log('already booked', result.result);
    break;
  case 'in_doubt':
  case 'blocked':
    console.log('not repeated; resolve', result.doubt.actionId);
    break;
  case 'retry_by_agent':
    console.log('did not happen; check the page and call again');
    break;
  case 'ledger_unavailable':
    console.error(result.error);
    break;
}
```

`run` throws `CanonicalizationError` before dispatch when the arguments contain `NaN` or `Infinity`. A thrown `execute` is recorded as a transport error (in doubt).

## HTTP with Idempotency-Key

`guardedFetch` runs a request under the guard and sets the `Idempotency-Key` header to the guard's key unless you set one:

```ts
import { Guard, MemoryLedgerStore, guardedFetch, systemClock } from 'agent-once';

const guard = new Guard({ store: new MemoryLedgerStore(systemClock), clock: systemClock, runInstance: 'run-1', evidence: { emit: () => {} } });

const order = { item: 'Blue mug', qty: 1 };
const result = await guardedFetch(
  guard,
  { tool: 'create_charge', args: order, sessionKey: 'shopper-17', sessionExplicit: true, policy: 'block-on-doubt', toolClass: 'money' },
  'https://payments.example.com/v1/charges',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) },
);
if (result.status === 'executed') console.log(result.outcome);
```

A 2xx response is `ok` and anything else an error result, both recorded as `{ status, body }`. With a service that honours the header (Stripe and many payment and booking APIs do), a late retry by the guard reuses the earlier key and the service deduplicates it. If that service caches error responses per key, the retry gets the same error back.

## Reconcilers

A reconciler checks whether an in-doubt action happened. Return `happened` (optionally with the result to replay), `not_happened`, or `unknown`:

```ts
import { Guard, MemoryLedgerStore, systemClock, type Reconciler } from 'agent-once';

const guard = new Guard({ store: new MemoryLedgerStore(systemClock), clock: systemClock, runInstance: 'run-1', evidence: { emit: () => {} } });

const findCharge: Reconciler = async ({ event }) => {
  const key = typeof event.detail.idempotency_key === 'string' ? event.detail.idempotency_key : event.actionId;
  const reply = await fetch(`https://payments.example.com/v1/charges?idempotency_key=${encodeURIComponent(key)}`);
  if (!reply.ok) return { outcome: 'unknown', reason: `lookup failed with ${reply.status}` };
  const charges = (await reply.json()) as unknown[];
  return charges.length > 0 ? { outcome: 'happened', result: { charged: true } } : { outcome: 'not_happened' };
};

await guard.run(
  { tool: 'create_charge', args: { amountCents: 1999 }, sessionKey: 'shopper-17', sessionExplicit: true, policy: 'block-on-doubt', toolClass: 'money', reconciler: findCharge },
  async () => ({ kind: 'ok', result: { charged: true } }),
);
```

`not_happened` is accepted only after the settle window; earlier it counts as unknown. With a reconciler, money actions run unattended: "at most once by default, exactly once wherever a reconciler can confirm the outcome".

## Intent keys and resolution

- Set `intentKey` on the call when your code knows the intent exactly (an order id, a message id). Identity then ignores the arguments, and a repeat replays for the whole ledger expiry.
- `identityRule: { include: [...] }` or `{ exclude: [...] }` picks the top-level arguments that make up the intent.
- `guard.resolve(actionId, 'happened' | 'not_happened', 'human' | 'webhook' | 'agent')` records an answer. Agents may resolve only `standard` actions and not `not_happened` inside the settle window.
- A `humanResolver` (`{ resolve(doubt, signal) }` returning `{ outcome: 'happened' | 'not_happened', by }` or `{ outcome: 'unresolved' }`) is asked for `block-on-doubt` doubts.

## Evidence

```ts
import { FanoutEvidenceSink, JsonlEvidenceSink, OtelEvidenceSink } from 'agent-once';

const otel = await OtelEvidenceSink.create();
export const evidence = new FanoutEvidenceSink([new JsonlEvidenceSink('agent-once-events.jsonl'), otel]);
```

`OtelEvidenceSink.create()` loads `@opentelemetry/api` if it is installed and adds `agent_once.*` events to the active span; without the package it does nothing. Each event has `v`, `atMs`, `kind` (`decision`, `state`, `resolve`, `reconcile`), `actionId`, `tool`, `sessionKey` and `detail`.

## Tests

Use `MemoryLedgerStore` and `ManualClock` for deterministic tests, and two `Guard` objects with different `runInstance` values to simulate a rerun:

```ts
import { Guard, ManualClock, MemoryLedgerStore } from 'agent-once';

const clock = new ManualClock(1_761_912_345_678);
const store = new MemoryLedgerStore(clock);
const first = new Guard({ store, clock, runInstance: 'run-1', evidence: { emit: () => {} } });
const rerun = new Guard({ store, clock, runInstance: 'run-2', evidence: { emit: () => {} } });

const call = { tool: 'place_order', args: { item: 'Blue mug' }, sessionKey: 'shopper', sessionExplicit: true, policy: 'guard', toolClass: 'standard' } as const;
let placed = 0;
const placeOrder = async () => ({ kind: 'ok', result: { order: ++placed } }) as const;

await first.run(call, placeOrder);
clock.advance(1_000);
const again = await rerun.run(call, placeOrder);
console.log(again.status, placed);
```

This prints `replayed 1`.
