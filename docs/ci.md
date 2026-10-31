# CI

Run the chaos suite on every change so a regression in your agent, your tools or your agent-once config shows up as a duplicate order in CI, not in production.

## GitHub Action

```yaml
jobs:
  chaos:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: ajibadedapo/agent-once@<commit-sha>
        with:
          agent-once-version: 0.1.0
          agent-command: node ./scripts/chaos-agent.js
          scenarios: lost_response_after_commit,slow_commit,crash_mid_run
          targets: checkout,booking
          guard: "on"
          runs: "3"
```

Pin the action to a full commit SHA and set `agent-once-version` to an exact version. The default, `latest`, floats with every release.

| Input | Default | Meaning |
|---|---|---|
| `agent-command` | required | The command that starts your agent ([chaos.md](chaos.md#your-own-agent) lists the environment it receives), or `scripted:naive` or `scripted:obedient` |
| `scenarios` | `all` | Comma-separated scenarios |
| `targets` | `all` | Comma-separated targets: checkout, booking, email, ticket |
| `guard` | `on` | `on`, `off` or `both` |
| `runs` | `3` | Runs per scenario and target |
| `fail-on-duplicates` | `true` | Fail the step when a guarded run duplicated an effect |
| `agent-once-version` | `latest` | The npm version run with `npx`, or `local` to build the checkout the action was loaded from |
| `artifact-name` | `agent-once-chaos` | Name of the uploaded JSON report; make it unique per job and matrix entry |

The action needs Node.js 22.13 or later on the runner. It writes the Markdown report to the job summary and uploads `<artifact-name>.json` with every run record.

## vitest

`agent-once/vitest` starts the chaos targets inside a test and adds two matchers. vitest 5 is an optional peer dependency.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, test } from 'vitest';
import { startChaosTargets, type ChaosHandle } from 'agent-once/vitest';

const handles: ChaosHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

test('a retry after a lost response does not place a second order', async () => {
  const chaos = await startChaosTargets({ faults: [{ target: 'checkout', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 }] });
  handles.push(chaos);
  const [command = '', ...args] = chaos.mcpCommand(true);
  const client = new Client({ name: 'chaos-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command, args }));
  try {
    const order = { name: 'place_order', arguments: { item: 'Blue mug', qty: 1 } };
    await client.callTool(order);
    await client.callTool(order);
  } finally {
    await client.close();
  }
  expect(chaos).toHaveNoDuplicateEffects();
  expect(chaos).toHaveExactlyOneEffect('checkout');
}, 30_000);
```

- `startChaosTargets({ faults?, clock?, cli? })` returns `{ url, adminToken, mcpCommand(guard), truth(), close() }`. `adminToken` is the value for the `x-agent-once-admin-token` header if you call the control endpoints over HTTP yourself.
- `mcpCommand(true)` is the argv of the targets MCP server wrapped by the agent-once proxy with the chaos preset (read-backs for all four targets); `mcpCommand(false)` is the bare server. Start your agent with it.
- `toHaveNoDuplicateEffects()` fails when a target holds two effects with the same fields; `toHaveExactlyOneEffect(target)` fails unless the target holds exactly one effect.

The test above plays the agent itself: the first `place_order` commits but the target drops the connection before answering, so the call fails; the retry is checked against `list_orders` by the preset's read-back and replayed, and the target holds one order. Without the guard (`mcpCommand(false)`) it holds two. In your own tests, start your agent with the same command instead.

## pytest

Installing `once-guard` adds the `once_guard`, `once_clock` and `agent_once_chaos_targets` fixtures and the `chaos` marker; see [python.md](python.md#pytest).

## Without the action

```bash
npx --yes agent-once@0.1.0 chaos run --agent "node ./scripts/chaos-agent.js" --guard on --runs 3 --fail-on-duplicates --markdown chaos.md --json chaos.json
```

exits 1 when a guarded run duplicated an effect.
