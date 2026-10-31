# Browser agents

Browser MCP servers mark almost every tool as destructive, hovers and navigation included, and none of them sets `idempotentHint`. Guarding by annotations alone would hold up harmless clicks, and a raw click has no meaningful identity (`ref` `e12` means nothing on the next page load). So agent-once has page-aware rules for two servers:

- `@playwright/mcp` (measured with 0.0.83)
- `chrome-devtools-mcp` (checked with 1.12.0)

The rules switch on automatically when the server's `serverInfo.name` is `Playwright` or `chrome_devtools`, or when the wrapped command contains `@playwright/mcp` or `chrome-devtools-mcp`. Set `browser.enabled` to `false` to turn them off, or to `true` to apply them by tool name to a server that is not detected.

```bash
claude mcp add playwright -- npx agent-once mcp -- npx @playwright/mcp@latest
claude mcp add devtools -- npx agent-once mcp -- npx chrome-devtools-mcp@latest
```

## What is a side effect

Only these tools can be guarded. Every other known browser tool passes (snapshots, screenshots, navigation, hover, typing without submit, `fill_form`, tabs, waits, console and network reads), and so does a script that does none of the things listed below.

| Server | Tools | When |
|---|---|---|
| Playwright | `browser_click`, `browser_select_option`, `browser_file_upload`, `browser_drop` | always checked |
| Playwright | `browser_type` | when `submit` is true |
| Playwright | `browser_press_key` | when the key is Enter |
| chrome-devtools | `click`, `upload_file`, `drag` | always checked |
| chrome-devtools | `type_text` | when `submitKey` is Enter |
| chrome-devtools | `press_key` | when the key is Enter |
| Playwright | `browser_evaluate` (`function`), `browser_run_code_unsafe` (`code`) | script text, see below |
| chrome-devtools | `evaluate_script` (`function`) | script text, see below |

A checked call is guarded when its text matches a side-effect word (whole words, case-insensitive): pay, buy, checkout, book, confirm, submit, send, delete, publish, order, purchase, place, create, post. The text is:

- for element actions, the element's label from the latest snapshot (resolved by `ref`, `target` or `uid`) and the agent's element description; the page URL is used only when both are empty;
- for keyboard submits, the page URL, the page title and the button and link labels of the last snapshot of the same URL.

A script is guarded when its code text calls `click`, `dblclick`, `submit`, `requestSubmit`, `dispatchEvent`, `fetch` or `sendBeacon`, mentions `XMLHttpRequest`, or matches a side-effect word. Its class comes from the words in the code text (`fetch('/api/pay')` is `money`), and its identity is the page URL plus the code text, so the same script on the same page is the same intent.

The class follows the same words: "Place order" and "Pay now" are `money`, "Send message" and "Delete account" are `irreversible`, "Create ticket" is `standard`. Money and irreversible clicks are `block-on-doubt`.

chrome-devtools tools take only a `uid`, so labels come from the last `take_snapshot`. A `uid` that the last snapshot does not resolve is guarded as `standard`, because agent-once cannot tell what it is.

## Identity

A guarded browser action is identified by the page and the element, not by the raw arguments: the snapshot references (`target`, `ref`, `uid`, `from_uid`, `to_uid`), `pageId`, `slowly`, `includeSnapshot` and the free-text `element` description are dropped, and `page_url` (origin and path, no query or fragment) and `label` (the resolved element label) are added. Clicking "Place order" on `/checkout` twice is the same intent even if the agent took a new snapshot in between.

## Did the click work?

The tool result alone rarely says. After a guarded action, agent-once reads the result text, and if it holds no page snapshot it takes one (`browser_snapshot` or `take_snapshot`). Then:

1. An error result matching `notDispatchedErrors` (for example `Ref e12 not found`, a stale element) means the click never happened: `not_dispatched`, and the next attempt runs.
2. Text matching `failureMarkers` (`ERR_...`, "This site can't be reached", `502 `, `503 `, `504 `, "timed out") means failed.
3. Text matching `successMarkers` (order number, booking confirmed, message sent, ticket created, "thank you for your order") means confirmed.
4. Anything else is recorded as failed. That is the cautious choice: a retry within the retry window is held as in doubt instead of repeated. Add success markers for your own sites so confirmed actions are recorded as confirmed.

The agent always receives the server's real result; the classification only feeds the ledger.

## Read-back

Without a read-back, an in-doubt browser action is held: the agent is told not to retry (standard) or a person is asked (money and irreversible). A read-back lets agent-once check by itself. It is configured per URL pattern:

```json
{
  "browser": {
    "capture": [
      { "urlPattern": "^https://shop\\.example\\.com/checkout", "regex": "Order reference (R-\\d+)" }
    ],
    "readBack": [
      {
        "urlPattern": "^https://shop\\.example\\.com/checkout",
        "steps": [
          { "tool": "browser_navigate", "args": { "url": "{{origin}}/account/orders" } },
          { "tool": "browser_snapshot", "args": {} }
        ],
        "happened": "\\b{{captured}}\\b",
        "notHappened": "Your orders"
      }
    ]
  }
}
```

- `capture` runs before the click on the current snapshot when the URL matches, and stores the first group of `regex` with the action (here a reference printed on the form).
- On doubt, the read-back whose `urlPattern` matches the page the agent is on when it retries runs its `steps` and tests the joined text: `happened` first, then `notHappened` (both case-insensitive). Neither matching means unknown.
- Templates: `{{origin}}` (origin of that page), `{{captured}}`, `{{idempotency_key}}`, `{{action_id}}` and `{{args.<path>}}`. Values are regex-escaped inside patterns.
- `not_happened` is trusted only after the settle window (10 s), so a slow commit is not mistaken for a missing one.
- When the read-back navigated away and finds the action did not happen, agent-once navigates back to the page and answers `retry_by_agent`: the agent is told to take a fresh snapshot and repeat the action, instead of agent-once clicking a stale element on a changed page.

[examples/playwright-mcp/agent-once.config.json](../examples/playwright-mcp/agent-once.config.json) is a working config for the four reference sites.

## Limits

- **No network view.** agent-once sees MCP calls, not the browser's HTTP traffic. It cannot see a lost response between the browser and the site except through the page.
- **Connection reset after commit (known limitation).** When the site commits a form POST and then resets the connection, Chromium silently re-sends the POST below the MCP layer. One click becomes two orders and agent-once never sees the second request. Measured: 12 duplicates in 12 runs with and without the guard ([RESULTS.md](../RESULTS.md#known-limitations)). The fix is on the server (deduplicate resubmitted forms).
- **One page state per proxy.** Labels, the last snapshot and captured values are tracked per proxy, not per tab or `pageId`. Agents that switch tabs between the snapshot and the click can get a label from the other tab.
- **Scripts are judged by their text.** A script that reaches the page indirectly (built from strings, `eval`, `Function`, renamed or minified calls, a Playwright locator method other than `click`, or code loaded from `browser_run_code_unsafe`'s `filename`) can change the page without matching, and then passes unguarded. Pin `"policy": "guard"` for the script tools under `tools` in the config if your agent runs scripts you cannot read.
- **Coordinate tools.** Vision tools such as `browser_mouse_click_xy` have no page-aware identity. They are guarded through their annotations like any other MCP tool, with the raw arguments (coordinates and description) as identity, so an identical retry is held but the element label is not known.
- Upstream calls agent-once makes itself (snapshot, read-back steps) have no timeout of their own; a hung server keeps the guarded call open until the client cancels it.
