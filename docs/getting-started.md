# Getting started

This walkthrough wraps the Playwright MCP server, makes a checkout lose its response on purpose, and shows agent-once stopping the second order. It takes a few minutes and needs Node.js 22.13 or later and an MCP client such as Claude Code.

## 1. Wrap the browser server

```bash
claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest
```

For Claude Desktop or Cursor, edit the client's MCP config so the server command starts with `agent-once mcp --`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["agent-once", "mcp", "--", "npx", "@playwright/mcp@latest"]
    }
  }
}
```

Nothing else is needed. agent-once reads the tool list, passes read-only tools straight through, and guards the calls that change something. For browser servers it guards clicks and submits whose button text, element description or page matches side-effect words such as pay, buy, checkout, book, confirm, submit, send, delete, publish, order, purchase, place, create and post. Other clicks pass through. See [browser.md](browser.md).

On Windows, agent-once starts the wrapped server without a shell, so write the inner command as `cmd /c npx @playwright/mcp@latest` or use the full path to `npx.cmd`.

## 2. Start a shop that loses responses

agent-once ships four small reference sites (checkout, booking, email, ticket) with a ground-truth API and fault injection:

```bash
npx agent-once chaos serve --port 4100
```

It prints `agent-once chaos targets listening on http://127.0.0.1:4100`. In another terminal, make the first checkout commit the order and then answer with a 504, as a gateway timeout would:

```bash
curl -X POST http://127.0.0.1:4100/__faults -H 'content-type: application/json' -d '[{"target":"checkout","nth":1,"kind":"lost_response_after_commit"}]'
```

## 3. Ask the agent to buy something

Ask your client: "Open http://127.0.0.1:4100/checkout and place the order. If it fails, try again."

What happens:

1. The agent clicks "Place order". The shop stores the order and returns a 504 page.
2. agent-once records the click as `intended`, then `sent`, then `failed` (the page matched a failure marker).
3. The agent clicks again. The click has the same identity (same page, same button), it falls inside the 120 s retry window, and "order" makes it a money action, so the policy is `block-on-doubt`.
4. If the client supports MCP form elicitation, it asks you "Did it happen?". Otherwise the agent gets an error result saying the call was blocked and how to resolve it.

Check the truth:

```bash
curl http://127.0.0.1:4100/__truth
```

There is one order. Without agent-once (`claude mcp add playwright -- npx @playwright/mcp@latest`) there are two.

## 4. Settle the doubt

```bash
npx agent-once ledger list
npx agent-once resolve <action_id> --happened
```

After `--happened`, a repeat of the same click within the retry window (120 s from the resolution) is answered with "this action already happened" instead of ordering again. After `--not-happened`, the next click runs. `resolve` uses the default ledger; pass `--config` if the proxy uses a different ledger path.

## 5. Let agent-once check by itself

A read-back tells agent-once how to find out whether an action landed. The example config [examples/playwright-mcp/agent-once.config.json](../examples/playwright-mcp/agent-once.config.json) does it for the four reference sites: it captures the order reference from the form, opens the history page, and looks for it. Copy the file and point the proxy at it:

```bash
claude mcp add playwright -- npx agent-once mcp --config ./agent-once.config.json -- npx @playwright/mcp@latest
```

Now a repeated "Place order" after a lost response is answered from the history page without asking anyone. Writing read-backs for your own sites is covered in [configuration.md](configuration.md#read-back).

## Next

- [How it works](how-it-works.md): identity, the ledger and the decision table.
- [MCP proxy](mcp-proxy.md): sessions, the resolve tool, elicitation and the approval webhook.
- [Chaos suite](chaos.md) and [CI](ci.md): measure your own agent.
