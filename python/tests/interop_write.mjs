import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST = new URL('../../packages/agent-once/dist/index.js', import.meta.url);

if (!existsSync(fileURLToPath(DIST))) {
  process.stderr.write(`interop: the TypeScript build is missing at ${fileURLToPath(DIST)}; run npm run build first\n`);
  process.exit(3);
}

const { DEFAULT_VOLATILE_KEYS, Guard, ManualClock, SqliteLedgerStore, decide, intentHash, projectArgs } = await import(DIST.href);

const [mode, dbPath, scenarioJson] = process.argv.slice(2);
if ((mode !== 'write' && mode !== 'read') || dbPath === undefined || scenarioJson === undefined) {
  process.stderr.write('usage: node interop_write.mjs <write|read> <ledger.db> <scenario json>\n');
  process.exit(2);
}
const scenario = JSON.parse(scenarioJson);
const NAMES = ['confirmed', 'sent'];
const silent = { emit() {} };

function callFor(name) {
  const spec = scenario[name];
  return {
    tool: spec.tool,
    args: spec.args,
    sessionKey: scenario.session_key,
    sessionExplicit: true,
    policy: spec.policy,
    toolClass: spec.tool_class,
  };
}

function hashFor(name) {
  const call = callFor(name);
  return intentHash({ sessionKey: call.sessionKey, tool: call.tool, projectedArgs: projectArgs(call.args, undefined, DEFAULT_VOLATILE_KEYS) });
}

function snake(event) {
  if (event === undefined) return null;
  return {
    seq: event.seq,
    action_id: event.actionId,
    intent_hash: event.intentHash,
    occurrence: event.occurrence,
    state: event.state,
    at_ms: event.atMs,
    expires_at_ms: event.expiresAtMs,
    session_key: event.sessionKey,
    session_explicit: event.sessionExplicit,
    intent_key_explicit: event.intentKeyExplicit,
    run_instance: event.runInstance,
    tool: event.tool,
    tool_class: event.toolClass,
    policy: event.policy,
    args_json: event.argsJson,
    detail: event.detail,
  };
}

function crashingAfterDispatch(store) {
  let transactions = 0;
  return {
    transact(fn) {
      transactions += 1;
      if (transactions === 3) throw new Error('the process died before recording the outcome');
      return store.transact(fn);
    },
    findAction: (actionId) => store.findAction(actionId),
    listInDoubt: (nowMs) => store.listInDoubt(nowMs),
    close: () => store.close(),
  };
}

async function write() {
  const clock = new ManualClock(scenario.start_ms);
  const store = SqliteLedgerStore.open(dbPath, clock);
  try {
    const writer = { store, clock, runInstance: scenario.writer_run_instance, evidence: silent };
    await new Guard(writer).run(callFor('confirmed'), async () => ({ kind: 'ok', result: scenario.confirmed.result }));
    clock.advance(scenario.step_ms);
    await new Guard({ ...writer, store: crashingAfterDispatch(store) }).run(callFor('sent'), async () => ({ kind: 'ok', result: null }));
  } finally {
    store.close();
  }
}

function report() {
  const clock = new ManualClock(scenario.read_at_ms);
  const store = SqliteLedgerStore.open(dbPath, clock);
  try {
    const intents = {};
    for (const name of NAMES) {
      const hash = hashFor(name);
      const latest = store.transact((tx) => tx.latest(hash));
      const decision = decide({
        latest,
        nowMs: scenario.read_at_ms,
        retryWindowMs: scenario.retry_window_ms,
        call: { runInstance: scenario.reader_run_instance, sessionExplicit: true, intentKeyExplicit: false, policy: scenario[name].policy },
      });
      intents[name] = {
        intent_hash: hash,
        latest: snake(latest),
        decision: { kind: decision.kind, reason: decision.reason, occurrence: decision.kind === 'execute' ? decision.occurrence : decision.event.occurrence },
      };
    }
    return intents;
  } finally {
    store.close();
  }
}

async function guardOutcomes() {
  const clock = new ManualClock(scenario.read_at_ms);
  const store = SqliteLedgerStore.open(dbPath, clock);
  const results = {};
  let dispatched = 0;
  try {
    const guard = new Guard({ store, clock, runInstance: scenario.reader_run_instance, evidence: silent });
    for (const name of NAMES) {
      const result = await guard.run(callFor(name), async () => {
        dispatched += 1;
        return { kind: 'ok', result: null };
      });
      results[name] = { status: result.status, reason: result.reason ?? result.doubt?.reason ?? null, result: result.result ?? null };
    }
  } finally {
    store.close();
  }
  return { results, dispatched };
}

if (mode === 'write') await write();
const output = { intents: report() };
if (mode === 'read') output.guard = await guardOutcomes();
process.stdout.write(`${JSON.stringify(output)}\n`);
